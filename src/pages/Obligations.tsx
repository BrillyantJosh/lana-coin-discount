import { useEffect, useState } from 'react';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';

/**
 * Public transparency board: every UNPAID obligation to LANA sellers and the exact
 * order it will be paid (financiers first by FIFO rank, then the rest), separately
 * per currency. Reads the open /api/obligations endpoint (no payment details).
 */
interface QueueItem {
  position: number;
  name: string;
  hex_short: string;
  is_financier: boolean;
  finance_rank: number | null;
  outstanding: number;
  payable: boolean; // true = payable now; false = waiting behind a higher-priority recipient
}
interface CurrencyBlock {
  total_outstanding: number;
  count: number;
  financier_count: number;
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

const Obligations = () => {
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
        if (alive) setError('Failed to load obligations. Please try again.');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Currencies, largest outstanding first.
  const currencies = data
    ? Object.entries(data.currencies).sort((a, b) => b[1].total_outstanding - a[1].total_outstanding)
    : [];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Navbar />
      <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
        {/* Hero */}
        <div className="text-center mb-10">
          <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">Payout Queue</h1>
          <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
            Full transparency: every unpaid obligation to LANA sellers and the exact order it will be
            paid. Those who finance first are paid first — evaluated separately for each currency.
          </p>
          {data && currencies.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
              {currencies.map(([cur, b]) => (
                <span key={cur} className="px-3 py-1 rounded-full font-semibold bg-primary/10 text-primary border border-primary/20">
                  {fmt(b.total_outstanding, cur)} outstanding
                </span>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>
        ) : error ? (
          <p className="text-center text-red-500 py-16">{error}</p>
        ) : currencies.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">No unpaid obligations 🎉</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Everyone has been paid out.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {currencies.map(([cur, block]) => (
              <section key={cur} className="rounded-2xl border-2 border-border bg-card overflow-hidden">
                <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-bold text-foreground">{cur}</h2>
                    <span className="text-xs text-muted-foreground">
                      {block.count} recipient{block.count !== 1 ? 's' : ''} · {block.financier_count} financier{block.financier_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-amber-600">{fmt(block.total_outstanding, cur)}</span>
                </div>
                <ol>
                  {block.queue.map((q) => (
                    <li
                      key={q.position}
                      className={`flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border/50 last:border-b-0 ${q.payable ? 'bg-green-50/50 dark:bg-green-500/[0.04]' : ''}`}
                    >
                      <span className={`inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full font-mono text-sm font-bold ${
                        q.is_financier ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300' : 'bg-muted text-muted-foreground'
                      }`}>
                        {q.position}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground truncate">{q.name}</span>
                          {q.is_financier ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">Financier #{q.finance_rank}</span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">Non-financier</span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">{q.hex_short}…</span>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-bold text-foreground">{fmt(q.outstanding, cur)}</div>
                        <div className={`text-[10px] font-semibold uppercase tracking-wider ${q.payable ? 'text-green-600' : 'text-muted-foreground'}`}>
                          {q.payable ? 'Payable now' : 'Waiting'}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            <p className="text-center text-xs text-muted-foreground">
              Financiers first (by budget registration order), then the rest · per currency · updates every 30s
            </p>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Obligations;
