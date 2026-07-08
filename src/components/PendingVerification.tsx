import { useEffect, useState } from 'react';

/** Sales that are submitted but still awaiting on-chain (RPC) verification before
 * they enter the payout queue. Renders a self-contained amber "In verification"
 * card, or null when there are none. Reads the open /api/pending-verification. */
interface PendingItem {
  name: string;
  hex_short: string | null;
  amount: number;
  currency: string;
  status: string;
  rpc_confirmations: number;
  created_at: string;
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

export default function PendingVerification({ limit }: { limit?: number }) {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/pending-verification');
        const json = await res.json();
        if (!alive) return;
        setItems(json.items || []);
      } catch {
        /* optional — stay quiet on error */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Nothing pending → render nothing (no empty section).
  if (!loaded || items.length === 0) return null;

  const shown = limit ? items.slice(0, limit) : items;

  return (
    <div className="rounded-2xl border-2 border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.06] overflow-hidden">
      <div className="px-4 sm:px-6 py-3 border-b border-amber-200/70 dark:border-amber-500/20 flex items-center gap-2 flex-wrap">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse" />
        <span className="font-semibold text-amber-800 dark:text-amber-300">In verification</span>
        <span className="text-xs text-amber-700/80 dark:text-amber-400/70">
          {items.length} transaction{items.length !== 1 ? 's' : ''} awaiting on-chain confirmation before payout
        </span>
      </div>
      <ul>
        {shown.map((p, i) => (
          <li key={i} className="flex items-center gap-3 px-4 sm:px-6 py-2.5 border-b border-amber-200/40 dark:border-amber-500/10 last:border-b-0">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300 shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" /> Verifying
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground truncate">{p.name}</span>
              {p.hex_short && <span className="ml-2 text-xs text-muted-foreground font-mono">{p.hex_short}…</span>}
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(p.amount, p.currency)}</div>
              <div className="text-[10px] text-muted-foreground">
                {fmtDateTime(p.created_at)}{p.rpc_confirmations ? ` · ${p.rpc_confirmations} conf` : ''}
              </div>
            </div>
          </li>
        ))}
        {limit && items.length > limit && (
          <li className="px-4 sm:px-6 py-2 text-center text-xs text-amber-700/70 dark:text-amber-400/70">
            + {items.length - limit} more awaiting verification
          </li>
        )}
      </ul>
    </div>
  );
}
