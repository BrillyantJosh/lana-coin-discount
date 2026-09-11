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

type OpensMode = 'date' | 'sequence' | null;

interface RoundRow {
  round: number;
  opensAt: string | null;
  /** How this round opens. null = nothing chosen = it never will. */
  opensMode: OpensMode;
  /** Set once its turn came and was recorded; from then on it is open. */
  openedAt: string | null;
  /** False when the round has neither a date nor a rule — the silent block. */
  canEverOpen: boolean;
  /** Live mandates pointing at this round, and what they are holding. */
  mandateCount: number;
  waitingLana: number;
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
  /**
   * Not a round term — a treasury-wide switch that happens to belong on this
   * page, because this is where the treasury's appetite is set. It is stored in
   * app_settings, not in acquisition_rounds, and it applies to every split.
   */
  lanapaysOnly?: boolean;
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
  const [mode, setMode] = useState<Record<number, string>>({ 1: '', 2: '', 3: '' });
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
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
      if (!res.ok || json.error) throw new Error(json.error || 'Failed to load round terms');
      setData(json);
      if (s === null) setSplit(json.split);
      const o: Record<number, string> = {}; const d: Record<number, string> = {}; const m: Record<number, string> = {};
      for (const r of json.rounds) {
        o[r.round] = isoToLocalUtc(r.opensAt);
        d[r.round] = r.discountPercent === null ? '' : String(r.discountPercent);
        m[r.round] = r.opensMode ?? '';
      }
      setOpens(o); setDiscount(d); setMode(m);
      setLanapaysOnly(json.lanapaysOnly === true);
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
        opensMode: (mode[round] || '') === '' ? null : mode[round],
      }));
      const res = await fetch('/api/treasury/admin/rounds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ split, rounds, lanapaysOnly }),
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

            {/* What the treasury is acquiring from at all — not a round term.
                It sits above the rounds because it outranks them: with this on,
                a Main Wallet is refused no matter which round is open. */}
            <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
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

              {(() => {
                /**
                 * THE WARNING NOBODY GOT.
                 *
                 * Split 9 sat with three empty rounds and five mandates
                 * pointing at them, and every screen was quiet about it,
                 * because a round with no date looks exactly like a round
                 * whose date has not arrived. A round that cannot open is only
                 * alarming when it says who is standing behind it.
                 */
                // Two ways a round can be unreachable, and they are equally
                // silent: no way to open, or no price to open at. A round that
                // opens on time and then refuses everyone for want of a
                // discount is no better off than one that never opens.
                const stuck = (data?.rounds || []).filter(
                  r => r.mandateCount > 0 && (!r.canEverOpen || r.discountPercent === null),
                );
                if (stuck.length === 0) return null;
                const people = stuck.reduce((t, r) => t + r.mandateCount, 0);
                const lana = stuck.reduce((t, r) => t + r.waitingLana, 0);
                const missing = (r: RoundRow) => {
                  const bits: string[] = [];
                  if (!r.canEverOpen) bits.push('no date and no rule for opening');
                  if (r.discountPercent === null) bits.push('no discount');
                  return `round ${r.round}: ${bits.join(', ')}`;
                };
                return (
                  <div className="rounded-lg border-2 border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-4 py-3 space-y-1">
                    <p className="text-sm font-bold text-red-800 dark:text-red-300">
                      Split {data?.split}: {people} financing mandate{people > 1 ? 's' : ''} cannot be answered
                    </p>
                    <p className="text-xs text-red-700 dark:text-red-400">
                      {lana.toLocaleString('en-GB', { maximumFractionDigits: 2 })} LANA is waiting behind{' '}
                      {stuck.length > 1 ? 'rounds' : 'a round'} that cannot serve it — {stuck.map(missing).join('; ')}.
                      Nothing will change on its own: every proposal against{' '}
                      {stuck.length > 1 ? 'these rounds' : 'this round'} is refused, and the financer is not told
                      that the reason is on our side.
                    </p>
                  </div>
                );
              })()}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3">Round</th>
                      <th className="py-2 pr-3">Opens</th>
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
                          <td className="py-3 pr-3 font-bold">
                            Round {round}
                            {row && row.mandateCount > 0 && (
                              <p className="mt-1 text-[11px] font-normal text-muted-foreground">
                                {row.mandateCount} mandate{row.mandateCount > 1 ? 's' : ''} ·{' '}
                                {row.waitingLana.toLocaleString('en-GB', { maximumFractionDigits: 2 })} LANA
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <select
                              value={mode[round] || ''}
                              onChange={e => setMode(prev => ({ ...prev, [round]: e.target.value }))}
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                            >
                              <option value="">— not set (stays shut)</option>
                              <option value="date">On the date</option>
                              <option value="sequence">
                                {round === 1 ? 'As soon as the window opens' : `When round ${round - 1} runs out`}
                              </option>
                            </select>
                            {mode[round] === 'sequence' && (
                              <p className="mt-1 max-w-xs text-[11px] text-muted-foreground">
                                {round === 1
                                  ? 'Opens the moment this Split enters its buyback window. No date needed.'
                                  : `Opens once the treasury has acquired what round ${round - 1} is holding. A date, if you also set one, stays as the day it opens at the latest — never later.`}
                              </p>
                            )}
                            {row?.openedAt && (
                              <p className="mt-1 text-[11px] font-medium text-green-700 dark:text-green-400">
                                Opened {row.openedAt}
                              </p>
                            )}
                          </td>
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
