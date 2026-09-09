// @vitest-environment node
/**
 * The rule that would have stopped OFF-2026-042: 20,070 LANA proposed from a
 * wallet holding 2,200.72. What matters as much as the refusal is WHICH
 * failure is which — an unreadable balance must never read as "not enough" or
 * as "fine", because one of those turns an outage into an accusation and the
 * other turns it into a promise we cannot keep.
 */
import { describe, it, expect } from 'vitest';
import { verifyBacking, isBacked, BACKING_TOLERANCE_LANOSHIS } from './acquisitionBacking';

const LANA = 100_000_000;

describe('verifyBacking', () => {
  it('refuses the live case: 20,070 offered against 2,200.72 held', () => {
    const v = verifyBacking(Math.round(2200.72 * LANA), 20070 * LANA);
    expect(v).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      status: 409,
      shortfallLanoshis: 20070 * LANA - Math.round(2200.72 * LANA),
    });
    expect((v as any).error).toContain('2,200.72');
    expect((v as any).error).toContain('20,070');
  });

  it('lets a wallet sell exactly what it holds', () => {
    expect(verifyBacking(500 * LANA, 500 * LANA).ok).toBe(true);
  });

  it('forgives the rounding a screen shows, and nothing beyond it', () => {
    const offered = 500 * LANA;
    expect(verifyBacking(offered - BACKING_TOLERANCE_LANOSHIS, offered).ok).toBe(true);
    expect(verifyBacking(offered - BACKING_TOLERANCE_LANOSHIS - 1, offered).ok).toBe(false);
  });

  it('an unreadable balance is its own answer — not zero, not enough', () => {
    const v = verifyBacking(null, 10 * LANA);
    expect(v).toMatchObject({ ok: false, code: 'BALANCE_UNVERIFIABLE', status: 503 });
    expect((v as any).error).toMatch(/try again/i);

    // NaN arrives the same way a missing entry does.
    expect(verifyBacking(Number.NaN, 10 * LANA)).toMatchObject({ ok: false, code: 'BALANCE_UNVERIFIABLE' });
  });

  it('an empty wallet is short, not unverifiable', () => {
    expect(verifyBacking(0, LANA)).toMatchObject({
      ok: false, code: 'INSUFFICIENT_BALANCE', balanceLanoshis: 0,
    });
  });

  it('isBacked answers the display question only', () => {
    expect(isBacked(20070 * LANA, 20070 * LANA)).toBe(true);
    expect(isBacked(2200 * LANA, 20070 * LANA)).toBe(false);
    expect(isBacked(null, 1)).toBe(false);
  });
});
