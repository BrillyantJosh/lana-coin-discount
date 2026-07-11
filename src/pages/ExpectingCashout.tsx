import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import AdminNav from '@/components/AdminNav';

/**
 * Expecting Cash Out — first-priority operator worklist. For the PREVIOUS split's
 * investors, sums the current on-chain LANA in their wallets, values it in EUR
 * minus the live Lana.discount commission, and shows "still to pay" (net of
 * already-paid). Read-only report — pays no one.
 */

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtLana = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSplitStart = (unixSec?: number | null) => unixSec ? new Date(unixSec * 1000).toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;

interface CashoutInvestor {
  nostrHexId: string;
  name: string | null;
  walletIds: string[];
  walletCount: number;
  onchainLana: number;
  grossEur: number;
  commissionPct: number;
  commissionEur: number;
  netExpectedEur: number;
  alreadyPaidEur: number;
  stillToPayEur: number;
  isLastBudget: boolean;
  hasMultipleCurrencies: boolean;
  currencies: string[];
  status: string | null;
  balanceUnavailable: boolean;
}
interface CurrencyBlock {
  investors: CashoutInvestor[];
  totals: { onchainLana: number; grossEur: number; commissionEur: number; netExpectedEur: number; alreadyPaidEur: number; stillToPayEur: number };
  rateMissing: boolean;
}
interface CashoutData {
  prevSplit: number;
  currentSplit: number;
  commissionPct?: number;
  splitStartedAt?: number | null;
  splitStartMissing?: boolean;
  currencies: Record<string, CurrencyBlock>;
  grandTotals: Record<string, { netExpectedEur: number; stillToPayEur: number; investorCount: number }>;
  stale?: boolean;
  balancesPartial?: boolean;
  degraded?: boolean;
  error?: string;
  note?: string;
  updated_at: string;
}

export default function ExpectingCashout() {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<CashoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  const load = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/expecting-cashout', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const json = await res.json();
      if (json.error && !json.degraded) throw new Error(json.error);
      setData(json);
      setCur((prev) => prev ?? Object.keys(json.currencies || {}).sort(
        (a, b) => (json.grandTotals?.[b]?.stillToPayEur || 0) - (json.grandTotals?.[a]?.stillToPayEur || 0)
      )[0] ?? null);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!session || !isAdmin) return;
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, isAdmin]);

  const currencyKeys = useMemo(() => Object.keys(data?.currencies || {}), [data]);
  const block = cur ? data?.currencies?.[cur] : null;
  const gt = cur ? data?.grandTotals?.[cur] : null;

  if (!session) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-2">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Expecting Cash Out</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              First-priority worklist: EUR still owed to <strong>Split {data ? data.prevSplit : '…'}</strong> investors,
              from the current on-chain LANA in their wallets.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Banners */}
        {data?.degraded && (
          <div className="mb-4 rounded-lg border-2 border-red-400 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            Could not reach Direct Fund to load the investor cohort — numbers are unavailable. Try again shortly.
          </div>
        )}
        {data?.stale && !data?.degraded && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            Investor cohort served from cache (Direct Fund briefly unreachable) — may be slightly stale.
          </div>
        )}
        {data?.balancesPartial && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            Some on-chain balances could not be fetched (Electrum). Rows marked <em>balance unavailable</em> show 0 — refresh to retry.
          </div>
        )}
        {data?.splitStartMissing && !data?.degraded && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            KIND 38888 carries no split-start date — "already paid" falls back to the lifetime total (may over-subtract). Publish <code>split_started_at</code> to scope it to this cycle.
          </div>
        )}
        {block?.rateMissing && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            No exchange rate for {cur} in the current KIND 38888 — EUR values shown as 0.
          </div>
        )}

        {loading && !data ? (
          <div className="flex justify-center py-16"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>
        ) : error ? (
          <p className="text-center text-red-500 py-12">{error}</p>
        ) : data?.note || currencyKeys.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
            <p className="text-lg text-muted-foreground">{data?.note || 'No Split investors expecting cash out.'}</p>
          </div>
        ) : (
          <>
            {/* Currency toggle + headline totals */}
            <div className="flex items-start justify-between gap-4 flex-wrap mt-4 mb-4">
              <div className="flex items-start gap-8 flex-wrap">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Still to pay ({cur})</p>
                  <p className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums">{fmt(gt?.stillToPayEur || 0, cur!)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{gt?.investorCount || 0} investor{(gt?.investorCount || 0) !== 1 ? 's' : ''} · net of paid since split start{fmtSplitStart(data?.splitStartedAt) ? ` (${fmtSplitStart(data?.splitStartedAt)})` : ''}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Net expected ({cur})</p>
                  <p className="text-2xl sm:text-3xl font-bold text-muted-foreground tabular-nums">{fmt(gt?.netExpectedEur || 0, cur!)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">on-chain LANA − {data?.commissionPct ?? '?'}% (LanaPays.Us investor rate)</p>
                </div>
              </div>
              {currencyKeys.length > 1 && (
                <div className="flex rounded-lg border border-border overflow-hidden">
                  {currencyKeys.sort((a, b) => (data!.grandTotals[b]?.stillToPayEur || 0) - (data!.grandTotals[a]?.stillToPayEur || 0)).map((c) => (
                    <button key={c} onClick={() => setCur(c)}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${cur === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border-2 border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="px-3 py-3 font-medium text-left">Investor</th>
                    <th className="px-3 py-3 font-medium text-right">On-chain LANA</th>
                    <th className="px-3 py-3 font-medium text-right">Gross</th>
                    <th className="px-3 py-3 font-medium text-right">Commission</th>
                    <th className="px-3 py-3 font-medium text-right">Net expected</th>
                    <th className="px-3 py-3 font-medium text-right">Already paid</th>
                    <th className="px-3 py-3 font-medium text-right">Still to pay</th>
                  </tr>
                </thead>
                <tbody>
                  {block!.investors.map((inv) => (
                    <tr key={inv.nostrHexId} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20 transition-colors">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{inv.name || `${inv.nostrHexId.slice(0, 12)}…`}</span>
                          {inv.isLastBudget && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">LAST</span>}
                          {inv.hasMultipleCurrencies && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400" title={`Budgets in ${inv.currencies.join(', ')}`}>{inv.currencies.join('/')}</span>}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">{inv.nostrHexId.slice(0, 12)}… · {inv.walletCount} wallet{inv.walletCount !== 1 ? 's' : ''}
                          {inv.balanceUnavailable && <span className="ml-1 text-amber-600 dark:text-amber-500">· balance unavailable</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmtLana(inv.onchainLana)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(inv.grossEur, cur!)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{inv.commissionPct}% · {fmt(inv.commissionEur, cur!)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmt(inv.netExpectedEur, cur!)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(inv.alreadyPaidEur, cur!)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums font-bold text-foreground whitespace-nowrap">{fmt(inv.stillToPayEur, cur!)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-bold">
                    <td className="px-3 py-3 text-foreground">Total · {block!.investors.length}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmtLana(block!.totals.onchainLana)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(block!.totals.grossEur, cur!)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(block!.totals.commissionEur, cur!)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmt(block!.totals.netExpectedEur, cur!)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(block!.totals.alreadyPaidEur, cur!)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmt(block!.totals.stillToPayEur, cur!)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {block!.investors.map((inv) => (
                <div key={inv.nostrHexId} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground truncate">{inv.name || `${inv.nostrHexId.slice(0, 12)}…`}</span>
                    <span className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(inv.stillToPayEur, cur!)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground font-mono">{inv.nostrHexId.slice(0, 12)}… · {inv.walletCount} wallet{inv.walletCount !== 1 ? 's' : ''}{inv.balanceUnavailable && <span className="text-amber-600 dark:text-amber-500"> · balance unavailable</span>}</div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
                    <span className="text-muted-foreground">On-chain LANA</span><span className="text-right font-mono tabular-nums text-foreground">{fmtLana(inv.onchainLana)}</span>
                    <span className="text-muted-foreground">Net expected</span><span className="text-right font-mono tabular-nums text-foreground">{fmt(inv.netExpectedEur, cur!)}</span>
                    <span className="text-muted-foreground">Commission</span><span className="text-right font-mono tabular-nums text-muted-foreground">{inv.commissionPct}% · {fmt(inv.commissionEur, cur!)}</span>
                    <span className="text-muted-foreground">Already paid</span><span className="text-right font-mono tabular-nums text-muted-foreground">{fmt(inv.alreadyPaidEur, cur!)}</span>
                  </div>
                </div>
              ))}
              <div className="rounded-xl border-2 border-border bg-muted/30 p-4 flex items-center justify-between font-bold">
                <span className="text-foreground">Total still to pay · {block!.investors.length}</span>
                <span className="font-mono text-foreground">{fmt(block!.totals.stillToPayEur, cur!)}</span>
              </div>
            </div>

            {/* Footnote: the honest caveat */}
            <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
              <strong>Net expected</strong> = current on-chain LANA × rate − {data?.commissionPct ?? '?'}% commission (LanaPays.Us investor rate; LANA still in the wallet).
              <strong> Already paid</strong> = EUR paid to them <em>since the current split started</em>{fmtSplitStart(data?.splitStartedAt) ? ` (${fmtSplitStart(data?.splitStartedAt)})` : ''} — this cash-out cycle only, for LANA they already sold (a different tranche that has left the wallet).
              <strong> Still to pay</strong> = max(0, net expected − already paid); treat it as an optimistic lower bound and use the components to reconcile before paying.
              {data?.updated_at && <> · Updated {new Date(data.updated_at).toLocaleString('sl-SI')}.</>}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
