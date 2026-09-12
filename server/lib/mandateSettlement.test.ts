import { describe, it, expect } from 'vitest';
import {
  categorise, parseSettlementParam, settlementCounts, SETTLEMENT_CATEGORIES,
  type MandateSettlementInput,
} from './mandateSettlement.js';

const m = (expectedLana: number, settledLana: number, unsoldSellable: boolean): MandateSettlementInput =>
  ({ expectedLana, settledLana, unsoldSellable });

describe('where one mandate stands', () => {
  it('untouched: nothing sold, and what is there can be', () => {
    expect(categorise(m(3_191.17, 0, true))).toBe('none');
  });

  /**
   * Primož Medjo, the row that started this: 2,510 of 3,191.17 LANA sold and
   * paid for, 681.17 left. He had had money and was sitting in the same box as
   * people who had had none.
   */
  it('part sold: money has changed hands and there is still something to sell', () => {
    expect(categorise(m(3_191.17, 2_510, true))).toBe('partly');
  });

  it('finished: nothing left that anybody could sell', () => {
    expect(categorise(m(3_191.17, 3_191.17, false))).toBe('paid');
  });

  /**
   * A CRUMB DOES NOT MAKE IT PART SOLD. Boštjan Zajc's transfer landed 0.02
   * LANA short of his mandate — under the smallest purchase the treasury
   * makes, refused by the offer route, stepped over by the round. He is
   * finished, and no extra threshold is needed to say so: the same test that
   * refuses the sale answers this.
   */
  it('a crumb left behind is finished, not part sold', () => {
    expect(categorise(m(32_535.08, 32_535.06, false))).toBe('paid');
  });

  /**
   * `remaining` would be zero here — an offer holds the whole mandate — and
   * calling that finished would hide the row from the one person looking for
   * it. Only a completed purchase counts.
   */
  it('a mandate wholly reserved by an unanswered offer is still untouched', () => {
    expect(categorise(m(32_488.67, 0, true))).toBe('none');
  });
});

describe('choosing more than one box', () => {
  it('nothing chosen shows everything', () => {
    for (const raw of [undefined, null, '', '   ', 'all']) {
      expect(parseSettlementParam(raw)).toEqual(new Set(SETTLEMENT_CATEGORIES));
    }
  });

  it('takes a list, in any order, with spaces', () => {
    expect(parseSettlementParam('partly,none')).toEqual(new Set(['none', 'partly']));
    expect(parseSettlementParam(' paid , partly ')).toEqual(new Set(['partly', 'paid']));
  });

  it('one box is one box', () => {
    expect(parseSettlementParam('partly')).toEqual(new Set(['partly']));
  });

  /** A link made when there were two boxes still opens what it promised. */
  it('keeps the old "unpaid" meaning the two boxes it used to cover', () => {
    expect(parseSettlementParam('unpaid')).toEqual(new Set(['none', 'partly']));
    expect(parseSettlementParam('unpaid,paid')).toEqual(new Set(SETTLEMENT_CATEGORIES));
  });

  /**
   * A stale or mistyped link shows the list rather than an empty table: an
   * operator reads an empty table as "there are none of these", which is a
   * statement about the treasury rather than about the URL.
   */
  it('shows everything rather than nothing when it understands none of it', () => {
    expect(parseSettlementParam('pink,elephants')).toEqual(new Set(SETTLEMENT_CATEGORIES));
  });

  it('ignores only the part it does not know', () => {
    expect(parseSettlementParam('partly,rubbish')).toEqual(new Set(['partly']));
  });
});

describe('the counts beside the boxes', () => {
  const rows = [
    m(100, 0, true),        // none
    m(100, 40, true),       // partly
    m(100, 100, false),     // paid
    m(100, 99.98, false),   // paid, crumb left
  ];

  it('counts each box and what is still to come', () => {
    expect(settlementCounts(rows)).toEqual({ all: 4, none: 1, partly: 1, paid: 2, owedLana: 160 });
  });

  it('leaves the crumb of a finished mandate out of the total owed', () => {
    expect(settlementCounts([m(100, 99.98, false)]).owedLana).toBe(0);
  });

  it('an empty list is empty, not zero of everything', () => {
    expect(settlementCounts([])).toEqual({ all: 0, none: 0, partly: 0, paid: 0, owedLana: 0 });
  });
});
