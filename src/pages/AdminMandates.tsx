import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { ADMIN_MANDATES, MANDATE, OFFER_STATUS_LABELS } from '@/copy';
import { fill } from '@/components/MandatePanel';
import type { RoundState } from '../../server/lib/roundMandate';

/**
 * MANDATES — financer × round. The operator's worklist for the financing-
 * round mandate, replacing /admin/expecting-cashout.
 *
 * Every row is one signed KIND 30960 event (one financer, one round, one
 * Split) mirrored into acquisition_mandates, with what the budget received,
 * what remains under the mandate, and what has been proposed, accepted and
 * settled against it. Nothing here pays anyone: "Release now" opens a
 * mandate ahead of its date (with a reason, recorded), "Sync now" re-reads
 * the relays, and "Void" closes an accepted offer whose transfer never came.
 */

interface WalletRow {
  address: string;
  currency: string;
  fundSettingId: string;
  lanaReceived: number;
  onchainLana: number | null;
  balanceUnavailable: boolean;
}

interface MandateOffer {
  offerRef: string;
  status: string;
  lanaAmount: number;
  proposedLanaAmount: number | null;
  currency: string;
  purchasePrice: number | null;
  createdAt: string;
  acceptedAt: string | null;
  settlementDueAt: string | null;
  decisionReason: string | null;
  mandateCode: string | null;
}

interface CurrencyFunding {
  currency: string;
  lanaExpected: number;
  lanaRemaining: number;
  lanaProposed: number;
  lanaAccepted: number;
  lanaSettled: number;
  referenceRate: number | null;
  basis: 'projected_next_split' | 'current_split' | null;
  discountPercent: number | null;
  pricePerLana: number | null;
  fiatExpected: number | null;
  fiatRemaining: number | null;
  fiatAccepted: number;
  fiatSettled: number;
  gaps: Array<'NO_RATE' | 'NO_DISCOUNT' | 'NO_REFERENCE'>;
}

interface RoundFunding {
  round: number;
  mandateCount: number;
  currencies: CurrencyFunding[];
  totalsByCurrency: Record<string, number | null>;
}

interface MandateRow {
  mandateRef: string;
  eventId: string;
  status: 'announced' | 'closed';
  split: number;
  round: number;
  financerHex: string;
  wallets: WalletRow[];
  currencies: string[];
  expectedLana: number;
  proposedLana: number;
  acceptedLana: number;
  settledLana: number;
  remainingLana: number;
  state: RoundState;
  opensAt: string | null;
  discountPercent: number | null;
  released: { by: string; reason: string; at: string } | null;
  warnings: string[];
  offers: MandateOffer[];
}

interface MandatesResponse {
  split: number;
  currentSplit: number | null;
  lastSyncAt: string | null;
  degraded: { noEvents: boolean; noTerms: boolean; splitUnknown: boolean; staleSync: boolean; balancesPartial: boolean };
  totals: { expectedLana: number; remainingLana: number; proposedLana: number; acceptedLana: number; settledLana: number };
  rounds: Array<{ round: number; opensAt: string | null; discountPercent: number | null }>;
  funding: RoundFunding[];
  mandates: MandateRow[];
  updated_at: string;
}

const fmtLana = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (s: string | null | undefined, head = 8, tail = 6) =>
  !s ? '—' : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const fmtUtc = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso);
  return isNaN(d.getTime()) ? iso : `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
};

/** A money figure, or an em dash when there is no honest number to show. */
const fmtFiat = (n: number | null | undefined, currency: string) => {
  if (n === null || n === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
};

/** Why the treasury cannot be told what a round costs. */
const GAP_TEXT: Record<string, string> = {
  NO_RATE: 'no reference rate for this currency in KIND 38888',
  NO_DISCOUNT: 'no discount set for this round',
  NO_REFERENCE: 'this Split is outside the mandate window — no reference to quote',
};

const BASIS_TEXT: Record<string, string> = {
  projected_next_split: 'at twice the current rate (this Split has not landed yet)',
  current_split: 'at the current rate (the Split has landed)',
};

const STATE_TONE: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  released: 'bg-green-100 text-green-800',
  not_open: 'bg-amber-100 text-amber-800',
  upcoming_split: 'bg-blue-100 text-blue-800',
  fully_acquired: 'bg-muted text-muted-foreground',
  terms_missing: 'bg-amber-100 text-amber-800',
  window_passed: 'bg-muted text-muted-foreground',
  closed: 'bg-muted text-muted-foreground',
  split_unknown: 'bg-muted text-muted-foreground',
};

/** Names from the users cache (KIND 0), a few at a time; a miss shows the hex. */
async function resolveNames(hexes: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const CONCURRENCY = 6;
  for (let i = 0; i < hexes.length; i += CONCURRENCY) {
    await Promise.all(hexes.slice(i, i + CONCURRENCY).map(async hex => {
      try {
        const r = await fetch(`/api/user/${hex}/profile`);
        const j = await r.json();
        const name = j.fullName || j.displayName || null;
        if (name) out[hex] = name;
      } catch { /* the hex is enough */ }
    }));
  }
  return out;
}

export default function AdminMandates() {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState<MandatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [split, setSplit] = useState<number | null>(null);
  const [currency, setCurrency] = useState('');
  const [round, setRound] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  // Release dialog
  const [releaseFor, setReleaseFor] = useState<MandateRow | null>(null);
  const [releaseReason, setReleaseReason] = useState('');
  const [round1Confirm, setRound1Confirm] = useState(false);
  const [releasing, setReleasing] = useState(false);

  // Void dialog
  const [voidFor, setVoidFor] = useState<MandateOffer | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    load();
  }, [session, isAdmin, split, currency, round]);

  const load = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (split !== null) q.set('split', String(split));
      if (currency) q.set('currency', currency);
      if (round) q.set('round', round);
      const res = await fetch(`/api/treasury/admin/mandates?${q.toString()}`, { headers: { 'x-admin-hex-id': session.nostrHexId } });
      const json: MandatesResponse & { error?: string } = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Failed to load mandates');
      setData(json);
      if (split === null) setSplit(json.split);
      const missing = [...new Set(json.mandates.map(m => m.financerHex))].filter(h => names[h] === undefined);
      if (missing.length) {
        resolveNames(missing).then(found => setNames(prev => ({ ...prev, ...found })));
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to load mandates');
    } finally {
      setLoading(false);
    }
  };

  const sync = async () => {
    if (!session) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/treasury/admin/mandates/sync', { method: 'POST', headers: { 'x-admin-hex-id': session.nostrHexId } });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Sync failed');
      toast.success(`Synced — ${json.seen ?? 0} seen, ${json.stored ?? 0} stored, ${json.rejected ?? 0} rejected`);
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const submitRelease = async (released: boolean) => {
    if (!session || !releaseFor) return;
    const reason = releaseReason.trim();
    if (!reason) { toast.error('A reason is required.'); return; }
    if (released && releaseFor.round === 1 && !round1Confirm) { toast.error('Confirm the round-1 release first.'); return; }
    setReleasing(true);
    try {
      const res = await fetch(`/api/treasury/admin/mandates/${encodeURIComponent(releaseFor.mandateRef)}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ released, reason }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Release failed');
      toast.success(released ? 'Mandate released' : 'Release withdrawn');
      setReleaseFor(null); setReleaseReason(''); setRound1Confirm(false);
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Release failed');
    } finally {
      setReleasing(false);
    }
  };

  const submitVoid = async () => {
    if (!session || !voidFor) return;
    const reason = voidReason.trim();
    if (!reason) { toast.error('A reason is required.'); return; }
    setVoiding(true);
    try {
      const res = await fetch(`/api/acquisitions/admin/${voidFor.offerRef}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ reason }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Void failed');
      toast.success(`${voidFor.offerRef} voided`);
      setVoidFor(null); setVoidReason('');
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Void failed');
    } finally {
      setVoiding(false);
    }
  };

  const currencies = useMemo(() => [...new Set((data?.mandates || []).flatMap(m => m.currencies))].sort(), [data]);

  if (authLoading || !session || !isAdmin) return null;

  const current = data?.currentSplit ?? null;
  const splitOptions = current === null ? [] : [
    { value: current - 1, label: `Split ${current - 1} — live window` },
    { value: current, label: `Split ${current} — upcoming` },
  ];
  const degraded = data?.degraded;
  const banners: string[] = [];
  if (degraded?.splitUnknown) banners.push(ADMIN_MANDATES.degraded.splitUnknown);
  if (degraded?.noEvents) banners.push(ADMIN_MANDATES.degraded.noEvents);
  if (degraded?.noTerms) banners.push(ADMIN_MANDATES.degraded.noTerms);
  if (degraded?.staleSync) banners.push(ADMIN_MANDATES.degraded.staleSync);
  if (degraded?.balancesPartial) banners.push(ADMIN_MANDATES.degraded.balancesPartial);

  const tiles: Array<[string, number | undefined]> = [
    [ADMIN_MANDATES.tiles.expected, data?.totals.expectedLana],
    [ADMIN_MANDATES.tiles.remaining, data?.totals.remainingLana],
    [ADMIN_MANDATES.tiles.proposed, data?.totals.proposedLana],
    [ADMIN_MANDATES.tiles.accepted, data?.totals.acceptedLana],
    [ADMIN_MANDATES.tiles.settled, data?.totals.settledLana],
  ];

  // One list, cut into rounds: each round carries its own header, its own rows
  // and its own money line, so round 1 and round 2 are never read as one pile.
  const renderMandateRow = (m: MandateRow) => {
                  const isOpen = expanded === m.mandateRef;
                  return (
                    <Fragment key={m.mandateRef}>
                      <tr className={`border-b border-border/50 align-top ${m.status === 'closed' ? 'opacity-60' : ''}`}>
                        <td className="px-3 py-3 min-w-[10rem]">
                          <div className="font-medium text-foreground">{names[m.financerHex] || `${m.financerHex.slice(0, 12)}…`}</div>
                          <div className="font-mono text-[11px] text-muted-foreground" title={m.financerHex}>{m.financerHex.slice(0, 12)}…</div>
                        </td>
                        <td className="px-3 py-3 font-bold whitespace-nowrap">R{m.round} <span className="text-[11px] font-normal text-muted-foreground">S{m.split}</span></td>
                        <td className="px-3 py-3">
                          {m.wallets.map(w => (
                            <div key={w.address} className="text-[11px] whitespace-nowrap">
                              <span className="font-mono" title={w.address}>{short(w.address, 8, 5)}</span>
                              <span className="ml-1 font-bold">{w.currency}</span>
                              <span className="ml-1 text-muted-foreground">recv {fmtLana(w.lanaReceived)}</span>
                              <span className="ml-1 text-muted-foreground">· chain {w.balanceUnavailable ? 'n/a' : fmtLana(w.onchainLana)}</span>
                            </div>
                          ))}
                        </td>
                        <td className="px-3 py-3 text-right font-mono whitespace-nowrap">{fmtLana(m.expectedLana)}</td>
                        <td className="px-3 py-3 text-right font-mono whitespace-nowrap font-bold">{fmtLana(m.remainingLana)}</td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${STATE_TONE[m.state] || STATE_TONE.split_unknown}`}>
                            {MANDATE.states[m.state] || m.state}
                          </span>
                          {m.opensAt && <div className="text-[11px] text-muted-foreground mt-1 whitespace-nowrap">{fmtUtc(m.opensAt)} · {m.discountPercent ?? '—'}%</div>}
                          {m.released && (
                            <div className="mt-1 inline-flex flex-col rounded bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-2 py-1 text-[11px] text-green-800 dark:text-green-300"
                              title={`${m.released.by} · ${m.released.at}`}>
                              <span className="font-bold">Released</span>
                              <span>{m.released.reason}</span>
                              <span className="font-mono text-[10px]">{m.released.by.slice(0, 10)}… · {fmtUtc(m.released.at)}</span>
                            </div>
                          )}
                          {m.warnings.includes('ACCEPTED_EXCEEDS_RECEIVED') && (
                            <div className="mt-1 text-[11px] text-red-600 font-medium">{ADMIN_MANDATES.acceptedExceedsReceived}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground" title={m.eventId}>{short(m.eventId, 8, 4)}</td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <div className="flex flex-col gap-1 items-stretch">
                            <button
                              onClick={() => setExpanded(isOpen ? null : m.mandateRef)}
                              className="rounded border border-border px-2 py-1 text-[11px] font-bold hover:bg-accent"
                            >
                              {isOpen ? 'Hide' : `Offers (${m.offers.length})`}
                            </button>
                            {m.status === 'announced' && (
                              <button
                                onClick={() => { setReleaseFor(m); setReleaseReason(''); setRound1Confirm(false); }}
                                className={`rounded px-2 py-1 text-[11px] font-bold border ${m.released ? 'border-border text-muted-foreground hover:bg-accent' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                              >
                                {m.released ? ADMIN_MANDATES.releaseWithdraw : ADMIN_MANDATES.releaseNow}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-border/50 bg-muted/20">
                          <td colSpan={8} className="px-3 py-3">
                            {m.offers.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No offers against this mandate.</p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                                    <th className="py-1 pr-3">Ref</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3 text-right">LANA</th>
                                    <th className="py-1 pr-3 text-right">Proposed</th><th className="py-1 pr-3 text-right">Price</th>
                                    <th className="py-1 pr-3">Created</th><th className="py-1 pr-3">Due</th><th className="py-1 pr-3">Note</th><th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {m.offers.map(o => (
                                    <tr key={o.offerRef} className="border-t border-border/40">
                                      <td className="py-1 pr-3 font-mono">{o.offerRef}</td>
                                      <td className="py-1 pr-3">{OFFER_STATUS_LABELS[o.status] || o.status}{o.proposedLanaAmount !== null && <span className="ml-1 text-[10px] uppercase text-amber-700">counter</span>}</td>
                                      <td className="py-1 pr-3 text-right font-mono">{fmtLana(o.lanaAmount)}</td>
                                      <td className="py-1 pr-3 text-right font-mono">{o.proposedLanaAmount === null ? '—' : fmtLana(o.proposedLanaAmount)}</td>
                                      <td className="py-1 pr-3 text-right font-mono">{o.purchasePrice === null ? '—' : `${o.purchasePrice.toFixed(2)} ${o.currency}`}</td>
                                      <td className="py-1 pr-3 whitespace-nowrap">{fmtUtc(o.createdAt)}</td>
                                      <td className="py-1 pr-3 whitespace-nowrap">{fmtUtc(o.settlementDueAt)}</td>
                                      <td className="py-1 pr-3 text-muted-foreground">{o.mandateCode || ''}{o.decisionReason ? ` — ${o.decisionReason}` : ''}</td>
                                      <td className="py-1">
                                        {o.status === 'accepted' && (
                                          <button onClick={() => { setVoidFor(o); setVoidReason(''); }}
                                            className="rounded border border-red-300 px-2 py-0.5 text-[11px] font-bold text-red-600 hover:bg-red-50">
                                            Void
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
    );
  };

  const mandatesOfRound = (r: number) => (data?.mandates || []).filter(m => m.round === r);
  const fundingOfRound = (r: number) => (data?.funding || []).find(f => f.round === r) || null;
  const roundsShown = [...new Set([
    ...(data?.mandates || []).map(m => m.round),
    ...(data?.funding || []).filter(f => f.mandateCount > 0).map(f => f.round),
  ])].sort((a, b) => a - b);

  /** What one round still has to pay, per currency, under the list of its mandates. */
  const renderFunding = (f: RoundFunding | null) => {
    if (!f || f.currencies.length === 0) {
      return <p className="text-xs text-muted-foreground">{ADMIN_MANDATES.funding.none}</p>;
    }
    return (
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {fill(ADMIN_MANDATES.funding.heading, { round: f.round })}
        </p>
        <div className="flex flex-wrap gap-3">
          {f.currencies.map(c => (
            <div key={c.currency} className="min-w-[15rem] flex-1 rounded-xl border border-border bg-background p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-bold text-foreground">{c.currency}</span>
                <span className="font-mono text-lg font-bold text-foreground">{fmtFiat(c.fiatRemaining, c.currency)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {ADMIN_MANDATES.funding.stillToPay} · {fmtLana(c.lanaRemaining)} LANA
              </p>
              {c.gaps.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                  {c.gaps.map(g => GAP_TEXT[g] || g).join(' · ')}
                </p>
              )}
              <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                <div className="flex justify-between gap-3">
                  <dt>{ADMIN_MANDATES.funding.wholeRound}</dt>
                  <dd className="font-mono">{fmtFiat(c.fiatExpected, c.currency)} · {fmtLana(c.lanaExpected)} LANA</dd>
                </div>
                {c.lanaAccepted > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>{ADMIN_MANDATES.funding.agreed}</dt>
                    <dd className="font-mono">{fmtFiat(c.fiatAccepted, c.currency)} · {fmtLana(c.lanaAccepted)} LANA</dd>
                  </div>
                )}
                {c.lanaSettled > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>{ADMIN_MANDATES.funding.paid}</dt>
                    <dd className="font-mono">{fmtFiat(c.fiatSettled, c.currency)} · {fmtLana(c.lanaSettled)} LANA</dd>
                  </div>
                )}
                {c.pricePerLana !== null && (
                  <div className="flex justify-between gap-3">
                    <dt>{ADMIN_MANDATES.funding.perLana}</dt>
                    <dd className="font-mono" title={c.basis ? BASIS_TEXT[c.basis] : undefined}>
                      {c.pricePerLana.toFixed(4)} {c.currency}
                      {c.discountPercent !== null && <span className="ml-1">({c.discountPercent}% off {c.referenceRate?.toFixed(4)})</span>}
                    </dd>
                  </div>
                )}
              </dl>
              {c.basis && <p className="mt-1 text-[10px] text-muted-foreground">{BASIS_TEXT[c.basis]}</p>}
            </div>
          ))}
        </div>
      </div>
    );
  };

  /** Everything still owed across the rounds, so the Split has one bottom line. */
  const splitTotals = (() => {
    const out = new Map<string, { value: number; complete: boolean }>();
    for (const f of data?.funding || []) {
      for (const c of f.currencies) {
        const cell = out.get(c.currency) || { value: 0, complete: true };
        if (c.fiatRemaining === null) cell.complete = false;
        else cell.value += c.fiatRemaining;
        out.set(c.currency, cell);
      }
    }
    return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  })();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <h1 className="text-3xl font-bold text-foreground">{ADMIN_MANDATES.title}</h1>
            <p className="text-muted-foreground">{ADMIN_MANDATES.intro}</p>
            <p className="text-xs text-muted-foreground">
              Last sync: {fmtUtc(data?.lastSyncAt)}
            </p>
          </div>
          <button
            onClick={sync}
            disabled={syncing}
            className="rounded-lg border border-border px-4 py-2 text-sm font-bold text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {syncing ? ADMIN_MANDATES.syncing : ADMIN_MANDATES.sync}
          </button>
        </div>

        {banners.length > 0 && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 space-y-1">
            {banners.map((b, i) => <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{b}</p>)}
          </div>
        )}

        {/* What the whole Split still owes, before the per-round detail */}
        {splitTotals.length > 0 && (
          <div className="mb-4 rounded-2xl border-2 border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{ADMIN_MANDATES.funding.splitTotal}</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              {splitTotals.map(([currency, cell]) => (
                <span key={currency} className="font-mono text-2xl font-bold text-foreground">
                  {fmtFiat(cell.value, currency)}
                  {!cell.complete && <span className="ml-1 align-middle text-xs font-normal text-amber-700 dark:text-amber-400">+ unpriced</span>}
                </span>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{ADMIN_MANDATES.funding.projection}</p>
          </div>
        )}

        {/* Tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {tiles.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="font-mono text-base font-bold text-foreground">{fmtLana(value)} <span className="text-xs font-normal text-muted-foreground">LANA</span></p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {splitOptions.length > 0 ? (
            <select value={split ?? ''} onChange={e => setSplit(Number(e.target.value))}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {splitOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              {split !== null && !splitOptions.some(o => o.value === split) && <option value={split}>Split {split}</option>}
            </select>
          ) : (
            <input type="number" min="1" value={split ?? ''} onChange={e => setSplit(e.target.value ? Number(e.target.value) : null)}
              className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" placeholder="Split" />
          )}
          <select value={currency} onChange={e => setCurrency(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="">All currencies</option>
            {currencies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={round} onChange={e => setRound(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="">All rounds</option>
            {[1, 2, 3].map(r => <option key={r} value={r}>Round {r}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">
            {(data?.rounds || []).map(r => `R${r.round}: ${r.opensAt ? fmtUtc(r.opensAt) : 'no date'} / ${r.discountPercent ?? '—'}%`).join(' · ')}
          </span>
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border-2 border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">Financer</th>
                  <th className="px-3 py-2">Round</th>
                  <th className="px-3 py-2">Wallets</th>
                  <th className="px-3 py-2 text-right">Expected</th>
                  <th className="px-3 py-2 text-right">Remaining</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {roundsShown.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No mandates for this selection.</td></tr>
                )}
                {roundsShown.map(r => {
                  const terms = (data?.rounds || []).find(x => x.round === r);
                  const f = fundingOfRound(r);
                  const rows = mandatesOfRound(r);
                  return (
                    <Fragment key={`round-${r}`}>
                      <tr className="border-y-2 border-border bg-muted/50">
                        <td colSpan={8} className="px-3 py-2">
                          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                            <span className="text-base font-bold text-foreground">{fill(MANDATE.roundLabel, { round: r })}</span>
                            <span className="text-xs text-muted-foreground">
                              {f ? fill(ADMIN_MANDATES.funding.mandateCount, { count: f.mandateCount }) : ''}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {terms?.opensAt ? fmtUtc(terms.opensAt) : ADMIN_MANDATES.funding.noDate}
                              {terms?.discountPercent !== null && terms?.discountPercent !== undefined ? ` · ${terms.discountPercent}%` : ''}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {rows.length === 0 ? (
                        <tr><td colSpan={8} className="px-3 py-4 text-center text-xs text-muted-foreground">{ADMIN_MANDATES.funding.filteredOut}</td></tr>
                      ) : rows.map(renderMandateRow)}
                      <tr className="border-b-2 border-border bg-muted/20">
                        <td colSpan={8} className="px-3 py-3">{renderFunding(f)}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && <p className="mt-2 text-[11px] text-muted-foreground">Updated {fmtUtc(data.updated_at)}</p>}
      </div>

      {/* Release dialog */}
      {releaseFor && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={() => !releasing && setReleaseFor(null)}>
          <div className="w-full max-w-md rounded-2xl border-2 border-border bg-card p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-foreground">
              {releaseFor.released ? ADMIN_MANDATES.releaseWithdraw : ADMIN_MANDATES.releaseTitle}
            </h2>
            <p className="text-sm text-muted-foreground">
              {fill(MANDATE.roundLabel, { round: releaseFor.round })} · {names[releaseFor.financerHex] || releaseFor.financerHex.slice(0, 12) + '…'} · {fmtLana(releaseFor.remainingLana)} LANA remaining
            </p>
            {!releaseFor.released && <p className="text-sm text-muted-foreground">{ADMIN_MANDATES.releaseBody}</p>}
            <label className="block text-xs font-bold text-foreground">{ADMIN_MANDATES.releaseReason}</label>
            <textarea rows={2} value={releaseReason} onChange={e => setReleaseReason(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            {!releaseFor.released && releaseFor.round === 1 && (
              <label className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                <input type="checkbox" checked={round1Confirm} onChange={e => setRound1Confirm(e.target.checked)} className="mt-0.5" />
                {ADMIN_MANDATES.releaseRound1Confirm}
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setReleaseFor(null)} disabled={releasing}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                onClick={() => submitRelease(!releaseFor.released)}
                disabled={releasing || !releaseReason.trim() || (!releaseFor.released && releaseFor.round === 1 && !round1Confirm)}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {releasing ? 'Saving…' : releaseFor.released ? ADMIN_MANDATES.releaseWithdraw : ADMIN_MANDATES.releaseNow}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Void dialog */}
      {voidFor && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={() => !voiding && setVoidFor(null)}>
          <div className="w-full max-w-md rounded-2xl border-2 border-red-200 bg-card p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-foreground">Void accepted offer {voidFor.offerRef}</h2>
            <p className="text-sm text-muted-foreground">
              Only an accepted offer with no transfer can be voided. Its cap returns to the mandate. The reason is recorded.
            </p>
            <textarea rows={2} value={voidReason} onChange={e => setVoidReason(e.target.value)} placeholder="Reason"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setVoidFor(null)} disabled={voiding}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={submitVoid} disabled={voiding || !voidReason.trim()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">
                {voiding ? 'Voiding…' : 'Void'}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
}
