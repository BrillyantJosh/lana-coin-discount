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
 * TWO PATHS THROUGH /offers, chosen by the wallet class:
 *
 *   other    non-financer wallets — class-based discount, per-currency
 *            mandate settings, as before.
 *   mandate  every LanaPays.Us wallet (the owner retired the uncapped
 *            path on 2026-09-04: rounds are the only way): the
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
  minimumFiatFor, belowMinimum, proposalTooSmall, smallestProposableLana,
} from '../lib/acquisitionMinimum.js';
import { decideTransferShape } from '../lib/transferShape.js';
import {
  getAppSetting, getAllAppSettings, getRelaysFromDb, getTrustedSignersFromDb,
  getSplitFromDb, getElectrumServersFromDb, getExchangeRatesFromDb,
  insertBuybackTransaction, getDbHandle,
} from '../db/index.js';
import {
  decideAcquisition, readMandateSettings, CLASS_LABELS, type WalletClass,
} from '../lib/treasuryMandate.js';
import {
  generateOfferRef, insertOffer, getOfferByRef, sqliteFuture, markOffered,
  markDeclined, markAccepted, markSettled, markWithdrawn, listOffersForReview,
  listOffersForUser, assertTransferable, consumedByMandate, markExpiredWithReason,
  offerTotalsByMandate, markVoidedByAdmin, OFFER_VALIDITY_MINUTES, MANUAL_OFFER_VALIDITY_DAYS,
  sellerDecisionReason, sellerActionDeadline, ACCEPTED_TRANSFER_WINDOW_HOURS,
  type OfferRow,
} from '../lib/acquisitionOffer.js';
import { activeRestriction, restrictionReason, RESTRICTED_CODE } from '../lib/acquisitionRestriction.js';
import { checkSellerEligibility as realCheckSellerEligibility } from '../lib/sellerEligibility.js';
import { sendLanaTransaction as realSendLanaTransaction } from '../lib/transaction.js';
import { fetchUserWallets as realFetchUserWallets } from '../lib/nostr.js';
import { fetchBatchBalances as realFetchBatchBalances, type WalletBalance } from '../lib/electrum.js';
import { verifyBacking, isBacked } from '../lib/acquisitionBacking.js';
import { requireAdmin } from '../lib/adminAuth.js';
import { lanapaysOnlyEnabled, LANAPAYS_ONLY_KEY } from '../lib/acquisitionScope.js';
import { verifyRequestSignature, type ReplayCache } from '../lib/requestSignature.js';
import {
  evaluateRoundMandate, roundState, remainingOf,
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
 * How wrong a balance READ FROM THE 2dp DISPLAY FIGURE can be.
 *
 * fetchBatchBalances answers in LANA rounded to two decimals, i.e. to the
 * nearest 1,000,000 lanoshis, so a figure reconstructed from it is accurate to
 * half of that either way. Since 10 Sept 2026 the exact chain integer is
 * carried alongside (WalletBalance.balanceLanoshis) and this slack is added
 * ONLY when it is missing — see BalanceReading.exact. A rounded figure that is
 * treated as exact refuses honest transfers for a rounding artefact; an exact
 * figure padded with this slack lets 0.005 LANA past a mandate for nothing.
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
export interface BalanceReading {
  lanoshis: number;
  /**
   * True when this came from the chain's own integer, false when it was
   * reconstructed from the 2dp display figure and is therefore only accurate
   * to half a rounding step (BALANCE_ROUNDING_LANOSHIS). Anything that gates
   * money — a sweep ceiling, a repeat-refusal fingerprint — must widen its
   * tolerance or decline to decide when this is false.
   */
  exact: boolean;
}

export function verifiedBalanceReading(
  balances: WalletBalance[] | null | undefined,
  wallet: string,
): BalanceReading | null {
  if (!Array.isArray(balances)) return null;
  const entry = balances.find(b => b && sameAddress(String(b.wallet_id || ''), wallet));
  if (!entry) return null;
  if (entry.error) return null;
  // The exact integer the chain gave, when the server carried it through.
  const exact = (entry as WalletBalance).balanceLanoshis;
  if (typeof exact === 'number' && Number.isFinite(exact)) {
    return { lanoshis: Math.round(exact), exact: true };
  }
  if (typeof entry.balance !== 'number' || !Number.isFinite(entry.balance)) return null;
  return { lanoshis: Math.round(entry.balance * 100_000_000), exact: false };
}

/** The same reading as a plain number, for the displays that only want one. */
export function verifiedBalanceLanoshis(balances: WalletBalance[] | null | undefined, wallet: string): number | null {
  const reading = verifiedBalanceReading(balances, wallet);
  return reading === null ? null : reading.lanoshis;
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
   * What the chain says this wallet holds, or null when that cannot be
   * established. Every commitment goes through here first: a proposal for LANA
   * the wallet does not hold is a promise nobody can keep, and until 9 Sept
   * 2026 the only thing that noticed was the network, at the very end.
   */
  const readBalance = async (wallet: string): Promise<BalanceReading | null> => {
    try {
      const balances = await fetchBatchBalances(getElectrumServersFromDb(), [wallet]);
      return verifiedBalanceReading(balances, wallet);
    } catch (err: any) {
      console.warn('[lana-discount] Balance read failed for', wallet, err?.message || err);
      return null;
    }
  };

  const readBalanceLanoshis = async (wallet: string): Promise<number | null> => {
    const reading = await readBalance(wallet);
    return reading === null ? null : reading.lanoshis;
  };

  /** Answers the request itself when the wallet cannot back the amount. */
  const refuseUnbacked = async (res: Response, wallet: string, lanoshis: number): Promise<boolean> => {
    const verdict = verifyBacking(await readBalanceLanoshis(wallet), lanoshis);
    if (verdict.ok) return false;
    const { status, ...body } = verdict as any;
    res.status(status).json(body);
    return true;
  };

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
      // The deadline for what the SELLER must do next, worked out here so no
      // page has to know which sweep applies to which row.
      actionDueAt: sellerActionDeadline(o),
      // Only where something actually wrote it AT the transition into the
      // status this row is in now. A verdict written when the proposal was
      // submitted is not a description of a live purchase offer, nor of a
      // proposal its own seller later withdrew, and shipping it made both
      // contradict their own badge. The column itself is untouched — see
      // sellerDecisionReason.
      decisionReason: sellerDecisionReason(o),
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
    // Read on every call, not captured once at start-up: an admin turning the
    // switch has to take effect on the next offer, not the next deploy.
    lanapaysOnly: lanapaysOnlyEnabled(getAllAppSettings()[LANAPAYS_ONLY_KEY]),
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

      // The wallet must actually hold what is being offered. Checked here, for
      // BOTH paths, so an unbacked proposal never reaches a mandate cap, a
      // treasury review queue or an obligation.
      if (await refuseUnbacked(res, senderAddress, Math.floor(lanaAmount * 100_000_000))) return;

      const walletClass = eligibility.walletClass!;
      if (walletClass === 'lanapays') {
        return await proposeUnderMandate(req, res, {
          hexId, senderAddress, lanaAmount, currency, eligibility: eligibility.evidence || null,
        });
      }

      // ── other wallets — class-based mandate settings, unchanged ──
      const priced = price(lanaAmount, currency, walletClass);
      if (!priced) return res.status(400).json({ error: `No reference price for ${currency}` });

      const minSell = minimumFiatFor(getAllAppSettings(), currency);
      if (belowMinimum(priced.grossFiat, minSell)) {
        return res.status(400).json({ error: `Minimum acquisition value is ${minSell} ${currency}` });
      }

      // ── the treasury's own decision ──────────────────────────────
      // Judged on the PURCHASE PRICE, not the reference gross: the ceiling in
      // the settings screen is money we commit, and it is the price — never
      // the gross — that the admin typed a limit for and the seller is quoted.
      const settings = readMandateSettings(getAllAppSettings(), currency, walletClass);
      const decided = decideAcquisition({
        walletClass,
        currency,
        purchasePriceFiat: priced.purchasePriceFiat,
        settings,
      });
      // Restriction withholds the automatic yes and only that: a decline keeps
      // its own reason, and a proposal already heading for review is left
      // exactly where it was going.
      const restriction = activeRestriction(db(), hexId);
      const mandate = restriction && decided.outcome === 'accept'
        ? { outcome: 'review' as const, code: RESTRICTED_CODE, reason: restrictionReason(restriction.reason) }
        : decided;

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
        console.log(`[lana-discount] Offer ${offerRef} under review (${mandate.code}) — ${priced.purchasePriceFiat} ${currency} (gross ${priced.grossFiat})`);
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
      const restriction = activeRestriction(handle, hexId);
      const verdict = evaluateRoundMandate({
        currentSplit,
        hexId, wallet: senderAddress, requestedLanoshis,
        candidates, terms,
        released: loadReleases(handle, dTags),
        consumed: consumedByMandate(handle, dTags),
        now: now(),
        restricted: restriction ? { reason: restriction.reason } : null,
        // So a round holding less than we may acquire is stepped over rather
        // than chosen and then refused — which left every round behind it
        // unreachable. Same two numbers the BELOW_MINIMUM refusal is made of.
        liveRate: getExchangeRatesFromDb()[currency] ?? null,
        minimumFiat: minimumFiatFor(getAllAppSettings(), currency),
      });
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
        // IN QUEUE — a person looks. A proposal parked by RESTRICTED keeps the
        // mandate the rules had already found for it, so the decide endpoint
        // re-prices it at that round's discount and re-checks its remaining
        // cap. NO_MANDATE has no such binding and falls back to the class
        // discount as a reference only.
        const offer = insertOffer(handle, {
          ...base, status: 'under_review', mandateCode: verdict.code,
          mandateRef: verdict.mandateRef ?? null,
          round: verdict.round ?? null,
          discountPercent: verdict.discountPercent ?? legacyPriced?.discountPercent ?? null,
          lanaAmountLanoshis: verdict.allowedLanoshis ?? requestedLanoshis,
          lanaAmountDisplay: (verdict.allowedLanoshis ?? requestedLanoshis) / 100_000_000,
          proposedLanaLanoshis: verdict.allowedLanoshis !== undefined && verdict.allowedLanoshis !== requestedLanoshis
            ? requestedLanoshis : null,
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

      const minSell = minimumFiatFor(getAllAppSettings(), currency);
      if (belowMinimum(priced.grossFiat, minSell)) {
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
      //
      // What is weighed against the cap is `purchasePriceFiat`, and on this
      // path that is already the right number twice over: it is priced at the
      // ROUND's discount, and it is priced on `allowedLana` — so a counter,
      // where we take min(requested, remaining), is judged on the cheque we
      // would write, not on the larger amount the seller asked for.
      const settings = readMandateSettings(getAllAppSettings(), currency, 'lanapays');
      const decision = decideAcquisition({ walletClass: 'lanapays', currency, purchasePriceFiat: priced.purchasePriceFiat, settings });
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
    // WHAT THE PAGE MAY INVITE. The same number the two refusals above compare
    // against, asked here so the invitation and the refusal cannot disagree:
    // a completed sale left 0.73 LANA in a round and the page offered to
    // propose it, which could only ever have been refused (11 Sept 2026).
    const minimumFiat = currency ? minimumFiatFor(getAllAppSettings(), currency) : 0;

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
        minimumFiat: minimumFiat > 0 ? minimumFiat : null,
        /**
         * True when everything left in this round is too small to be acquired.
         *
         * Priced on `fx` — the LIVE rate — and NOT on `ref.rate`, which can be
         * the projected next-Split reference, i.e. twice it. The refusal always
         * prices on the live rate, so the invitation must too; using the
         * reference here would put the bar in a different place from the
         * refusal, which is the one thing this must never do.
         */
        belowMinimum: proposalTooSmall(remaining / 100_000_000, fx ?? null, minimumFiat),
        /** Where the bar is, in LANA, for saying so. Null when it cannot be priced. */
        minimumLana: smallestProposableLana(fx ?? null, minimumFiat),
      };
    });

    return res.json({
      nonBinding: true,
      note: 'Indicative figures are projections, not a price, rate or guarantee. Only a Purchase Price accepted on lana.discount binds (BEF P08 §4).',
      currentSplit,
      mandates,
    });
  });

  // ── 2. Seller accepts our purchase offer ────────────────────────────

  router.post('/:ref/accept', async (req: Request, res: Response) => {
    const ref = String(req.params.ref);
    const hexId = String(req.body?.hexId || '');
    if (!hexId) return res.status(400).json({ error: 'Missing hexId' });

    const offer = getOfferByRef(db(), ref);
    if (!offer || offer.user_hex_id.toLowerCase() !== hexId.toLowerCase()) {
      return res.status(404).json({ error: 'No such acquisition offer.' });
    }

    // Balances move between the proposal and this moment. Accepting creates a
    // settlement obligation with a due date, so it is checked again here.
    if (await refuseUnbacked(res, offer.sender_wallet_id, offer.lana_amount_lanoshis)) return;

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
        // The CODE, not the two numbers. copy.ts already carries the sentence
        // a seller reads for this event (OFFER_ERRORS.REFERENCE_MOVED) and it
        // is deliberately number-free — a pair of reference rates on a
        // counterparty's own record is a rate history, which is the one thing
        // §4 says must never be shown. The numbers go to the log, where the
        // void endpoint below already puts its own.
        console.log(`[lana-discount] Offer ${ref} lapsed: reference moved ${offer.reference_rate} → ${live ?? 'none'} before acceptance`);
        markExpiredWithReason(db(), ref, 'REFERENCE_MOVED');
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

  /** Lanoshis in a sentence: LANA, grouped, without a false tail of zeros. */
  const lanaWords = (lanoshis: number) => (lanoshis / 100_000_000).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 8,
  });

  /**
   * A REFUSAL THAT CANNOT COME OUT DIFFERENTLY IS ONLY ISSUED ONCE.
   *
   * On 10 Sept 2026 one seller's transfer failed eight times with the same
   * sentence and wrote eight FAILED rows, because nothing anywhere knew that
   * "not enough LANA" is not the kind of answer a retry changes. Pressing the
   * button again cost another electrum round trip, another row, and another
   * identical disappointment.
   *
   * So a deterministic refusal is remembered against the offer together with
   * the balance it was decided on, and repeated instantly while that balance
   * is unchanged — no chain, no row. The moment the wallet moves (a top-up,
   * a consolidation) the memory is dropped and the seller gets a real attempt.
   * It lives in this process only, which is the right lifetime: a restart
   * costs at most one more attempt, and can never lock an offer out.
   *
   * THREE RULES KEEP IT FROM BECOMING THE PROBLEM IT SOLVES. A memory that
   * cannot see the remedy it asks for is a lock-out, not a kindness:
   *
   *   1. THE FINGERPRINT IS EXACT. It was the 2dp balance, so every wallet
   *      change under 0.01 LANA — including the ~0.002 LANA top-up the fee
   *      message asks for, and the single fee a consolidation costs — left it
   *      identical and the seller was refused with the same sentence for doing
   *      exactly what he was told. Only an exact reading is remembered; a
   *      rounded one is too coarse to notice a cure, so it is not written down
   *      at all and the seller costs us one chain call instead of a dead end.
   *   2. ONLY BALANCE-DETERMINED REFUSALS. TOO_MANY_UTXOS is about the shape
   *      of the wallet, not its size, and its own sentence tells the seller to
   *      consolidate — it is never remembered (see REMEMBERED_REFUSAL_CODES).
   *   3. IT EXPIRES. Ten minutes absorbs a burst of presses; it cannot eat a
   *      meaningful part of a 24-hour transfer window if anything above is
   *      still wrong.
   */
  type RefusalPrint = {
    lanoshis: number;
    /** 'balance' = electrum's exact integer; 'plan' = the chain's own UTXO total. */
    source: 'balance' | 'plan';
  };
  const refusedTransfers = new Map<string, { print: RefusalPrint; at: number; status: number; body: Record<string, unknown> }>();
  const REFUSAL_MEMORY = 500;
  const REFUSAL_MEMORY_TTL_SECONDS = 600;

  /**
   * The refusals whose cure IS a change in the balance, and which the print
   * above can therefore watch for. Nothing else is remembered, whatever the
   * chain layer says about retrying.
   */
  const REMEMBERED_REFUSAL_CODES = new Set(['INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS']);

  const rememberRefusal = (ref: string, print: RefusalPrint | null, status: number, body: Record<string, unknown>) => {
    if (!print) return; // no fingerprint that can see a remedy: say it again next time
    if (refusedTransfers.size >= REFUSAL_MEMORY) {
      const oldest = refusedTransfers.keys().next().value;
      if (oldest !== undefined) refusedTransfers.delete(oldest);
    }
    refusedTransfers.set(ref, { print, at: now(), status, body });
  };

  const standingRefusal = (ref: string, print: RefusalPrint | null) => {
    const remembered = refusedTransfers.get(ref);
    if (!remembered) return null;
    if (now() - remembered.at > REFUSAL_MEMORY_TTL_SECONDS) {
      refusedTransfers.delete(ref);
      return null;
    }
    if (!print) {
      // The wallet cannot be read at all. A memory taken from the chain's own
      // UTXO total is still the best thing anyone here knows, so a burst of
      // presses during an electrum outage does not become a burst of rows; a
      // memory taken from a balance reading cannot be compared, so it waits.
      return remembered.print.source === 'plan' ? remembered : null;
    }
    if (remembered.print.source !== print.source || remembered.print.lanoshis !== print.lanoshis) {
      refusedTransfers.delete(ref);
      return null;
    }
    return remembered;
  };

  router.post('/:ref/transfer', async (req: Request, res: Response) => {
    try {
      const ref = String(req.params.ref);
      const hexId = String(req.body?.hexId || '');
      const privateKey = String(req.body?.privateKey || '');
      // ADVISORY ONLY since 10 Sept 2026 — see the emptying decision below.
      const askedToEmpty = !!req.body?.emptyWallet;
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

      const agreedLanoshis = offer.lana_amount_lanoshis;

      // ONE READING OF THE WALLET, and everything below decided from it: the
      // repeat guard, whether the coins are still there, and who pays the fee.
      // Fail closed on both roads — a throw, and an answer that does not
      // verifiably state THIS wallet's balance (see verifiedBalanceLanoshis).
      const reading = await readBalance(offer.sender_wallet_id);
      const balanceLanoshis = reading === null ? null : reading.lanoshis;
      /**
       * Half a rounding step of slack, and ONLY when the reading needs it.
       * Since 10 Sept 2026 electrum's exact integer comes through, so this is
       * normally 0 — the ceiling below is then the mandate itself rather than
       * the mandate plus 0.005 LANA of guesswork.
       */
      const roundingSlack = reading?.exact ? 0 : BALANCE_ROUNDING_LANOSHIS;
      /** Only an exact reading can watch for the remedy — see the guard above. */
      const walletPrint: RefusalPrint | null = reading?.exact
        ? { lanoshis: reading.lanoshis, source: 'balance' }
        : null;

      const standing = standingRefusal(ref, walletPrint);
      if (standing) {
        console.log(`[lana-discount] Transfer for ${ref} refused again on an unchanged wallet; not attempted.`);
        return res.status(standing.status).json({ ...standing.body, repeated: true });
      }

      // THE COINS MUST STILL BE THERE. An accepted offer says what we agreed
      // to buy; it does not say the wallet still holds it. Reading that from
      // the chain here is what turns "Insufficient funds: need 326179861200
      // lanoshis" — the network's own words, at the very end, after a signed
      // transaction was built — into a sentence, before anything is signed.
      // A readable balance can only be enough or short here — the unreadable
      // case is the one above, and it is handled with the emptying decision.
      if (balanceLanoshis !== null) {
        if (!verifyBacking(balanceLanoshis, agreedLanoshis).ok) {
          const body = {
            success: false,
            error: `This wallet holds about ${lanaWords(balanceLanoshis)} LANA — less than the ${lanaWords(agreedLanoshis)} LANA this acquisition is for, so the transfer cannot be made. Nothing has moved.`,
            code: 'INSUFFICIENT_BALANCE',
            retryable: false,
          };
          rememberRefusal(ref, walletPrint, 409, body);
          console.warn(`[lana-discount] Transfer for ${ref} not attempted: wallet holds ${balanceLanoshis} of ${agreedLanoshis} lanoshis`);
          return res.status(409).json(body);
        }
      }

      // WHO DECIDES THE EMPTYING — the server, from this balance and the fee.
      //
      // The rule itself lives in lib/transferShape.ts, as a function rather
      // than as a paragraph inside a route handler. Three separate incidents
      // in two days came from two numbers that had to agree, in two places,
      // with no way to ask "is there a wallet for which NEITHER shape works?"
      // Out there it can be swept as a space — see transferInvariants.test.ts.
      const shape = decideTransferShape({
        balanceLanoshis, agreedLanoshis, askedToEmpty, roundingSlack,
      });
      if (shape.kind === 'refuse') {
        return res.status(shape.status).json({ error: shape.error, code: shape.code });
      }
      const emptyWallet = shape.emptyWallet;

      const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
      if (!buybackWalletId) return res.status(400).json({ error: 'Treasury wallet not configured' });

      const lanaAmount = offer.lana_amount_display;
      console.log(`[lana-discount] Transfer for ${ref}: ${lanaAmount} LANA ${offer.sender_wallet_id} → ${buybackWalletId}`);

      const txResult = await sendLanaTransaction({
        senderAddress: offer.sender_wallet_id,
        recipientAddress: buybackWalletId,
        // ALWAYS the agreed amount, even when sweeping: it is what the layer
        // below falls back to when the exact wallet turns out to sit above the
        // ceiling. Without it, a wallet 0.006 LANA over — one small payment
        // arriving after acceptance — was a refusal with no way round it.
        amount: lanaAmount,
        privateKey,
        emptyWallet,
        // The mandate, in exact lanoshis, for the one layer that knows the
        // exact balance. `roundingSlack` is 0 whenever the chain's own integer
        // came through, so this is normally the mandate itself.
        // ALWAYS, not only when this layer already thinks it is a sweep. Its
        // PRESENCE is what tells the chain layer that emptying this wallet is
        // within the mandate at all; that layer then decides the shape from the
        // UTXOs, which is the only place the real fee is known. Passing it only
        // on the sweep road left the ordinary road unable to fall back, and
        // that is the band OFF-2026-062 fell into.
        sweepCeilingLanoshis: shape.sweepCeilingLanoshis,
        electrumServers: getElectrumServersFromDb(),
      });
      // What the chain layer actually did, which is not always what was asked.
      const emptiedWallet = txResult.emptyWallet ?? emptyWallet;

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
        // A failed attempt belongs to the acquisition it was for. Until 10 Sept
        // 2026 only the successful row carried the reference, so eight failures
        // for one offer sat in the table as eight unattached rows.
        db().prepare('UPDATE buyback_transactions SET offer_ref = ? WHERE id = ?').run(ref, txId);
        console.error(`[lana-discount] Transfer failed for ${ref}: ${txResult.error}`);
        const body = {
          success: false,
          error: txResult.error,
          ...(txResult.code ? { code: txResult.code } : {}),
          // Both ways round, so the browser can tell "pressing again cannot
          // help" from "fix this and press again" — TOO_MANY_UTXOS is the
          // second kind and used to be dressed as the first.
          ...(typeof txResult.retryable === 'boolean' ? { retryable: txResult.retryable } : {}),
          transactionId: txId,
        };
        // Refused by arithmetic, not by luck: the same wallet and the same
        // amount give the same answer, so the next press is answered from here.
        // Only for the codes whose cure is a change in the balance — a
        // TOO_MANY_UTXOS remembered here would outlive the consolidation its
        // own sentence asks for. When electrum could not be read, the refused
        // plan carries the exact UTXO total, which is a fingerprint after all.
        const chainPrint: RefusalPrint | null = walletPrint
          ?? (typeof txResult.detail?.totalBalance === 'number'
            ? { lanoshis: txResult.detail.totalBalance, source: 'plan' }
            : null);
        if (txResult.retryable === false && txResult.code && REMEMBERED_REFUSAL_CODES.has(txResult.code)) {
          rememberRefusal(ref, chainPrint, 400, body);
        }
        return res.status(400).json(body);
      }
      refusedTransfers.delete(ref);

      // WHAT ARRIVED, BESIDE WHAT WAS AGREED. A sweep delivers the balance less
      // the fee — never more than the agreed amount and sometimes a fee's worth
      // under it — and every row recorded the agreed figure regardless, so the
      // difference was a fact about the chain that existed in no book of ours.
      const receivedLanoshis = typeof txResult.amount === 'number' ? txResult.amount : null;
      if (receivedLanoshis !== null && receivedLanoshis !== offer.lana_amount_lanoshis) {
        console.log(
          `[lana-discount] ${ref}: agreed ${offer.lana_amount_lanoshis} lanoshis, received ${receivedLanoshis} ` +
          `(${offer.lana_amount_lanoshis - receivedLanoshis} to the network fee)`,
        );
      }
      const txId = insertBuybackTransaction({
        ...commonRow,
        lana_received_lanoshis: receivedLanoshis,
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
        emptyWallet: emptiedWallet,
      });
    } catch (err: any) {
      console.error('[lana-discount] Transfer failed:', err.message);
      return res.status(500).json({ error: 'Could not complete this acquisition right now.' });
    }
  });

  // ── 4. Admin: the review queue ──────────────────────────────────────

  router.get('/admin/queue', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const queue = listOffersForReview(db());
    // What each wallet actually holds, so the operator sees an unbacked
    // proposal before deciding on it. Best effort ONLY: a display that cannot
    // read a balance says so; the decision endpoints refuse instead.
    const walletBalances = new Map<string, number | null>();
    const wallets = [...new Set(queue.map(o => o.sender_wallet_id).filter(Boolean))];
    if (wallets.length) {
      try {
        const balances = await fetchBatchBalances(getElectrumServersFromDb(), wallets);
        for (const w of wallets) walletBalances.set(w, verifiedBalanceLanoshis(balances, w));
      } catch (err: any) {
        console.warn('[lana-discount] Queue balance read failed:', err?.message || err);
      }
    }
    return res.json({ offers: queue.map(o => ({
      ...offerView(o),
      userHexId: o.user_hex_id,
      walletClass: o.wallet_class,
      grossFiat: o.gross_fiat,
      indicativePrice: o.gross_fiat !== null && o.discount_percent !== null
        ? Math.round((o.gross_fiat - o.gross_fiat * o.discount_percent / 100) * 100) / 100
        : null,
      mandateCode: o.mandate_code,
      // null = could not be read just now, which is not the same as empty.
      walletLana: walletBalances.get(o.sender_wallet_id) === null || walletBalances.get(o.sender_wallet_id) === undefined
        ? null
        : (walletBalances.get(o.sender_wallet_id) as number) / 100_000_000,
      backed: walletBalances.has(o.sender_wallet_id)
        ? isBacked(walletBalances.get(o.sender_wallet_id) as number | null, o.lana_amount_lanoshis)
        : null,
    })) });
  });

  // ── 4b. Admin: what we have accepted and not yet bought ─────────────

  /**
   * Every timestamp in `acquisition_offers` is written by SQLite's own
   * `datetime()` — or by sqlitePlusHours, deliberately in the same shape —
   * as `YYYY-MM-DD HH:MM:SS` in UTC, a format whose lexical order IS its
   * chronological order. assertTransferable already compares the offer window
   * that way. Anything not of that shape is left out of the comparison rather
   * than parsed into a guess.
   */
  const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const comparableTs = (t: string | null | undefined): string | null =>
    t && SQLITE_UTC.test(t) ? t : null;

  /**
   * WHAT THE TREASURY HAS AGREED TO BUY AND HAS NOT YET BOUGHT.
   *
   * Every row here is a contract: the seller accepted our purchase price, and
   * the LANA has not arrived. These are the only offers with TWO live clocks,
   * which is the whole reason this is its own screen:
   *
   *   transferDueAt    the SELLER's window. Runs out and the deal evaporates:
   *                    expireStaleOffers voids a mandate-bound row
   *                    ACCEPTED_TRANSFER_WINDOW_HOURS after acceptance and
   *                    hands the cap back to the financer.
   *   settlementDueAt  OUR obligation. Runs out and we are late paying — the
   *                    date written onto the offer when it was made, from
   *                    `due_days` (15 by default).
   *
   * They mean opposite things, so they are shipped as two fields under two
   * names and never as one called "expires". `nextDue` says which of the two
   * is nearer; it is computed here because the rule for the seller's horizon
   * (sellerActionDeadline: mandate-bound rows are swept, legacy ones are not)
   * lives on this side and no browser should hold a second opinion about it.
   *
   * Where this page ENDS is as load-bearing as what it shows. The moment the
   * transfer lands the offer becomes a sale, and what we owe on it is tracked
   * against payouts (`remaining` on /admin/payouts) rather than here. So
   * `totals` is what is owed on accepted offers, not what the treasury owes
   * altogether; `stillWithSellers` names the money one step earlier — priced,
   * sent, not yet answered; and `lapsed` names what is on the list but owed to
   * nobody. Three separate figures because they are three different promises,
   * and one number spanning them would be true of none of them.
   */
  router.get('/admin/accepted', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    // `transaction_id IS NULL` is the sweeper's own guard, kept here for the
    // same reason: a row whose transfer DID happen is not waiting on anybody.
    const rows = db().prepare(`
      SELECT * FROM acquisition_offers
       WHERE status = 'accepted' AND transaction_id IS NULL
    `).all() as OfferRow[];

    // SQLite's own clock, in SQLite's own shape, so "has this window closed?"
    // is asked of the same wall clock that wrote the deadlines.
    const clock = (db().prepare(`SELECT datetime('now') AS t`).get() as any).t as string;

    const offers = rows.map(o => {
      const transferDueAt = sellerActionDeadline(o);
      const settlementDueAt = o.settlement_due_at;
      const t = comparableTs(transferDueAt);
      const s = comparableTs(settlementDueAt);
      const nextDue: 'transfer' | 'settlement' | null =
        t && s ? (t <= s ? 'transfer' : 'settlement') : t ? 'transfer' : s ? 'settlement' : null;
      return {
        offerRef: o.offer_ref,
        userHexId: o.user_hex_id,
        senderWallet: o.sender_wallet_id,
        walletClass: o.wallet_class,
        currency: o.currency,
        lanaAmount: o.lana_amount_display,
        purchasePrice: o.purchase_price_fiat,
        createdAt: o.created_at,
        acceptedAt: o.accepted_at,
        /** The seller's: transfer by this, or there is nothing to pay for. */
        transferDueAt,
        /** Ours: pay the purchase price by this. */
        settlementDueAt,
        /** Which of the two is nearer — 'transfer' | 'settlement' | null. */
        nextDue,
        nextDueAt: nextDue === 'transfer' ? transferDueAt : nextDue === 'settlement' ? settlementDueAt : null,
        /**
         * Whether the transfer window closes this row on its own. Only
         * mandate-bound rows are swept (the sweep exists to free a financer's
         * cap), so on a legacy row a passed window is not an ending — it waits
         * for a person to void it, and the screen has to be able to say so.
         */
        // Every accepted offer does now, mandate or not: the transfer window is
        // the seller's and never depended on where the offer came from.
        sweepsItself: Boolean(o.accepted_at),
        /**
         * The seller's window has already closed. assertTransferable refuses
         * such a transfer, so this row can never become a sale and the money
         * on it is NOT owed — it is a reservation nobody has released yet.
         * It stays in the list, because releasing it is the operator's job;
         * it stays out of the total, because a total that counts it says the
         * treasury owes money it does not owe.
         */
        transferLapsed: Boolean(t && t <= clock),
        round: o.round ?? null,
        mandateRef: o.mandate_ref ?? null,
      };
    }).sort((a, b) => {
      // Soonest deadline first, whichever clock it belongs to; a row with no
      // deadline at all cannot be urgent, so it goes last rather than first.
      const x = comparableTs(a.nextDueAt), y = comparableTs(b.nextDueAt);
      if (x && y && x !== y) return x < y ? -1 : 1;
      if (x && !y) return -1;
      if (!x && y) return 1;
      return a.offerRef < b.offerRef ? -1 : a.offerRef > b.offerRef ? 1 : 0;
    });

    // Per currency, because adding EUR to GBP would be a number nobody owes.
    // `unpriced` is counted rather than skipped silently: a row with no price
    // is missing from the total, and the screen must be able to say so.
    const totals: Record<string, { owed: number; lana: number; count: number; unpriced: number }> = {};
    const lapsedByCurrency: Record<string, number> = {};
    let lapsedCount = 0;
    for (const o of offers) {
      if (o.transferLapsed) {
        lapsedCount += 1;
        lapsedByCurrency[o.currency] = Math.round(
          ((lapsedByCurrency[o.currency] || 0) + (o.purchasePrice || 0)) * 100,
        ) / 100;
        continue;
      }
      const cell = totals[o.currency] || (totals[o.currency] = { owed: 0, lana: 0, count: 0, unpriced: 0 });
      cell.count += 1;
      cell.lana += o.lanaAmount || 0;
      if (o.purchasePrice === null || o.purchasePrice === undefined) cell.unpriced += 1;
      else cell.owed += o.purchasePrice;
    }
    for (const cell of Object.values(totals)) {
      cell.owed = Math.round(cell.owed * 100) / 100;
      cell.lana = Math.round(cell.lana * 100_000_000) / 100_000_000;
    }

    // One step earlier in the same pipeline: priced and sent, not yet
    // answered. Not owed — the seller may simply let it lapse — and counted
    // exactly as consumedByMandate counts a live offer, so the two agree.
    const liveOffers = db().prepare(`
      SELECT currency, COUNT(*) AS n, COALESCE(SUM(purchase_price_fiat), 0) AS fiat
        FROM acquisition_offers
       WHERE status = 'offered'
         AND offer_expires_at IS NOT NULL
         AND offer_expires_at > datetime('now')
       GROUP BY currency
    `).all() as any[];
    // The rows themselves, not only the sum of them.
    //
    // A count said "2 purchase offers are still out with sellers" and an
    // operator who remembered one of them by name could not find it anywhere:
    // /admin/offers holds what is waiting on US (under_review), this page held
    // what a seller had already accepted, and the step between the two — priced
    // by us, sent, standing for its window while the seller decides — was on no
    // screen at all. That is the largest money on the page in reach: not owed,
    // because the seller may let it lapse, but owed the moment they say yes.
    const withSellerRows = db().prepare(`
      SELECT offer_ref, user_hex_id, sender_wallet_id, currency, lana_amount_display,
             purchase_price_fiat, discount_percent, round, mandate_ref,
             created_at, decided_at, offer_expires_at
        FROM acquisition_offers
       WHERE status = 'offered'
         AND offer_expires_at IS NOT NULL
         AND offer_expires_at > datetime('now')
       ORDER BY offer_expires_at ASC
    `).all() as any[];

    const stillWithSellers = {
      count: liveOffers.reduce((n, r) => n + Number(r.n || 0), 0),
      byCurrency: Object.fromEntries(
        liveOffers.map(r => [String(r.currency), Math.round(Number(r.fiat || 0) * 100) / 100]),
      ) as Record<string, number>,
      offers: withSellerRows.map(o => ({
        offerRef: o.offer_ref,
        userHexId: o.user_hex_id,
        senderWallet: o.sender_wallet_id,
        currency: o.currency,
        lanaAmount: o.lana_amount_display,
        purchasePrice: o.purchase_price_fiat,
        discountPercent: o.discount_percent ?? null,
        round: o.round ?? null,
        mandateRef: o.mandate_ref ?? null,
        createdAt: o.created_at,
        /** When we priced it — which is when the seller's window started. */
        pricedAt: o.decided_at ?? null,
        /** Until when it stands; after this it lapses and the cap comes back. */
        standsUntil: o.offer_expires_at,
      })),
    };

    return res.json({
      offers,
      totals,
      /** Reserved by a row that can no longer complete — owed by nobody. */
      lapsed: { count: lapsedCount, byCurrency: lapsedByCurrency },
      stillWithSellers,
      /** So the screen can name the seller's window without inventing it. */
      transferWindowHours: ACCEPTED_TRANSFER_WINDOW_HOURS,
      updated_at: new Date().toISOString(),
    });
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
  router.post('/admin/:ref/decide', async (req: Request, res: Response) => {
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
      // Never make an offer for LANA the wallet cannot deliver — including the
      // rows that were taken in before this was checked at all.
      if (await refuseUnbacked(res, offer.sender_wallet_id, offer.lana_amount_lanoshis)) return;

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
        // A person decided this one, so it stands for days rather than
        // minutes: the seller is not on the page waiting for it.
        offerExpiresAt: sqliteFuture(db(), `+${MANUAL_OFFER_VALIDITY_DAYS} days`),
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
