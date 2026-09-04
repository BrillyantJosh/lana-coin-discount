import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { ADMIN_ROUNDS } from '@/copy';
import { fill } from '@/components/MandatePanel';
import { DISCOUNT_BAND } from '../../server/lib/roundMandate';

/**
 * ROUND DATES & DISCOUNTS — the terms of the financing-round mandate.
 *
 * One date and one discount per round, per Split (owner's decisions 1 and 2,
 * 4 Sep 2026). lana.discount is the authority for both: the KIND 30960 event
 * only echoes them. A date OPENS a mandate and grants no right to sell (BEF
 * P08 §8); the discount is orientation within the P08 §4 band and is flagged,
 * not refused, outside it.
 *
 * Dates are entered as UTC. A datetime-local input has no zone of its own,
 * so the value is read and written as if it were UTC — the field label says
 * so, and the ISO the server stores is what it shows back.
 */

interface RoundRow {
  round: number;
  opensAt: string | null;
  discountPercent: number | null;
  prefillDiscountPercent: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface RoundsResponse {
  split: number;
  currentSplit: number | null;
  directFundReachable: boolean;
  rounds: RoundRow[];
}

/** ISO → "YYYY-MM-DDTHH:mm" in UTC, for a datetime-local input. */
function isoToLocalUtc(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" read as UTC → ISO Z. */
function localUtcToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}:00Z`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const fmtUtcLong = (iso: string | null) => {
  if (!iso) return '—';
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

  // The three rows as edited.
  const [opens, setOpens] = useState<Record<number, string>>({ 1: '', 2: '', 3: '' });
  const [discount, setDiscount] = useState<Record<number, string>>({ 1: '', 2: '', 3: '' });
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);

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
      if (!res.ok || json.error) throw new Error(json.error || 'Failed to load round terms');
      setData(json);
      if (s === null) setSplit(json.split);
      const o: Record<number, string> = {}; const d: Record<number, string> = {};
      for (const r of json.rounds) {
        o[r.round] = isoToLocalUtc(r.opensAt);
        d[r.round] = r.discountPercent === null ? '' : String(r.discountPercent);
      }
      setOpens(o); setDiscount(d);
      setServerWarnings([]);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load round terms');
    } finally {
      setLoading(false);
    }
  };

  const prefill = () => {
    if (!data) return;
    let filled = 0;
    const next = { ...discount };
    for (const r of data.rounds) {
      if ((next[r.round] || '').trim() === '' && r.prefillDiscountPercent !== null) {
        next[r.round] = String(r.prefillDiscountPercent);
        filled++;
      }
    }
    setDiscount(next);
    if (filled === 0) toast.info(data.directFundReachable ? ADMIN_ROUNDS.prefillNone : ADMIN_ROUNDS.prefillUnreachable);
  };

  /** Client-side echoes of the server's warnings, so they are seen before saving. */
  const localWarnings = (round: number): string[] => {
    const out: string[] = [];
    const d = Number(discount[round]);
    if ((discount[round] || '').trim() !== '' && Number.isFinite(d) && (d < DISCOUNT_BAND.min || d > DISCOUNT_BAND.max)) {
      out.push(fill(ADMIN_ROUNDS.bandWarning, { min: DISCOUNT_BAND.min, max: DISCOUNT_BAND.max }));
    }
    return out;
  };

  const save = async () => {
    if (!session || split === null) return;
    setSaving(true);
    try {
      const rounds = [1, 2, 3].map(round => ({
        round,
        opensAt: localUtcToIso(opens[round]),
        discountPercent: (discount[round] || '').trim() === '' ? null : Number(discount[round]),
      }));
      const res = await fetch('/api/treasury/admin/rounds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ split, rounds }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setServerWarnings(json.warnings || []);
        throw new Error(json.error || 'Save failed');
      }
      setServerWarnings(json.warnings || []);
      toast.success(ADMIN_ROUNDS.saved);
      await load(split);
      if (json.warnings?.length) setServerWarnings(json.warnings);
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
            {/* Split */}
            <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-3">
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
            </div>

            {/* Rounds */}
            <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-foreground">Split {split ?? '—'}</h2>
                <button
                  onClick={prefill}
                  disabled={!data}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                  title={data?.directFundReachable === false ? ADMIN_ROUNDS.prefillUnreachable : undefined}
                >
                  {ADMIN_ROUNDS.prefill}
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3">Round</th>
                      <th className="py-2 pr-3">{ADMIN_ROUNDS.opensLabel}</th>
                      <th className="py-2 pr-3">{ADMIN_ROUNDS.discountLabel}</th>
                      <th className="py-2">Last change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3].map(round => {
                      const row = data?.rounds.find(r => r.round === round);
                      const warns = localWarnings(round);
                      return (
                        <tr key={round} className="border-b border-border/50 align-top">
                          <td className="py-3 pr-3 font-bold">Round {round}</td>
                          <td className="py-3 pr-3">
                            <input
                              type="datetime-local"
                              value={opens[round] || ''}
                              onChange={e => setOpens(prev => ({ ...prev, [round]: e.target.value }))}
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                            {opens[round] && (
                              <p className="mt-1 text-[11px] text-muted-foreground">= {fmtUtcLong(localUtcToIso(opens[round]))}</p>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <div className="relative w-28">
                              <input
                                type="number" min="0" max="100" step="0.5"
                                value={discount[round] || ''}
                                onChange={e => setDiscount(prev => ({ ...prev, [round]: e.target.value }))}
                                placeholder={row?.prefillDiscountPercent !== null && row?.prefillDiscountPercent !== undefined ? `DF: ${row.prefillDiscountPercent}` : ''}
                                className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-8 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold">%</span>
                            </div>
                            {warns.map((w, i) => (
                              <p key={i} className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 max-w-xs">{w}</p>
                            ))}
                          </td>
                          <td className="py-3 text-[11px] text-muted-foreground">
                            {row?.updatedAt ? (
                              <>
                                {row.updatedAt}
                                {row.updatedBy && <><br /><span className="font-mono">{row.updatedBy.slice(0, 12)}…</span></>}
                              </>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {serverWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 space-y-1">
                  {serverWarnings.map((w, i) => <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{w}</p>)}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={save}
                  disabled={saving || split === null}
                  className={`rounded-xl px-6 py-2.5 font-semibold text-white transition-all ${
                    saving || split === null ? 'bg-muted-foreground/30 cursor-not-allowed' : 'bg-primary hover:bg-primary/90'
                  }`}
                >
                  {saving ? 'Saving…' : ADMIN_ROUNDS.save}
                </button>
              </div>
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
