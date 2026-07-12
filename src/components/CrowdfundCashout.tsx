import { useEffect, useMemo, useState } from 'react';

/**
 * Crowd-funding cash-out — Tier-2 monitoring + payout eligibility for THIS split.
 * Per currency: a per-owner eligibility table (raised − paid = the priority list
 * that pays right after investors) and a per-project monitoring table (raised /
 * goal / %funded). Read-only report — pays no one. Rendered as a tab on
 * /admin/expecting-cashout.
 */

const SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };
const fmt = (n: number, cur: string) =>
  (SYM[cur] || cur + ' ') + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtLana = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSplitStart = (unixSec?: number | null) =>
  unixSec ? new Date(unixSec * 1000).toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;

interface Owner {
  ownerHex: string; ownerName: string;
  raisedLana: number; raisedFiat: number;
  alreadyPaidFiat: number; stillEligibleFiat: number; donationCount: number;
}
interface Project {
  projectId: string; title: string | null; ownerHex: string | null; ownerName: string | null;
  fiatGoal: number; raisedLana: number; raisedFiat: number; pctFunded: number | null; backers: number; status: string | null;
}
interface CurBlock {
  owners: Owner[]; projects: Project[];
  totals: { raisedFiat: number; raisedLana: number; alreadyPaidFiat: number; stillEligibleFiat: number };
}
interface Data {
  currentSplit: number;
  splitStartedAt?: number | null;
  splitStartMissing?: boolean;
  currencies: Record<string, CurBlock>;
  grandTotals: Record<string, { raisedFiat: number; stillEligibleFiat: number; ownerCount: number; projectCount: number }>;
  updated_at: string;
  error?: string;
}

export default function CrowdfundCashout({ adminHexId }: { adminHexId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/crowdfund-cashout', { headers: { 'x-admin-hex-id': adminHexId } });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setCur((prev) => prev ?? Object.keys(json.currencies || {}).sort(
        (a, b) => (json.grandTotals?.[b]?.stillEligibleFiat || 0) - (json.grandTotals?.[a]?.stillEligibleFiat || 0)
      )[0] ?? null);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminHexId]);

  const currencyKeys = useMemo(() => Object.keys(data?.currencies || {}), [data]);
  const block = cur ? data?.currencies?.[cur] : null;
  const gt = cur ? data?.grandTotals?.[cur] : null;

  if (loading && !data) return <div className="flex justify-center py-16"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (error) return <p className="text-center text-red-500 py-12">{error}</p>;
  if (currencyKeys.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
        <p className="text-lg text-muted-foreground">No crowd-funding donations this split yet.</p>
        <p className="text-sm text-muted-foreground/70 mt-1">LanaCrowd (KIND 60200) donations appear here once the heartbeat pulls them.</p>
      </div>
    );
  }

  return (
    <>
      {data?.splitStartMissing && (
        <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          KIND 38888 carries no split-start date — figures fall back to the lifetime total. Publish <code>split_started_at</code> to scope to this cycle.
        </div>
      )}

      {/* Currency toggle + headline totals */}
      <div className="flex items-start justify-between gap-4 flex-wrap mt-4 mb-4">
        <div className="flex items-start gap-8 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Still eligible ({cur})</p>
            <p className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums">{fmt(gt?.stillEligibleFiat || 0, cur!)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{gt?.ownerCount || 0} owner{(gt?.ownerCount || 0) !== 1 ? 's' : ''} · raised − project-wallet cash-outs, since split start{fmtSplitStart(data?.splitStartedAt) ? ` (${fmtSplitStart(data?.splitStartedAt)})` : ''}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Raised ({cur})</p>
            <p className="text-2xl sm:text-3xl font-bold text-muted-foreground tabular-nums">{fmt(block?.totals.raisedFiat || 0, cur!)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{fmtLana(block?.totals.raisedLana || 0)} LANA · {gt?.projectCount || 0} project{(gt?.projectCount || 0) !== 1 ? 's' : ''}</p>
          </div>
        </div>
        {currencyKeys.length > 1 && (
          <div className="flex rounded-lg border border-border overflow-hidden">
            {currencyKeys.sort((a, b) => (data!.grandTotals[b]?.stillEligibleFiat || 0) - (data!.grandTotals[a]?.stillEligibleFiat || 0)).map((c) => (
              <button key={c} onClick={() => setCur(c)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${cur === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Priority eligibility (the payout list) ── */}
      <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300">TIER 2</span>
        Priority eligibility — paid right after investors
      </h2>
      <div className="hidden md:block overflow-x-auto rounded-2xl border-2 border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="px-3 py-3 font-medium text-left">Project owner</th>
              <th className="px-3 py-3 font-medium text-right">Raised LANA</th>
              <th className="px-3 py-3 font-medium text-right">Raised</th>
              <th className="px-3 py-3 font-medium text-right" title="Only LANA cashed out of the project wallet — investor / LanaPays.Us payouts are not counted">Cashed out</th>
              <th className="px-3 py-3 font-medium text-right">Still eligible</th>
            </tr>
          </thead>
          <tbody>
            {block!.owners.map((o) => (
              <tr key={o.ownerHex} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-3">
                  <div className="font-medium text-foreground">{o.ownerName}</div>
                  <div className="text-xs text-muted-foreground font-mono">{o.ownerHex.slice(0, 12)}… · {o.donationCount} donation{o.donationCount !== 1 ? 's' : ''}</div>
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmtLana(o.raisedLana)}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(o.raisedFiat, cur!)}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(o.alreadyPaidFiat, cur!)}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums font-bold text-foreground whitespace-nowrap">{fmt(o.stillEligibleFiat, cur!)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/30 font-bold">
              <td className="px-3 py-3 text-foreground">Total · {block!.owners.length}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmtLana(block!.totals.raisedLana)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(block!.totals.raisedFiat, cur!)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{fmt(block!.totals.alreadyPaidFiat, cur!)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmt(block!.totals.stillEligibleFiat, cur!)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="md:hidden space-y-3">
        {block!.owners.map((o) => (
          <div key={o.ownerHex} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground truncate">{o.ownerName}</span>
              <span className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(o.stillEligibleFiat, cur!)}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground font-mono">{o.ownerHex.slice(0, 12)}… · {o.donationCount} donation{o.donationCount !== 1 ? 's' : ''}</div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
              <span className="text-muted-foreground">Raised LANA</span><span className="text-right font-mono tabular-nums text-foreground">{fmtLana(o.raisedLana)}</span>
              <span className="text-muted-foreground">Raised</span><span className="text-right font-mono tabular-nums text-foreground">{fmt(o.raisedFiat, cur!)}</span>
              <span className="text-muted-foreground">Cashed out</span><span className="text-right font-mono tabular-nums text-muted-foreground">{fmt(o.alreadyPaidFiat, cur!)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Projects (monitoring) ── */}
      <h2 className="text-sm font-semibold text-foreground mb-2 mt-6">Projects</h2>
      <div className="hidden md:block overflow-x-auto rounded-2xl border-2 border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="px-3 py-3 font-medium text-left">Project</th>
              <th className="px-3 py-3 font-medium text-left">Owner</th>
              <th className="px-3 py-3 font-medium text-right">Goal</th>
              <th className="px-3 py-3 font-medium text-right">Raised</th>
              <th className="px-3 py-3 font-medium text-right">Funded</th>
              <th className="px-3 py-3 font-medium text-right">Backers</th>
            </tr>
          </thead>
          <tbody>
            {block!.projects.map((p) => (
              <tr key={p.projectId} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-3">
                  <div className="font-medium text-foreground">{p.title || `${p.projectId.slice(0, 20)}…`}</div>
                  {p.status && p.status !== 'active' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p.status}</span>}
                </td>
                <td className="px-3 py-3 text-muted-foreground">{p.ownerName || (p.ownerHex ? `${p.ownerHex.slice(0, 10)}…` : '—')}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{p.fiatGoal ? fmt(p.fiatGoal, cur!) : '—'}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground whitespace-nowrap">{fmt(p.raisedFiat, cur!)}<div className="text-[11px] text-muted-foreground">{fmtLana(p.raisedLana)} LANA</div></td>
                <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">{p.pctFunded != null ? <span className={p.pctFunded >= 100 ? 'text-emerald-600 font-semibold' : 'text-foreground'}>{p.pctFunded}%</span> : '—'}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">{p.backers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden space-y-3">
        {block!.projects.map((p) => (
          <div key={p.projectId} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground truncate">{p.title || `${p.projectId.slice(0, 16)}…`}</span>
              <span className="font-mono font-bold text-foreground whitespace-nowrap">{fmt(p.raisedFiat, cur!)}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground truncate">{p.ownerName || (p.ownerHex ? `${p.ownerHex.slice(0, 10)}…` : '—')}</div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
              <span className="text-muted-foreground">Goal</span><span className="text-right font-mono tabular-nums text-muted-foreground">{p.fiatGoal ? fmt(p.fiatGoal, cur!) : '—'}</span>
              <span className="text-muted-foreground">Funded</span><span className="text-right font-mono tabular-nums text-foreground">{p.pctFunded != null ? `${p.pctFunded}%` : '—'}</span>
              <span className="text-muted-foreground">Backers</span><span className="text-right font-mono tabular-nums text-muted-foreground">{p.backers}</span>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
        <strong>Still eligible</strong> = raised − <strong>project-wallet cash-outs</strong>, this split only. Only LANA sold out of the project's own wallet counts as cashed out — <strong>investor / LanaPays.Us payouts do NOT reduce it</strong>, so someone who is both an investor and a project owner keeps their crowd-funding eligibility (the two entitlements are separate). A project owner with still-eligible &gt; 0 is paid <strong>right after investors</strong> (Tier 2) and ahead of everyone else, in whichever currency they raised. Excludes the 10% mentor fee and any blocked project.
        {data?.updated_at && <> · Updated {new Date(data.updated_at).toLocaleString('sl-SI')}.</>}
      </p>
    </>
  );
}
