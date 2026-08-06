/**
 * The buyback window: only LANA from the Split before the current one is
 * bought back. Everything newer (including the Split still running) and
 * everything older is refused — and so is anything we could not establish.
 *
 * The window is a constant, not a setting. These tests are the record of that:
 * there is no input here that can move it.
 */
import { describe, it, expect } from 'vitest';
import { evaluateBuybackSplit, BUYBACK_SPLIT_OFFSET } from './buybackSplit';

const at = (walletSplit: number | null, over: Partial<Parameters<typeof evaluateBuybackSplit>[0]> = {}) =>
  evaluateBuybackSplit({ walletSplit, currentSplit: 8, registrarReachable: true, ...over });

describe('the window is exactly one Split: current − 1', () => {
  it('is fixed in code and not configurable', () => {
    expect(BUYBACK_SPLIT_OFFSET).toBe(1);
  });

  it('a wallet from the previous Split may sell', () => {
    const v = at(7);
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('OK');
    expect(v.allowedSplits).toEqual([7]);
  });

  it('the CURRENT Split is refused — it is still running', () => {
    const v = at(8);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_TOO_NEW');
    expect(v.reason).toContain('still running');
  });

  it('an older Split is refused', () => {
    const v = at(6);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_TOO_OLD');
    expect(v.reason).toContain('Split 6');
  });

  it('every Split further back is refused too', () => {
    expect(at(5).code).toBe('SPLIT_TOO_OLD');
    expect(at(1).code).toBe('SPLIT_TOO_OLD');
    expect(at(0).code).toBe('SPLIT_TOO_OLD');
  });

  it('a Split beyond the current one is refused as too new', () => {
    expect(at(9).code).toBe('SPLIT_TOO_NEW');
  });

  it('the window follows the current Split, whatever it is', () => {
    expect(evaluateBuybackSplit({ walletSplit: 41, currentSplit: 42, registrarReachable: true }).allowed).toBe(true);
    expect(evaluateBuybackSplit({ walletSplit: 40, currentSplit: 42, registrarReachable: true }).code).toBe('SPLIT_TOO_OLD');
  });

  it('names the one bought-back Split in every refusal, so the seller knows the rule', () => {
    expect(at(6).reason).toContain('Only LANA from Split 7');
    expect(at(8).reason).toContain('Only LANA from Split 7');
  });
});

describe('fail-closed: what we cannot establish is not permission', () => {
  it('an unregistered wallet has no Split, so it cannot sell', () => {
    const v = at(null);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNKNOWN');
  });

  it('an unreachable registrar blocks rather than clears', () => {
    // Note the input: a Split IS supplied, and it is even the eligible one.
    // It must still be refused, because nothing answered for it.
    const v = at(7, { registrarReachable: false });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNVERIFIABLE');
  });

  it('not knowing the current Split blocks too', () => {
    const v = at(7, { currentSplit: null });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNVERIFIABLE');
    expect(v.allowedSplits).toEqual([]);
  });

  it('before any Split has completed there is nothing to buy back', () => {
    const v = evaluateBuybackSplit({ walletSplit: 0, currentSplit: 0, registrarReachable: true });
    expect(v.allowed).toBe(false);
    expect(v.allowedSplits).toEqual([]);
  });
});
