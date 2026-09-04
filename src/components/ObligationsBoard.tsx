import { useEffect, useState } from 'react';
import { FrozenBadge } from './FrozenBadge';
import { BOARD } from '@/copy';

/** Shared live board of purchase prices we have agreed and not yet settled, per
 * currency, in the order we settle them: financing round 1, then 2, then 3,
 * then acquisitions outside a round. Used by the /obligations page and
 * embedded on the landing. These are our own obligations from completed
 * acquisitions — not places in line for a service, which is why nothing here
 * says a holder is owed a transaction, and nothing here says who is "next". */
interface Settlement {
  position: number;
  name: string;
  hex_short: string | null;
  /** 1 | 2 | 3, or null for an acquisition outside a financing round. */
  round: number | null;
  mandate_split: number | null;
  outstanding: number;
  /** null = not resolved yet (which is NOT the same as "clean") */
  frozen: boolean | null;
  freeze_level: 'account' | 'wallet' | 'none' | null;
  frozen_wallets: number | null;
  total_wallets: number | null;
  freeze_reasons: string[];
}
interface CurrencyBlock {
  total_outstanding: number;
  count: number;
  /** Purchase prices agreed and not yet paid, in the order we settle them. */
  settlements: Settlement[];
}
interface ObligationsData {
  currencies: Record<string, CurrencyBlock>;
  total_currencies: number;
  updated_at: string;
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ROUND_CLS: Record<number, string> = {
  1: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  2: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  3: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
};

export default function ObligationsBoard({ maxPerCurrency }: { maxPerCurrency?: number }) {
  const [data, setData] = useState<ObligationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/obligations');
        const json = await res.json();
        if (!alive) return;
        setData(json);
        setError(null);
      } catch {
        if (alive) setError(BOARD.loadFailed);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const currencies = data
    ? Object.entries(data.currencies).sort((a, b) => b[1].total_outstanding - a[1].total_outstanding)
    : [];

  if (loading) return <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (error) return <p className="text-center text-red-500 py-8">{error}</p>;
  if (currencies.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">{BOARD.nothingOutstanding}</p>
        <p className="text-sm text-muted-foreground/70 mt-1">{BOARD.nothingOutstandingBody}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {currencies.map(([cur, block]) => {
        const all = block.settlements;
        const shown = maxPerCurrency ? all.slice(0, maxPerCurrency) : all;
        const inRounds = all.filter(q => q.round !== null).length;
        return (
          <section key={cur} className="rounded-2xl border-2 border-border bg-card overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <h3 className="text-lg font-bold text-foreground">{cur}</h3>
                <span className="text-xs text-muted-foreground">
                  {block.count} counterpart{block.count !== 1 ? 'ies' : 'y'}
                  {inRounds > 0 && ` · ${inRounds} in a financing round`}
                </span>
              </div>
              <span className="font-mono font-bold text-amber-600 shrink-0 whitespace-nowrap">{fmt(block.total_outstanding, cur)}</span>
            </div>
            <ol>
              {shown.map((q) => (
                <li
                  key={q.position}
                  className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border/50 last:border-b-0"
                >
                  <span className={`inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full font-mono text-sm font-bold ${
                    q.round !== null ? ROUND_CLS[q.round] || 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {q.round !== null ? `R${q.round}` : '—'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-medium text-foreground truncate">{q.name}</span>
                      {q.round !== null ? (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ROUND_CLS[q.round] || 'bg-muted text-muted-foreground'}`}
                          title={q.mandate_split !== null ? BOARD.roundTitle.replace('{round}', String(q.round)).replace('{split}', String(q.mandate_split)) : undefined}
                        >
                          {BOARD.roundBadge.replace('{round}', String(q.round))}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">{BOARD.outsideRoundBadge}</span>
                      )}
                      <FrozenBadge info={q} />
                    </div>
                    {q.hex_short && <span className="text-xs text-muted-foreground font-mono">{q.hex_short}…</span>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(q.outstanding, cur)}</div>
                  </div>
                </li>
              ))}
              {maxPerCurrency && all.length > maxPerCurrency && (
                <li className="px-4 sm:px-6 py-2 text-center text-xs text-muted-foreground">
                  + {all.length - maxPerCurrency} more in {cur}…
                </li>
              )}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
