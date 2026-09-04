// @vitest-environment node
/**
 * The arithmetic behind every purchase price: class discount by default,
 * the round's discount when the mandate path says so, and never a price
 * when there is no reference.
 */
import { describe, it, expect } from 'vitest';
import { priceAcquisition } from '../routes/acquisitions';

const rates = { EUR: 0.256, GBP: 0.22 };
const settings = { commission_lanapays: '21', commission_other: '30' };

describe('priceAcquisition', () => {
  it('prices a LanaPays.Us wallet at the class discount by default', () => {
    const p = priceAcquisition(1000, 'EUR', 'lanapays', { rates, settings })!;
    expect(p.referenceRate).toBe(0.256);
    expect(p.discountPercent).toBe(21);
    expect(p.grossFiat).toBe(256);
    expect(p.discountFiat).toBe(53.76);
    expect(p.purchasePriceFiat).toBe(202.24);
  });

  it('prices any other wallet at the other discount', () => {
    const p = priceAcquisition(1000, 'EUR', 'other', { rates, settings })!;
    expect(p.discountPercent).toBe(30);
    expect(p.purchasePriceFiat).toBe(179.2);
  });

  it("a round's discount overrides the class discount — the plan's worked example", () => {
    // 32,527.97 LANA × 0.256 × (1 − 22 %) = 6,495.19 (contract example)
    const p = priceAcquisition(32527.97, 'EUR', 'lanapays', { rates, settings, discountPercent: 22 })!;
    expect(p.discountPercent).toBe(22);
    expect(p.grossFiat).toBe(8327.16);
    expect(p.purchasePriceFiat).toBe(6495.18);
  });

  it('falls back to the seeded 21 / 30 when the settings rows are missing', () => {
    expect(priceAcquisition(100, 'EUR', 'lanapays', { rates, settings: {} })!.discountPercent).toBe(21);
    expect(priceAcquisition(100, 'EUR', 'other', { rates, settings: {} })!.discountPercent).toBe(30);
  });

  it('a discount of 0 is honoured as 0, not treated as unset', () => {
    expect(priceAcquisition(100, 'EUR', 'lanapays', { rates, settings, discountPercent: 0 })!.purchasePriceFiat).toBe(25.6);
  });

  it('no reference rate → no price', () => {
    expect(priceAcquisition(100, 'USD', 'lanapays', { rates, settings })).toBeNull();
    expect(priceAcquisition(100, 'EUR', 'lanapays', { rates: { EUR: 0 }, settings })).toBeNull();
  });

  it('rounds to cents at each step, the way the ledger stores them', () => {
    const p = priceAcquisition(3, 'GBP', 'lanapays', { rates, settings, discountPercent: 25 })!;
    expect(p.grossFiat).toBe(0.66);
    expect(p.discountFiat).toBe(0.17);
    expect(p.purchasePriceFiat).toBe(0.49);
  });
});
