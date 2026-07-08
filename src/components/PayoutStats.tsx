import { useEffect, useMemo, useState } from 'react';

/** Public daily FIAT flows: per day, FIAT paid out (to LANA sellers, with the
 * recipient breakdown) and FIAT received (from investors), as two bars per day.
 * Reads the open /api/payouts-daily endpoint. */
interface Person { name: string; hex_short: string | null; amount: number; }
interface DayCur { total: number; count: number; payouts: number; people: Person[]; received: number; receivedCount: number; }
interface DayEntry { day: string; byCur: Record<string, DayCur>; }
interface DailyData {
  currencies: string[];
  totals_by_currency: Record<string, number>;
  received_by_currency: Record<string, number>;
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

interface SeriesPoint { day: string; paid: number; paidCount: number; people: Person[]; received: number; receivedCount: number; }

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
      return {
        day,
        paid: dc?.total || 0,
        paidCount: dc?.count || 0,
        people: dc?.people || [],
        received: dc?.received || 0,
        receivedCount: dc?.receivedCount || 0,
      };
    });
  }, [data, cur]);

  if (loading) return <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (!data || !cur || (data.currencies?.length ?? 0) === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">No activity yet.</p>
      </div>
    );
  }

  const max = Math.max(1, ...series.map((s) => Math.max(s.paid, s.received)));
  const totalPaid = data.totals_by_currency[cur] || 0;
  const totalReceived = data.received_by_currency?.[cur] || 0;
  const payoutCount = data.count_by_currency[cur] || 0;
  const active = hover !== null ? series[hover] : null;
  const tooltipLeft = hover !== null ? Math.min(88, Math.max(12, ((hover + 0.5) / series.length) * 100)) : 50;
  const barH = (v: number) => (v > 0 ? `${Math.max(2, (v / max) * 100)}%` : '0%');

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-6">
      {/* Header: paid + received totals, legend, currency toggle */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div className="flex items-start gap-8 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" /> Paid out ({cur})
            </p>
            <p className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums">{fmt(totalPaid, cur)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{payoutCount} payout{payoutCount !== 1 ? 's' : ''}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" /> Received ({cur})
            </p>
            <p className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums">{fmt(totalReceived, cur)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">from investors</p>
          </div>
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

      {/* Chart + hover tooltip */}
      <div className="relative">
        {active && (active.paid > 0 || active.received > 0) && (
          <div
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 z-10 w-56 max-w-[15rem] rounded-lg border border-border bg-card shadow-xl px-3 py-2 text-left"
            style={{ left: `${tooltipLeft}%` }}
          >
            <div className="text-xs font-semibold text-foreground mb-1.5">{fmtDayFull(active.day)}</div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground"><span className="inline-block h-2 w-2 rounded-sm bg-primary" /> Paid out</span>
              <span className="font-semibold text-foreground tabular-nums">{fmt(active.paid, cur)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
              <span className="flex items-center gap-1.5 text-muted-foreground"><span className="inline-block h-2 w-2 rounded-sm bg-sky-500" /> Received</span>
              <span className="font-semibold text-foreground tabular-nums">{fmt(active.received, cur)}</span>
            </div>
            {active.people.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-1">Paid to {active.paidCount} {active.paidCount === 1 ? 'person' : 'people'}</div>
                <ul className="space-y-0.5 mt-0.5">
                  {active.people.slice(0, 6).map((p, i) => (
                    <li key={i} className="flex justify-between gap-2 text-[11px]">
                      <span className="truncate text-foreground">{p.name}</span>
                      <span className="font-mono text-muted-foreground whitespace-nowrap">{fmt(p.amount, cur)}</span>
                    </li>
                  ))}
                  {active.people.length > 6 && <li className="text-[10px] text-muted-foreground">+{active.people.length - 6} more</li>}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="flex items-end gap-[3px] h-44 sm:h-52">
          {series.map((s, i) => (
            <div
              key={s.day}
              className="flex-1 h-full flex items-end justify-center gap-[1px] min-w-0 cursor-default"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              title={`${fmtDay(s.day)} — paid ${fmt(s.paid, cur)} · received ${fmt(s.received, cur)}`}
            >
              <div
                className={`w-1/2 max-w-[7px] rounded-t transition-colors ${s.paid > 0 ? (hover === i ? 'bg-primary/70' : 'bg-primary') : ''}`}
                style={{ height: barH(s.paid) }}
              />
              <div
                className={`w-1/2 max-w-[7px] rounded-t transition-colors ${s.received > 0 ? (hover === i ? 'bg-sky-400' : 'bg-sky-500') : ''}`}
                style={{ height: barH(s.received) }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* X-axis date labels (sparse) */}
      <div className="flex gap-[3px] mt-2">
        {series.map((s, i) => {
          const labelEvery = Math.max(1, Math.ceil(series.length / 8));
          return (
            <div key={s.day} className="flex-1 text-center text-[9px] text-muted-foreground min-w-0 overflow-hidden whitespace-nowrap">
              {i % labelEvery === 0 ? fmtDay(s.day) : ''}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2 mt-3">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-primary" /> Paid out</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-sky-500" /> Received</span>
        </div>
        <p className="text-[10px] text-muted-foreground text-right">
          Hover a bar for the day's detail · peak {fmtShort(max, cur)} · last {series.length} days · updates every 60s
        </p>
      </div>
    </div>
  );
};

/** Currency with the largest paid-out total gets shown first. */
function pickDefaultCurrency(d: DailyData): string | null {
  const curs = d.currencies || [];
  if (curs.length === 0) return null;
  return curs.slice().sort((a, b) => (d.totals_by_currency[b] || 0) - (d.totals_by_currency[a] || 0))[0];
}

export default PayoutStats;
