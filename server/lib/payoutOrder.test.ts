import { describe, it, expect } from 'vitest';
import { computeBlocker, priorityFor, NON_FINANCIER, CROWDFUND_TIER, type QueueSeller } from './payoutOrder';

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
