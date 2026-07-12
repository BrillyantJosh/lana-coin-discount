import { useEffect, useState } from 'react';

/** Shared live board of UNPAID obligations, per currency, in payout order.
 * Used by the /obligations page and embedded on the landing. */
interface QueueItem {
  position: number;
  name: string;
  hex_short: string | null;
  is_financier: boolean;
  finance_rank: number | null;
  is_crowdfunder: boolean;
  outstanding: number;
  payable: boolean;
}
interface CurrencyBlock {
  total_outstanding: number;
  count: number;
  financier_count: number;
  crowdfunder_count: number;
  queue: QueueItem[];
}
interface ObligationsData {
  currencies: Record<string, CurrencyBlock>;
  total_currencies: number;
  updated_at: string;
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        if (alive) setError('Failed to load the payout queue. Please try again.');
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
        <p className="text-lg text-muted-foreground">No unpaid obligations 🎉</p>
        <p className="text-sm text-muted-foreground/70 mt-1">Everyone has been paid out.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {currencies.map(([cur, block]) => {
        const shown = maxPerCurrency ? block.queue.slice(0, maxPerCurrency) : block.queue;
        return (
          <section key={cur} className="rounded-2xl border-2 border-border bg-card overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-bold text-foreground">{cur}</h3>
                <span className="text-xs text-muted-foreground">
                  {block.count} recipient{block.count !== 1 ? 's' : ''} · {block.financier_count} financier{block.financier_count !== 1 ? 's' : ''}
                  {block.crowdfunder_count > 0 && ` · ${block.crowdfunder_count} crowdfunding`}
                </span>
              </div>
              <span className="font-mono font-bold text-amber-600">{fmt(block.total_outstanding, cur)}</span>
            </div>
            <ol>
              {shown.map((q) => (
                <li
                  key={q.position}
                  className={`flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border/50 last:border-b-0 ${q.payable ? 'bg-green-50/50 dark:bg-green-500/[0.04]' : ''}`}
                >
                  <span className={`inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full font-mono text-sm font-bold ${
                    q.is_financier ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
                      : q.is_crowdfunder ? 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {q.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{q.name}</span>
                      {q.is_financier ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">Financier #{q.finance_rank}</span>
                      ) : q.is_crowdfunder ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">Crowdfunding</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">Non-financier</span>
                      )}
                    </div>
                    {q.hex_short && <span className="text-xs text-muted-foreground font-mono">{q.hex_short}…</span>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-foreground">{fmt(q.outstanding, cur)}</div>
                    <div className={`text-[10px] font-semibold uppercase tracking-wider ${q.payable ? 'text-green-600' : 'text-muted-foreground'}`}>
                      {q.payable ? 'Payable now' : 'Waiting'}
                    </div>
                  </div>
                </li>
              ))}
              {maxPerCurrency && block.queue.length > maxPerCurrency && (
                <li className="px-4 sm:px-6 py-2 text-center text-xs text-muted-foreground">
                  + {block.queue.length - maxPerCurrency} more in {cur}…
                </li>
              )}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
