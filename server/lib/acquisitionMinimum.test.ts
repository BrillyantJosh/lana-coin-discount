// @vitest-environment node
/**
 * The minimum was enforced at the end and invited at the start. These pin that
 * one question now has one answer — and that the answer is the one the two
 * refusals in acquisitions.ts actually ask (on the reference GROSS, not on the
 * purchase price).
 */
import { describe, it, expect } from 'vitest';
import {
  minimumFiatFor, belowMinimum, proposalTooSmall, smallestProposableLana,
} from './acquisitionMinimum';

describe('the smallest sale worth making', () => {
  it('reads the setting the admin screen writes, per currency', () => {
    const s = { min_sell_eur: '25', min_sell_gbp: '20' };
    expect(minimumFiatFor(s, 'EUR')).toBe(25);
    expect(minimumFiatFor(s, 'eur')).toBe(25);
    expect(minimumFiatFor(s, 'GBP')).toBe(20);
    expect(minimumFiatFor(s, 'USD')).toBe(0);   // not set = no minimum
  });

  it('treats a blank, zero or broken setting as no minimum, never as "refuse everything"', () => {
    for (const v of ['', '0', 'abc', '-5']) {
      expect(minimumFiatFor({ min_sell_eur: v }, 'EUR')).toBe(0);
      expect(proposalTooSmall(0.73, 0.256, minimumFiatFor({ min_sell_eur: v }, 'EUR'))).toBe(false);
    }
  });

  /** 0.73 LANA at 0.256 is 18.7 cents. The figure the page was offering. */
  it('says the 11 Sept crumb is too small, and by how far', () => {
    expect(proposalTooSmall(0.73, 0.256, 25)).toBe(true);
    expect(smallestProposableLana(0.256, 25)).toBe(97.66);   // 25 / 0.256 = 97.65625, rounded UP
    // The figure shown must itself clear the bar — rounding DOWN would print a
    // number that is refused the moment somebody types it.
    expect(proposalTooSmall(smallestProposableLana(0.256, 25)!, 0.256, 25)).toBe(false);
  });

  it('is the same comparison the refusal makes, on the reference gross', () => {
    // acquisitions.ts: `minSell > 0 && priced.grossFiat < minSell`
    expect(belowMinimum(24.99, 25)).toBe(true);
    expect(belowMinimum(25, 25)).toBe(false);      // not below: equal clears it
    expect(belowMinimum(25.01, 25)).toBe(false);
  });

  it('says nothing at all when there is no reference to price against', () => {
    // A round with no terms yet has no rate. Silence is the only honest answer;
    // claiming "too small" would hide LANA that may well be sellable tomorrow.
    expect(proposalTooSmall(0.73, null, 25)).toBe(false);
    expect(smallestProposableLana(null, 25)).toBeNull();
    expect(smallestProposableLana(0, 25)).toBeNull();
  });

  it('calls nothing at all too small, because nothing is not a proposal', () => {
    expect(proposalTooSmall(0, 0.256, 25)).toBe(true);
  });
});
