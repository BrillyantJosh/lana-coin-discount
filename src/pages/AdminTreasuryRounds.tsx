import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { ADMIN_ROUNDS } from '@/copy';
import { fill } from '@/components/MandatePanel';

/**
 * ROUND PAYOUT DATES — read-only.
 *
 * One date per financing round, per Split (owner's decision 2, 4 Sep 2026).
 * Since 13 Sept 2026 the dates and each round's sell fee are published in
 * KIND 38888 (split_payout) and taken over by the server; the owner asked for
 * the fees to leave this page entirely, "da ne bo zmede". The page shows the
 * dates and where they come from, and keeps the one switch the event does not
 * carry: whether the treasury acquires only from LanaPays.Us wallets.
 *
 * Dates are shown in UTC, as they are published.
 */

interface RoundRow {
  round: number;
  opensAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface RoundsResponse {
  split: number;
  currentSplit: number | null;
  rounds: RoundRow[];
  /**
   * Not a round term — a treasury-wide switch that happens to belong on this
   * page, because this is where the treasury's appetite is set. It is stored in
   * app_settings, not in acquisition_rounds, and it applies to every split.
   */
  lanapaysOnly?: boolean;
  /** The terms of this split came from KIND 38888. */
  publishedIn38888?: boolean;
  kind38888?: {
    eventId: string | null;
    createdAt: number | null;
    /** This split's rows in the event that were refused, with why. */
    rejected: Array<{ split: string; reason: string }>;
  };
}

const fmtUtcLong = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
};

const AdminTreasuryRounds = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState<RoundsResponse | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lanapaysOnly, setLanapaysOnly] = useState(false);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    load(split);
  }, [session, isAdmin, split]);

  const load = async (s: number | null) => {
    if (!session) return;
    setLoading(true);
    try {
      const q = s === null ? '' : `?split=${s}`;
      const res = await fetch(`/api/treasury/admin/rounds${q}`, { headers: { 'x-admin-hex-id': session.nostrHexId } });
      const json: RoundsResponse & { error?: string } = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Failed to load round dates');
      setData(json);
      if (s === null) setSplit(json.split);
      setLanapaysOnly(json.lanapaysOnly === true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load round dates');
    } finally {
      setLoading(false);
    }
  };

  const saveScope = async () => {
    if (!session) return;
    setSaving(true);
    try {
      const res = await fetch('/api/treasury/admin/rounds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ lanapaysOnly }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Save failed');
      setLanapaysOnly(json.lanapaysOnly === true);
      setData(d => (d ? { ...d, lanapaysOnly: json.lanapaysOnly === true } : d));
      toast.success(ADMIN_ROUNDS.savedScope);
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || !session || !isAdmin) return null;

  const current = data?.currentSplit ?? null;
  const splitOptions: Array<{ value: number; label: string }> = current === null ? [] : [
    { value: current - 1, label: fill(ADMIN_ROUNDS.liveSplit, { split: current - 1 }) },
    { value: current, label: fill(ADMIN_ROUNDS.upcomingSplit, { split: current }) },
  ];
  const published = data?.publishedIn38888 === true;
  const scopeChanged = data !== null && (data.lanapaysOnly === true) !== lanapaysOnly;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-4xl">
        <div className="mb-6 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">{ADMIN_ROUNDS.title}</h1>
          <p className="text-muted-foreground">{ADMIN_ROUNDS.intro}</p>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 mb-6">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{ADMIN_ROUNDS.banner}</p>
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* What the treasury is acquiring from at all — not a round term.
                It sits above the rounds because it outranks them: with this on,
                a Main Wallet is refused no matter which round is open. */}
            <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={lanapaysOnly}
                  onChange={e => setLanapaysOnly(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-border accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{ADMIN_ROUNDS.lanapaysOnlyLabel}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {ADMIN_ROUNDS.lanapaysOnlyHelp}
                  </span>
                  {lanapaysOnly && (
                    <span className="mt-2 block rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                      {ADMIN_ROUNDS.lanapaysOnlyOn}
                    </span>
                  )}
                </span>
              </label>
              <div className="flex justify-end">
                <button
                  onClick={saveScope}
                  disabled={saving || !scopeChanged}
                  className={`rounded-xl px-6 py-2.5 font-semibold text-white transition-all ${
                    saving || !scopeChanged ? 'bg-muted-foreground/30 cursor-not-allowed' : 'bg-primary hover:bg-primary/90'
                  }`}
                >
                  {saving ? 'Saving…' : ADMIN_ROUNDS.saveScope}
                </button>
              </div>
            </div>

            {/* Rounds — shown, never edited here */}
            <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm font-medium text-foreground">{ADMIN_ROUNDS.splitLabel}</label>
                {splitOptions.length > 0 ? (
                  <select
                    value={split ?? ''}
                    onChange={e => setSplit(Number(e.target.value))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {splitOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    {split !== null && !splitOptions.some(o => o.value === split) && (
                      <option value={split}>Split {split}</option>
                    )}
                  </select>
                ) : (
                  <input
                    type="number" min="1" value={split ?? ''}
                    onChange={e => setSplit(e.target.value ? Number(e.target.value) : null)}
                    className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
                  />
                )}
                <span className="text-xs text-muted-foreground">
                  Current Split: <strong className="text-foreground">{current ?? 'unknown'}</strong>
                </span>
              </div>

              {published ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800 px-4 py-3 space-y-2">
                  <p className="text-sm font-semibold text-sky-900 dark:text-sky-200">{ADMIN_ROUNDS.publishedTitle}</p>
                  <p className="text-xs leading-relaxed text-sky-900 dark:text-sky-200">{fill(ADMIN_ROUNDS.publishedBody, { split: split ?? '' })}</p>
                  {data?.kind38888?.eventId && (
                    <p className="text-[11px] text-sky-800/80 dark:text-sky-300/80 font-mono">
                      {fill(ADMIN_ROUNDS.publishedEvent, {
                        event: `${data.kind38888.eventId.slice(0, 12)}…`,
                        when: data.kind38888.createdAt ? fmtUtcLong(new Date(data.kind38888.createdAt * 1000).toISOString()) ?? '—' : '—',
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 space-y-1">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{ADMIN_ROUNDS.notPublishedTitle}</p>
                  <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">{fill(ADMIN_ROUNDS.notPublished, { split: split ?? '' })}</p>
                </div>
              )}

              {(data?.kind38888?.rejected || []).map((r, i) => (
                <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{ADMIN_ROUNDS.refusedTitle}</p>
                  <p className="text-xs text-amber-800 dark:text-amber-300">{fill(ADMIN_ROUNDS.refusedBody, { reason: r.reason })}</p>
                </div>
              ))}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3">Round</th>
                      <th className="py-2 pr-3">{ADMIN_ROUNDS.opensLabel}</th>
                      <th className="py-2">Last change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3].map(round => {
                      const row = data?.rounds.find(r => r.round === round);
                      const opens = fmtUtcLong(row?.opensAt ?? null);
                      return (
                        <tr key={round} className="border-b border-border/50 align-top">
                          <td className="py-3 pr-3 font-bold">Round {round}</td>
                          <td className="py-3 pr-3 font-mono">
                            {opens ?? <span className="text-muted-foreground font-sans">{ADMIN_ROUNDS.notDated}</span>}
                          </td>
                          <td className="py-3 text-[11px] text-muted-foreground">
                            {row?.updatedAt ? (
                              <>
                                {row.updatedAt}
                                {row.updatedBy && (
                                  <><br /><span className="font-mono">
                                    {row.updatedBy.startsWith('kind38888:')
                                      ? `${ADMIN_ROUNDS.lastChangeEvent} ${row.updatedBy.slice('kind38888:'.length, 'kind38888:'.length + 12)}…`
                                      : `${row.updatedBy.slice(0, 12)}…`}
                                  </span></>
                                )}
                              </>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <a
                href={ADMIN_ROUNDS.publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-foreground hover:bg-accent"
              >
                {ADMIN_ROUNDS.publishedCta}
              </a>
            </div>
          </div>
        )}
      </div>
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminTreasuryRounds;
