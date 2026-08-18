/**
 * The acquisition workflow: a seller proposes, we decide, and only then do
 * coins move.
 *
 * This replaces the old one-shot `/sell/execute`, where a seller signed and
 * the transaction was broadcast and booked in the same request — no moment at
 * which Lana.discount decided whether it wanted the asset at all. The order of
 * these endpoints IS the compliance argument:
 *
 *   POST /offers          seller proposes; we run the mandate and either make
 *                         a purchase offer, send it for review, or decline
 *   POST /:ref/accept     the seller accepts OUR offer — the contract moment,
 *                         recorded with the terms they saw
 *   POST /:ref/transfer   only now does LANA move, priced from the offer
 *
 * A submission is not an order and creates no right to execution; every path
 * out of `/offers` can be a refusal.
 */
import { Router, type Request, type Response } from 'express';
import {
  getAppSetting, getAllAppSettings, getRelaysFromDb, getTrustedSignersFromDb,
  getSplitFromDb, getElectrumServersFromDb, getExchangeRatesFromDb,
  getCrowdfundBandSet, insertBuybackTransaction, isAdminUser, getDbHandle,
} from '../db/index.js';
import {
  decideAcquisition, readMandateSettings, CLASS_LABELS, type WalletClass,
} from '../lib/treasuryMandate.js';
import {
  generateOfferRef, insertOffer, getOfferByRef, sqliteFuture, markOffered,
  markDeclined, markAccepted, markSettled, markWithdrawn, listOffersForReview,
  listOffersForUser, assertTransferable, OFFER_VALIDITY_MINUTES, type OfferRow,
} from '../lib/acquisitionOffer.js';
import { checkSellerEligibility } from '../lib/sellerEligibility.js';
import { sendLanaTransaction } from '../lib/transaction.js';

/**
 * The terms a seller agrees to when accepting a purchase offer. Bump this
 * whenever the wording changes — the version is stored on the offer so we can
 * always say which text a given counterparty actually saw.
 */
export const TERMS_VERSION = '2026-08-18.v1';

const db = () => getDbHandle();

export function createAcquisitionsRouter(deps: {
  walletCheckBaseUrl: string;
  publishBuybackEvent: (tx: any) => Promise<unknown>;
}): Router {
  const router = Router();

  // ── shared helpers ──────────────────────────────────────────────────

  /**
   * What we are willing to pay. Kept in one place so the offer, the admin
   * counteroffer and the transfer can never disagree about it.
   *
   * The class comes from the server-resolved wallet type, never from the
   * request: the tier used to be whatever the client posted, which meant a
   * tampered request could pick the cheaper one.
   */
  function priceAcquisition(lanaAmount: number, currency: string, walletClass: WalletClass) {
    const rates = getExchangeRatesFromDb();
    const referenceRate = rates[currency];
    if (!referenceRate) return null;

    // Fallbacks match the seeded values (lanapays 21, other 30). The old
    // inline fallbacks had them the other way round, so a missing settings
    // row would silently have charged the wrong tier.
    const discountPercent = walletClass === 'lanapays'
      ? parseFloat(getAppSetting('commission_lanapays') || '21')
      : parseFloat(getAppSetting('commission_other') || '30');

    const grossFiat = Math.round(lanaAmount * referenceRate * 100) / 100;
    const discountFiat = Math.round(grossFiat * discountPercent / 100 * 100) / 100;
    const purchasePriceFiat = Math.round((grossFiat - discountFiat) * 100) / 100;
    return { referenceRate, discountPercent, grossFiat, discountFiat, purchasePriceFiat };
  }

  /** What a seller is allowed to see about their own offer. */
  function offerView(o: OfferRow) {
    return {
      offerRef: o.offer_ref,
      status: o.status,
      lanaAmount: o.lana_amount_display,
      currency: o.currency,
      purchasePrice: o.purchase_price_fiat,
      settlementDueAt: o.settlement_due_at,
      offerExpiresAt: o.offer_expires_at,
      decisionReason: o.decision_reason,
      senderWallet: o.sender_wallet_id,
      createdAt: o.created_at,
      transactionId: o.transaction_id,
    };
  }

  function requireAdminHex(req: Request, res: Response): string | null {
    const hexId = String(req.headers['x-admin-hex-id'] || '');
    if (!hexId || !isAdminUser(hexId)) {
      res.status(403).json({ error: 'Admin access required' });
      return null;
    }
    return hexId;
  }

  // ── 1. Submit an offer ──────────────────────────────────────────────

  router.post('/offers', async (req: Request, res: Response) => {
    try {
      const hexId = String(req.body?.hexId || '');
      const senderAddress = String(req.body?.senderAddress || '');
      const lanaAmount = Number(req.body?.lanaAmount);
      const currency = String(req.body?.currency || '').toUpperCase();

      if (!hexId || !senderAddress || !currency) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!Number.isFinite(lanaAmount) || lanaAmount <= 0) {
        return res.status(400).json({ error: 'Invalid LANA amount' });
      }

      let activeCurrencies: string[] = ['EUR'];
      try { activeCurrencies = JSON.parse(getAppSetting('active_currencies') || '["EUR"]'); } catch { /* default */ }
      if (!activeCurrencies.includes(currency)) {
        return res.status(400).json({ error: `Currency ${currency} is not active` });
      }

      // Who and what — the same three gates the sale has always had.
      const eligibility = await checkSellerEligibility(hexId, senderAddress, {
        relays: getRelaysFromDb(),
        trustedRegistrars: getTrustedSignersFromDb().LanaRegistrar || [],
        walletCheckBaseUrl: deps.walletCheckBaseUrl,
        currentSplit: getSplitFromDb(),
        crowdfundHexes: getCrowdfundBandSet(currency),
      });
      if (!eligibility.ok) {
        return res.status(eligibility.httpStatus || 403).json({
          error: eligibility.error, code: eligibility.code, ...(eligibility.detail || {}),
        });
      }

      const walletClass = eligibility.walletClass!;
      const priced = priceAcquisition(lanaAmount, currency, walletClass);
      if (!priced) return res.status(400).json({ error: `No reference price for ${currency}` });

      const minSell = parseFloat(getAppSetting(`min_sell_${currency.toLowerCase()}`) || '0');
      if (minSell > 0 && priced.grossFiat < minSell) {
        return res.status(400).json({ error: `Minimum acquisition value is ${minSell} ${currency}` });
      }

      // ── the treasury's own decision ──────────────────────────────
      const settings = readMandateSettings(getAllAppSettings(), currency, walletClass);
      const mandate = decideAcquisition({
        walletClass,
        currency,
        fiatValue: priced.grossFiat,
        settings,
      });

      const offerRef = generateOfferRef(db());
      const base = {
        offerRef,
        userHexId: hexId,
        senderWalletId: senderAddress,
        walletClass,
        lanaAmountLanoshis: Math.floor(lanaAmount * 100_000_000),
        lanaAmountDisplay: lanaAmount,
        currency,
        referenceRate: priced.referenceRate,
        discountPercent: priced.discountPercent,
        grossFiat: priced.grossFiat,
        mandateCode: mandate.code,
        eligibility: eligibility.evidence || null,
      };

      if (mandate.outcome === 'decline') {
        const offer = insertOffer(db(), {
          ...base, status: 'declined',
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: mandate.reason,
        });
        console.log(`[lana-discount] Offer ${offerRef} declined (${mandate.code}) — ${CLASS_LABELS[walletClass]} ${currency}`);
        return res.json({ offer: offerView(offer) });
      }

      if (mandate.outcome === 'review') {
        const offer = insertOffer(db(), {
          ...base, status: 'under_review',
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: mandate.reason,
        });
        console.log(`[lana-discount] Offer ${offerRef} under review (${mandate.code}) — ${priced.grossFiat} ${currency}`);
        return res.json({ offer: offerView(offer) });
      }

      // Within the mandate: we make a purchase offer here and now. It carries
      // a price we owe and a date we owe it by, and it lapses if unaccepted.
      const offer = insertOffer(db(), {
        ...base, status: 'offered',
        purchasePriceFiat: priced.purchasePriceFiat,
        settlementDueAt: sqliteFuture(db(), `+${mandate.dueDays} days`),
        offerExpiresAt: sqliteFuture(db(), `+${OFFER_VALIDITY_MINUTES} minutes`),
        decisionReason: null,
      });
      console.log(`[lana-discount] Offer ${offerRef} made: ${priced.purchasePriceFiat} ${currency} for ${lanaAmount} LANA (${walletClass})`);
      return res.json({ offer: offerView(offer) });
    } catch (err: any) {
      console.error('[lana-discount] Offer submission failed:', err.message);
      return res.status(500).json({ error: 'Could not process this proposal right now.' });
    }
  });

  // ── 2. Seller accepts our purchase offer ────────────────────────────

  router.post('/:ref/accept', (req: Request, res: Response) => {
    const ref = String(req.params.ref);
    const hexId = String(req.body?.hexId || '');
    if (!hexId) return res.status(400).json({ error: 'Missing hexId' });

    const offer = getOfferByRef(db(), ref);
    if (!offer || offer.user_hex_id.toLowerCase() !== hexId.toLowerCase()) {
      return res.status(404).json({ error: 'No such acquisition offer.' });
    }
    if (!markAccepted(db(), ref, TERMS_VERSION)) {
      const fresh = getOfferByRef(db(), ref)!;
      return res.status(409).json({
        error: fresh.status === 'offered'
          ? 'This purchase offer has lapsed. Please submit a new offer.'
          : 'This offer can no longer be accepted.',
        status: fresh.status,
      });
    }
    return res.json({ offer: offerView(getOfferByRef(db(), ref)!) });
  });

  router.post('/:ref/withdraw', (req: Request, res: Response) => {
    const hexId = String(req.body?.hexId || '');
    if (!hexId) return res.status(400).json({ error: 'Missing hexId' });
    const ok = markWithdrawn(db(), String(req.params.ref), hexId);
    return ok ? res.json({ ok: true }) : res.status(409).json({ error: 'This offer can no longer be withdrawn.' });
  });

  router.get('/mine/:hexId', (req: Request, res: Response) => {
    const offers = listOffersForUser(db(), String(req.params.hexId));
    return res.json({ offers: offers.map(offerView) });
  });

  router.get('/:ref', (req: Request, res: Response) => {
    const hexId = String(req.query.hexId || '');
    const offer = getOfferByRef(db(), String(req.params.ref));
    if (!offer || !hexId || offer.user_hex_id.toLowerCase() !== hexId.toLowerCase()) {
      return res.status(404).json({ error: 'No such acquisition offer.' });
    }
    return res.json({ offer: offerView(offer) });
  });

  // ── 3. Transfer — the only place LANA moves ─────────────────────────

  router.post('/:ref/transfer', async (req: Request, res: Response) => {
    try {
      const ref = String(req.params.ref);
      const hexId = String(req.body?.hexId || '');
      const privateKey = String(req.body?.privateKey || '');
      const emptyWallet = !!req.body?.emptyWallet;
      if (!hexId || !privateKey) return res.status(400).json({ error: 'Missing required fields' });

      // The one door.
      const gate = assertTransferable(db(), ref, hexId);
      if (!gate.ok) {
        return res.status(gate.code === 'NO_SUCH_OFFER' ? 404 : 409).json({
          error: gate.reason, code: gate.code,
        });
      }
      const offer = gate.offer!;

      // Re-run eligibility: an accepted offer is not a licence to move coins
      // that have been frozen in the meantime.
      const eligibility = await checkSellerEligibility(hexId, offer.sender_wallet_id, {
        relays: getRelaysFromDb(),
        trustedRegistrars: getTrustedSignersFromDb().LanaRegistrar || [],
        walletCheckBaseUrl: deps.walletCheckBaseUrl,
        currentSplit: getSplitFromDb(),
        crowdfundHexes: getCrowdfundBandSet(offer.currency),
      });
      if (!eligibility.ok) {
        return res.status(eligibility.httpStatus || 403).json({
          error: eligibility.error, code: eligibility.code, ...(eligibility.detail || {}),
        });
      }

      const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
      if (!buybackWalletId) return res.status(400).json({ error: 'Treasury wallet not configured' });

      const lanaAmount = offer.lana_amount_display;
      console.log(`[lana-discount] Transfer for ${ref}: ${lanaAmount} LANA ${offer.sender_wallet_id} → ${buybackWalletId}`);

      const txResult = await sendLanaTransaction({
        senderAddress: offer.sender_wallet_id,
        recipientAddress: buybackWalletId,
        amount: emptyWallet ? undefined : lanaAmount,
        privateKey,
        emptyWallet,
        electrumServers: getElectrumServersFromDb(),
      });

      // EVERY figure below comes from the offer, never from a fresh rate read.
      // This is what makes it an agreed purchase price rather than whatever
      // the market said at the instant the coins happened to move.
      const commonRow = {
        user_hex_id: hexId,
        sender_wallet_id: offer.sender_wallet_id,
        buyback_wallet_id: buybackWalletId,
        lana_amount_lanoshis: offer.lana_amount_lanoshis,
        lana_amount_display: lanaAmount,
        currency: offer.currency,
        exchange_rate: offer.reference_rate!,
        split: getSplitFromDb(),
        gross_fiat: offer.gross_fiat!,
        commission_percent: offer.discount_percent!,
        commission_fiat: Math.round((offer.gross_fiat! - offer.purchase_price_fiat!) * 100) / 100,
        net_fiat: offer.purchase_price_fiat!,
      };

      if (!txResult.success) {
        const txId = insertBuybackTransaction({
          ...commonRow, status: 'failed', error_message: txResult.error,
        } as any);
        console.error(`[lana-discount] Transfer failed for ${ref}: ${txResult.error}`);
        return res.status(400).json({ success: false, error: txResult.error, transactionId: txId });
      }

      const txId = insertBuybackTransaction({
        ...commonRow,
        tx_hash: txResult.txHash,
        tx_fee_lanoshis: txResult.fee,
        status: 'broadcast',
      } as any);

      // Carry the acquisition and the date we owe by onto the sale, so the
      // payout screens and the seller's own page can see them without a join.
      db().prepare('UPDATE buyback_transactions SET offer_ref = ?, settlement_due_at = ? WHERE id = ?')
        .run(ref, offer.settlement_due_at, txId);
      markSettled(db(), ref, txId);

      console.log(`[lana-discount] Acquisition ${ref} completed: TX ${txResult.txHash}, ID ${txId}, due ${offer.settlement_due_at}`);

      deps.publishBuybackEvent({
        id: txId, tx_hash: txResult.txHash, user_hex_id: hexId,
        sender_wallet_id: offer.sender_wallet_id, buyback_wallet_id: buybackWalletId,
        lana_amount_lanoshis: offer.lana_amount_lanoshis, lana_amount_display: lanaAmount,
        currency: offer.currency, exchange_rate: offer.reference_rate,
        gross_fiat: offer.gross_fiat, commission_percent: offer.discount_percent,
        commission_fiat: commonRow.commission_fiat, net_fiat: offer.purchase_price_fiat,
        split: commonRow.split, source: 'internal', status: 'broadcast',
      }).catch((err: any) => console.error('[lana-discount] Nostr publish failed:', err.message));

      return res.json({
        success: true,
        offerRef: ref,
        txHash: txResult.txHash,
        lanaAmount,
        currency: offer.currency,
        purchasePrice: offer.purchase_price_fiat,
        settlementDueAt: offer.settlement_due_at,
        fee: txResult.fee,
        transactionId: txId,
      });
    } catch (err: any) {
      console.error('[lana-discount] Transfer failed:', err.message);
      return res.status(500).json({ error: 'Could not complete this acquisition right now.' });
    }
  });

  // ── 4. Admin: the review queue ──────────────────────────────────────

  router.get('/admin/queue', (req: Request, res: Response) => {
    if (!requireAdminHex(req, res)) return;
    return res.json({ offers: listOffersForReview(db()).map(o => ({
      ...offerView(o),
      userHexId: o.user_hex_id,
      walletClass: o.wallet_class,
      grossFiat: o.gross_fiat,
      indicativePrice: o.gross_fiat !== null && o.discount_percent !== null
        ? Math.round((o.gross_fiat - o.gross_fiat * o.discount_percent / 100) * 100) / 100
        : null,
      mandateCode: o.mandate_code,
    })) });
  });

  /**
   * Accept, decline or counter. A counteroffer is simply an acceptance at a
   * price we choose — the framework treats the three as one decision, and so
   * does this endpoint.
   */
  router.post('/admin/:ref/decide', (req: Request, res: Response) => {
    const adminHex = requireAdminHex(req, res);
    if (!adminHex) return;

    const ref = String(req.params.ref);
    const action = String(req.body?.action || '');
    const reason = String(req.body?.reason || '').trim();

    const offer = getOfferByRef(db(), ref);
    if (!offer) return res.status(404).json({ error: 'No such acquisition offer.' });

    if (action === 'decline') {
      if (!reason) return res.status(400).json({ error: 'A reason is required to decline.' });
      if (!markDeclined(db(), ref, reason, adminHex)) {
        return res.status(409).json({ error: 'This offer has already been decided.' });
      }
      return res.json({ offer: offerView(getOfferByRef(db(), ref)!) });
    }

    if (action === 'accept' || action === 'counter') {
      const priced = priceAcquisition(offer.lana_amount_display, offer.currency, offer.wallet_class as WalletClass);
      if (!priced) return res.status(400).json({ error: `No reference price for ${offer.currency}` });

      let purchasePriceFiat = priced.purchasePriceFiat;
      if (action === 'counter') {
        const override = Number(req.body?.purchasePrice);
        if (!Number.isFinite(override) || override <= 0) {
          return res.status(400).json({ error: 'A counteroffer needs a purchase price.' });
        }
        purchasePriceFiat = Math.round(override * 100) / 100;
      }

      const settings = readMandateSettings(getAllAppSettings(), offer.currency, offer.wallet_class as WalletClass);
      const ok = markOffered(db(), ref, {
        purchasePriceFiat,
        grossFiat: priced.grossFiat,
        referenceRate: priced.referenceRate,
        // What we actually gave away against the reference, whatever route it
        // came by — so a counteroffer records its own real discount.
        discountPercent: priced.grossFiat > 0
          ? Math.round((1 - purchasePriceFiat / priced.grossFiat) * 10000) / 100
          : priced.discountPercent,
        settlementDueAt: sqliteFuture(db(), `+${settings.dueDays} days`),
        offerExpiresAt: sqliteFuture(db(), `+${OFFER_VALIDITY_MINUTES} minutes`),
        decidedBy: adminHex,
      });
      if (!ok) return res.status(409).json({ error: 'This offer has already been decided.' });
      return res.json({ offer: offerView(getOfferByRef(db(), ref)!) });
    }

    return res.status(400).json({ error: 'action must be accept, counter or decline' });
  });

  return router;
}
