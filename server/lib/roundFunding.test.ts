// @vitest-environment node
/**
 * WHAT EACH ROUND COSTS — and the two ways a money figure may be wrong.
 *
 * The projection has to equal the money that would really leave the treasury,
 * so the arithmetic here is checked against priceAcquisition's own shape
 * (gross to the cent, discount to the cent, price to the cent) rather than
 * against a formula written twice.
 *
 * The other half of the file is about refusing to make a number up: no rate,
 * no discount, or a Split outside the mandate's window each leave the figure
 * null with a reason, because a confident zero on this page would be read as
 * "this round costs nothing".
 */
import { describe, it, expect } from 'vitest';
import { fundingByRound, type FundingInput, type FundingMandate, type FundingOffer } from './roundFunding';

const LANA = 100_000_000;
const lanoshis = (lana: number) => Math.round(lana * LANA);

const mandate = (over: Partial<FundingMandate> & { dTag: string; round: number }): FundingMandate => ({
  split: 8,
  status: 'announced',
  wallets: [{ currency: 'EUR', lanaLanoshis: lanoshis(1000) }],
  ...over,
});

const input = (over: Partial<FundingInput> = {}): FundingInput => ({
  split: 8,
  currentSplit: 8,
  mandates: [mandate({ dTag: '8:1:a', round: 1 })],
  offers: [],
  terms: [{ round: 1, discountPercent: 22 }, { round: 2, discountPercent: 25 }],
  rates: { EUR: 0.128, GBP: 0.11 },
  ...over,
});

const round = (out: ReturnType<typeof fundingByRound>, n: number) => out.find(r => r.round === n)!;
const cur = (out: ReturnType<typeof fundingByRound>, n: number, c: string) =>
  round(out, n).currencies.find(x => x.currency === c)!;

describe('fundingByRound', () => {
  it('prices the whole round at twice the live rate while the mandate Split is still running', () => {
    const out = fundingByRound(input());
    const eur = cur(out, 1, 'EUR');
    expect(eur.basis).toBe('projected_next_split');
    expect(eur.referenceRate).toBeCloseTo(0.256, 10);
    // 1000 LANA × 0.256 = 256.00 gross, 22 % = 56.32, price 199.68
    expect(eur.fiatExpected).toBe(199.68);
    expect(eur.fiatRemaining).toBe(199.68);
    expect(eur.lanaExpected).toBe(1000);
  });

  it('uses the live rate once the Split has landed — the doubling is already in it', () => {
    const out = fundingByRound(input({ currentSplit: 9 }));
    const eur = cur(out, 1, 'EUR');
    expect(eur.basis).toBe('current_split');
    expect(eur.referenceRate).toBe(0.128);
    expect(eur.fiatExpected).toBe(99.84);   // 128.00 gross − 22 %
  });

  it('keeps rounds apart, each on its own discount', () => {
    const out = fundingByRound(input({
      mandates: [
        mandate({ dTag: '8:1:a', round: 1 }),
        mandate({ dTag: '8:2:b', round: 2 }),
      ],
    }));
    expect(cur(out, 1, 'EUR').discountPercent).toBe(22);
    expect(cur(out, 2, 'EUR').discountPercent).toBe(25);
    expect(cur(out, 1, 'EUR').fiatExpected).toBe(199.68);
    expect(cur(out, 2, 'EUR').fiatExpected).toBe(192);      // 256.00 − 25 %
    expect(round(out, 1).mandateCount).toBe(1);
    expect(round(out, 2).mandateCount).toBe(1);
  });

  it('keeps currencies apart inside one round, including a financer holding both', () => {
    const out = fundingByRound(input({
      mandates: [mandate({
        dTag: '8:1:a', round: 1,
        wallets: [
          { currency: 'EUR', lanaLanoshis: lanoshis(1000) },
          { currency: 'GBP', lanaLanoshis: lanoshis(500) },
        ],
      })],
    }));
    expect(cur(out, 1, 'EUR').lanaExpected).toBe(1000);
    expect(cur(out, 1, 'GBP').lanaExpected).toBe(500);
    // GBP: 500 × 0.22 = 110.00 gross, 22 % = 24.20, price 85.80
    expect(cur(out, 1, 'GBP').fiatRemaining).toBe(85.8);
    expect(round(out, 1).totalsByCurrency).toEqual({ EUR: 199.68, GBP: 85.8 });
  });

  it('takes settled and accepted out of what is still to pay, and reports their REAL prices', () => {
    const offers: FundingOffer[] = [
      { mandateRef: '8:1:a', currency: 'EUR', status: 'settled', lanoshis: lanoshis(400), purchasePriceFiat: 79.87, live: false },
      { mandateRef: '8:1:a', currency: 'EUR', status: 'accepted', lanoshis: lanoshis(100), purchasePriceFiat: 19.97, live: false },
    ];
    const eur = cur(fundingByRound(input({ offers })), 1, 'EUR');
    expect(eur.lanaSettled).toBe(400);
    expect(eur.lanaAccepted).toBe(100);
    expect(eur.lanaRemaining).toBe(500);
    expect(eur.fiatRemaining).toBe(99.84);        // 500 LANA at the projection
    expect(eur.fiatSettled).toBe(79.87);          // what was actually paid
    expect(eur.fiatAccepted).toBe(19.97);         // what was actually agreed
    // The whole round is still reported at its full size.
    expect(eur.fiatExpected).toBe(199.68);
  });

  it('reserves a live proposal and frees a lapsed one', () => {
    const base: FundingOffer = { mandateRef: '8:1:a', currency: 'EUR', status: 'offered', lanoshis: lanoshis(300), purchasePriceFiat: 59.9, live: true };
    const reserved = cur(fundingByRound(input({ offers: [base] })), 1, 'EUR');
    expect(reserved.lanaProposed).toBe(300);
    expect(reserved.lanaRemaining).toBe(700);

    const lapsed = cur(fundingByRound(input({ offers: [{ ...base, live: false }] })), 1, 'EUR');
    expect(lapsed.lanaProposed).toBe(0);
    expect(lapsed.lanaRemaining).toBe(1000);
  });

  it('ignores declined and withdrawn offers, and offers against a mandate that is not live', () => {
    const out = fundingByRound(input({
      mandates: [mandate({ dTag: '8:1:a', round: 1 }), mandate({ dTag: '8:1:z', round: 1, status: 'closed' })],
      offers: [
        { mandateRef: '8:1:a', currency: 'EUR', status: 'declined', lanoshis: lanoshis(900), purchasePriceFiat: null, live: false },
        { mandateRef: '8:1:a', currency: 'EUR', status: 'withdrawn', lanoshis: lanoshis(900), purchasePriceFiat: null, live: false },
        { mandateRef: '8:1:z', currency: 'EUR', status: 'settled', lanoshis: lanoshis(900), purchasePriceFiat: 500, live: false },
      ],
    }));
    const eur = cur(out, 1, 'EUR');
    expect(eur.lanaExpected).toBe(1000);     // the closed mandate carries nothing
    expect(eur.lanaRemaining).toBe(1000);
    expect(eur.fiatSettled).toBe(0);
    expect(round(out, 1).mandateCount).toBe(1);
  });

  it('never invents a figure: no rate, no discount and a Split outside the window each say why', () => {
    const noRate = cur(fundingByRound(input({ rates: { EUR: 0 } })), 1, 'EUR');
    expect(noRate.fiatRemaining).toBeNull();
    expect(noRate.gaps).toContain('NO_RATE');

    const noDiscount = cur(fundingByRound(input({ terms: [{ round: 1, discountPercent: null }] })), 1, 'EUR');
    expect(noDiscount.fiatRemaining).toBeNull();
    expect(noDiscount.gaps).toContain('NO_DISCOUNT');
    expect(noDiscount.referenceRate).toBeCloseTo(0.256, 10);   // the rate is still known

    const passed = cur(fundingByRound(input({ currentSplit: 10 })), 1, 'EUR');
    expect(passed.fiatRemaining).toBeNull();
    expect(passed.gaps).toContain('NO_REFERENCE');

    const unknown = cur(fundingByRound(input({ currentSplit: null })), 1, 'EUR');
    expect(unknown.fiatRemaining).toBeNull();
    expect(unknown.gaps).toContain('NO_REFERENCE');
  });

  it('rounds the way a real purchase price is built — gross, then discount, each to the cent', () => {
    // 32527.96875 LANA is a live budget figure. Two steps to the cent give
    // 6495.18; multiplying straight through (lana x rate x 0.78) gives
    // 6495.19. The treasury pays the two-step figure, because that is how
    // priceAcquisition builds a purchase price, so that is what this forecasts.
    // The indicative tag on the KIND 30960 event uses the one-step form and
    // may therefore sit a cent away; it is informational and never binding.
    const out = fundingByRound(input({
      mandates: [mandate({ dTag: '8:1:a', round: 1, wallets: [{ currency: 'EUR', lanaLanoshis: lanoshis(32527.96875) }] })],
    }));
    const eur = cur(out, 1, 'EUR');
    const gross = Math.round(32527.96875 * 0.256 * 100) / 100;
    const discount = Math.round(gross * 22 / 100 * 100) / 100;
    expect(eur.fiatExpected).toBe(Math.round((gross - discount) * 100) / 100);
    expect(eur.fiatExpected).toBe(6495.18);
  });

  it('lists a round that has terms but no mandates yet, so an empty round is visible', () => {
    const out = fundingByRound(input({ mandates: [] }));
    expect(out.map(r => r.round)).toEqual([1, 2]);
    expect(round(out, 1).mandateCount).toBe(0);
    expect(round(out, 1).currencies).toEqual([]);
  });
});
