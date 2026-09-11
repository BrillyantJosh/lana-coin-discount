/**
 * The rule that replaces a date nobody can know in advance.
 *
 * Owner, 11 Sept 2026: "Krog 2 se odpre ko se krog 1 zapre.. avtomatsko...
 * nemogoče je zares povedati v naprej kdaj bo.. ko zmanjka denarja"
 *
 * Most of these are about the ways this could go WRONG, because every one of
 * them opens a treasury cap: silence read as completion, an opening that
 * un-happens when an offer expires, one financer's crumb holding a whole round
 * shut, and a blank field meaning yes.
 */
import { describe, it, expect } from 'vitest';
import {
  roundStandings, roundIsOpen, roundCanEverOpen, sequenceOpenings,
  ROUND_CLOSE_FLOOR_LANOSHIS, type RoundMember, type RoundOpening,
} from './roundSequence.js';

const LANA = 100_000_000;
const NOW = 1_800_000_000;

const member = (round: number, lana: number): RoundMember =>
  ({ round, remainingLanoshis: Math.round(lana * LANA) });

const opening = (over: Partial<RoundOpening> & { round: number }): RoundOpening =>
  ({ opensAt: null, opensMode: 'sequence', openedAt: null, ...over });

describe('what a round still holds', () => {
  it('adds up every financer in it, not just the one asking', () => {
    const s = roundStandings([member(1, 100), member(1, 250), member(2, 9_000)]);
    expect(s.get(1)!.members).toBe(2);
    expect(s.get(1)!.remainingLanoshis).toBe(350 * LANA);
    expect(s.get(2)!.members).toBe(1);
  });

  it('counts a round spent once what is left is under the floor', () => {
    expect(roundStandings([member(1, 0), member(1, 0)]).get(1)!.exhausted).toBe(true);
    expect(roundStandings([member(1, 3), member(1, 4)]).get(1)!.exhausted).toBe(true);
  });

  it('but not while a sellable remainder is still in it', () => {
    expect(roundStandings([member(1, 0), member(1, 12_992.89)]).get(1)!.exhausted).toBe(false);
  });

  /**
   * A crumb must not hold the round open for ever. One financer who stops
   * 3 LANA short cannot sell that 3 LANA — it is under the smallest purchase
   * the treasury makes — so waiting for it is waiting for something that can
   * never arrive, and everybody in the next round waits with it.
   */
  it('a crumb nobody can sell does not hold the round open', () => {
    const justUnder = roundStandings([member(1, 99)]).get(1)!;
    expect(justUnder.exhausted).toBe(true);
    const justOver = roundStandings([member(1, 101)]).get(1)!;
    expect(justOver.exhausted).toBe(false);
    expect(ROUND_CLOSE_FLOOR_LANOSHIS).toBe(100 * LANA);
  });

  /**
   * THE ONE THAT MATTERS MOST. Mandates arrive one signed event at a time, and
   * a relay that does not answer returns an empty list that looks exactly like
   * "there are none". If silence counted as completion, round 2 would open at
   * the top of a window — before round 1's mandates had even been fetched —
   * and round-2 financers would be served ahead of round 1. That is the
   * treasury's published order, run backwards.
   */
  it('SILENCE IS NOT COMPLETION: a round nobody has seen is not spent', () => {
    const s = roundStandings([member(2, 5_000)]);
    expect(s.get(1)).toBeUndefined();
    expect(sequenceOpenings({
      openings: [opening({ round: 2 })],
      standings: s,
      syncFresh: true,
    })).toEqual([]);
  });
});

describe('whether a round is open', () => {
  it('opens on its date, as it always did', () => {
    const o = opening({ round: 2, opensMode: 'date', opensAt: NOW - 1 });
    expect(roundIsOpen(o, NOW)).toBe(true);
    expect(roundIsOpen({ ...o, opensAt: NOW + 1 }, NOW)).toBe(false);
  });

  it('opens on a recorded turn, with no date anywhere', () => {
    expect(roundIsOpen(opening({ round: 2, openedAt: NOW - 1 }), NOW)).toBe(true);
  });

  /**
   * The date and the turn are not rivals — whichever comes first opens it, and
   * neither pushes the other back. Split 8 round 2 carries 26 October: under
   * this rule it may open sooner, and it can never open later, so nobody is
   * made to wait longer than the date they were already shown.
   */
  it('whichever comes first wins, and neither ever delays the other', () => {
    const dated = opening({ round: 2, opensMode: 'sequence', opensAt: NOW + 10_000 });
    expect(roundIsOpen(dated, NOW)).toBe(false);
    expect(roundIsOpen({ ...dated, openedAt: NOW - 1 }, NOW)).toBe(true);
    const turnedButNotYetDue = opening({ round: 2, opensAt: NOW + 10_000, openedAt: NOW + 10 });
    expect(roundIsOpen(turnedButNotYetDue, NOW)).toBe(false);
    expect(roundIsOpen(turnedButNotYetDue, NOW + 20)).toBe(true);
  });

  it('a round with neither stays shut, and says it can never open', () => {
    const bare = opening({ round: 2, opensMode: null });
    expect(roundIsOpen(bare, NOW)).toBe(false);
    expect(roundCanEverOpen(bare)).toBe(false);
    expect(roundCanEverOpen(opening({ round: 2 }))).toBe(true);
    expect(roundCanEverOpen(opening({ round: 2, opensMode: null, opensAt: NOW }))).toBe(true);
  });
});

describe('which turns have come', () => {
  const spent = roundStandings([member(1, 0)]);

  it('round 1 opens with the window itself — it waits for nothing', () => {
    expect(sequenceOpenings({ openings: [opening({ round: 1 })], standings: new Map(), syncFresh: true }))
      .toEqual([{ round: 1, trigger: 'window opened' }]);
  });

  it('round 2 opens when round 1 is spent, and says so in the record', () => {
    const out = sequenceOpenings({ openings: [opening({ round: 2 })], standings: spent, syncFresh: true });
    expect(out).toHaveLength(1);
    expect(out[0].round).toBe(2);
    expect(out[0].trigger).toMatch(/round 1 spent/);
  });

  it('a round already recorded is not recorded twice', () => {
    expect(sequenceOpenings({
      openings: [opening({ round: 2, openedAt: NOW - 5 })], standings: spent, syncFresh: true,
    })).toEqual([]);
  });

  it('a round on a date is left alone — sequence only speaks for sequence rounds', () => {
    expect(sequenceOpenings({
      openings: [opening({ round: 2, opensMode: 'date', opensAt: NOW })], standings: spent, syncFresh: true,
    })).toEqual([]);
    expect(sequenceOpenings({
      openings: [opening({ round: 2, opensMode: null })], standings: spent, syncFresh: true,
    })).toEqual([]);
  });

  /**
   * Exhaustion is read off mandates, and mandates come from relays. If we have
   * not verifiably heard from one recently, what we hold is a guess, and a
   * guess is not a reason to open a treasury cap.
   */
  it('nothing opens while we have not heard from the relays', () => {
    expect(sequenceOpenings({ openings: [opening({ round: 2 })], standings: spent, syncFresh: false }))
      .toEqual([]);
    expect(sequenceOpenings({ openings: [opening({ round: 1 })], standings: new Map(), syncFresh: false }))
      .toEqual([]);
  });

  it('does not skip a round: round 3 waits for round 2, not for round 1', () => {
    const r1SpentR2Live = roundStandings([member(1, 0), member(2, 5_000)]);
    expect(sequenceOpenings({ openings: [opening({ round: 3 })], standings: r1SpentR2Live, syncFresh: true }))
      .toEqual([]);
    const bothSpent = roundStandings([member(1, 0), member(2, 0)]);
    expect(sequenceOpenings({ openings: [opening({ round: 3 })], standings: bothSpent, syncFresh: true }))
      .toHaveLength(1);
  });
});

/**
 * MONOTONICITY — the property the whole "write it down" design exists for.
 *
 * `consumed` counts live offers, and a live offer can expire, which hands its
 * mandate's LANA back. Recomputed on every read, "round 1 is spent" would go
 * true, then false, then true, and round 2 would open and shut under the
 * people standing in front of it. Recorded once, it cannot.
 */
describe('an opening cannot un-happen', () => {
  it('an offer expiring puts money back in round 1 and round 2 stays open', () => {
    const openings = [opening({ round: 2 })];
    const emptied = roundStandings([member(1, 0)]);
    const [turn] = sequenceOpenings({ openings, standings: emptied, syncFresh: true });
    expect(turn.round).toBe(2);

    // The record is written; then the offer that emptied round 1 lapses.
    const recorded = [opening({ round: 2, openedAt: NOW - 1 })];
    const refilled = roundStandings([member(1, 32_545)]);
    expect(refilled.get(1)!.exhausted).toBe(false);
    expect(roundIsOpen(recorded[0], NOW)).toBe(true);
    // …and nothing asks for it to be recorded again, so nothing changes.
    expect(sequenceOpenings({ openings: recorded, standings: refilled, syncFresh: true })).toEqual([]);
  });

  it('round 1 keeps its own money when its turn passes to round 2', () => {
    // Round 1 is not "closed" in the sense of unsellable — the treasury simply
    // stops waiting for it. Anything that comes back is still sellable, and the
    // decision loop still tries round 1 first.
    const s = roundStandings([member(1, 32_545), member(2, 5_000)]);
    expect(s.get(1)!.remainingLanoshis).toBeGreaterThan(0);
  });
});
