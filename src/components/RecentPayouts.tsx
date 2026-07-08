import { useEffect, useState } from 'react';

/** Shared live list of recent payouts. Used by the /history page (full 100) and
 * embedded on the landing (pass `limit`). */
interface PayoutItem {
  payout_id: string;
  name: string;
  hex_short: string | null;
  amount: number;
  currency: string;
  paid_at: string;
}
interface HistoryData {
  count: number;
  payouts: PayoutItem[];
  updated_at: string;
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → short local date + time. */
function fmtDateTime(s: string | null): string {
  if (!s) return '—';
  let d = new Date(s);
  if (isNaN(d.getTime())) d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return (
    d.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
  );
}

export default function RecentPayouts({ limit }: { limit?: number }) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/payouts-history');
        const json = await res.json();
        if (!alive) return;
        setData(json);
        setError(null);
      } catch {
        if (alive) setError('Failed to load payout history. Please try again.');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const all = data?.payouts || [];
  const payouts = limit ? all.slice(0, limit) : all;

  if (loading) return <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (error) return <p className="text-center text-red-500 py-8">{error}</p>;
  if (payouts.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">No payouts recorded yet.</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto rounded-2xl border-2 border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="px-4 py-3 font-medium text-left">Date</th>
              <th className="px-4 py-3 font-medium text-left">Recipient</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3 font-medium text-left">Payout ID</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p, i) => (
              <tr key={`${p.payout_id}-${i}`} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDateTime(p.paid_at)}</td>
                <td className="px-4 py-3">
                  <span className="font-medium text-foreground">{p.name}</span>
                  {p.hex_short && <span className="ml-2 text-xs text-muted-foreground font-mono">{p.hex_short}…</span>}
                </td>
                <td className="px-4 py-3 text-right font-mono font-bold text-foreground whitespace-nowrap">{fmt(p.amount, p.currency)}</td>
                <td className="px-4 py-3 font-mono text-xs text-primary">{p.payout_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-3">
        {payouts.map((p, i) => (
          <div key={`${p.payout_id}-${i}`} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground truncate">{p.name}</span>
              <span className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(p.amount, p.currency)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{fmtDateTime(p.paid_at)}</span>
              <span className="font-mono text-primary">{p.payout_id}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
