// @vitest-environment node
/**
 * FIFO BY ROUND, FROM THE DATE, UP TO WHAT THE BUDGET RECEIVED — and every
 * way the answer must be "not now".
 *
 * The gate can open a treasury cap, so most of this file is about the
 * refusals and about the exact meaning of a date: it OPENS a round at the
 * second it names (>= — the mutation to > must fail here), a release waives
 * the date and nothing else, and a mandate whose split is still running is
 * closed however far in the past its date lies.
 *
 * The last block drives consumedByMandate against real SQLite, because the
 * cap is only as good as the definition of "already spoken for".
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRoundMandate, roundState, validateRoundTerms, parseGateSetting, isGateActive,
  ESTIMATED_FEE_LANOSHIS, EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS,
  type MandateCandidate, type RoundTerms, type EvaluateRoundMandateInput,
} from './roundMandate';
import { consumedByMandate, insertOffer, sqliteFuture, type NewOffer } from './acquisitionOffer';
import { createMandateTestDb } from './roundMandateTestKit';

const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const W1 = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const W2 = 'LdY5W1Qm6xXoTmr3hjCkGyeJ7YqTx6Zv4t';
const LANA = 100_000_000;
const NOW = 1_757_800_000; // 2026-09-14 ~ 00:00 UTC

const mandate = (over: Partial<MandateCandidate> = {}): MandateCandidate => ({
  dTag: `8:1:${HEX}`, eventId: 'e'.repeat(64), split: 8, round: 1, financerHex: HEX,
  wallets: [{ address: W1, currency: 'EUR', lanaLanoshis: 1000 * LANA, fundSettingId: '52' }],
  lanaReceivedLanoshis: 1000 * LANA, status: 'announced', ...over,
});
const r2 = (over: Partial<MandateCandidate> = {}) => mandate({
  dTag: `8:2:${HEX}`, round: 2,
  wallets: [{ address: W1, currency: 'EUR', lanaLanoshis: 500 * LANA, fundSettingId: '61' }],
  lanaReceivedLanoshis: 500 * LANA, ...over,
});

const open = (round: number, discount = 22, opensAt = NOW - 3600): RoundTerms => ({ round, opensAt, discountPercent: discount });

const input = (over: Partial<EvaluateRoundMandateInput> = {}): EvaluateRoundMandateInput => ({
  gateFromSplit: 9, currentSplit: 9, hexId: HEX, wallet: W1, requestedLanoshis: 100 * LANA,
  candidates: [mandate()], terms: [open(1)], released: new Set(), consumed: new Map(), now: NOW, ...over,
});

const decided = (v: ReturnType<typeof evaluateRoundMandate>) => (typeof v === 'string' ? { outcome: v } : v) as any;

describe('the gate', () => {
  it("'' or missing means off → legacy path, whatever else is true", () => {
    expect(parseGateSetting('')).toBeNull();
    expect(parseGateSetting(null)).toBeNull();
    expect(parseGateSetting('abc')).toBeNull();
    expect(parseGateSetting('0')).toBeNull();
    expect(parseGateSetting('9')).toBe(9);
    expect(evaluateRoundMandate(input({ gateFromSplit: null }))).toBe('legacy');
  });

  it('a gate set for split 9 stays legacy during split 8 and turns on by itself at 9', () => {
    expect(isGateActive(9, 8)).toBe(false);
    expect(isGateActive(9, 9)).toBe(true);
    expect(isGateActive(9, 10)).toBe(true);
    expect(isGateActive(9, null)).toBe(false);
    expect(evaluateRoundMandate(input({ currentSplit: 8 }))).toBe('legacy');
  });
});

describe('no mandate → a person looks (IN QUEUE), never an automatic yes or a hard no', () => {
  it('a wallet no announced event names', () => {
    const v = decided(evaluateRoundMandate(input({ wallet: W2 })));
    expect(v.outcome).toBe('review');
    expect(v.code).toBe('NO_MANDATE');
  });

  it("another financer's mandate does not count for this hex", () => {
    const v = decided(evaluateRoundMandate(input({ hexId: OTHER_HEX })));
    expect(v.code).toBe('NO_MANDATE');
  });

  it('a closed (tombstoned) mandate is no mandate', () => {
    const v = decided(evaluateRoundMandate(input({ candidates: [mandate({ status: 'closed', wallets: [] })] })));
    expect(v.code).toBe('NO_MANDATE');
  });

  it('wallet addresses match case-insensitively (QR scans, relay tags)', () => {
    const v = decided(evaluateRoundMandate(input({ wallet: W1.toLowerCase() })));
    expect(v.outcome).toBe('accept');
  });
});

describe('the split window — the same one-split rule the wallet gate enforces', () => {
  it('a past date does NOT open a mandate whose split is still running', () => {
    const v = decided(evaluateRoundMandate(input({ gateFromSplit: 8, currentSplit: 8, terms: [open(1, 22, NOW - 86400 * 30)] })));
    expect(v.outcome).toBe('decline');
    expect(v.code).toBe('SPLIT_WINDOW');
    expect(v.reason).toMatch(/still running/);
  });

  it('a release does not move a mandate into a split it was not published for', () => {
    const v = decided(evaluateRoundMandate(input({
      gateFromSplit: 8, currentSplit: 8, released: new Set([`8:1:${HEX}`]),
    })));
    expect(v.code).toBe('SPLIT_WINDOW');
  });

  it('two splits on, the window has passed', () => {
    const v = decided(evaluateRoundMandate(input({ currentSplit: 10 })));
    expect(v.code).toBe('SPLIT_WINDOW');
    expect(v.reason).toMatch(/passed/);
  });
});

describe('dates and terms', () => {
  it('opens EXACTLY at opensAt — one second before is closed, the second itself is open', () => {
    const t = [open(1, 22, NOW)];
    const before = decided(evaluateRoundMandate(input({ terms: t, now: NOW - 1 })));
    expect(before.code).toBe('MANDATE_NOT_OPEN');
    expect(before.opensAt).toBe(NOW);
    const at = decided(evaluateRoundMandate(input({ terms: t, now: NOW })));
    expect(at.outcome).toBe('accept');
  });

  it('a decline for a future date carries that date and names the round', () => {
    const v = decided(evaluateRoundMandate(input({ terms: [open(1, 22, NOW + 86400)] })));
    expect(v.code).toBe('MANDATE_NOT_OPEN');
    expect(v.opensAt).toBe(NOW + 86400);
    expect(v.round).toBe(1);
    expect(v.mandateRef).toBe(`8:1:${HEX}`);
    expect(v.reason).toMatch(/round 1/);
  });

  it('no terms row at all → TERMS_MISSING (a missing date is a closed round)', () => {
    expect(decided(evaluateRoundMandate(input({ terms: [] }))).code).toBe('TERMS_MISSING');
  });

  it('a date without a discount is still TERMS_MISSING — nothing to price', () => {
    expect(decided(evaluateRoundMandate(input({ terms: [{ round: 1, opensAt: NOW - 1, discountPercent: null }] }))).code).toBe('TERMS_MISSING');
  });

  it('a discount without a date is TERMS_MISSING too', () => {
    expect(decided(evaluateRoundMandate(input({ terms: [{ round: 1, opensAt: null, discountPercent: 22 }] }))).code).toBe('TERMS_MISSING');
  });

  it('a release waives the date, not the window and not the discount', () => {
    const released = new Set([`8:1:${HEX}`]);
    const v = decided(evaluateRoundMandate(input({ terms: [open(1, 22, NOW + 86400)], released })));
    expect(v.outcome).toBe('accept');
    expect(v.released).toBe(true);
    // Released but no discount: still nothing to offer.
    const noDisc = decided(evaluateRoundMandate(input({ terms: [{ round: 1, opensAt: null, discountPercent: null }], released })));
    expect(noDisc.code).toBe('TERMS_MISSING');
  });
});

describe('FIFO by round, on one wallet', () => {
  const both = () => [r2(), mandate()]; // out of order on purpose

  it('round 1 before round 2 when both are open', () => {
    const v = decided(evaluateRoundMandate(input({ candidates: both(), terms: [open(1), open(2, 25)] })));
    expect(v.round).toBe(1);
    expect(v.discountPercent).toBe(22);
    expect(v.mandateRef).toBe(`8:1:${HEX}`);
  });

  it('round 1 not yet open, round 2 released → round 2, at round 2 terms', () => {
    const v = decided(evaluateRoundMandate(input({
      candidates: both(), terms: [open(1, 22, NOW + 86400), open(2, 25, NOW + 86400 * 2)],
      released: new Set([`8:2:${HEX}`]),
    })));
    expect(v.outcome).toBe('accept');
    expect(v.round).toBe(2);
    expect(v.discountPercent).toBe(25);
  });

  it('round 1 exhausted → round 2 takes over', () => {
    const v = decided(evaluateRoundMandate(input({
      candidates: both(), terms: [open(1), open(2, 25)],
      consumed: new Map([[`8:1:${HEX}`, 1000 * LANA]]),
    })));
    expect(v.round).toBe(2);
  });

  it('one offer = one mandate = one discount: a proposal is never split across rounds', () => {
    const v = decided(evaluateRoundMandate(input({
      candidates: both(), terms: [open(1), open(2, 25)], requestedLanoshis: 1200 * LANA,
    })));
    expect(v.outcome).toBe('counter');
    expect(v.round).toBe(1);
    expect(v.allowedLanoshis).toBe(1000 * LANA);
  });

  it('neither open: the message is about the FIRST round with something left', () => {
    const v = decided(evaluateRoundMandate(input({
      candidates: both(), terms: [open(1, 22, NOW + 100), open(2, 25, NOW + 200)],
    })));
    expect(v.code).toBe('MANDATE_NOT_OPEN');
    expect(v.round).toBe(1);
    expect(v.opensAt).toBe(NOW + 100);
  });

  it('round 1 exhausted and round 2 not yet open → the round 2 date', () => {
    const v = decided(evaluateRoundMandate(input({
      candidates: both(), terms: [open(1), open(2, 25, NOW + 200)],
      consumed: new Map([[`8:1:${HEX}`, 1000 * LANA]]),
    })));
    expect(v.code).toBe('MANDATE_NOT_OPEN');
    expect(v.round).toBe(2);
  });
});

describe('the cap', () => {
  it('within the remaining → accept for the amount asked', () => {
    const v = decided(evaluateRoundMandate(input({ requestedLanoshis: 999 * LANA + 1 })));
    expect(v.outcome).toBe('accept');
    expect(v.code).toBe('WITHIN_MANDATE');
    expect(v.allowedLanoshis).toBe(999 * LANA + 1);
    expect(v.remainingLanoshis).toBe(1000 * LANA);
  });

  it('exactly the remaining is still within', () => {
    expect(decided(evaluateRoundMandate(input({ requestedLanoshis: 1000 * LANA }))).outcome).toBe('accept');
  });

  it('one lanoshi over → a counteroffer for the remaining, to the lanoshi', () => {
    const v = decided(evaluateRoundMandate(input({
      requestedLanoshis: 1000 * LANA + 1, consumed: new Map([[`8:1:${HEX}`, 123_456_789]]),
    })));
    expect(v.outcome).toBe('counter');
    expect(v.code).toBe('COUNTER_MANDATE_CAP');
    expect(v.allowedLanoshis).toBe(1000 * LANA - 123_456_789);
    expect(v.remainingLanoshis).toBe(1000 * LANA - 123_456_789);
  });

  it('everything consumed → FULLY_ACQUIRED', () => {
    const v = decided(evaluateRoundMandate(input({ consumed: new Map([[`8:1:${HEX}`, 1000 * LANA]]) })));
    expect(v.outcome).toBe('decline');
    expect(v.code).toBe('FULLY_ACQUIRED');
  });

  it('over-consumed (re-allocation after acceptance) reads as zero, not negative', () => {
    const v = decided(evaluateRoundMandate(input({ consumed: new Map([[`8:1:${HEX}`, 5000 * LANA]]) })));
    expect(v.code).toBe('FULLY_ACQUIRED');
  });
});

describe('what counts as consumed (real SQLite)', () => {
  const D = `8:1:${HEX}`;
  const row = (db: any, status: NewOffer['status'], lanoshis: number, over: Partial<NewOffer> = {}): void => {
    const n = (db.prepare('SELECT COUNT(*) c FROM acquisition_offers').get() as any).c;
    insertOffer(db, {
      offerRef: `OFF-T-${n + 1}`, userHexId: HEX, senderWalletId: W1, walletClass: 'lanapays',
      lanaAmountLanoshis: lanoshis, lanaAmountDisplay: lanoshis / LANA, currency: 'EUR', status,
      referenceRate: 0.256, discountPercent: 22, purchasePriceFiat: 1, grossFiat: 1, mandateCode: 'WITHIN_MANDATE',
      eligibility: null, settlementDueAt: null,
      offerExpiresAt: status === 'offered' ? sqliteFuture(db, '+30 minutes') : null,
      decisionReason: null, mandateRef: D, round: 1, ...over,
    });
  };

  it('accepted, settled and live offered reserve; expired, declined, withdrawn, under_review do not', () => {
    const db = createMandateTestDb();
    row(db, 'accepted', 100 * LANA);
    row(db, 'settled', 200 * LANA);
    row(db, 'offered', 50 * LANA);
    row(db, 'expired', 1000 * LANA);
    row(db, 'declined', 1000 * LANA);
    row(db, 'withdrawn', 1000 * LANA);
    row(db, 'under_review', 1000 * LANA);
    expect(consumedByMandate(db, [D]).get(D)).toBe(350 * LANA);
  });

  it('an offered row whose 30 minutes are up no longer reserves, even before the sweep renames it', () => {
    const db = createMandateTestDb();
    row(db, 'offered', 50 * LANA, { offerExpiresAt: sqliteFuture(db, '-1 minute') });
    row(db, 'offered', 70 * LANA);
    expect(consumedByMandate(db, [D]).get(D)).toBe(70 * LANA);
  });

  it('a counteroffer reserves what WE offered, not what the seller asked', () => {
    const db = createMandateTestDb();
    row(db, 'offered', 400 * LANA, { proposedLanaLanoshis: 900 * LANA });
    expect(consumedByMandate(db, [D]).get(D)).toBe(400 * LANA);
  });

  it('other mandates are not mixed in, and an unknown d reads as nothing', () => {
    const db = createMandateTestDb();
    row(db, 'accepted', 100 * LANA, { mandateRef: `8:2:${HEX}` });
    expect(consumedByMandate(db, [D]).get(D)).toBeUndefined();
    expect(consumedByMandate(db, []).size).toBe(0);
  });

  it('end to end: an expired offer frees the cap for the next proposal', () => {
    const db = createMandateTestDb();
    row(db, 'expired', 1000 * LANA);
    const v = decided(evaluateRoundMandate(input({ consumed: consumedByMandate(db, [D]), requestedLanoshis: 1000 * LANA })));
    expect(v.outcome).toBe('accept');
  });
});

describe('roundState for a screen', () => {
  const base = { split: 8, round: 1, status: 'announced' as const, currentSplit: 9, terms: open(1), released: false, remainingLanoshis: 1, now: NOW };
  it('walks the same ladder as the decision', () => {
    expect(roundState({ ...base, status: 'closed' }).state).toBe('closed');
    expect(roundState({ ...base, currentSplit: null }).state).toBe('split_unknown');
    expect(roundState({ ...base, currentSplit: 8 }).state).toBe('upcoming_split');
    expect(roundState({ ...base, currentSplit: 10 }).state).toBe('window_passed');
    expect(roundState({ ...base, remainingLanoshis: 0 }).state).toBe('fully_acquired');
    expect(roundState({ ...base, terms: undefined }).state).toBe('terms_missing');
    expect(roundState({ ...base, terms: { round: 1, opensAt: NOW + 1, discountPercent: null } }).state).toBe('terms_missing');
    expect(roundState({ ...base, terms: open(1, 22, NOW + 1), released: true }).state).toBe('released');
    expect(roundState({ ...base, terms: open(1, 22, NOW + 1) }).state).toBe('not_open');
    expect(roundState({ ...base, terms: open(1, 22, NOW) }).state).toBe('open');
  });
});

describe('validateRoundTerms', () => {
  it('normalises dates to ISO UTC and orders rows by round', () => {
    const v = validateRoundTerms([
      { round: 2, opensAt: '2026-09-21T22:00:00+02:00', discountPercent: 25 },
      { round: 1, opensAt: '2026-09-14T22:00:00Z', discountPercent: 22 },
    ], { splitEndsAt: null });
    expect(v.ok).toBe(true);
    expect(v.rows.map(r => r.round)).toEqual([1, 2]);
    expect(v.rows[1].opensAt).toBe('2026-09-21T20:00:00.000Z');
    expect(v.warnings).toEqual([]);
  });

  it('refuses a bad round, a bad date, a discount outside 0–100, a duplicate', () => {
    expect(validateRoundTerms([{ round: 4, opensAt: null, discountPercent: null }], { splitEndsAt: null }).ok).toBe(false);
    expect(validateRoundTerms([{ round: 1, opensAt: 'soon', discountPercent: null }], { splitEndsAt: null }).ok).toBe(false);
    expect(validateRoundTerms([{ round: 1, opensAt: null, discountPercent: 101 }], { splitEndsAt: null }).ok).toBe(false);
    expect(validateRoundTerms([{ round: 1, opensAt: null, discountPercent: 22 }, { round: 1, opensAt: null, discountPercent: 22 }], { splitEndsAt: null }).ok).toBe(false);
    expect(validateRoundTerms([], { splitEndsAt: null }).ok).toBe(false);
  });

  it('rounds must open in order once every date is set — earlier rows may stay empty', () => {
    const bad = validateRoundTerms([
      { round: 1, opensAt: '2026-09-21T00:00:00Z', discountPercent: 22 },
      { round: 2, opensAt: '2026-09-14T00:00:00Z', discountPercent: 25 },
    ], { splitEndsAt: null });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/round 2 opens before round 1/);
    const partial = validateRoundTerms([
      { round: 1, opensAt: null, discountPercent: 22 },
      { round: 2, opensAt: '2026-09-14T00:00:00Z', discountPercent: 25 },
    ], { splitEndsAt: null });
    expect(partial.ok).toBe(true);
  });

  it('warns, but saves, when a date precedes the Split end or a discount leaves the 22–35 band', () => {
    const splitEndsAt = Math.floor(Date.parse('2026-09-14T22:00:00Z') / 1000);
    const v = validateRoundTerms([
      { round: 1, opensAt: '2026-09-14T21:00:00Z', discountPercent: 21 },
      { round: 2, opensAt: '2026-09-15T00:00:00Z', discountPercent: 36 },
    ], { splitEndsAt });
    expect(v.ok).toBe(true);
    expect(v.warnings).toHaveLength(3);
    expect(v.warnings[0]).toMatch(/before the Split ends/);
    expect(v.warnings[1]).toMatch(/21% is outside/);
    expect(v.warnings[2]).toMatch(/36% is outside/);
  });
});

describe('the dust allowance matches the client fee estimate', () => {
  it('(1 input + 1 output) × 1.5, three times over', () => {
    expect(ESTIMATED_FEE_LANOSHIS).toBe(33_600);
    expect(EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS).toBe(100_800);
  });
});
