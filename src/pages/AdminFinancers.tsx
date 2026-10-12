import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signedFetch } from '@/lib/nip98Fetch';
import { refusalText } from '@/lib/refusalText';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { knownNames, resolveNames } from '@/lib/counterpartyNames';
import { formatFiat, formatLana } from '@/lib/money';

/**
 * WHAT EACH FINANCER STILL HAS TO DO (owner, 12 Oct 2026).
 *
 * Since 9 Oct 2026 every financer settles their own purchases on /financer. Five steps lie between a purchase and its
 * LANA arriving, and each can stall with a different person: the financer pays on Direct.Fund, confirms here, the
 * brain approves, the financer signs and sends, the chain confirms. One card per financer, one row per step, so the
 * owner sees at a glance who is stuck where.
 *
 * Step 4 — approved, to send — is the one only the financer can move and the one that means somebody is waiting for
 * LANA, so it is the row drawn strongest. Anything that has waited longer than a day turns amber.
 *
 * Read from GET /api/admin/financers-overview (server/routes/adminFinancers.ts). The financers are the server's,
 * read from the data; nothing about who they are is written down here. Never an npub: a name, or a short hex.
 */

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' };
const sym = (currency: string) => CURRENCY_SYMBOLS[currency] || `${currency} `;

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60_000;
const txUrl = (txid: string) => `https://chainz.cryptoid.info/lana/tx.dws?${txid}`;

type Lana = Record<string, string>;
interface Totals { purchases: number; legs: number; lana: Lana; oldestAt: string | null }
interface Batch {
  batchRef: string; status: string; currency: string; totalAmount: number; purchases: number;
  createdAt: string | null; closedAt: string | null; paidAt: string | null; held: boolean;
}
interface WaitingPart {
  batchRef: string | null; batchStatus: string | null; orderType: string; destinationType: string | null;
  amount: number; currency: string; transactionRef: string;
}
interface Send { txid: string; state: string; walletId: string; legs: number; lanoshis: string; since: string }
export interface FinancerOverview {
  hex: string;
  name: string | null;
  isFinancer: boolean | null;
  dfUnavailable: boolean;
  wallets: Record<string, string> | null;
  stages: {
    toPayOnDf: (Totals & { batches: Batch[] }) | null;
    toConfirm: (Totals & { batches: Batch[] }) | null;
    waitingApproval: Totals & { withoutLegs: number; waitingOn: WaitingPart[] | null; waitingOnPartial: boolean };
    toSend: Totals & { wallets: number; oldestApprovedAt: string | null; ownerMismatch: number };
    onTheWay: Totals & { sends: Send[] };
  };
  unowned: Totals;
  lastConfirmedSend: { txid: string; at: string | null } | null;
}
export interface OverviewResponse {
  generatedAt: string;
  dfUnavailable: boolean;
  financers: FinancerOverview[];
  unowned: Totals & { withoutFinancer: Totals };
}

/** SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone; anything else is read as given. */
export function parseAt(at: string | null | undefined): number | null {
  if (!at) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(at) ? `${at.replace(' ', 'T')}Z` : at;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** "3 h", "2 d 4 h" — how long ago. */
export function ageText(at: string | null | undefined, nowMs = Date.now()): string {
  const ms = parseAt(at);
  if (ms === null) return '';
  const mins = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

const isOld = (at: string | null | undefined, nowMs = Date.now()) => {
  const ms = parseAt(at);
  return ms !== null && nowMs - ms > DAY_MS;
};

/** Lanoshis per currency → "1,234.5 LANA (EUR) · 10 LANA (GBP)". */
export function lanaText(lana: Lana): string {
  const parts = Object.entries(lana)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([c, lanoshis]) => `${formatLana(Number(lanoshis) / 1e8)} LANA (${c})`);
  return parts.length ? parts.join(' · ') : '—';
}

const shortHex = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const Age = ({ at, label }: { at: string | null | undefined; label?: string }) => {
  if (!at) return null;
  const old = isOld(at);
  return (
    <span className={`text-[11px] ${old ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} title={at}>
      {label ? `${label} ` : ''}{ageText(at)}{old ? ' — over 24 h' : ''}
    </span>
  );
};

const BatchList = ({ batches }: { batches: Batch[] }) => {
  if (batches.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {batches.map(b => (
        <span key={b.batchRef} className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground"
          title={`${b.status} · ${plural(b.purchases, 'purchase')}`}>
          {b.batchRef} · {b.status} · {Number.isFinite(b.totalAmount) ? formatFiat(sym(b.currency), b.totalAmount) : b.currency}
          {b.held && <span className="ml-1 font-sans font-semibold text-red-600">held</span>}
        </span>
      ))}
    </div>
  );
};

interface RowProps {
  step: number;
  title: string;
  who: string;
  totals: Totals | null;
  strong?: boolean;
  unavailable?: boolean;
  children?: ReactNode;
}

const StageRow = ({ step, title, who, totals, strong, unavailable, children }: RowProps) => {
  const empty = !unavailable && totals !== null && totals.purchases === 0 && totals.legs === 0;
  const old = !empty && totals ? isOld(totals.oldestAt) : false;
  const tone = strong && !empty
    ? 'border-2 border-primary bg-primary/5'
    : old ? 'border border-amber-400/70 bg-amber-50/40 dark:bg-amber-950/20' : 'border border-border bg-card';
  return (
    <li className={`rounded-xl px-3 py-2.5 ${tone}`} data-stage={step} data-empty={empty ? 'true' : 'false'}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className={`text-sm ${strong ? 'font-bold text-foreground' : 'font-semibold text-foreground'}`}>
            {step}. {title}
          </span>
          <span className="ml-2 text-[11px] text-muted-foreground">{who}</span>
        </div>
        {unavailable ? (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">Direct.Fund could not be read</span>
        ) : totals && !empty ? (
          <div className="flex flex-wrap items-baseline gap-x-3 text-[12px]">
            <span className="text-foreground">{plural(totals.purchases, 'purchase')} · {plural(totals.legs, 'leg')}</span>
            <span className={`font-mono ${strong ? 'font-bold text-foreground' : 'text-foreground'}`}>{lanaText(totals.lana)}</span>
            <Age at={totals.oldestAt} label="oldest" />
          </div>
        ) : (
          <span className="text-[12px] text-muted-foreground">nothing</span>
        )}
      </div>
      {!unavailable && !empty && children}
    </li>
  );
};

const FinancerCard = ({ f, name }: { f: FinancerOverview; name: string | null }) => {
  const s = f.stages;
  const wallets = f.wallets ? Object.entries(f.wallets).sort(([a], [b]) => (a < b ? -1 : 1)) : [];
  return (
    <section className="rounded-2xl border-2 border-border bg-card p-4" data-financer={f.hex}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-foreground">{name || shortHex(f.hex)}</h2>
          <p className="font-mono text-[11px] text-muted-foreground break-all" title={f.hex}>{shortHex(f.hex)}</p>
          {f.isFinancer === false && (
            <p className="mt-1 text-[11px] font-semibold text-red-600">Direct.Fund does not know this key as a financer now.</p>
          )}
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          {f.dfUnavailable ? (
            <span className="text-amber-700 dark:text-amber-400">Direct.Fund could not be read — wallets unknown</span>
          ) : wallets.length === 0 ? (
            <span className="text-amber-700 dark:text-amber-400">No Lana.Discount wallet chosen on Direct.Fund</span>
          ) : (
            wallets.map(([c, w]) => (
              <div key={c}><span className="font-semibold">{c}</span> <span className="font-mono">{w}</span></div>
            ))
          )}
        </div>
      </div>

      <ol className="space-y-2">
        <StageRow step={1} title="To pay on Direct.Fund" who="financer · I Have Paid" totals={s.toPayOnDf} unavailable={!s.toPayOnDf}>
          {s.toPayOnDf && <BatchList batches={s.toPayOnDf.batches} />}
        </StageRow>
        <StageRow step={2} title="Paid on Direct.Fund, to confirm on lana.discount" who="financer · /financer" totals={s.toConfirm} unavailable={!s.toConfirm}>
          {s.toConfirm && <BatchList batches={s.toConfirm.batches} />}
        </StageRow>
        <StageRow step={3} title="Confirmed, waiting for approval" who="brain" totals={s.waitingApproval}>
          <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {s.waitingApproval.withoutLegs > 0 && (
              <p>{plural(s.waitingApproval.withoutLegs, 'purchase')} with no leg from the brain yet.</p>
            )}
            {s.waitingApproval.waitingOn === null ? (
              <p>Approval comes once every part of these purchases is paid on Direct.Fund.</p>
            ) : s.waitingApproval.waitingOn.length === 0 ? (
              <p>Direct.Fund has every part paid; the approval comes on the brain's next rounds.</p>
            ) : (
              <div>
                <p className="text-foreground">Still unpaid on Direct.Fund{s.waitingApproval.waitingOnPartial ? ' (oldest purchases only)' : ''}:</p>
                <ul className="ml-3 list-disc">
                  {s.waitingApproval.waitingOn.map((p, i) => (
                    <li key={`${p.transactionRef}-${i}`}>
                      {formatFiat(sym(p.currency), p.amount)} {p.orderType.replace(/_/g, ' ') || 'part'}
                      {p.destinationType ? ` by ${p.destinationType === 'lana_discount' ? 'Lana.Discount' : p.destinationType}` : ''}
                      {p.batchRef ? ` · batch ${p.batchRef} (${p.batchStatus || '?'})` : ' · in no batch yet'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </StageRow>
        <StageRow step={4} title="Approved, to send now" who="financer · sign & send" totals={s.toSend} strong>
          <p className="mt-1 text-[11px] text-muted-foreground">
            to {plural(s.toSend.wallets, 'wallet')} · <Age at={s.toSend.oldestApprovedAt} label="approved" />
          </p>
        </StageRow>
        <StageRow step={5} title="On the way" who="chain" totals={s.onTheWay}>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {s.onTheWay.sends.map(t => (
              <li key={t.txid} className="flex flex-wrap items-baseline gap-x-2">
                <a href={txUrl(t.txid)} target="_blank" rel="noopener noreferrer" className="font-mono text-amber-500 hover:underline">
                  {t.txid.slice(0, 16)}…
                </a>
                <span className="text-muted-foreground">{t.state} · {plural(t.legs, 'leg')} · {formatLana(Number(t.lanoshis) / 1e8)} LANA</span>
                <Age at={t.since} label="since" />
              </li>
            ))}
          </ul>
        </StageRow>
      </ol>

      {s.toSend.ownerMismatch > 0 && (
        <p className="mt-2 text-[11px] font-semibold text-red-600">
          {plural(s.toSend.ownerMismatch, 'purchase')} of theirs now name{s.toSend.ownerMismatch === 1 ? 's' : ''} another investor: nothing sends {s.toSend.ownerMismatch === 1 ? 'it' : 'them'} until a person looks.
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Open legs naming them, nobody owns yet:{' '}
          {f.unowned.legs === 0 ? 'none' : <>{plural(f.unowned.purchases, 'purchase')} · {plural(f.unowned.legs, 'leg')} · {lanaText(f.unowned.lana)}</>}
        </span>
        <span>
          Last confirmed send:{' '}
          {f.lastConfirmedSend ? (
            <>
              <a href={txUrl(f.lastConfirmedSend.txid)} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-500 hover:underline">
                {f.lastConfirmedSend.txid.slice(0, 16)}…
              </a>{' '}
              <Age at={f.lastConfirmedSend.at} label="" />
            </>
          ) : 'none yet'}
        </span>
      </div>
    </section>
  );
};

const AdminFinancers = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [names, setNames] = useState<Record<string, string>>(() => knownNames());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const namesRef = useRef(names);
  namesRef.current = names;

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await signedFetch('/api/admin/financers-overview');
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(refusalText(body, body.error || `HTTP ${res.status}`));
      setData(body as OverviewResponse);
      setError(null);
      const missing = (body as OverviewResponse).financers
        .filter(f => !f.name && namesRef.current[f.hex] === undefined)
        .map(f => f.hex);
      if (missing.length) resolveNames(missing).then(found => setNames(prev => ({ ...prev, ...found })));
    } catch (err: any) {
      console.error('Failed to load the financers overview:', err);
      setError(err?.message || 'Failed to load the financers overview');
      if (!quiet) toast.error(err?.message || 'Failed to load the financers overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session || !isAdmin) return;
    load();
    // Every minute while the tab is looked at, and at once when it comes back.
    const tick = () => { if (document.visibilityState !== 'hidden') load(true); };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [session, isAdmin, load]);

  if (authLoading || !session || !isAdmin) return null;

  const financers = data?.financers || [];
  const toSendNow = financers.reduce((n, f) => n + f.stages.toSend.legs, 0);
  const unowned = data?.unowned;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-5xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <h1 className="text-3xl font-bold text-foreground">Financers</h1>
            <p className="text-muted-foreground">
              What each financing company still has to pay, confirm and send. Step 4 is what they must sign and send now;
              anything waiting longer than 24 hours is amber.
            </p>
          </div>
          <button
            onClick={() => load()}
            disabled={loading}
            className="flex-shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-bold text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && data && (
          <p className="mb-3 text-[12px] text-amber-700 dark:text-amber-400">Last refresh failed ({error}); showing the previous answer.</p>
        )}
        {data?.dfUnavailable && (
          <p className="mb-3 rounded-lg border border-amber-400/70 bg-amber-50/40 dark:bg-amber-950/20 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
            Direct.Fund could not be read for every financer: steps 1 and 2 are missing where it says so. The rest is from lana.discount.
          </p>
        )}

        {data && (
          <div className="mb-4 rounded-2xl border-2 border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Approved, to send now — all financers</p>
            <p className="mt-1 font-mono text-3xl font-bold text-foreground">{plural(toSendNow, 'leg')}</p>
            {unowned && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Open legs nobody owns yet: {unowned.legs === 0 ? 'none' : (
                  <>{plural(unowned.purchases, 'purchase')} · {plural(unowned.legs, 'leg')} · {lanaText(unowned.lana)}
                    {unowned.withoutFinancer.legs > 0 && <> — {plural(unowned.withoutFinancer.purchases, 'purchase')} of them name no financer</>}
                    {' · '}<Age at={unowned.oldestAt} label="oldest" />
                  </>
                )}
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">Updated {new Date(data.generatedAt).toLocaleTimeString()} · refreshes every minute</p>
          </div>
        )}

        {data && financers.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-border p-8 text-center text-muted-foreground">
            No financer has anything here yet.
          </div>
        )}

        <div className="space-y-4">
          {financers.map(f => <FinancerCard key={f.hex} f={f} name={f.name || names[f.hex] || null} />)}
        </div>
      </div>
    </div>
  );
};

export default AdminFinancers;
