import { useEffect, useMemo, useState } from 'react';

/**
 * NET FIAT POSITION — the line under the Daily FIAT flows bars.
 *
 * Same two flows as the chart above (FIAT in from investors, purchase prices
 * settled out), but accumulated: every point is the running sum since the first
 * day of activity, so the question it answers is "on that day, had we taken in
 * more than we had settled, or less?".
 *
 * The combined figure converts through the LANA pivot — KIND 38888 quotes how
 * much of each currency one LANA costs, and two quotes imply a cross rate. The
 * implied rate is printed next to the total on purpose: when the same number is
 * entered for two currencies the pivot means 1:1, and a reader must be able to
 * see that rather than infer a conversion that is not happening.
 */

interface DayPoint {
  day: string;
  byCur: Record<string, { in: number; out: number; net: number; cum: number }>;
  eur: { in: number; out: number; net: number; cum: number };
}
interface LiquidityData {
  days: DayPoint[];
  balance: { byCur: Record<string, number>; eur: number };
  totals: {
    byCur: Record<string, { in: number; out: number; net: number }>;
    eur: { in: number; out: number; net: number };
  };
  crossRates: Record<string, number>;
  unconvertible: string[];
  firstDay: string | null;
  lastDay: string | null;
  eurRange: { min: number; max: number };
  rates: Record<string, number>;
  updated_at: string;
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Signed, for a delta where the direction is the whole point. */
const fmtSigned = (n: number, cur: string) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), cur);
const fmtShort = (n: number, cur: string) => {
  const sym = SYM[cur] || cur + ' ';
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1000) return s + sym + (a / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'k';
  return s + sym + Math.round(a).toLocaleString();
};
const fmtDay = (d: string) => { const [, m, day] = d.split('-'); return `${day}.${m}.`; };
const fmtDayFull = (d: string) => { const [y, m, day] = d.split('-'); return `${day}.${m}.${y}`; };

type Range = 30 | 90 | 0; // 0 = everything
const RANGES: { key: Range; label: string }[] = [
  { key: 30, label: '30d' }, { key: 90, label: '90d' }, { key: 0, label: 'All' },
];

const LiquidityBalance = () => {
  const [data, setData] = useState<LiquidityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>(90);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/liquidity-daily');
        const json: LiquidityData = await res.json();
        if (alive) setData(json);
      } catch {
        /* stats are optional — stay quiet on error, like the chart above */
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Only the DISPLAY window is sliced. The cumulative was summed server-side
  // over the whole history — slicing the input would not be a balance at all.
  const view = useMemo(() => {
    const all = data?.days || [];
    return range === 0 ? all : all.slice(Math.max(0, all.length - range));
  }, [data, range]);

  if (loading) {
    return <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  }
  if (!data || view.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">No activity yet.</p>
      </div>
    );
  }

  const currencies = Object.keys(data.balance.byCur).sort();
  const balance = data.balance.eur;

  // Domain always contains zero, so "above" and "below" stay legible; padded so
  // the line never touches the frame.
  const lo = Math.min(0, ...view.map((d) => d.eur.cum));
  const hi = Math.max(0, ...view.map((d) => d.eur.cum));
  const pad = Math.max((hi - lo) * 0.08, 1);
  const yMin = lo - pad;
  const yMax = hi + pad;
  const H = 100;
  const y = (v: number) => ((yMax - v) / (yMax - yMin)) * H;
  const x = (i: number) => (view.length === 1 ? 0.5 : i / (view.length - 1));
  const zeroY = y(0);

  const line = view.map((d, i) => `${x(i) * 100},${y(d.eur.cum)}`).join(' ');
  const area = `0,${zeroY} ` + line + ` 100,${zeroY}`;

  const netMax = Math.max(1, ...view.map((d) => Math.abs(d.eur.net)));
  const active = hover !== null ? view[hover] : null;
  const tipLeft = hover !== null ? Math.min(86, Math.max(14, x(hover) * 100)) : 50;

  const daysBelow = view.filter((d) => d.eur.cum < 0).length;
  const crossNote = currencies
    .filter((c) => c !== 'EUR' && data.crossRates[c] !== undefined)
    .map((c) => `${SYM[c] || c}1 = €${data.crossRates[c].toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`)
    .join(' · ');

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-6">
      {/* Balance today + the delta that produced it */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Net FIAT position today</p>
          <p className="text-3xl sm:text-4xl font-bold tabular-nums text-foreground">
            {fmtSigned(balance, 'EUR')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            received {fmt(data.totals.eur.in, 'EUR')} · settled {fmt(data.totals.eur.out, 'EUR')}
            {crossNote && <> · combined at {crossNote}</>}
          </p>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden self-start">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => { setRange(r.key); setHover(null); }}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${range === r.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Per-currency delta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {currencies.map((c) => {
          const t = data.totals.byCur[c] || { in: 0, out: 0, net: 0 };
          return (
            <div key={c} className="rounded-xl border border-border bg-background/40 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">{c}</span>
                <span className="text-lg font-bold tabular-nums text-foreground">{fmtSigned(data.balance.byCur[c], c)}</span>
              </div>
              <div className="mt-1 flex justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
                <span>in {fmt(t.in, c)}</span>
                <span>out {fmt(t.out, c)}</span>
              </div>
              {data.unconvertible.includes(c) && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                  No LANA quote for {c} — not included in the combined figure above.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Cumulative line */}
      <div className="relative">
        {active && (
          <div
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 z-10 w-52 rounded-lg border border-border bg-card shadow-xl px-3 py-2 text-left"
            style={{ left: `${tipLeft}%` }}
          >
            <div className="text-xs font-semibold text-foreground mb-1.5">{fmtDayFull(active.day)}</div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Position</span>
              <span className="font-semibold tabular-nums text-foreground">{fmtSigned(active.eur.cum, 'EUR')}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">That day</span>
              <span className="font-semibold tabular-nums text-foreground">{fmtSigned(active.eur.net, 'EUR')}</span>
            </div>
            {currencies.length > 1 && (
              <div className="mt-1.5 pt-1.5 border-t border-border space-y-0.5">
                {currencies.map((c) => (
                  <div key={c} className="flex justify-between gap-2 text-[11px]">
                    <span className="text-muted-foreground">{c}</span>
                    <span className="tabular-nums text-foreground">{fmtSigned(active.byCur[c]?.cum ?? 0, c)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="relative h-40 sm:h-48">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            {/* zero baseline */}
            <line x1="0" y1={zeroY} x2="100" y2={zeroY} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />
            <polygon points={area} className="fill-primary/10" />
            <polyline points={line} fill="none" className="stroke-primary" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            {hover !== null && (
              <>
                <line x1={x(hover) * 100} y1="0" x2={x(hover) * 100} y2="100" className="stroke-muted-foreground/40" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <circle cx={x(hover) * 100} cy={y(view[hover].eur.cum)} r="3" className="fill-primary" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </svg>
          {/* zero label */}
          <span className="absolute left-0 -translate-y-1/2 text-[9px] text-muted-foreground bg-card pr-1" style={{ top: `${zeroY}%` }}>0</span>
          {/* hover targets */}
          <div className="absolute inset-0 flex">
            {view.map((d, i) => (
              <div
                key={d.day}
                className="flex-1 h-full cursor-default"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                title={`${fmtDay(d.day)} — ${fmtSigned(d.eur.cum, 'EUR')}`}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>{fmtShort(yMax, 'EUR')} high</span>
          <span>{fmtShort(yMin, 'EUR')} low</span>
        </div>
      </div>

      {/* Per-day movement, on its own scale so a small day is still visible */}
      <div className="mt-4">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Movement per day</p>
        <div className="flex items-center gap-[2px] h-14">
          {view.map((d, i) => {
            const h = Math.max(1, (Math.abs(d.eur.net) / netMax) * 50);
            const up = d.eur.net >= 0;
            return (
              <div
                key={d.day}
                className="flex-1 h-full flex flex-col justify-center min-w-0 cursor-default"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((hv) => (hv === i ? null : hv))}
              >
                <div className="h-1/2 flex items-end">
                  {up && <div className={`w-full rounded-t ${hover === i ? 'bg-sky-400' : 'bg-sky-500/70'}`} style={{ height: `${h}%` }} />}
                </div>
                <div className="h-1/2 flex items-start">
                  {!up && <div className={`w-full rounded-b ${hover === i ? 'bg-primary/60' : 'bg-primary/40'}`} style={{ height: `${h}%` }} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis */}
      <div className="flex gap-[2px] mt-1">
        {view.map((d, i) => {
          const every = Math.max(1, Math.ceil(view.length / 8));
          return (
            <div key={d.day} className="flex-1 text-center text-[9px] text-muted-foreground min-w-0 overflow-hidden whitespace-nowrap">
              {i % every === 0 ? fmtDay(d.day) : ''}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        The running total of FIAT received from investors minus purchase prices we have settled, since{' '}
        {data.firstDay ? fmtDayFull(data.firstDay) : '—'}. Above the line means more has come in than has gone out
        by that day; below it means the opposite. {daysBelow > 0 && <>{daysBelow} of the {view.length} days shown are below zero. </>}
        It is a flow difference, not a bank balance: LANA we hold, LANA still to be transferred to us and purchase
        prices not yet settled are not in it. Updates every 60s.
      </p>
    </div>
  );
};

export default LiquidityBalance;
