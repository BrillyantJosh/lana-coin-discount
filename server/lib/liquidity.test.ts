/**
 * The net FIAT position line. What matters here is the crossing — whether a
 * given day sits above or below zero — so the tests are mostly about the
 * running sum being a running sum: over every day since the first, never over
 * a display window, and never drifting from repeated rounding.
 */
import { describe, it, expect } from 'vitest';
import { buildLiquiditySeries, impliedCrossRate, dateRange, type FlowRow } from './liquidity';

const RATES = { EUR: 0.128, GBP: 0.11 }; // 1 LANA = €0.128 = £0.11  ->  £1 = €1.1636…
const flat = (day: string, currency: string, received: number, paid: number): FlowRow =>
  ({ day, currency, received, paid });

describe('impliedCrossRate — EUR per 1 unit, from the two LANA quotes', () => {
  it('EUR is 1 by definition', () => {
    expect(impliedCrossRate('EUR', RATES)).toBe(1);
  });

  it('divides the two quotes', () => {
    expect(impliedCrossRate('GBP', RATES)).toBeCloseTo(0.128 / 0.11, 10);
  });

  it('IDENTICAL quotes give exactly 1 — the collapse the UI has to show', () => {
    // This is the live condition today: EUR and GBP are both 0.128, so the
    // pivot is not converting anything. The function must not hide that.
    expect(impliedCrossRate('GBP', { EUR: 0.128, GBP: 0.128 })).toBe(1);
  });

  it('a missing or zero quote is null, never 1', () => {
    expect(impliedCrossRate('GBP', { EUR: 0.128 })).toBeNull();
    expect(impliedCrossRate('GBP', { EUR: 0.128, GBP: 0 })).toBeNull();
    expect(impliedCrossRate('CHF', { EUR: 0, CHF: 0.1 })).toBeNull();
  });
});

describe('dateRange', () => {
  it('is inclusive at both ends', () => {
    expect(dateRange('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });
  it('a single day is one point', () => {
    expect(dateRange('2026-05-05', '2026-05-05')).toEqual(['2026-05-05']);
  });
});

describe('the running balance', () => {
  it('accumulates across days and reports the closing position', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 100, 0),
      flat('2026-01-02', 'EUR', 0, 40),
      flat('2026-01-03', 'EUR', 0, 90),
    ], RATES);
    expect(s.days.map((d) => d.byCur.EUR.cum)).toEqual([100, 60, -30]);
    expect(s.balance.byCur.EUR).toBe(-30);
    expect(s.totals.byCur.EUR).toEqual({ in: 100, out: 130, net: -30 });
  });

  it('fills quiet days so the line is continuous, and keeps the level flat across them', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 50, 0),
      flat('2026-01-04', 'EUR', 0, 20),
    ], RATES);
    expect(s.days.map((d) => d.day)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(s.days.map((d) => d.byCur.EUR.cum)).toEqual([50, 50, 50, 30]);
  });

  it('extends to today so a drought is visible as a flat tail', () => {
    const s = buildLiquiditySeries([flat('2026-01-01', 'EUR', 10, 0)], RATES, '2026-01-05');
    expect(s.days).toHaveLength(5);
    expect(s.days[4].byCur.EUR.cum).toBe(10);
    expect(s.lastDay).toBe('2026-01-05');
  });

  it('an endDay before the last activity does NOT truncate real data', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 10, 0),
      flat('2026-01-09', 'EUR', 5, 0),
    ], RATES, '2026-01-03');
    expect(s.lastDay).toBe('2026-01-09');
    expect(s.balance.byCur.EUR).toBe(15);
  });

  it('THE CROSSING: reports where the line goes from below zero to above it', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 0, 100),
      flat('2026-01-02', 'EUR', 30, 0),
      flat('2026-01-03', 'EUR', 200, 0),
    ], RATES);
    const cums = s.days.map((d) => d.byCur.EUR.cum);
    expect(cums).toEqual([-100, -70, 130]);
    expect(cums.filter((c) => c < 0)).toHaveLength(2);
  });

  it('records the true low and high of the EUR line, and always includes zero', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 0, 500),
      flat('2026-01-02', 'EUR', 900, 0),
    ], RATES);
    expect(s.eurRange).toEqual({ min: -500, max: 400 });
    // Even an all-positive line keeps zero in the domain, so "above zero" is legible.
    const up = buildLiquiditySeries([flat('2026-01-01', 'EUR', 100, 0)], RATES);
    expect(up.eurRange.min).toBe(0);
  });

  it('does not drift over a long series of amounts that do not round cleanly', () => {
    // 0.1 + 0.2 territory: 300 days of a third of a cent each way.
    const rows: FlowRow[] = [];
    for (let i = 0; i < 300; i++) {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      rows.push(flat(day, 'EUR', 0.07, 0.01));
    }
    const s = buildLiquiditySeries(rows, RATES);
    expect(s.balance.byCur.EUR).toBe(18); // 300 × 0.06, exactly
  });
});

describe('combining currencies through the LANA pivot', () => {
  it('converts GBP at the implied rate and sums it into the EUR line', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 100, 0),
      flat('2026-01-01', 'GBP', 100, 0),
    ], RATES);
    // £100 -> €116.36
    expect(s.days[0].eur.cum).toBeCloseTo(100 + 100 * (0.128 / 0.11), 2);
    expect(s.balance.byCur.GBP).toBe(100);
  });

  it('keeps each currency honest in its own units regardless of the pivot', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'GBP', 0, 50),
      flat('2026-01-02', 'GBP', 80, 0),
    ], RATES);
    expect(s.days.map((d) => d.byCur.GBP.cum)).toEqual([-50, 30]);
  });

  it('IDENTICAL quotes: the combined figure is a plain addition, and the rate says so', () => {
    // Today's live condition. The total is EUR + GBP added at 1:1; the panel
    // publishes crossRates so a reader sees GBP = 1.00 rather than assuming FX.
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 100, 0),
      flat('2026-01-01', 'GBP', 100, 0),
    ], { EUR: 0.128, GBP: 0.128 });
    expect(s.crossRates.GBP).toBe(1);
    expect(s.balance.eur).toBe(200);
  });

  it('a currency with no usable quote is NAMED, not silently folded in at 1:1', () => {
    const s = buildLiquiditySeries([
      flat('2026-01-01', 'EUR', 100, 0),
      flat('2026-01-01', 'CHF', 0, 5000),
    ], RATES);
    expect(s.unconvertible).toEqual(['CHF']);
    expect(s.crossRates.CHF).toBeUndefined();
    expect(s.balance.eur).toBe(100);        // CHF excluded from the combined figure…
    expect(s.balance.byCur.CHF).toBe(-5000); // …but still fully reported on its own
  });
});

describe('degenerate input', () => {
  it('no rows at all is an empty, harmless series', () => {
    const s = buildLiquiditySeries([], RATES);
    expect(s.days).toEqual([]);
    expect(s.balance.eur).toBe(0);
    expect(s.firstDay).toBeNull();
    expect(s.eurRange).toEqual({ min: 0, max: 0 });
  });

  it('a day where in equals out moves the line by nothing', () => {
    const s = buildLiquiditySeries([flat('2026-01-01', 'EUR', 250, 250)], RATES);
    expect(s.balance.byCur.EUR).toBe(0);
    expect(s.days[0].byCur.EUR.net).toBe(0);
  });
});
