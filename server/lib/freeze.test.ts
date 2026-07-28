/**
 * The freeze gate decides whether money is allowed to leave an account, so the
 * tests are written around that: not "does it read the flag", but "can a frozen
 * account still get its LANA out by any route".
 */
import { describe, it, expect } from 'vitest';
import { evaluateFreeze, walletListSignal, parseRegistrarBody, type FreezeSignal } from './freeze';

const reg = (frozen: boolean, reachable = true): FreezeSignal =>
  ({ source: 'registrar', reachable, frozen, detail: frozen ? 'registrar: wallet frozen' : undefined });
const list = (frozen: boolean, reachable = true): FreezeSignal =>
  ({ source: 'wallet-list', reachable, frozen, detail: frozen ? 'account status: frozen' : undefined });

describe('evaluateFreeze', () => {
  it('lets a clean account sell', () => {
    const v = evaluateFreeze([reg(false), list(false)]);
    expect(v.blocked).toBe(false);
    expect(v.code).toBe('OK');
  });

  it('blocks when the registrar says the wallet is frozen', () => {
    const v = evaluateFreeze([reg(true), list(false)]);
    expect(v.blocked).toBe(true);
    expect(v.code).toBe('WALLET_FROZEN');
    expect(v.reason).toMatch(/frozen/i);
  });

  it('blocks when the wallet list says the account is frozen', () => {
    const v = evaluateFreeze([reg(false), list(true)]);
    expect(v.blocked).toBe(true);
    expect(v.code).toBe('WALLET_FROZEN');
  });

  it('ONE frozen source outvotes any number of clean ones', () => {
    // The two sources guard different things; neither can clear the other's
    // freeze, so a majority vote would be exactly the wrong rule here.
    const v = evaluateFreeze([reg(false), reg(false), list(true)]);
    expect(v.blocked).toBe(true);
  });

  it('blocks when nothing can be reached — "unknown" is not "not frozen"', () => {
    const v = evaluateFreeze([reg(false, false), list(false, false)]);
    expect(v.blocked).toBe(true);
    expect(v.code).toBe('FREEZE_UNVERIFIABLE');
  });

  it('one reachable clean source is enough to proceed', () => {
    // Requiring BOTH would mean any single outage stops all selling; one
    // authoritative all-clear with no contradicting freeze is enough.
    const v = evaluateFreeze([reg(false), list(false, false)]);
    expect(v.blocked).toBe(false);
  });

  it('an unreachable source cannot cause a block by itself', () => {
    // frozen=false on an unreachable source is a placeholder, not an answer —
    // it must never be read as either evidence.
    const v = evaluateFreeze([reg(true, false), list(false)]);
    expect(v.blocked).toBe(false);
  });

  it('no signals at all blocks', () => {
    expect(evaluateFreeze([]).blocked).toBe(true);
  });
});

describe('parseRegistrarBody — the two proxy shapes', () => {
  // check.lanapays.us FLATTENS the registrar reply; the mobile proxy forwards
  // it raw. Reading only one shape finds `frozen` undefined against the other
  // and silently reports "not frozen" — a false clearance on a safety gate.
  it('reads a freeze from the flattened check.lanapays.us shape', () => {
    const s = parseRegistrarBody({ registered: true, frozen: true, wallet_type: 'LanaPays.Us' });
    expect(s.frozen).toBe(true);
    expect(s.reachable).toBe(true);
  });

  it('reads a freeze from the raw mobile shape', () => {
    const s = parseRegistrarBody({ success: true, registered: true, wallet: { frozen: true } });
    expect(s.frozen).toBe(true);
  });

  it('a registered wallet with no freeze flag is a real all-clear', () => {
    // Verified against production: check.lanapays.us returns exactly this for a
    // healthy wallet — `frozen` is simply absent.
    const s = parseRegistrarBody({ registered: true, wallet_type: 'Wallet' });
    expect(s.reachable).toBe(true);
    expect(s.frozen).toBe(false);
  });

  it('registered:false is treated as UNKNOWN, never as a clearance', () => {
    // The proxy returns registered:false both for a genuinely unknown wallet
    // AND when the registrar API errors, so it cannot clear anyone.
    const s = parseRegistrarBody({ registered: false });
    expect(s.reachable).toBe(false);
    // and on its own it must therefore block
    expect(evaluateFreeze([s]).code).toBe('FREEZE_UNVERIFIABLE');
  });

  it('an explicit freeze is believed even without a registration flag', () => {
    const s = parseRegistrarBody({ frozen: true });
    expect(s.reachable).toBe(true);
    expect(s.frozen).toBe(true);
    expect(evaluateFreeze([s]).code).toBe('WALLET_FROZEN');
  });

  it('an empty or garbage body clears nobody', () => {
    for (const body of [{}, null, undefined, { error: 'boom' }]) {
      expect(parseRegistrarBody(body).reachable).toBe(false);
    }
  });
});

describe('walletListSignal', () => {
  const W = 'LZBE9KtfPwAbCdEfGhIjKlMnOpQrStUvWx';

  it('an account-level freeze blocks every wallet on it, listed or not', () => {
    const s = walletListSignal(
      [{ walletId: 'LOther', status: 'frozen', freezeStatus: 'frozen' }],
      W,
    );
    expect(s.frozen).toBe(true);
    expect(s.detail).toMatch(/account status/);
  });

  it('a per-wallet freeze blocks that wallet on an otherwise active account', () => {
    const s = walletListSignal(
      [
        { walletId: W, status: 'active', freezeStatus: 'frozen_max_cap' },
        { walletId: 'LOther', status: 'active' },
      ],
      W,
    );
    expect(s.frozen).toBe(true);
    expect(s.detail).toContain('frozen_max_cap');
  });

  it("another wallet's freeze does not block this one", () => {
    const s = walletListSignal(
      [
        { walletId: W, status: 'active' },
        { walletId: 'LOther', status: 'active', freezeStatus: 'frozen_too_wild' },
      ],
      W,
    );
    expect(s.frozen).toBe(false);
  });

  it('matches the wallet id case-insensitively', () => {
    // Wallet ids travel through QR scans, manual entry and relay tags. A case
    // difference must not silently clear a freeze.
    const s = walletListSignal(
      [{ walletId: W.toUpperCase(), status: 'active', freezeStatus: 'frozen' }],
      W.toLowerCase(),
    );
    expect(s.frozen).toBe(true);
  });

  it('an empty list is unreachable, not "clean"', () => {
    const s = walletListSignal([], W);
    expect(s.reachable).toBe(false);
    expect(s.frozen).toBe(false);
    // and on its own it must therefore block
    expect(evaluateFreeze([s]).code).toBe('FREEZE_UNVERIFIABLE');
  });

  it('an active account whose list omits the wallet still clears at account level', () => {
    const s = walletListSignal([{ walletId: 'LOther', status: 'active' }], W);
    expect(s.reachable).toBe(true);
    expect(s.frozen).toBe(false);
    expect(s.detail).toMatch(/not on account list/);
  });
});
