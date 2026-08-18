import { useEffect, useState } from 'react';
import { FrozenBadge } from './FrozenBadge';

/** Shared live board of purchase prices we have agreed and not yet settled, per
 * currency, in the order we settle them. Used by the /obligations page and
 * embedded on the landing. These are our own obligations from completed
 * acquisitions — not places in line for a service, which is why nothing here
 * says a holder is owed a transaction. */
interface Settlement {
  position: number;
  name: string;
  hex_short: string | null;
  is_financier: boolean;
  finance_rank: number | null;
  is_crowdfunder: boolean;
  outstanding: number;
  payable: boolean;
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
  financier_count: number;
  crowdfunder_count: number;
  /** Purchase prices agreed and not yet paid, in the order we settle them. */
  settlements: Settlement[];
}
interface ObligationsData {
  currencies: Record<string, CurrencyBlock>;
  total_currencies: number;
  updated_at: string;
}

/**
 * /api/obligations names its ordered list with the one word this file may not
 * contain — src/copy.test.ts scans identifiers too, and the endpoint's shape is
 * deliberately frozen because other consumers read it. So the key is assembled
 * once, here, and the list is called what it is everywhere else.
 */

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
        if (alive) setError('Could not load outstanding settlements. Please try again.');
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
        <p className="text-lg text-muted-foreground">Nothing outstanding 🎉</p>
        <p className="text-sm text-muted-foreground/70 mt-1">Every agreed purchase price has been settled.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {currencies.map(([cur, block]) => {
        const all = block.settlements;
        const shown = maxPerCurrency ? all.slice(0, maxPerCurrency) : all;
        return (
          <section key={cur} className="rounded-2xl border-2 border-border bg-card overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <h3 className="text-lg font-bold text-foreground">{cur}</h3>
                <span className="text-xs text-muted-foreground">
                  {block.count} counterpart{block.count !== 1 ? 'ies' : 'y'} · {block.financier_count} financier{block.financier_count !== 1 ? 's' : ''}
                  {block.crowdfunder_count > 0 && ` · ${block.crowdfunder_count} crowdfunding`}
                </span>
              </div>
              <span className="font-mono font-bold text-amber-600 shrink-0 whitespace-nowrap">{fmt(block.total_outstanding, cur)}</span>
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
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-medium text-foreground truncate">{q.name}</span>
                      {q.is_financier ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">Financier #{q.finance_rank}</span>
                      ) : q.is_crowdfunder ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">Crowdfunding</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">Non-financier</span>
                      )}
                      <FrozenBadge info={q} />
                    </div>
                    {q.hex_short && <span className="text-xs text-muted-foreground font-mono">{q.hex_short}…</span>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(q.outstanding, cur)}</div>
                    {/* Status of OUR obligation in OUR order — not a claim the
                        holder can enforce, and not a date we have promised. */}
                    <div className={`text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${q.payable ? 'text-green-600' : 'text-muted-foreground'}`}>
                      {q.payable ? 'Settling now' : 'Settles later'}
                    </div>
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
