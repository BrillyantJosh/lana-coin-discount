/**
 * The buyback window: only LANA from the split before the current one is
 * bought back. Everything newer (including the split still running) and
 * everything older is refused — and so is anything we could not establish.
 */
import { describe, it, expect } from 'vitest';
import { evaluateBuybackSplit, parseAllowedOffsets, DEFAULT_ALLOWED_OFFSETS } from './buybackSplit';

const at = (walletSplit: number | null, over: Partial<Parameters<typeof evaluateBuybackSplit>[0]> = {}) =>
  evaluateBuybackSplit({
    walletSplit,
    currentSplit: 8,
    allowedOffsets: DEFAULT_ALLOWED_OFFSETS,
    registrarReachable: true,
    ...over,
  });

describe('the default window is exactly current − 1', () => {
  it('a wallet from the previous split may sell', () => {
    const v = at(7);
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('OK');
    expect(v.allowedSplits).toEqual([7]);
  });

  it('the CURRENT split is refused — it is still running', () => {
    const v = at(8);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_TOO_NEW');
    expect(v.reason).toContain('still running');
  });

  it('an older split is refused', () => {
    const v = at(6);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_TOO_OLD');
    expect(v.reason).toContain('Split 6');
  });

  it('the very first split is refused once it is far enough back', () => {
    expect(at(1).code).toBe('SPLIT_TOO_OLD');
    expect(at(0).code).toBe('SPLIT_TOO_OLD');
  });

  it('a split beyond the current one is refused as too new', () => {
    expect(at(9).code).toBe('SPLIT_TOO_NEW');
  });
});

describe('fail-closed: what we cannot establish is not permission', () => {
  it('an unregistered wallet has no split, so it cannot sell', () => {
    const v = at(null);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNKNOWN');
  });

  it('an unreachable registrar blocks rather than clears', () => {
    // Note the input: a split IS supplied, and it is even an eligible one.
    // It must still be refused, because nothing answered for it.
    const v = at(7, { registrarReachable: false });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNVERIFIABLE');
  });

  it('not knowing the current split blocks too', () => {
    const v = at(7, { currentSplit: null });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNVERIFIABLE');
    expect(v.allowedSplits).toEqual([]);
  });
});

describe('the window is configurable without a deploy', () => {
  it('two offsets open two splits', () => {
    const opts = { currentSplit: 8, allowedOffsets: [1, 2], registrarReachable: true };
    expect(evaluateBuybackSplit({ ...opts, walletSplit: 7 }).allowed).toBe(true);
    expect(evaluateBuybackSplit({ ...opts, walletSplit: 6 }).allowed).toBe(true);
    expect(evaluateBuybackSplit({ ...opts, walletSplit: 5 }).code).toBe('SPLIT_TOO_OLD');
    expect(evaluateBuybackSplit({ ...opts, walletSplit: 8 }).code).toBe('SPLIT_TOO_NEW');
  });

  it('offset 0 deliberately admits the current split', () => {
    const v = evaluateBuybackSplit({ walletSplit: 8, currentSplit: 8, allowedOffsets: [0, 1], registrarReachable: true });
    expect(v.allowed).toBe(true);
    expect(v.allowedSplits).toEqual([7, 8]);
  });

  it('an offset past the beginning of time is dropped, not negative', () => {
    const v = evaluateBuybackSplit({ walletSplit: 0, currentSplit: 1, allowedOffsets: [1, 2], registrarReachable: true });
    expect(v.allowedSplits).toEqual([0]);
    expect(v.allowed).toBe(true);
  });

  it('names every allowed split in the refusal, so the seller knows the rule', () => {
    const v = evaluateBuybackSplit({ walletSplit: 3, currentSplit: 8, allowedOffsets: [1, 2], registrarReachable: true });
    expect(v.reason).toContain('Splits 6 and 7');
  });
});

describe('parseAllowedOffsets', () => {
  it('reads the plain and the widened forms', () => {
    expect(parseAllowedOffsets('1')).toEqual([1]);
    expect(parseAllowedOffsets('1,2')).toEqual([1, 2]);
    expect(parseAllowedOffsets(' 2 , 1 ')).toEqual([1, 2]);
    expect(parseAllowedOffsets('1,1,2')).toEqual([1, 2]);
  });

  it('an unset setting means the documented default, not "everything"', () => {
    expect(parseAllowedOffsets(null)).toEqual([1]);
    expect(parseAllowedOffsets(undefined)).toEqual([1]);
    expect(parseAllowedOffsets('')).toEqual([1]);
  });

  it('a hand-mangled value falls back to the default rather than opening or closing the gate', () => {
    expect(parseAllowedOffsets('all')).toEqual([1]);
    expect(parseAllowedOffsets('-1')).toEqual([1]);
    expect(parseAllowedOffsets('1,abc')).toEqual([1]);
  });
});
