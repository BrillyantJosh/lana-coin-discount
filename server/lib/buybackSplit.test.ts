/**
 * The buyback window: only LANA from the Split before the current one is
 * bought back. Everything newer (including the Split still running) and
 * everything older is refused — and so is anything we could not establish.
 *
 * The window is a constant, not a setting. These tests are the record of that:
 * there is no input here that can move it.
 *
 * It is also a rule about ONE KIND OF WALLET. Applied to everything, it shut
 * half the honest sellers out (18 Aug 2026): the registrar stamps a split on
 * LanaPays.Us wallets and mostly leaves a person's own Main Wallet unstamped,
 * and "nobody wrote it down" was being read as "disqualified".
 */
import { describe, it, expect } from 'vitest';
import { evaluateBuybackSplit, BUYBACK_SPLIT_OFFSET } from './buybackSplit';

// Every case below is a LanaPays.Us wallet unless it says otherwise — that is
// the only kind the window is about.
const at = (walletSplit: number | null, over: Partial<Parameters<typeof evaluateBuybackSplit>[0]> = {}) =>
  evaluateBuybackSplit({
    walletSplit, currentSplit: 8, registrarReachable: true,
    walletType: 'LanaPays.Us', ...over,
  });

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
    expect(evaluateBuybackSplit({ walletSplit: 41, currentSplit: 42, registrarReachable: true, walletType: 'LanaPays.Us' }).allowed).toBe(true);
    expect(evaluateBuybackSplit({ walletSplit: 40, currentSplit: 42, registrarReachable: true, walletType: 'LanaPays.Us' }).code).toBe('SPLIT_TOO_OLD');
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
    const v = evaluateBuybackSplit({ walletSplit: 0, currentSplit: 0, registrarReachable: true, walletType: 'LanaPays.Us' });
    expect(v.allowed).toBe(false);
    expect(v.allowedSplits).toEqual([]);
  });
});

describe('the window applies to LanaPays.Us wallets and nothing else', () => {
  it("a person's own Main Wallet is not held to it", () => {
    // The regression this rule caused: 35 of 40 Main Wallets that had been
    // selling happily carried no split stamp at all, and were refused for it.
    const v = at(null, { walletType: 'Main Wallet' });
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('OUT_OF_SCOPE');
    expect(v.reason).toBe('');
  });

  it('a Main Wallet from a long-past Split is not held to it either', () => {
    // Its registration date says nothing about the coins in it today.
    expect(at(2, { walletType: 'Main Wallet' }).allowed).toBe(true);
    expect(at(6, { walletType: 'Retail' }).allowed).toBe(true);
    expect(at(8, { walletType: 'Wallet' }).allowed).toBe(true);
  });

  it('sub-types of LanaPays.Us stay IN scope', () => {
    // "LanaPays.Us Investors" is one the registrar already issues; a new
    // sub-type must not fall out of scope just by being unlisted.
    const v = at(8, { walletType: 'LanaPays.Us Investors' });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_TOO_NEW');
  });

  it('the type is matched case-insensitively and trimmed', () => {
    expect(at(8, { walletType: '  lanapays.us  ' }).allowed).toBe(false);
  });

  it('a wallet nobody types is out of scope — the issuer is who stamps it', () => {
    expect(at(null, { walletType: null }).code).toBe('OUT_OF_SCOPE');
    expect(at(null, { walletType: '' }).code).toBe('OUT_OF_SCOPE');
    expect(evaluateBuybackSplit({ walletSplit: null, currentSplit: 8, registrarReachable: true }).code)
      .toBe('OUT_OF_SCOPE');
  });

  it('scope is decided BEFORE the fail-closed arms', () => {
    // An unreachable registrar, or no known current Split, must not refuse a
    // wallet the rule was never about.
    expect(at(null, { walletType: 'Main Wallet', registrarReachable: false }).allowed).toBe(true);
    expect(at(null, { walletType: 'Main Wallet', currentSplit: null }).allowed).toBe(true);
    // …while a LanaPays.Us wallet still gets the closed door.
    expect(at(7, { registrarReachable: false }).allowed).toBe(false);
    expect(at(7, { currentSplit: null }).allowed).toBe(false);
  });

  it('a LanaPays.Us wallet with no stamp is still refused', () => {
    const v = at(null);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SPLIT_UNKNOWN');
  });
});
