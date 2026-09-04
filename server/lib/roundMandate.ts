/**
 * ROUND MANDATE — under which financing round, and up to how much, does the
 * treasury acquire from THIS wallet right now?
 *
 * The owner's policy (4 Sep 2026): FIFO by financing round — round 1 first,
 * then 2, then 3 — each from its own date, and within a round only up to the
 * LANA that budget actually received. That is a Treasury Acquisition Mandate
 * in the BEF-P08 §2 sense: published by LanaPays.us as KIND 30960 (one event
 * per financer × round × split), mirrored here after signature verification,
 * and enforced with OUR OWN dates, discount and split window — the event's
 * own opens_at is an echo (contract rule 5).
 *
 * Pure, like treasuryMandate.ts: no database, no clock, no relays. The route
 * hands it the rows, the terms, what is already consumed and the time, and
 * runs it INSIDE the same SQLite transaction as the offer insert — that is
 * what makes "remaining" impossible to double-spend, and it is only possible
 * because this function does no I/O of its own.
 *
 * The order of the answers is the policy, so it is fixed here and tested:
 *
 *   gate off                              → 'legacy'  (today's path, untouched)
 *   no announced mandate for this wallet  → review NO_MANDATE (IN QUEUE — a
 *                                           person looks; never auto-accept,
 *                                           never a hard refusal)
 *   mandate split not in the window       → decline SPLIT_WINDOW
 *   rounds ascending, remaining > 0:
 *     no terms / not yet open (unless released) → skip
 *     first open                          → accept (≤ remaining) or counter
 *                                           (= remaining, P08 §2 counteroffer)
 *   none open                             → decline TERMS_MISSING or
 *                                           MANDATE_NOT_OPEN (with the date)
 *   every round exhausted                 → decline FULLY_ACQUIRED
 *
 * A date OPENS a mandate; it creates no right to sell (P08 §8, P14 §8).
 */
import { BUYBACK_SPLIT_OFFSET } from './buybackSplit.js';

export interface MandateWallet {
  address: string;
  currency: string;
  lanaLanoshis: number;
  fundSettingId: string;
}

/** One mirrored KIND 30960 row, as stored in acquisition_mandates. */
export interface MandateCandidate {
  dTag: string;
  eventId: string;
  split: number;
  round: number;
  financerHex: string;
  wallets: MandateWallet[];
  lanaReceivedLanoshis: number;
  status: 'announced' | 'closed';
}

/** The admin's terms for one round of one split (acquisition_rounds). */
export interface RoundTerms {
  round: number;
  /** Unix seconds; null = no date set = closed. */
  opensAt: number | null;
  /** Percent under the reference; null = not set = cannot price. */
  discountPercent: number | null;
}

export type RoundDeclineCode = 'SPLIT_WINDOW' | 'TERMS_MISSING' | 'MANDATE_NOT_OPEN' | 'FULLY_ACQUIRED';

export type RoundMandateVerdict =
  | 'legacy'
  | { outcome: 'review'; code: 'NO_MANDATE'; reason: string }
  | { outcome: 'decline'; code: RoundDeclineCode; reason: string; opensAt?: number; mandateRef?: string; round?: number }
  | {
      outcome: 'accept' | 'counter';
      code: 'WITHIN_MANDATE' | 'COUNTER_MANDATE_CAP';
      mandateRef: string;
      round: number;
      split: number;
      discountPercent: number;
      /** What we will actually offer to acquire, in lanoshis. */
      allowedLanoshis: number;
      /** What was left on this mandate BEFORE this proposal. */
      remainingLanoshis: number;
      released: boolean;
    };

export interface EvaluateRoundMandateInput {
  /** Parsed acq_round_mandates_from_split; null = gate off. */
  gateFromSplit: number | null;
  currentSplit: number | null;
  hexId: string;
  wallet: string;
  requestedLanoshis: number;
  /** Every mirrored mandate row of this hex (any status; filtered here). */
  candidates: MandateCandidate[];
  /** Terms for the MANDATE split (acquisition_rounds WHERE split = mandate.split). */
  terms: RoundTerms[];
  /** d tags an admin has released ahead of their date. */
  released: Set<string>;
  /** d tag → lanoshis already consumed by live offers (consumedByMandate). */
  consumed: Map<string, number>;
  /** Unix seconds. */
  now: number;
}

/** '' or missing = off; anything that is not a positive integer = off (cautious end). */
export function parseGateSetting(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function isGateActive(gateFromSplit: number | null, currentSplit: number | null): boolean {
  return gateFromSplit !== null && currentSplit !== null && currentSplit >= gateFromSplit;
}

/** Is the mandate's split the one the buyback window is about right now? */
export function mandateInWindow(mandateSplit: number, currentSplit: number | null): boolean {
  return currentSplit !== null && mandateSplit + BUYBACK_SPLIT_OFFSET === currentSplit;
}

export function remainingOf(c: MandateCandidate, consumed: Map<string, number>): number {
  return Math.max(0, c.lanaReceivedLanoshis - (consumed.get(c.dTag) || 0));
}

const sameAddress = (a: string, b: string) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const fmtDate = (unix: number) => new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

export function evaluateRoundMandate(input: EvaluateRoundMandateInput): RoundMandateVerdict {
  if (!isGateActive(input.gateFromSplit, input.currentSplit)) return 'legacy';

  const hex = String(input.hexId || '').toLowerCase();
  const mine = input.candidates.filter(c =>
    c.status === 'announced' &&
    String(c.financerHex || '').toLowerCase() === hex &&
    c.wallets.some(w => sameAddress(w.address, input.wallet)),
  );
  if (mine.length === 0) {
    return {
      outcome: 'review', code: 'NO_MANDATE',
      reason: 'No published financing-round mandate names this wallet, so this proposal is under treasury review.',
    };
  }

  // Window before dates, and before releases: a release opens a round early,
  // it never moves a mandate into a split it was not published for.
  const inWindow = mine.filter(c => mandateInWindow(c.split, input.currentSplit));
  if (inWindow.length === 0) {
    const splits = [...new Set(mine.map(c => c.split))].sort((a, b) => a - b);
    const s = splits[0];
    const current = input.currentSplit as number;
    return {
      outcome: 'decline', code: 'SPLIT_WINDOW',
      reason: current <= s
        ? `This mandate is for Split ${s}, which is still running. The treasury accepts proposals under it once Split ${s + BUYBACK_SPLIT_OFFSET} has started.`
        : `This mandate was for Split ${s}; that window has passed.`,
    };
  }

  const byRound = [...inWindow].sort((a, b) => a.round - b.round);
  const termsOf = (round: number) => input.terms.find(t => t.round === round);

  let firstBlocked: { code: 'TERMS_MISSING' | 'MANDATE_NOT_OPEN'; opensAt?: number; c: MandateCandidate } | null = null;

  for (const c of byRound) {
    const remaining = remainingOf(c, input.consumed);
    if (remaining <= 0) continue;

    const terms = termsOf(c.round);
    const released = input.released.has(c.dTag);
    // A release waives the DATE, not the price: without a discount there is
    // nothing to offer, released or not.
    if (!terms || terms.discountPercent === null || !Number.isFinite(terms.discountPercent)) {
      if (!firstBlocked) firstBlocked = { code: 'TERMS_MISSING', c };
      continue;
    }
    const open = released || (terms.opensAt !== null && input.now >= terms.opensAt);
    if (!open) {
      if (!firstBlocked) {
        firstBlocked = terms.opensAt === null
          ? { code: 'TERMS_MISSING', c }
          : { code: 'MANDATE_NOT_OPEN', opensAt: terms.opensAt, c };
      }
      continue;
    }

    const base = {
      mandateRef: c.dTag, round: c.round, split: c.split,
      discountPercent: terms.discountPercent, remainingLanoshis: remaining, released,
    };
    if (input.requestedLanoshis <= remaining) {
      return { ...base, outcome: 'accept', code: 'WITHIN_MANDATE', allowedLanoshis: input.requestedLanoshis };
    }
    // Above the cap is a COUNTEROFFER for what is left (P08 §2), not a refusal.
    return { ...base, outcome: 'counter', code: 'COUNTER_MANDATE_CAP', allowedLanoshis: remaining };
  }

  if (firstBlocked) {
    const { c } = firstBlocked;
    if (firstBlocked.code === 'MANDATE_NOT_OPEN') {
      return {
        outcome: 'decline', code: 'MANDATE_NOT_OPEN', opensAt: firstBlocked.opensAt,
        mandateRef: c.dTag, round: c.round,
        reason: `The treasury accepts proposals from financing round ${c.round} from ${fmtDate(firstBlocked.opensAt!)}. Please propose again then.`,
      };
    }
    return {
      outcome: 'decline', code: 'TERMS_MISSING', mandateRef: c.dTag, round: c.round,
      reason: `The treasury has not yet published its terms for financing round ${c.round} of Split ${c.split}.`,
    };
  }

  return {
    outcome: 'decline', code: 'FULLY_ACQUIRED',
    reason: 'The treasury has already acquired the full amount this mandate covers.',
  };
}

// ─── display state ────────────────────────────────────────────────────────

export type RoundState =
  | 'closed'          // tombstoned by the publisher
  | 'split_unknown'   // we have no KIND 38888
  | 'upcoming_split'  // mandate split still running — opens after the Split
  | 'window_passed'   // more than one split behind
  | 'fully_acquired'
  | 'released'        // admin opened it ahead of the date
  | 'open'
  | 'not_open'        // date set, in the future
  | 'terms_missing';  // no date and/or no discount

export interface RoundStateView {
  state: RoundState;
  opensAt: number | null;
  discountPercent: number | null;
  remainingLanoshis: number;
}

/** The same rules as evaluateRoundMandate, phrased as one state for a screen. */
export function roundState(input: {
  split: number;
  round: number;
  status: 'announced' | 'closed';
  currentSplit: number | null;
  terms: RoundTerms | undefined;
  released: boolean;
  remainingLanoshis: number;
  now: number;
}): RoundStateView {
  const opensAt = input.terms?.opensAt ?? null;
  const discountPercent = input.terms?.discountPercent ?? null;
  const remainingLanoshis = Math.max(0, input.remainingLanoshis);
  const view = (state: RoundState): RoundStateView => ({ state, opensAt, discountPercent, remainingLanoshis });

  if (input.status === 'closed') return view('closed');
  if (input.currentSplit === null) return view('split_unknown');
  if (input.currentSplit < input.split + BUYBACK_SPLIT_OFFSET) return view('upcoming_split');
  if (input.currentSplit > input.split + BUYBACK_SPLIT_OFFSET) return view('window_passed');
  if (remainingLanoshis <= 0) return view('fully_acquired');
  if (discountPercent === null) return view('terms_missing');
  if (input.released) return view('released');
  if (opensAt === null) return view('terms_missing');
  return view(input.now >= opensAt ? 'open' : 'not_open');
}

// ─── admin terms validation ───────────────────────────────────────────────

/** BEF-P08 §4 orientation band; outside it is allowed but flagged. */
export const DISCOUNT_BAND = { min: 22, max: 35 };

export interface RoundTermsInput {
  round: number;
  /** ISO-8601 or null. */
  opensAt: string | null;
  discountPercent: number | null;
}

export interface RoundTermsValidation {
  ok: boolean;
  error?: string;
  /** Non-blocking; shown to the admin, saved anyway. */
  warnings: string[];
  /** Normalised rows, ISO UTC dates. */
  rows: Array<{ round: number; opensAt: string | null; discountPercent: number | null }>;
}

export function validateRoundTerms(
  rounds: RoundTermsInput[],
  ctx: { splitEndsAt: number | null },
): RoundTermsValidation {
  const warnings: string[] = [];
  const rows: RoundTermsValidation['rows'] = [];
  const seen = new Set<number>();

  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { ok: false, error: 'rounds must be a non-empty array', warnings, rows };
  }
  for (const r of rounds) {
    const round = Number(r?.round);
    if (!Number.isInteger(round) || round < 1 || round > 3) {
      return { ok: false, error: `round must be 1, 2 or 3 (got ${String(r?.round)})`, warnings, rows };
    }
    if (seen.has(round)) return { ok: false, error: `round ${round} given twice`, warnings, rows };
    seen.add(round);

    let opensAt: string | null = null;
    if (r.opensAt !== null && r.opensAt !== undefined && String(r.opensAt).trim() !== '') {
      const ms = Date.parse(String(r.opensAt));
      if (!Number.isFinite(ms)) return { ok: false, error: `round ${round}: opensAt must be an ISO-8601 date`, warnings, rows };
      opensAt = new Date(ms).toISOString();
      if (ctx.splitEndsAt && ms / 1000 < ctx.splitEndsAt) {
        warnings.push(`Round ${round} opens before the Split ends (${new Date(ctx.splitEndsAt * 1000).toISOString()}); the window rule will keep proposals declined until the Split turns.`);
      }
    }

    let discountPercent: number | null = null;
    if (r.discountPercent !== null && r.discountPercent !== undefined && String(r.discountPercent).trim() !== '') {
      const d = Number(r.discountPercent);
      if (!Number.isFinite(d) || d < 0 || d > 100) {
        return { ok: false, error: `round ${round}: discountPercent must be between 0 and 100`, warnings, rows };
      }
      discountPercent = d;
      if (d < DISCOUNT_BAND.min || d > DISCOUNT_BAND.max) {
        warnings.push(`Round ${round} discount ${d}% is outside the ${DISCOUNT_BAND.min}–${DISCOUNT_BAND.max}% orientation band (BEF P08 §4).`);
      }
    }
    rows.push({ round, opensAt, discountPercent });
  }

  // FIFO by round means the dates must not run backwards. Checked only when
  // every date is set, so an admin can fill the form one round at a time.
  const sorted = [...rows].sort((a, b) => a.round - b.round);
  if (sorted.every(r => r.opensAt !== null)) {
    for (let i = 1; i < sorted.length; i++) {
      if (Date.parse(sorted[i].opensAt!) < Date.parse(sorted[i - 1].opensAt!)) {
        return {
          ok: false, warnings, rows,
          error: `round ${sorted[i].round} opens before round ${sorted[i - 1].round}; rounds open in order 1, 2, 3`,
        };
      }
    }
  }
  return { ok: true, warnings, rows: sorted };
}

/**
 * The client estimates its network fee as (1 input + 1 output) × 1.5 —
 * src/pages/SubmitOffer.tsx — and treats an offer covering "balance minus
 * three fees" as an emptying one. The transfer guard uses the same three
 * fees as the dust it will tolerate above a mandate-bound amount.
 */
export const ESTIMATED_FEE_LANOSHIS = Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5);
export const EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS = 3 * ESTIMATED_FEE_LANOSHIS;
