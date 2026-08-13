import { describe, it, expect } from 'vitest';
import { computeBlocker, financingPriorityOf, priorityFor, NON_FINANCIER, CROWDFUND_TIER, type QueueSeller } from './payoutOrder';

// Helper: build a per-currency seller list. priority defaults to NON_FINANCIER.
const s = (hex: string, remaining: number, priority: number = NON_FINANCIER): QueueSeller => ({ hex, remaining, priority });

describe('priorityFor', () => {
  it('returns the financier rank when present, NON_FINANCIER otherwise', () => {
    const ranks = new Map([['a', 1], ['b', 3]]);
    expect(priorityFor('a', ranks)).toBe(1);
    expect(priorityFor('b', ranks)).toBe(3);
    expect(priorityFor('z', ranks)).toBe(NON_FINANCIER);
  });
});

describe('priorityFor — crowd-funding tier (Tier 2)', () => {
  it('financier rank wins even if the hex is also crowd-funding-eligible', () => {
    const ranks = new Map([['a', 2]]);
    const crowd = new Set(['a', 'c']);
    expect(priorityFor('a', ranks, crowd)).toBe(2);
  });
  it('a crowd-funder (not a financier) gets CROWDFUND_TIER', () => {
    const ranks = new Map([['a', 1]]);
    const crowd = new Set(['c']);
    expect(priorityFor('c', ranks, crowd)).toBe(CROWDFUND_TIER);
  });
  it('CROWDFUND_TIER sits between financier ranks and NON_FINANCIER', () => {
    expect(CROWDFUND_TIER).toBeGreaterThan(999); // any realistic financier rank M
    expect(CROWDFUND_TIER).toBeLessThan(NON_FINANCIER);
  });
  it('non-crowd, non-financier still NON_FINANCIER', () => {
    expect(priorityFor('z', new Map(), new Set(['c']))).toBe(NON_FINANCIER);
  });
});

describe('computeBlocker — crowd-funding tier ordering', () => {
  const cf = (hex: string, remaining: number) => s(hex, remaining, CROWDFUND_TIER);
  it('a crowd-funder is blocked while any financier still owes', () => {
    const list = [s('fin', 100, 2), cf('cf', 100)];
    expect(computeBlocker(list, 'cf')).toEqual({ blocked: true, blockedByHex: 'fin' });
  });
  it('a crowd-funder blocks a plain non-financier', () => {
    const list = [cf('cf', 100), s('user', 100)];
    expect(computeBlocker(list, 'user')).toEqual({ blocked: true, blockedByHex: 'cf' });
    expect(computeBlocker(list, 'cf')).toEqual({ blocked: false, blockedByHex: null });
  });
  it('two crowd-funders (flat band) never block each other', () => {
    const list = [cf('cf1', 100), cf('cf2', 100)];
    expect(computeBlocker(list, 'cf1').blocked).toBe(false);
    expect(computeBlocker(list, 'cf2').blocked).toBe(false);
  });
  it('a crowd-funder becomes payable once all financiers are clear', () => {
    const list = [s('fin', 0, 1), cf('cf', 100), s('user', 100)];
    expect(computeBlocker(list, 'cf')).toEqual({ blocked: false, blockedByHex: null });
    // ...and the plain user is now blocked by the crowd-funder
    expect(computeBlocker(list, 'user')).toEqual({ blocked: true, blockedByHex: 'cf' });
  });
});

describe('computeBlocker — financiers (strict FIFO by rank)', () => {
  it('rank 1 (head) is payable', () => {
    const list = [s('a', 100, 1), s('b', 100, 2)];
    expect(computeBlocker(list, 'a')).toEqual({ blocked: false, blockedByHex: null });
  });

  it('rank 2 is blocked while rank 1 still owes', () => {
    const list = [s('a', 100, 1), s('b', 100, 2)];
    expect(computeBlocker(list, 'b')).toEqual({ blocked: true, blockedByHex: 'a' });
  });

  it('rank 2 becomes payable once rank 1 is fully paid (remaining 0)', () => {
    const list = [s('a', 0, 1), s('b', 100, 2)];
    expect(computeBlocker(list, 'b')).toEqual({ blocked: false, blockedByHex: null });
  });

  it('names the HEAD (lowest rank) as the blocker, not an intermediate', () => {
    const list = [s('a', 100, 1), s('b', 100, 2), s('c', 100, 3)];
    expect(computeBlocker(list, 'c')).toEqual({ blocked: true, blockedByHex: 'a' });
  });
});

describe('computeBlocker — financiers before non-financiers', () => {
  it('a non-financier is blocked while any financier still owes', () => {
    const list = [s('fin', 100, 2), s('user', 100)]; // user = NON_FINANCIER
    expect(computeBlocker(list, 'user')).toEqual({ blocked: true, blockedByHex: 'fin' });
  });

  it('a non-financier is payable once all financiers are clear', () => {
    const list = [s('fin', 0, 1), s('user', 100)];
    expect(computeBlocker(list, 'user')).toEqual({ blocked: false, blockedByHex: null });
  });
});

describe('computeBlocker — no order among non-financiers', () => {
  it('two non-financiers never block each other', () => {
    const list = [s('u1', 100), s('u2', 100)];
    expect(computeBlocker(list, 'u1').blocked).toBe(false);
    expect(computeBlocker(list, 'u2').blocked).toBe(false);
  });
});

describe('computeBlocker — sweeper ranked last among financiers', () => {
  // Sweeper gets the highest rank number among financiers (Direct Fund orders it last).
  it('sweeper is blocked by a lower-rank regular financier', () => {
    const list = [s('fin1', 100, 1), s('sweep', 100, 5)];
    expect(computeBlocker(list, 'sweep')).toEqual({ blocked: true, blockedByHex: 'fin1' });
  });

  it('sweeper (when it is the only outstanding financier) blocks non-financiers', () => {
    const list = [s('fin1', 0, 1), s('sweep', 100, 5), s('user', 100)];
    expect(computeBlocker(list, 'user')).toEqual({ blocked: true, blockedByHex: 'sweep' });
  });
});

describe('computeBlocker — nothing outstanding / not in queue', () => {
  it('a seller with no remaining is never blocked', () => {
    const list = [s('a', 100, 1), s('b', 0, 2)];
    expect(computeBlocker(list, 'b')).toEqual({ blocked: false, blockedByHex: null });
  });

  it('an unknown target hex is not blocked', () => {
    const list = [s('a', 100, 1)];
    expect(computeBlocker(list, 'missing')).toEqual({ blocked: false, blockedByHex: null });
  });
});

describe('computeBlocker — per-currency independence (caller contract)', () => {
  it('only sellers in the passed (single-currency) list are considered', () => {
    // EUR list: 'eurFin' rank 1 already paid, 'eurUser' non-financier outstanding.
    // A GBP financier who still owes is simply NOT in this list, so it cannot block.
    const eurList = [s('eurFin', 0, 1), s('eurUser', 100)];
    expect(computeBlocker(eurList, 'eurUser')).toEqual({ blocked: false, blockedByHex: null });
  });
});

describe('financingPriorityOf — round-aware with registration fallback', () => {
  it('returns financing_rank when present', () => {
    expect(financingPriorityOf({ rank: 1, financing_rank: 3 })).toBe(3);
  });

  it('falls back to registration rank when the field is absent or null', () => {
    // An older Direct Fund during a deploy window, or stale cached rows.
    expect(financingPriorityOf({ rank: 4 })).toBe(4);
    expect(financingPriorityOf({ rank: 4, financing_rank: null })).toBe(4);
  });

  it('stays a dense small number — below the crowd-funding band', () => {
    // financing_rank is 1..N per currency; if anyone ever fed the raw
    // queue_key (round*1e9 + id) through here, financiers would silently
    // fall BEHIND crowd-funders. Pin the boundary.
    expect(financingPriorityOf({ rank: 51, financing_rank: 51 })).toBeLessThan(CROWDFUND_TIER);
  });
});

describe('computeBlocker — the financing order end-to-end', () => {
  // The live inversion (split 8): A registered FIRST but their remaining money
  // sits in round 2; B and C registered later, still financing round 1.
  const rows = [
    { hex: 'A', rank: 1, financing_rank: 3 },
    { hex: 'B', rank: 2, financing_rank: 1 },
    { hex: 'C', rank: 3, financing_rank: 2 },
  ];
  const mapOf = (rs: Array<{ hex: string; rank: number; financing_rank?: number }>) =>
    new Map(rs.map((r) => [r.hex, financingPriorityOf(r)]));

  const sellersFrom = (rankByHex: Map<string, number>, remaining: Record<string, number>) => {
    const crowdSet = new Set(['P']);
    return ['A', 'B', 'C', 'P', 'X'].map((hex) => ({
      hex,
      remaining: remaining[hex] ?? 100,
      priority: priorityFor(hex, rankByHex, crowdSet),
    }));
  };

  it('the round-1 financier is payable and blocks the earlier-registered round-2 one', () => {
    const sellers = sellersFrom(mapOf(rows), {});
    expect(computeBlocker(sellers, 'B').blocked).toBe(false);
    expect(computeBlocker(sellers, 'A')).toEqual({ blocked: true, blockedByHex: 'B' });
    expect(computeBlocker(sellers, 'C')).toEqual({ blocked: true, blockedByHex: 'B' });
  });

  it('once the head is paid out, the next round-1 financier takes over', () => {
    const sellers = sellersFrom(mapOf(rows), { B: 0 });
    expect(computeBlocker(sellers, 'C').blocked).toBe(false);
    expect(computeBlocker(sellers, 'A')).toEqual({ blocked: true, blockedByHex: 'C' });
  });

  it('crowd-funders and non-financiers wait for every financier regardless of rounds', () => {
    const sellers = sellersFrom(mapOf(rows), {});
    expect(computeBlocker(sellers, 'P').blocked).toBe(true);
    expect(computeBlocker(sellers, 'X').blocked).toBe(true);
    const drained = sellersFrom(mapOf(rows), { A: 0, B: 0, C: 0 });
    expect(computeBlocker(drained, 'P').blocked).toBe(false);
  });

  it('degrades to exact registration order when financing_rank is absent', () => {
    // Deploy-window fallback: same investors, no financing_rank fields.
    const old = rows.map(({ hex, rank }) => ({ hex, rank }));
    const sellers = sellersFrom(mapOf(old), {});
    expect(computeBlocker(sellers, 'A').blocked).toBe(false);
    expect(computeBlocker(sellers, 'B')).toEqual({ blocked: true, blockedByHex: 'A' });
  });
});
