import { describe, it, expect } from 'vitest';
import {
  owedLana, isPaid, matchesSettlement, settlementCounts, type SettlementShape,
} from './mandateSettlement';

const m = (expectedLana: number, settledLana: number): SettlementShape => ({ expectedLana, settledLana });

describe('what the treasury still has to acquire', () => {
  it('is the part of the mandate that has not completed', () => {
    expect(owedLana(m(12_992.89, 0))).toBeCloseTo(12_992.89, 8);
    expect(owedLana(m(12_992.89, 5_000))).toBeCloseTo(7_992.89, 8);
    expect(owedLana(m(12_992.89, 12_992.89))).toBe(0);
  });

  /**
   * A re-allocation can shrink what a budget received below what was already
   * bought from it. The row carries its own warning for that; a negative
   * "still owed" would also quietly subtract from the total below.
   */
  it('never goes negative when a budget shrinks under a completed purchase', () => {
    expect(owedLana(m(1_000, 1_500))).toBe(0);
  });

  it('treats a difference smaller than a lanoshi as no difference', () => {
    expect(owedLana(m(100, 100 - 1e-9))).toBe(0);
    expect(owedLana(m(100, 99.999_999_99))).toBe(0);
  });

  it('a tombstoned mandate with nothing on it owes nothing', () => {
    expect(isPaid(m(0, 0))).toBe(true);
  });
});

/**
 * THE ONE THAT DECIDES WHETHER THIS FILTER IS USEFUL AT ALL.
 *
 * `remaining` reaches zero the moment a live offer reserves the last of a
 * mandate — but a live offer is not money, it is a question the seller has not
 * answered, and the cap comes straight back if they let it lapse. Filtering on
 * that would file the rows an operator is hunting for under "paid".
 */
describe('an offer in flight is not a payment', () => {
  it('a mandate fully reserved by an unanswered offer is still unpaid', () => {
    // expected 32,488.67 · proposed/accepted the whole of it · settled nothing.
    expect(isPaid(m(32_488.67, 0))).toBe(false);
    expect(owedLana(m(32_488.67, 0))).toBeCloseTo(32_488.67, 8);
  });

  it('and becomes paid only once the purchase completes', () => {
    expect(isPaid(m(32_488.67, 32_488.67))).toBe(true);
  });

  it('a half-sold mandate whose rest lapsed stays unpaid — that LANA is still theirs', () => {
    expect(isPaid(m(1_000, 500))).toBe(false);
  });
});

describe('choosing what to look at', () => {
  const rows = [m(100, 100), m(100, 0), m(100, 40), m(0, 0)];

  it('all shows everything, including rows with nothing on them', () => {
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

  it('an empty list is empty rather than zero of everything owed', () => {
    expect(settlementCounts([])).toEqual({ all: 0, paid: 0, unpaid: 0, owedLana: 0 });
  });

  it('adds the owed LANA to the lanoshi, not to a rounded guess', () => {
    expect(settlementCounts([m(12_992.890_625, 0), m(19_530.234_375, 0)]).owedLana)
      .toBe(32_523.125);
  });
});
