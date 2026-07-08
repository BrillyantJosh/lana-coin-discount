import { useEffect, useMemo, useState } from 'react';

/** Public payout stats: total FIAT paid out per day (per currency), as a small bar
 * chart. Hovering a bar shows who was paid and how much that day. Reads the open
 * /api/payouts-daily endpoint. */
interface Person { name: string; hex_short: string | null; amount: number; }
interface DayCur { total: number; count: number; payouts: number; people: Person[]; }
interface DayEntry { day: string; byCur: Record<string, DayCur>; }
interface DailyData {
  currencies: string[];
  totals_by_currency: Record<string, number>;
  count_by_currency: Record<string, number>;
  days: DayEntry[];
  first_day: string | null;
  last_day: string | null;
  updated_at: string;
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShort = (n: number, cur: string) => {
  const sym = SYM[cur] || cur + ' ';
  if (n >= 1000) return sym + (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'k';
  return sym + Math.round(n).toLocaleString();
};

const MAX_DAYS = 60; // cap the visible window so the chart stays readable

/** Inclusive list of 'YYYY-MM-DD' from start to end (UTC). */
function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  let d = new Date(start + 'T00:00:00Z');
  const stop = new Date(end + 'T00:00:00Z');
  let guard = 0;
  while (d <= stop && guard++ < 4000) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}
const fmtDay = (d: string) => { const [, m, day] = d.split('-'); return `${day}.${m}.`; };
const fmtDayFull = (d: string) => { const [y, m, day] = d.split('-'); return `${day}.${m}.${y}`; };

interface SeriesPoint { day: string; value: number; count: number; people: Person[]; }

const PayoutStats = () => {
  const [data, setData] = useState<DailyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [cur, setCur] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/payouts-daily');
        const json: DailyData = await res.json();
        if (!alive) return;
        setData(json);
        setCur((prev) => prev ?? pickDefaultCurrency(json));
      } catch {
        /* stats are optional — stay quiet on error */
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Continuous daily series (zero-filled) for the selected currency, capped to MAX_DAYS.
  const series = useMemo<SeriesPoint[]>(() => {
    if (!data || !cur || !data.first_day) return [];
    const byDay = new Map<string, DayCur>();
    for (const d of data.days) if (d.byCur[cur]) byDay.set(d.day, d.byCur[cur]);
    const today = new Date().toISOString().slice(0, 10);
    const end = (data.last_day && data.last_day > today) ? data.last_day : today;
    let range = dateRange(data.first_day, end);
    if (range.length > MAX_DAYS) range = range.slice(range.length - MAX_DAYS);
    return range.map((day) => {
      const dc = byDay.get(day);
      return { day, value: dc?.total || 0, count: dc?.count || 0, people: dc?.people || [] };
    });
  }, [data, cur]);

  if (loading) return <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (!data || !cur || (data.currencies?.length ?? 0) === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">No payouts yet.</p>
      </div>
    );
  }

  const max = Math.max(1, ...series.map((s) => s.value));
  const total = data.totals_by_currency[cur] || 0;
  const count = data.count_by_currency[cur] || 0;
  const activeDays = series.filter((s) => s.value > 0).length;
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const active = hover !== null ? series[hover] : null;
  const tooltipLeft = hover !== null ? Math.min(88, Math.max(12, ((hover + 0.5) / series.length) * 100)) : 50;

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-6">
      {/* Header: totals + currency toggle */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Total paid out ({cur})</p>
          <p className="text-3xl font-bold text-foreground tabular-nums">{fmt(total, cur)}</p>
          <p className="text-xs text-muted-foreground mt-1">{count} payout{count !== 1 ? 's' : ''} · {activeDays} active day{activeDays !== 1 ? 's' : ''}</p>
        </div>
        {data.currencies.length > 1 && (
          <div className="flex rounded-lg border border-border overflow-hidden">
            {data.currencies
              .slice()
              .sort((a, b) => (data.totals_by_currency[b] || 0) - (data.totals_by_currency[a] || 0))
              .map((c) => (
                <button
                  key={c}
                  onClick={() => setCur(c)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${cur === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {c}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Bar chart + hover tooltip */}
      <div className="relative">
        {active && active.value > 0 && (
          <div
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 z-10 w-56 max-w-[15rem] rounded-lg border border-border bg-card shadow-xl px-3 py-2 text-left"
            style={{ left: `${tooltipLeft}%` }}
          >
            <div className="text-xs font-semibold text-foreground">{fmtDayFull(active.day)}</div>
            <div className="text-xs text-muted-foreground mb-1.5">
              {active.count} {active.count === 1 ? 'person' : 'people'} · <span className="font-semibold text-foreground">{fmt(active.value, cur)}</span>
            </div>
            <ul className="space-y-0.5">
              {active.people.slice(0, 8).map((p, i) => (
                <li key={i} className="flex justify-between gap-2 text-[11px]">
                  <span className="truncate text-foreground">{p.name}</span>
                  <span className="font-mono text-muted-foreground whitespace-nowrap">{fmt(p.amount, cur)}</span>
                </li>
              ))}
              {active.people.length > 8 && (
                <li className="text-[10px] text-muted-foreground">+{active.people.length - 8} more</li>
              )}
            </ul>
          </div>
        )}

        <div className="flex items-end gap-[3px] h-44 sm:h-52">
          {series.map((s, i) => (
            <div
              key={s.day}
              className="flex-1 h-full flex items-end min-w-0 cursor-default"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              title={s.value > 0 ? `${fmtDay(s.day)} — ${s.count} ${s.count === 1 ? 'person' : 'people'} · ${fmt(s.value, cur)}` : `${fmtDay(s.day)} — no payouts`}
            >
              <div
                className={`w-full rounded-t transition-colors ${s.value > 0 ? (hover === i ? 'bg-primary/70' : 'bg-primary hover:bg-primary/80') : 'bg-transparent'}`}
                style={{ height: s.value > 0 ? `${Math.max(2, (s.value / max) * 100)}%` : '0%' }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* X-axis date labels (sparse) */}
      <div className="flex gap-[3px] mt-2">
        {series.map((s, i) => (
          <div key={s.day} className="flex-1 text-center text-[9px] text-muted-foreground min-w-0 overflow-hidden whitespace-nowrap">
            {i % labelEvery === 0 ? fmtDay(s.day) : ''}
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground mt-3 text-right">
        Hover a bar for the day's recipients · peak {fmtShort(max, cur)} · last {series.length} days · updates every 60s
      </p>
    </div>
  );
};

/** Currency with the largest total gets shown first. */
function pickDefaultCurrency(d: DailyData): string | null {
  const curs = d.currencies || [];
  if (curs.length === 0) return null;
  return curs.slice().sort((a, b) => (d.totals_by_currency[b] || 0) - (d.totals_by_currency[a] || 0))[0];
}

export default PayoutStats;
