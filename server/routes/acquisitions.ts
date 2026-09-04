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
 *
 * TWO PATHS THROUGH /offers, chosen by the gate `acq_round_mandates_from_split`:
 *
 *   legacy   what the endpoint has always done — class-based discount,
 *            per-currency mandate settings. Unchanged, so the UI that exists
 *            today keeps working until the round-aware one ships.
 *   mandate  LanaPays.Us wallets once the gate's split is reached: the
 *            proposal must be signed by its hex, the wallet must be on that
 *            hex's signed KIND 30889 list, and the amount is judged against
 *            the financing-round mandate (lib/roundMandate.ts) INSIDE the same
 *            SQLite transaction as the insert — so two proposals cannot both
 *            be offered the last of a mandate.
 *
 * SIGNED REQUESTS (lib/requestSignature.ts — the scheme is documented there
 * as the contract for the UI): POST /offers on the mandate path, POST
 * /:ref/accept and /:ref/withdraw when the offer carries a mandate_ref, and
 * GET /mandate. Legacy offers (no mandate_ref) are never asked for one, so
 * the UI that exists today keeps working until the round-aware one ships.
 */
import { Router, type Request, type Response } from 'express';
import {
  getAppSetting, getAllAppSettings, getRelaysFromDb, getTrustedSignersFromDb,
  getSplitFromDb, getElectrumServersFromDb, getExchangeRatesFromDb,
  insertBuybackTransaction, getDbHandle,
} from '../db/index.js';
import { GATE_SETTING_KEY } from '../db/roundMandateSchema.js';
import {
  decideAcquisition, readMandateSettings, CLASS_LABELS, type WalletClass,
} from '../lib/treasuryMandate.js';
import {
  generateOfferRef, insertOffer, getOfferByRef, sqliteFuture, markOffered,
  markDeclined, markAccepted, markSettled, markWithdrawn, listOffersForReview,
  listOffersForUser, assertTransferable, consumedByMandate, markExpiredWithReason,
  offerTotalsByMandate, markVoidedByAdmin, OFFER_VALIDITY_MINUTES, type OfferRow,
} from '../lib/acquisitionOffer.js';
import { checkSellerEligibility as realCheckSellerEligibility } from '../lib/sellerEligibility.js';
import { sendLanaTransaction as realSendLanaTransaction } from '../lib/transaction.js';
import { fetchUserWallets as realFetchUserWallets } from '../lib/nostr.js';
import { fetchBatchBalances as realFetchBatchBalances, type WalletBalance } from '../lib/electrum.js';
import { requireAdmin } from '../lib/adminAuth.js';
import { verifyRequestSignature, type ReplayCache } from '../lib/requestSignature.js';
import {
  evaluateRoundMandate, roundState, parseGateSetting, isGateActive, remainingOf,
  mandateInWindow, EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS,
  type MandateCandidate, type RoundTerms,
} from '../lib/roundMandate.js';
import { listMandatesForHex, rowToCandidate, loadRoundTerms, loadReleases } from '../lib/roundMandateSync.js';
import { resolveReferenceBasis } from '../lib/referenceBasis.js';
import { BUYBACK_SPLIT_OFFSET } from '../lib/buybackSplit.js';

/**
 * The terms a seller agrees to when accepting a purchase offer. Bump this
 * whenever the wording changes — the version is stored on the offer so we can
 * always say which text a given counterparty actually saw.
 */
export const TERMS_VERSION = '2026-08-18.v1';

/**
 * The pathname a client signs for a proposal (lib/requestSignature.ts). The
 * router derives it from the mount point at runtime; this constant exists so
 * clients and tests spell it identically.
 */
export const OFFERS_SIGNED_PATH = '/api/acquisitions/offers';

/**
 * fetchBatchBalances answers in LANA rounded to two decimals, i.e. to the
 * nearest 1,000,000 lanoshis. The dust we tolerate above a mandate-bound
 * emptying transfer must therefore include half of that step, or an honest
 * "empty the wallet" would be refused for a rounding artefact.
 */
export const BALANCE_ROUNDING_LANOSHIS = 500_000;

const db = () => getDbHandle();

/**
 * What we are willing to pay. Kept in one place so the offer, the admin
 * counteroffer and the transfer can never disagree about it.
 *
 * Pure: rates and settings come in as arguments, so the arithmetic is
 * unit-tested on its own. The class comes from the server-resolved wallet
 * type, never from the request: the tier used to be whatever the client
 * posted, which meant a tampered request could pick the cheaper one.
 *
 * `discountPercent` overrides the class discount — it is the ROUND's
 * discount on the mandate path (owner's decision 1, 4 Sep 2026).
 */
export function priceAcquisition(
  lanaAmount: number,
  currency: string,
  walletClass: WalletClass,
  opts: { rates: Record<string, number>; settings: Record<string, string>; discountPercent?: number },
) {
  const referenceRate = opts.rates[currency];
  if (!referenceRate) return null;

  // Fallbacks match the seeded values (lanapays 21, other 30). The old
  // inline fallbacks had them the other way round, so a missing settings
  // row would silently have charged the wrong tier.
  const classDiscount = walletClass === 'lanapays'
    ? parseFloat(opts.settings['commission_lanapays'] || '21')
    : parseFloat(opts.settings['commission_other'] || '30');
  const discountPercent = Number.isFinite(opts.discountPercent) ? Number(opts.discountPercent) : classDiscount;

  const grossFiat = Math.round(lanaAmount * referenceRate * 100) / 100;
  const discountFiat = Math.round(grossFiat * discountPercent / 100 * 100) / 100;
  const purchasePriceFiat = Math.round((grossFiat - discountFiat) * 100) / 100;
  return { referenceRate, discountPercent, grossFiat, discountFiat, purchasePriceFiat };
}

const sameAddress = (a: string, b: string) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** An offer that drew on a KIND 30960 mandate, as opposed to a legacy one. */
const isMandateBound = (o: OfferRow): boolean => o.mandate_ref !== null && o.mandate_ref !== undefined;

/**
 * The balance of ONE wallet out of a fetchBatchBalances answer, or null when
 * the answer does not verifiably say it. Fail closed on every shape electrum
 * can produce short of throwing: an entry carrying `error`, no entry for the
 * wallet at all, an entry for some OTHER wallet, a non-numeric balance. Each
 * of these used to read as "balance 0" and let an emptying transfer through;
 * the guard is only worth having if an unreadable balance is a refusal.
 */
export function verifiedBalanceLanoshis(balances: WalletBalance[] | null | undefined, wallet: string): number | null {
  if (!Array.isArray(balances)) return null;
  const entry = balances.find(b => b && sameAddress(String(b.wallet_id || ''), wallet));
  if (!entry) return null;
  if (entry.error) return null;
  if (typeof entry.balance !== 'number' || !Number.isFinite(entry.balance)) return null;
  return Math.round(entry.balance * 100_000_000);
}

export interface AcquisitionsDeps {
  walletCheckBaseUrl: string;
  publishBuybackEvent: (tx: any) => Promise<unknown>;
  /** The I/O this router does, injectable so the tests can stand in for relays, electrum and the chain. */
  checkSellerEligibility?: typeof realCheckSellerEligibility;
  fetchUserWallets?: typeof realFetchUserWallets;
  fetchBatchBalances?: typeof realFetchBatchBalances;
  sendLanaTransaction?: typeof realSendLanaTransaction;
  /** Unix seconds. */
  now?: () => number;
  /** Replay memory for signed requests; defaults to the process-wide one. Tests inject a fresh one. */
  replayCache?: ReplayCache;
}

export function createAcquisitionsRouter(deps: AcquisitionsDeps): Router {
  const router = Router();
  const checkSellerEligibility = deps.checkSellerEligibility || realCheckSellerEligibility;
  const fetchUserWallets = deps.fetchUserWallets || realFetchUserWallets;
  const fetchBatchBalances = deps.fetchBatchBalances || realFetchBatchBalances;
  const sendLanaTransaction = deps.sendLanaTransaction || realSendLanaTransaction;
  const now = deps.now || (() => Math.floor(Date.now() / 1000));

  // ── shared helpers ──────────────────────────────────────────────────

  const price = (lanaAmount: number, currency: string, walletClass: WalletClass, discountPercent?: number) =>
    priceAcquisition(lanaAmount, currency, walletClass, {
      rates: getExchangeRatesFromDb(), settings: getAllAppSettings(), discountPercent,
    });

  const currentSplitNumber = (): number | null => parseInt(getSplitFromDb() || '') || null;

  /**
   * The one signature check. PATH is the pathname as routed (mount point +
   * route, no query), BODY is the parsed JSON for a POST and undefined for
   * a GET — exactly what the contract in lib/requestSignature.ts says the
   * client signs. Answers 401 itself: SIGNATURE_REPLAYED for a signature
   * already honoured, SIGNATURE_REQUIRED (with `detail`) for everything else.
   */
  function requireSignedBy(req: Request, res: Response, expectedPubkey: string, body: unknown): boolean {
    const sig = verifyRequestSignature({
      expectedPubkey,
      pubkeyHeader: req.headers['x-auth-pubkey'] as string | undefined,
      timestampHeader: req.headers['x-auth-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-auth-signature'] as string | undefined,
      method: req.method, path: req.baseUrl + req.path, body, now: now(),
      replayCache: deps.replayCache,
    });
    if (sig.ok) return true;
    res.status(401).json({
      error: sig.code === 'REPLAYED'
        ? 'This signed request was already used. Please sign a fresh one.'
        : 'This request must be signed with the key of the hex it is made for.',
      code: sig.code === 'REPLAYED' ? 'SIGNATURE_REPLAYED' : 'SIGNATURE_REQUIRED',
      detail: sig.code,
    });
    return false;
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
      // Round-mandate fields (null on the legacy path).
      mandateCode: o.mandate_code,
      mandateRef: o.mandate_ref ?? null,
      round: o.round ?? null,
      proposedLanaAmount: o.proposed_lana_lanoshis === null || o.proposed_lana_lanoshis === undefined
        ? null
        : o.proposed_lana_lanoshis / 100_000_000,
      isCounteroffer: o.proposed_lana_lanoshis !== null && o.proposed_lana_lanoshis !== undefined,
    };
  }

  const eligibilityDeps = () => ({
    relays: getRelaysFromDb(),
    trustedRegistrars: getTrustedSignersFromDb().LanaRegistrar || [],
    walletCheckBaseUrl: deps.walletCheckBaseUrl,
    currentSplit: getSplitFromDb(),
  });

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
      const eligibility = await checkSellerEligibility(hexId, senderAddress, eligibilityDeps());
      if (!eligibility.ok) {
        return res.status(eligibility.httpStatus || 403).json({
          error: eligibility.error, code: eligibility.code, ...(eligibility.detail || {}),
        });
      }

      const walletClass = eligibility.walletClass!;
      const gateFromSplit = parseGateSetting(getAppSetting(GATE_SETTING_KEY));
      if (walletClass === 'lanapays' && isGateActive(gateFromSplit, currentSplitNumber())) {
        return await proposeUnderMandate(req, res, {
          hexId, senderAddress, lanaAmount, currency, eligibility: eligibility.evidence || null,
        });
      }

      // ── legacy path — unchanged ──────────────────────────────────
      const priced = price(lanaAmount, currency, walletClass);
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
        console.log(`[lana-discount] Offer ${offerRef} declined (${mandate.code}) — ${CLASS_LABELS[walletClass] ?? walletClass} ${currency}`);
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

  /**
   * The mandate path. Three gates the legacy path does not have, then one
   * transaction that reads the cap and writes the offer.
   */
  async function proposeUnderMandate(req: Request, res: Response, p: {
    hexId: string; senderAddress: string; lanaAmount: number; currency: string; eligibility: unknown;
  }) {
    const { hexId, senderAddress, lanaAmount, currency } = p;

    // (b) The request must be signed by the hex it acts for — a mandate is a
    // financer's quota, and a body field is not proof of being that financer.
    // The signature covers the body, so the amount and wallet judged below
    // are the ones the financer signed, not ones swapped in on the way.
    if (!requireSignedBy(req, res, hexId, req.body)) return;

    // (a) The wallet must be on THIS hex's signed KIND 30889 list. Fail
    // closed: no list is not a clearance (eligibility swallows this error
    // because it only needs the freeze signal; here it decides whose cap is
    // spent).
    let listed: Awaited<ReturnType<typeof fetchUserWallets>>;
    try {
      listed = await fetchUserWallets(hexId, getRelaysFromDb(), getTrustedSignersFromDb().LanaRegistrar || []);
    } catch (err: any) {
      console.warn('[lana-discount] Wallet ownership check failed:', err.message);
      return res.status(503).json({
        error: 'Wallet ownership could not be verified right now. Please try again shortly.',
        code: 'WALLET_OWNERSHIP_UNVERIFIABLE',
      });
    }
    if (!listed || listed.length === 0) {
      return res.status(503).json({
        error: 'No signed wallet list was found for this account, so wallet ownership could not be verified.',
        code: 'WALLET_OWNERSHIP_UNVERIFIABLE',
      });
    }
    if (!listed.some(w => sameAddress(w.walletId, senderAddress))) {
      return res.status(403).json({
        error: 'This wallet is not on the signed wallet list of this account.',
        code: 'WALLET_NOT_OWNED',
      });
    }

    // (c) Cap and insert in ONE synchronous transaction. better-sqlite3 runs
    // it to completion before any other statement on this connection, so
    // "remaining" read here is still true when the row lands.
    const requestedLanoshis = Math.floor(lanaAmount * 100_000_000);
    type Result = { kind: 'offer'; offer: OfferRow; log: string } | { kind: 'error'; status: number; body: Record<string, unknown> };
    const run = db().transaction((): Result => {
      const handle = db();
      const currentSplit = currentSplitNumber();
      const candidates = listMandatesForHex(handle, hexId);
      const windowSplit = currentSplit === null ? null : currentSplit - BUYBACK_SPLIT_OFFSET;
      const terms = windowSplit === null ? [] : loadRoundTerms(handle, windowSplit);
      const dTags = candidates.map(c => c.dTag);
      const verdict = evaluateRoundMandate({
        gateFromSplit: parseGateSetting(getAppSetting(GATE_SETTING_KEY)),
        currentSplit,
        hexId, wallet: senderAddress, requestedLanoshis,
        candidates, terms,
        released: loadReleases(handle, dTags),
        consumed: consumedByMandate(handle, dTags),
        now: now(),
      });
      if (verdict === 'legacy') {
        // The gate flipped between the check above and here; the caller
        // re-proposes and takes the legacy path.
        return { kind: 'error', status: 409, body: { error: 'Please submit this proposal again.', code: 'GATE_CHANGED' } };
      }

      const offerRef = generateOfferRef(handle);
      const legacyPriced = price(lanaAmount, currency, 'lanapays');
      const base = {
        offerRef, userHexId: hexId, senderWalletId: senderAddress, walletClass: 'lanapays',
        lanaAmountLanoshis: requestedLanoshis, lanaAmountDisplay: lanaAmount, currency,
        referenceRate: legacyPriced?.referenceRate ?? null,
        discountPercent: null as number | null,
        grossFiat: legacyPriced?.grossFiat ?? null,
        eligibility: p.eligibility,
        referenceBasis: 'current_split',
      };

      if (verdict.outcome === 'review') {
        // IN QUEUE — a person looks, with the class discount as a reference only.
        const offer = insertOffer(handle, {
          ...base, status: 'under_review', mandateCode: verdict.code,
          discountPercent: legacyPriced?.discountPercent ?? null,
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: verdict.reason,
        });
        return { kind: 'offer', offer, log: `under review (${verdict.code})` };
      }

      if (verdict.outcome === 'decline') {
        const opens = verdict.opensAt ? ` Opens at ${new Date(verdict.opensAt * 1000).toISOString()}.` : '';
        const offer = insertOffer(handle, {
          ...base, status: 'declined', mandateCode: verdict.code,
          mandateRef: verdict.mandateRef ?? null, round: verdict.round ?? null,
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: verdict.reason + opens,
        });
        return { kind: 'offer', offer, log: `declined (${verdict.code})` };
      }

      // accept | counter — priced at the ROUND's discount, from the live fx.
      const allowedLana = verdict.allowedLanoshis / 100_000_000;
      const priced = price(allowedLana, currency, 'lanapays', verdict.discountPercent);
      if (!priced) return { kind: 'error', status: 400, body: { error: `No reference price for ${currency}` } };

      const minSell = parseFloat(getAppSetting(`min_sell_${currency.toLowerCase()}`) || '0');
      if (minSell > 0 && priced.grossFiat < minSell) {
        return { kind: 'error', status: 400, body: { error: `Minimum acquisition value is ${minSell} ${currency}`, code: 'BELOW_MINIMUM' } };
      }

      // The per-currency mandate settings still rule ON TOP of the round
      // mandate: the kill-switch declines, and the auto cap remains the outer
      // ceiling (plan: "auto_cap ostane zunanji strop"). A round mandate says
      // how much of a budget we may acquire; auto_cap says how much of it we
      // acquire WITHOUT a person looking. So any 'review' from
      // decideAcquisition — MANUAL_ONLY (cap 0), ABOVE_AUTO_CAP, UNMEASURABLE
      // — lands in under_review with its mandate fields kept, and the admin
      // decide endpoint re-prices at the round discount and re-checks the
      // remaining cap. It must never be turned into an automatic offer.
      const settings = readMandateSettings(getAllAppSettings(), currency, 'lanapays');
      const decision = decideAcquisition({ walletClass: 'lanapays', currency, fiatValue: priced.grossFiat, settings });
      const mandateFields = {
        mandateRef: verdict.mandateRef, round: verdict.round,
        lanaAmountLanoshis: verdict.allowedLanoshis, lanaAmountDisplay: allowedLana,
        proposedLanaLanoshis: verdict.outcome === 'counter' ? requestedLanoshis : null,
        referenceRate: priced.referenceRate, discountPercent: priced.discountPercent, grossFiat: priced.grossFiat,
      };
      if (decision.outcome === 'decline') {
        const offer = insertOffer(handle, {
          ...base, ...mandateFields, status: 'declined', mandateCode: decision.code,
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: decision.reason,
        });
        return { kind: 'offer', offer, log: `declined (${decision.code})` };
      }
      if (decision.outcome === 'review') {
        const offer = insertOffer(handle, {
          ...base, ...mandateFields, status: 'under_review', mandateCode: decision.code,
          purchasePriceFiat: null, settlementDueAt: null, offerExpiresAt: null,
          decisionReason: decision.reason,
        });
        return { kind: 'offer', offer, log: `under review (${decision.code})` };
      }

      const offer = insertOffer(handle, {
        ...base, ...mandateFields, status: 'offered', mandateCode: verdict.code,
        purchasePriceFiat: priced.purchasePriceFiat,
        settlementDueAt: sqliteFuture(handle, `+${settings.dueDays} days`),
        offerExpiresAt: sqliteFuture(handle, `+${OFFER_VALIDITY_MINUTES} minutes`),
        decisionReason: null,
      });
      return {
        kind: 'offer', offer,
        log: `${verdict.outcome === 'counter' ? 'countered' : 'made'}: ${priced.purchasePriceFiat} ${currency} for ${allowedLana} LANA (R${verdict.round}, ${verdict.mandateRef}, ${priced.discountPercent}%)`,
      };
    });

    const result = run();
    if (result.kind === 'error') return res.status(result.status).json(result.body);
    console.log(`[lana-discount] Offer ${result.offer.offer_ref} ${result.log}`);
    return res.json({ offer: offerView(result.offer) });
  }

  // ── 1b. The seller's view of their mandate ──────────────────────────

  /**
   * Everything here is INFORMATIONAL (`nonBinding: true`). An indicative
   * figure is a projection from public parameters, not a price, not a rate,
   * not a guarantee (BEF P08 §4); only a purchase price on an accepted offer
   * binds. The date OPENS a mandate and creates no right to sell (P08 §8).
   */
  router.get('/mandate', (req: Request, res: Response) => {
    const hexId = String(req.query.hexId || '');
    const wallet = String(req.query.wallet || '');
    const currency = String(req.query.currency || '').toUpperCase();
    const lanaAmountRaw = req.query.lanaAmount === undefined ? null : Number(req.query.lanaAmount);
    if (!hexId || !wallet) return res.status(400).json({ error: 'hexId and wallet are required' });
    // A financer's mandates, remaining cap and offers are theirs to read:
    // signed by that hex (GET → empty canonical body, pathname without query).
    if (!requireSignedBy(req, res, hexId, undefined)) return;

    const handle = db();
    const currentSplit = currentSplitNumber();
    const gateFromSplit = parseGateSetting(getAppSetting(GATE_SETTING_KEY));
    const gateActive = isGateActive(gateFromSplit, currentSplit);
    const candidates = listMandatesForHex(handle, hexId)
      .filter(c => c.wallets.some(w => sameAddress(w.address, wallet)))
      .sort((a, b) => (a.split - b.split) || (a.round - b.round));
    const dTags = candidates.map(c => c.dTag);
    const released = loadReleases(handle, dTags);
    const consumed = consumedByMandate(handle, dTags);
    const totals = offerTotalsByMandate(handle, dTags);
    const termsBySplit = new Map<number, RoundTerms[]>();
    const rates = getExchangeRatesFromDb();
    const fx = currency ? rates[currency] : null;
    const t = now();

    const mandates = candidates.map(c => {
      if (!termsBySplit.has(c.split)) termsBySplit.set(c.split, loadRoundTerms(handle, c.split));
      const terms = termsBySplit.get(c.split)!.find(x => x.round === c.round);
      const remaining = remainingOf(c, consumed);
      const state = roundState({
        split: c.split, round: c.round, status: c.status, currentSplit, terms,
        released: released.has(c.dTag), remainingLanoshis: remaining, now: t,
      });
      const ref = resolveReferenceBasis({ mandateSplit: c.split, currentSplit, fx });
      const share = c.wallets.find(w => sameAddress(w.address, wallet));
      const forLanoshis = lanaAmountRaw !== null && Number.isFinite(lanaAmountRaw) && lanaAmountRaw > 0
        ? Math.min(Math.floor(lanaAmountRaw * 100_000_000), remaining)
        : remaining;
      const indicativeFor = ref && state.discountPercent !== null && forLanoshis > 0
        ? {
            lanaAmount: forLanoshis / 100_000_000,
            currency,
            fiat: Math.round((forLanoshis / 100_000_000) * ref.rate * (1 - state.discountPercent / 100) * 100) / 100,
          }
        : null;
      const tot = totals.get(c.dTag) || { proposed: 0, accepted: 0, settled: 0 };
      return {
        mandateRef: c.dTag,
        eventId: c.eventId,
        split: c.split,
        round: c.round,
        state: state.state,
        opensAt: state.opensAt === null ? null : new Date(state.opensAt * 1000).toISOString(),
        discountPercent: state.discountPercent,
        released: released.has(c.dTag),
        inWindow: mandateInWindow(c.split, currentSplit),
        walletCurrency: share?.currency ?? null,
        walletShareLana: share ? share.lanaLanoshis / 100_000_000 : null,
        expectedLana: c.lanaReceivedLanoshis / 100_000_000,
        remainingLana: remaining / 100_000_000,
        proposedLana: tot.proposed / 100_000_000,
        acceptedLana: tot.accepted / 100_000_000,
        settledLana: tot.settled / 100_000_000,
        basis: ref?.basis ?? null,
        referenceRate: ref?.rate ?? null,
        indicativeFor,
      };
    });

    return res.json({
      nonBinding: true,
      note: 'Indicative figures are projections, not a price, rate or guarantee. Only a Purchase Price accepted on lana.discount binds (BEF P08 §4).',
      gateActive,
      currentSplit,
      mandates,
    });
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

    // Accepting a mandate-bound offer is the financer's contract moment and
    // consumes their cap; it must carry their signature. Legacy offers are
    // left as they are so today's UI keeps working.
    if (isMandateBound(offer) && !requireSignedBy(req, res, hexId, req.body)) return;

    // The accepted price is the price at the live reference, always. If the
    // reference moved while the offer stood, the offer no longer describes a
    // price we would make now — it lapses and the seller proposes again.
    //
    // PHASE A: only for mandate-bound offers. The UI that exists today does
    // not know the 409 REFERENCE_MOVED answer and would show a legacy seller
    // a dead end. PHASE B (round-aware UI shipped): drop the isMandateBound
    // condition so every offer is re-priced at the live reference on
    // acceptance — the rule is right for all of them; only the UI is not
    // ready for it yet.
    if (isMandateBound(offer) && offer.status === 'offered' && offer.reference_rate !== null) {
      const live = getExchangeRatesFromDb()[offer.currency];
      if (live !== offer.reference_rate) {
        markExpiredWithReason(db(), ref, `Reference price moved from ${offer.reference_rate} to ${live ?? 'none'} before acceptance.`);
        return res.status(409).json({
          error: 'The reference price changed while this offer stood, so it has lapsed. Please submit a new proposal.',
          code: 'REFERENCE_MOVED', status: 'expired',
        });
      }
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
    const ref = String(req.params.ref);
    // Withdrawing a mandate-bound offer frees the financer's cap for the next
    // proposal — a lever only the financer may pull, so it is signed. A
    // wrong hex falls through to markWithdrawn and gets the same 409 as ever.
    const offer = getOfferByRef(db(), ref);
    if (offer && offer.user_hex_id.toLowerCase() === hexId.toLowerCase() && isMandateBound(offer)) {
      if (!requireSignedBy(req, res, hexId, req.body)) return;
    }
    const ok = markWithdrawn(db(), ref, hexId);
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
      let emptyWallet = !!req.body?.emptyWallet;
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
      const eligibility = await checkSellerEligibility(hexId, offer.sender_wallet_id, eligibilityDeps());
      if (!eligibility.ok) {
        return res.status(eligibility.httpStatus || 403).json({
          error: eligibility.error, code: eligibility.code, ...(eligibility.detail || {}),
        });
      }

      // A mandate-bound amount is the amount. A counteroffer was made for
      // the remaining mandate precisely because the wallet holds more, so
      // "empty the wallet" would move LANA we did not agree to buy; and even
      // an accepted-as-is amount may only empty a wallet that holds little
      // more than it (dust: three network fees plus the balance rounding).
      if (offer.proposed_lana_lanoshis !== null && offer.proposed_lana_lanoshis !== undefined) {
        emptyWallet = false;
      } else if (offer.mandate_ref && emptyWallet) {
        // Fail closed on BOTH roads: a throw, and an answer that does not
        // verifiably state this wallet's balance (see verifiedBalanceLanoshis).
        let balanceLanoshis: number | null = null;
        try {
          const balances = await fetchBatchBalances(getElectrumServersFromDb(), [offer.sender_wallet_id]);
          balanceLanoshis = verifiedBalanceLanoshis(balances, offer.sender_wallet_id);
        } catch (err: any) {
          console.warn('[lana-discount] Balance check before transfer failed:', err.message);
        }
        if (balanceLanoshis === null) {
          return res.status(503).json({
            error: 'The wallet balance could not be read right now. Please try again shortly.',
            code: 'BALANCE_UNVERIFIABLE',
          });
        }
        if (balanceLanoshis - offer.lana_amount_lanoshis > EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS + BALANCE_ROUNDING_LANOSHIS) {
          return res.status(409).json({
            error: 'This wallet holds more than the amount the treasury agreed to acquire, so it cannot be emptied into this acquisition. Transfer the agreed amount only.',
            code: 'EMPTY_WALLET_EXCEEDS_MANDATE',
          });
        }
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
        emptyWallet,
      });
    } catch (err: any) {
      console.error('[lana-discount] Transfer failed:', err.message);
      return res.status(500).json({ error: 'Could not complete this acquisition right now.' });
    }
  });

  // ── 4. Admin: the review queue ──────────────────────────────────────

  router.get('/admin/queue', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
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
   *
   * An offer that carries a round is priced at THAT round's discount and
   * re-checked against what is left of its mandate: the admin's acceptance
   * is not a way around the cap.
   */
  router.post('/admin/:ref/decide', (req: Request, res: Response) => {
    const adminHex = requireAdmin(req, res);
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
      let roundDiscount: number | undefined;
      if (offer.mandate_ref && offer.round !== null && offer.round !== undefined) {
        const mandateRow = db().prepare('SELECT * FROM acquisition_mandates WHERE d_tag = ?').get(offer.mandate_ref) as any;
        if (!mandateRow) return res.status(409).json({ error: 'The mandate this offer drew on is no longer known.', code: 'NO_MANDATE' });
        const mandate: MandateCandidate = rowToCandidate(mandateRow);
        const terms = loadRoundTerms(db(), mandate.split).find(t => t.round === offer.round);
        if (!terms || terms.discountPercent === null) {
          return res.status(400).json({ error: `No discount is set for round ${offer.round} of Split ${mandate.split}.`, code: 'TERMS_MISSING' });
        }
        roundDiscount = terms.discountPercent;
        const remaining = remainingOf(mandate, consumedByMandate(db(), [mandate.dTag]));
        if (offer.lana_amount_lanoshis > remaining) {
          return res.status(409).json({
            error: `Only ${remaining / 100_000_000} LANA remain on this mandate.`, code: 'MANDATE_EXHAUSTED',
            remainingLana: remaining / 100_000_000,
          });
        }
      }

      const priced = price(offer.lana_amount_display, offer.currency, offer.wallet_class as WalletClass, roundDiscount);
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

  /**
   * Void an accepted offer whose transfer never came. The sweeper does this
   * by itself after ACCEPTED_TRANSFER_WINDOW_HOURS; an admin may do it
   * sooner, with a reason. Only `accepted` + no transaction — a transferred
   * offer is a sale and cannot be voided here or anywhere (409).
   */
  router.post('/admin/:ref/void', (req: Request, res: Response) => {
    const adminHex = requireAdmin(req, res);
    if (!adminHex) return;
    const ref = String(req.params.ref);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to void an accepted offer.' });

    const offer = getOfferByRef(db(), ref);
    if (!offer) return res.status(404).json({ error: 'No such acquisition offer.' });
    if (!markVoidedByAdmin(db(), ref, reason, adminHex)) {
      const fresh = getOfferByRef(db(), ref)!;
      return res.status(409).json({
        error: fresh.transaction_id !== null
          ? 'This acquisition was transferred and cannot be voided.'
          : 'Only an accepted offer without a transfer can be voided.',
        code: fresh.transaction_id !== null ? 'ALREADY_SETTLED' : 'NOT_VOIDABLE',
        status: fresh.status,
      });
    }
    console.log(`[lana-discount] Offer ${ref} voided by ${adminHex.slice(0, 12)}…: ${reason}`);
    return res.json({ offer: offerView(getOfferByRef(db(), ref)!) });
  });

  return router;
}
