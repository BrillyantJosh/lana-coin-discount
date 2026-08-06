/**
 * NET FIAT POSITION — what came in from investors minus what went out to LANA
 * sellers, accumulated day by day.
 *
 * The point of the line is the crossing: on any given day, had we taken in more
 * than we had paid out, or less? It starts at zero on the first day of activity
 * and every later point is the running sum, so a single day's swing shows as a
 * step and a long drought shows as a slide.
 *
 * CURRENCIES ARE COMBINED THROUGH LANA, and that is the owner's decision.
 * KIND 38888 quotes one number per currency: how much of that currency one LANA
 * costs. Two such quotes imply a cross rate — if 1 LANA is €0.128 and £0.110,
 * then £1 is €1.164. So a GBP amount converts as (amount / gbpRate) * eurRate.
 *
 * The catch, and why `impliedCrossRate` is exported and shown in the UI: those
 * numbers are hand-typed by an admin, and when the same value is entered for
 * both currencies the pivot silently collapses to 1 GBP = 1 EUR. That is not a
 * conversion, it is an absent one. The rate is therefore always published
 * alongside the total, so "£1 = €1.00" is visible on the page rather than
 * buried in a sum. Four other places in this fleet do this same pivot without
 * showing the rate; this one shows it.
 */

export interface FlowRow {
  /** 'YYYY-MM-DD' (UTC, as SQLite date() produces). */
  day: string;
  currency: string;
  /** FIAT in from investors that day. */
  received: number;
  /** FIAT out to LANA sellers that day. */
  paid: number;
}

export interface DayPoint {
  day: string;
  /** Per currency, in its own units. */
  byCur: Record<string, { in: number; out: number; net: number; cum: number }>;
  /** All currencies converted to EUR through the LANA pivot. */
  eur: { in: number; out: number; net: number; cum: number };
}

export interface LiquiditySeries {
  days: DayPoint[];
  /** Closing position — the last day's cumulative. */
  balance: { byCur: Record<string, number>; eur: number };
  totals: {
    byCur: Record<string, { in: number; out: number; net: number }>;
    eur: { in: number; out: number; net: number };
  };
  /** EUR per 1 unit of each currency, as implied by the KIND 38888 quotes. */
  crossRates: Record<string, number>;
  /** Currencies we could not convert (no usable quote) — never silently dropped. */
  unconvertible: string[];
  firstDay: string | null;
  lastDay: string | null;
  /** Lowest and highest the EUR cumulative ever reached, for the chart domain. */
  eurRange: { min: number; max: number };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * EUR per 1 unit of `currency`, implied by the two LANA quotes.
 * Returns null when either quote is missing or zero — an absent rate must not
 * become 1.0 by accident.
 */
export function impliedCrossRate(currency: string, rates: Record<string, number>): number | null {
  if (currency === 'EUR') return 1;
  const eur = Number(rates?.EUR);
  const own = Number(rates?.[currency]);
  if (!Number.isFinite(eur) || !Number.isFinite(own) || eur <= 0 || own <= 0) return null;
  return eur / own;
}

/** Inclusive 'YYYY-MM-DD' range (UTC), so quiet days still get a point. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  let d = Date.parse(start + 'T00:00:00Z');
  const stop = Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(d) || !Number.isFinite(stop)) return out;
  let guard = 0;
  while (d <= stop && guard++ < 5000) {
    out.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  return out;
}

/**
 * Build the full series. `endDay` extends the line to today even when nothing
 * happened for a while — a flat tail is information, a missing tail is not.
 *
 * The cumulative is summed over EVERY day from the first one, never over a
 * display window: a running balance that starts partway through the history is
 * not a balance at all. Callers that only render the last N days must slice the
 * result, not the input.
 */
export function buildLiquiditySeries(
  rows: FlowRow[],
  rates: Record<string, number>,
  endDay?: string,
): LiquiditySeries {
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const crossRates: Record<string, number> = {};
  const unconvertible: string[] = [];
  for (const c of currencies) {
    const cr = impliedCrossRate(c, rates);
    if (cr === null) unconvertible.push(c);
    else crossRates[c] = cr;
  }

  const byDay = new Map<string, Map<string, { in: number; out: number }>>();
  for (const r of rows) {
    if (!r.day) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, new Map());
    const m = byDay.get(r.day)!;
    const cur = m.get(r.currency) || { in: 0, out: 0 };
    cur.in += Number(r.received) || 0;
    cur.out += Number(r.paid) || 0;
    m.set(r.currency, cur);
  }

  const active = [...byDay.keys()].sort();
  const firstDay = active[0] || null;
  if (!firstDay) {
    return {
      days: [], balance: { byCur: {}, eur: 0 },
      totals: { byCur: {}, eur: { in: 0, out: 0, net: 0 } },
      crossRates, unconvertible, firstDay: null, lastDay: null,
      eurRange: { min: 0, max: 0 },
    };
  }
  const lastActive = active[active.length - 1];
  const end = endDay && endDay > lastActive ? endDay : lastActive;

  // Accumulate in full precision; round only what leaves this function, so a
  // long series cannot drift by repeated rounding of the running total.
  const cum: Record<string, number> = {};
  const totals: Record<string, { in: number; out: number; net: number }> = {};
  let cumEur = 0;
  const totalEur = { in: 0, out: 0, net: 0 };
  let minEur = Infinity;
  let maxEur = -Infinity;

  const days: DayPoint[] = dateRange(firstDay, end).map((day) => {
    const m = byDay.get(day);
    const byCur: DayPoint['byCur'] = {};
    let dayEurIn = 0;
    let dayEurOut = 0;

    for (const c of currencies) {
      const v = m?.get(c) || { in: 0, out: 0 };
      const net = v.in - v.out;
      cum[c] = (cum[c] || 0) + net;
      const t = totals[c] || (totals[c] = { in: 0, out: 0, net: 0 });
      t.in += v.in; t.out += v.out; t.net += net;
      byCur[c] = { in: r2(v.in), out: r2(v.out), net: r2(net), cum: r2(cum[c]) };

      const cr = crossRates[c];
      if (cr !== undefined) { dayEurIn += v.in * cr; dayEurOut += v.out * cr; }
    }

    cumEur += dayEurIn - dayEurOut;
    totalEur.in += dayEurIn; totalEur.out += dayEurOut; totalEur.net += dayEurIn - dayEurOut;
    if (cumEur < minEur) minEur = cumEur;
    if (cumEur > maxEur) maxEur = cumEur;

    return {
      day, byCur,
      eur: { in: r2(dayEurIn), out: r2(dayEurOut), net: r2(dayEurIn - dayEurOut), cum: r2(cumEur) },
    };
  });

  const balanceByCur: Record<string, number> = {};
  for (const c of currencies) balanceByCur[c] = r2(cum[c] || 0);
  const roundedTotals: LiquiditySeries['totals']['byCur'] = {};
  for (const [c, t] of Object.entries(totals)) {
    roundedTotals[c] = { in: r2(t.in), out: r2(t.out), net: r2(t.net) };
  }

  return {
    days,
    balance: { byCur: balanceByCur, eur: r2(cumEur) },
    totals: { byCur: roundedTotals, eur: { in: r2(totalEur.in), out: r2(totalEur.out), net: r2(totalEur.net) } },
    crossRates, unconvertible,
    firstDay, lastDay: days.length ? days[days.length - 1].day : null,
    eurRange: { min: r2(Math.min(0, minEur === Infinity ? 0 : minEur)), max: r2(Math.max(0, maxEur === -Infinity ? 0 : maxEur)) },
  };
}
