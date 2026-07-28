import { describe, it, expect } from 'vitest';
import { ownerOf, summarise, buildDirectory, refreshFrozenDirectory, freezeOf, _setDirectory } from './frozenDirectory';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const w = (id: string, freeze?: string) =>
  freeze ? ['w', id, 'Wallet', 'LANA', '', '0', freeze] : ['w', id, 'Wallet', 'LANA', '', '0'];
const ev = (tags: string[][], created_at = 100) => ({ tags, created_at });

describe('ownerOf — three d-tag conventions', () => {
  it('reads a bare hex d-tag', () => {
    expect(ownerOf(ev([['d', HEX_A]]))).toBe(HEX_A);
  });
  it('reads the wallet-list- prefix', () => {
    expect(ownerOf(ev([['d', `wallet-list-${HEX_A}`]]))).toBe(HEX_A);
  });
  it('falls back to the p tag', () => {
    expect(ownerOf(ev([['d', 'something-else'], ['p', HEX_A]]))).toBe(HEX_A);
  });
  it('lower-cases, so an upper-case tag still matches', () => {
    expect(ownerOf(ev([['d', HEX_A.toUpperCase()]]))).toBe(HEX_A);
  });
});

describe('summarise', () => {
  it('a clean account is not frozen', () => {
    const s = summarise(ev([['status', 'active'], w('L1'), w('L2')]));
    expect(s).toMatchObject({ frozen: false, level: 'none', frozenWallets: 0, totalWallets: 2 });
  });

  it('reports a single frozen WALLET as level "wallet", not "account"', () => {
    // This is the live shape: three people have one capped wallet each. Calling
    // that a frozen account would be a public accusation we cannot back.
    const s = summarise(ev([w('L1', 'frozen_max_cap'), w('L2'), w('L3')]));
    expect(s.level).toBe('wallet');
    expect(s.frozen).toBe(true);
    expect(s.frozenWallets).toBe(1);
    expect(s.totalWallets).toBe(3);
    expect(s.reasons).toEqual(['frozen_max_cap']);
  });

  it('an account-level freeze covers EVERY wallet, whatever the w tags say', () => {
    const s = summarise(ev([['status', 'frozen'], w('L1'), w('L2'), w('L3')]));
    expect(s.level).toBe('account');
    expect(s.frozenWallets).toBe(3);
    expect(s.totalWallets).toBe(3);
  });

  it('an account freeze with no per-wallet reason still states one', () => {
    expect(summarise(ev([['status', 'frozen'], w('L1')])).reasons).toEqual(['frozen']);
  });

  it('de-duplicates repeated reasons', () => {
    const s = summarise(ev([w('L1', 'frozen_max_cap'), w('L2', 'frozen_max_cap')]));
    expect(s.reasons).toEqual(['frozen_max_cap']);
    expect(s.frozenWallets).toBe(2);
  });

  it('a wallet tag too short to hold a freeze field is not frozen', () => {
    expect(summarise(ev([['w', 'L1', 'Wallet']])).frozen).toBe(false);
  });
});

describe('buildDirectory', () => {
  it('keeps only the NEWEST event per owner — 30889 is replaceable', () => {
    const d = buildDirectory([
      ev([['d', HEX_A], w('L1', 'frozen_max_cap')], 100),
      ev([['d', HEX_A], w('L1')], 200), // freeze lifted later
    ], [HEX_A]);
    expect(d.get(HEX_A)!.frozen).toBe(false);
  });

  it('ignores owners nobody asked about', () => {
    const d = buildDirectory([ev([['d', HEX_B], w('L1', 'frozen')])], [HEX_A]);
    expect(d.size).toBe(0);
  });
});

describe('refreshFrozenDirectory', () => {
  const relays = ['wss://r'];

  it('resolves in THREE batched queries, not one per person', async () => {
    const calls: any[] = [];
    const q = async (_r: string[], f: any) => { calls.push(f); return f['#d']?.[0] === HEX_A ? [ev([['d', HEX_A], w('L1', 'frozen_max_cap')])] : []; };
    _setDirectory(new Map());
    const r = await refreshFrozenDirectory([HEX_A, HEX_B], relays, q);
    expect(calls).toHaveLength(3);
    expect(calls[0]['#d']).toEqual([HEX_A, HEX_B]); // batched, not per hex
    expect(r.frozen).toBe(1);
    expect(freezeOf(HEX_A)!.level).toBe('wallet');
  });

  it('a relay outage KEEPS the previous answer — silence is not "not frozen"', async () => {
    _setDirectory(new Map([[HEX_A, { frozen: true, level: 'account' as const, frozenWallets: 1, totalWallets: 1, reasons: ['frozen'] }]]));
    const r = await refreshFrozenDirectory([HEX_A], relays, async () => []);
    expect(r.resolved).toBe(0);
    expect(freezeOf(HEX_A)!.frozen).toBe(true); // still there
  });

  it('someone missing from a partial pass is carried forward, not cleared', async () => {
    _setDirectory(new Map([[HEX_B, { frozen: true, level: 'wallet' as const, frozenWallets: 1, totalWallets: 2, reasons: ['frozen_max_cap'] }]]));
    await refreshFrozenDirectory([HEX_A, HEX_B], relays,
      async (_r, f) => (f['#d']?.includes(HEX_A) ? [ev([['d', HEX_A], w('L1')])] : []));
    expect(freezeOf(HEX_A)!.frozen).toBe(false);
    expect(freezeOf(HEX_B)!.frozen).toBe(true);
  });

  it('an unknown person is null — not "clean"', () => {
    _setDirectory(new Map());
    expect(freezeOf(HEX_A)).toBeNull();
    expect(freezeOf(null)).toBeNull();
  });

  it('ignores malformed hexes and does not query for them', async () => {
    const filters: any[] = [];
    _setDirectory(new Map());
    await refreshFrozenDirectory(['nope', HEX_A], relays, async (_r, f) => { filters.push(f); return []; });
    expect(filters[0]['#d']).toEqual([HEX_A]);      // bare-hex query
    expect(filters[2]['#p']).toEqual([HEX_A]);      // p-tag query
  });

  it('de-duplicates the same person appearing in both lists', async () => {
    const filters: any[] = [];
    _setDirectory(new Map());
    await refreshFrozenDirectory([HEX_A, HEX_A.toUpperCase(), HEX_A], relays,
      async (_r, f) => { filters.push(f); return []; });
    expect(filters[0]['#d']).toEqual([HEX_A]);
  });
});
