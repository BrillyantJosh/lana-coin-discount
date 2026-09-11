import { describe, it, expect } from 'vitest';
import {
  owedLana, isPaid, matchesSettlement, settlementCounts, type SettlementShape,
} from './mandateSettlement';

/** unsoldLana, and whether anybody could still sell it — the server's answer. */
const m = (unsoldLana: number, unsoldSellable: boolean): SettlementShape => ({ unsoldLana, unsoldSellable });

describe('what the treasury still has to acquire', () => {
  it('is what is left unsold, while it can still be sold', () => {
    expect(owedLana(m(12_992.89, true))).toBeCloseTo(12_992.89, 8);
    expect(owedLana(m(7_992.89, true))).toBeCloseTo(7_992.89, 8);
    expect(owedLana(m(0, false))).toBe(0);
  });

  /**
   * THE ONE THE OWNER CAUGHT — 11 Sept 2026.
   *
   * Boštjan Zajc's mandate was for 32,535.08 LANA and 32,535.06 arrived. He
   * had been bought out and paid, and the 0.02 LANA left over — a figure the
   * offer route would refuse as below the minimum, and the round steps over as
   * a crumb — put him in the unpaid list beside people who had sold nothing.
   * A remainder nobody can sell is not a debt.
   */
  it('a crumb too small to sell is NOT owed, however the subtraction reads', () => {
    const bostjan = m(0.02, false);
    expect(owedLana(bostjan)).toBe(0);
    expect(isPaid(bostjan)).toBe(true);
  });

  it('but a remainder that could still be sold is owed, however small it looks', () => {
    expect(isPaid(m(8.4, true))).toBe(false);
    expect(owedLana(m(8.4, true))).toBeCloseTo(8.4, 8);
  });

  it('a tombstoned mandate with nothing on it owes nothing', () => {
    expect(isPaid(m(0, false))).toBe(true);
  });

  /**
   * The rate and the per-currency minimum live on the server, and the browser
   * has neither. A second opinion built out of neither is how a screen and a
   * gate come to disagree about the same LANA, so this module takes the
   * server's word and never overrides it.
   */
  it('never second-guesses the server: sellable is sellable, small or not', () => {
    expect(isPaid(m(0.000_000_01, true))).toBe(false);
    expect(isPaid(m(9_999, false))).toBe(true);
  });
});

/**
 * `remaining` reaches zero the moment a live offer reserves the last of a
 * mandate — but a live offer is not money, it is a question the seller has not
 * answered, and the cap comes back if they let it lapse.
 */
describe('an offer in flight is not a payment', () => {
  it('a mandate fully reserved by an unanswered offer is still unpaid', () => {
    // Gašper Zorman: expected 32,488.67, all of it in a live offer, nothing
    // settled — so unsold is the whole amount and plainly sellable.
    const gasper = m(32_488.67, true);
    expect(isPaid(gasper)).toBe(false);
    expect(owedLana(gasper)).toBeCloseTo(32_488.67, 8);
  });

  it('and becomes paid once the purchase completes and only a crumb is left', () => {
    expect(isPaid(m(0.018, false))).toBe(true);
  });

  it('a half-sold mandate whose rest lapsed stays unpaid — that LANA is still theirs', () => {
    expect(isPaid(m(500, true))).toBe(false);
  });
});

describe('choosing what to look at', () => {
  const rows = [m(0, false), m(100, true), m(60, true), m(0.02, false)];

  it('all shows everything, including the finished ones', () => {
    expect(rows.filter(r => matchesSettlement(r, 'all'))).toHaveLength(4);
  });

  it('paid and unpaid split the list in two, with nothing lost between them', () => {
    const paid = rows.filter(r => matchesSettlement(r, 'paid'));
    const unpaid = rows.filter(r => matchesSettlement(r, 'unpaid'));
    expect(paid).toHaveLength(2);
    expect(unpaid).toHaveLength(2);
    expect(paid.length + unpaid.length).toBe(rows.length);
  });

  it('counts each choice, and how much LANA the unpaid ones are holding', () => {
    expect(settlementCounts(rows)).toEqual({ all: 4, paid: 2, unpaid: 2, owedLana: 160 });
  });

  it('leaves the unsellable crumbs OUT of the total, not just out of the count', () => {
    expect(settlementCounts([m(0.02, false), m(0.018, false)]).owedLana).toBe(0);
  });

  it('an empty list is empty rather than zero of everything owed', () => {
    expect(settlementCounts([])).toEqual({ all: 0, paid: 0, unpaid: 0, owedLana: 0 });
  });

  it('adds the owed LANA to the lanoshi, not to a rounded guess', () => {
    expect(settlementCounts([m(12_992.890_625, true), m(19_530.234_375, true)]).owedLana)
      .toBe(32_523.125);
  });
});
