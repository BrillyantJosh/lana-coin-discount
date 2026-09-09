// @vitest-environment node
/**
 * RESTRICTION WITHHOLDS THE AUTOMATIC YES, AND NOTHING ELSE.
 *
 * The owner's instruction (9 Sep 2026): someone on restrict always goes to
 * manual approval. These pin what that must and must not mean — a restricted
 * counterparty keeps every right they had, gains none, and simply never gets an
 * answer from the machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { ROUND_MANDATE_SCHEMA_SQL } from '../db/roundMandateSchema';
import { activeRestriction, activeRestrictionSet, listRestrictions, restrict, liftRestriction, restrictionReason } from './acquisitionRestriction';
import { evaluateRoundMandate, type EvaluateRoundMandateInput, type MandateCandidate } from './roundMandate';

const HEX = 'a'.repeat(64);
const ADMIN = 'c'.repeat(64);
const W = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const LANA = 100_000_000;

let db: Database.Database;
beforeEach(() => {
  db = new DatabaseCtor(':memory:');
  db.exec(ROUND_MANDATE_SCHEMA_SQL);
});

describe('the restriction record', () => {
  it('stores who, why and when — and reads back as active', () => {
    const row = restrict(db, HEX, 'Two proposals from a wallet we could not verify', ADMIN);
    expect(row.reason).toBe('Two proposals from a wallet we could not verify');
    expect(row.restricted_by).toBe(ADMIN);
    expect(row.lifted_at).toBeNull();
    expect(activeRestriction(db, HEX)?.hex_id).toBe(HEX);
    expect(activeRestrictionSet(db).has(HEX)).toBe(true);
  });

  it('refuses a restriction nobody can explain later', () => {
    expect(() => restrict(db, HEX, '   ', ADMIN)).toThrow('REASON_REQUIRED');
    expect(() => restrict(db, 'not-a-hex', 'because', ADMIN)).toThrow('INVALID_HEX');
    expect(activeRestriction(db, HEX)).toBeNull();
  });

  it('is case-insensitive about the hex, both writing and reading', () => {
    restrict(db, HEX.toUpperCase(), 'reason', ADMIN);
    expect(activeRestriction(db, HEX)).not.toBeNull();
    expect(activeRestriction(db, HEX.toUpperCase())).not.toBeNull();
  });

  it('lifting keeps the row, stamped, so the history reads back', () => {
    restrict(db, HEX, 'first reason', ADMIN);
    expect(liftRestriction(db, HEX, ADMIN)).toBe(true);
    expect(activeRestriction(db, HEX)).toBeNull();
    expect(liftRestriction(db, HEX, ADMIN)).toBe(false); // idempotent
    const all = listRestrictions(db);
    expect(all).toHaveLength(1);
    expect(all[0].reason).toBe('first reason');
    expect(all[0].lifted_by).toBe(ADMIN);
  });

  it('restricting again after a lift reopens the same row with the new reason', () => {
    restrict(db, HEX, 'first reason', ADMIN);
    liftRestriction(db, HEX, ADMIN);
    restrict(db, HEX, 'second reason', ADMIN);
    const row = activeRestriction(db, HEX)!;
    expect(row.reason).toBe('second reason');
    expect(row.lifted_at).toBeNull();
    expect(listRestrictions(db)).toHaveLength(1);
  });

  it('an empty or unknown hex is simply not restricted', () => {
    expect(activeRestriction(db, '')).toBeNull();
    expect(activeRestriction(db, 'b'.repeat(64))).toBeNull();
  });
});

// ── the rule ────────────────────────────────────────────────────────────────

const candidate = (over: Partial<MandateCandidate> = {}): MandateCandidate => ({
  dTag: `8:1:${HEX}`, split: 8, round: 1, financerHex: HEX, status: 'announced',
  lanaReceivedLanoshis: 1000 * LANA,
  wallets: [{ address: W, currency: 'EUR', lanaLanoshis: 1000 * LANA, fundSettingId: 1 }],
  ...over,
} as MandateCandidate);

const input = (over: Partial<EvaluateRoundMandateInput> = {}): EvaluateRoundMandateInput => ({
  currentSplit: 9,
  hexId: HEX,
  wallet: W,
  requestedLanoshis: 100 * LANA,
  candidates: [candidate()],
  terms: [{ round: 1, opensAt: 1_000, discountPercent: 22 }],
  released: new Set<string>(),
  consumed: new Map<string, number>(),
  now: 2_000,
  ...over,
});

describe('what restriction does to a verdict', () => {
  it('turns an acceptance into a review, and says why', () => {
    const open = evaluateRoundMandate(input());
    expect(open.outcome).toBe('accept');

    const held = evaluateRoundMandate(input({ restricted: { reason: 'under review by agreement' } }));
    expect(held.outcome).toBe('review');
    expect(held.code).toBe('RESTRICTED');
    expect(held.reason).toBe(restrictionReason('under review by agreement'));
  });

  it('turns a counteroffer into a review too — no automatic price at all', () => {
    const over = input({ requestedLanoshis: 5000 * LANA });
    expect(evaluateRoundMandate(over).outcome).toBe('counter');
    expect(evaluateRoundMandate({ ...over, restricted: { reason: 'r' } }).outcome).toBe('review');
  });

  it('keeps the mandate it would have drawn on, so the parked offer stays bound to its round', () => {
    const held = evaluateRoundMandate(input({ restricted: { reason: 'r' } })) as any;
    expect(held.mandateRef).toBe(`8:1:${HEX}`);
    expect(held.round).toBe(1);
    expect(held.discountPercent).toBe(22);
    expect(held.allowedLanoshis).toBe(100 * LANA);
  });

  it('a counteroffer parked by restriction still carries only what is left', () => {
    const held = evaluateRoundMandate(input({
      requestedLanoshis: 5000 * LANA,
      consumed: new Map([[`8:1:${HEX}`, 400 * LANA]]),
      restricted: { reason: 'r' },
    })) as any;
    expect(held.allowedLanoshis).toBe(600 * LANA);
    expect(held.remainingLanoshis).toBe(600 * LANA);
  });

  it('never turns a refusal into a review — a decline keeps its own reason', () => {
    // Split window closed: restricted or not, the answer is the same decline.
    const shut = { currentSplit: 12 };
    expect(evaluateRoundMandate(input(shut)).code).toBe('SPLIT_WINDOW');
    const held = evaluateRoundMandate(input({ ...shut, restricted: { reason: 'r' } }));
    expect(held.outcome).toBe('decline');
    expect(held.code).toBe('SPLIT_WINDOW');
  });

  it('never invents a mandate — NO_MANDATE stays NO_MANDATE', () => {
    const none = { candidates: [] };
    expect(evaluateRoundMandate(input(none)).code).toBe('NO_MANDATE');
    const held = evaluateRoundMandate(input({ ...none, restricted: { reason: 'r' } }));
    expect(held.outcome).toBe('review');
    expect(held.code).toBe('NO_MANDATE');
  });

  it('a fully acquired mandate is still declined, not reviewed', () => {
    const spent = { consumed: new Map([[`8:1:${HEX}`, 1000 * LANA]]) };
    expect(evaluateRoundMandate(input(spent)).code).toBe('FULLY_ACQUIRED');
    expect(evaluateRoundMandate(input({ ...spent, restricted: { reason: 'r' } })).code).toBe('FULLY_ACQUIRED');
  });

  it('no restriction changes nothing at all', () => {
    const plain = evaluateRoundMandate(input());
    for (const none of [undefined, null]) {
      expect(evaluateRoundMandate(input({ restricted: none }))).toEqual(plain);
    }
  });
});
