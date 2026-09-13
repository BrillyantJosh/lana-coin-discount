import { useEffect, useState } from 'react';
import { ROUND_DATES, MANDATE } from '@/copy';

/**
 * THE ROUNDS, ON THE LANDING PAGE.
 *
 * Read from the public GET /api/treasury/rounds: for each financing round of
 * the Split the treasury is acquiring from, the date payouts open, its state,
 * and — since 13 Sept 2026, when the owner asked for "koliko si izplačal od
 * koliko, tudi v FIAT" — how far it has been paid out: money per currency
 * ("€X of €Y") and LANA. The totals come from the same per-budget figures
 * lana.discount publishes as KIND 30961.
 *
 * No percentage of a discount is shown here: a published rate next to a date
 * would read as a standing offer (BEF P08 §4). The "of" figure is an estimate
 * for the LANA not yet sold and says so. A date opens a mandate; it grants no
 * right to sell.
 */
interface MoneyLine {
  currency: string;
  paid: number;
  agreed: number;
  inProgress: number;
  unsoldValue: number | null;
  total: number | null;
  owed: number;
  paidPercent: number | null;
}
interface Progress {
  budgets: number;
  lanaReceived: number;
  lanaAcquired: number;
  lanaInProgress: number;
  lanaUnsold: number;
  lanaPaid: number;
  acquiredPercent: number | null;
  paidPercent: number | null;
  money: MoneyLine[];
}
interface RoundRow {
  round: number;
  opensAt: string | null;
  state: string;
  mandateCount: number;
  expectedLana: number;
  remainingLana: number;
  acceptedLana: number;
  settledLana: number;
  progress?: Progress | null;
}
interface RoundsData {
  split: number;
  currentSplit: number | null;
  note: string;
  rounds: RoundRow[];
}

const utc = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};
const lana = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
const money = (n: number, currency: string) =>
  `${SYMBOL[currency] ?? `${currency} `}${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (p: number | null | undefined) =>
  p == null ? '—' : `${p.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

const STATE_CLS: Record<string, string> = {
  open: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  released: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  fully_acquired: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
};

function MoneyBlock({ line, primary }: { line: MoneyLine; primary: boolean }) {
  const width = Math.max(0, Math.min(100, line.paidPercent ?? 0));
  return (
    <div className={primary ? '' : 'mt-3 pt-3 border-t border-border/60'}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`font-semibold text-foreground tabular-nums ${primary ? 'text-2xl' : 'text-lg'}`}>{money(line.paid, line.currency)}</span>
        <span className="text-sm text-muted-foreground">
          {line.total != null ? ROUND_DATES.paidOf.replace('{total}', money(line.total, line.currency)) : ROUND_DATES.paidOfUnknown}
        </span>
      </div>
      {line.total != null && (
        <>
          <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden" aria-hidden>
            <div className="h-full rounded-full bg-green-500" style={{ width: `${width}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {ROUND_DATES.paidPercent.replace('{percent}', percent(line.paidPercent))}
          </div>
        </>
      )}
      {line.owed > 0.004 && (
        <div className="mt-1 text-xs text-muted-foreground">{ROUND_DATES.stillToPay.replace('{amount}', money(line.owed, line.currency))}</div>
      )}
      {line.inProgress > 0.004 && (
        <div className="mt-1 text-xs text-muted-foreground">{ROUND_DATES.inProgressMoney.replace('{amount}', money(line.inProgress, line.currency))}</div>
      )}
    </div>
  );
}

export default function RoundDates() {
  const [data, setData] = useState<RoundsData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/treasury/rounds')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: RoundsData) => { if (alive) setData(json); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  // Nothing published yet, or the read failed: say nothing rather than guess.
  if (failed || !data || !Array.isArray(data.rounds)) return null;
  const rounds = data.rounds.filter(r => r.opensAt || r.mandateCount > 0);
  if (rounds.length === 0) return null;
  const anyMoney = rounds.some(r => (r.progress?.money.length ?? 0) > 0);

  return (
    <section id="round-dates" className="py-16 md:py-20 border-y border-border bg-card">
      <div className="container mx-auto px-6 max-w-4xl">
        <div className="mb-8">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground">
            {ROUND_DATES.title.replace('{split}', String(data.split))}
          </h2>
          <p className="mt-2 text-muted-foreground max-w-2xl">{ROUND_DATES.intro}</p>
        </div>

        <div className={`grid gap-4 ${rounds.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
          {rounds.map(r => {
            const chip = r.state === 'no_mandates' ? ROUND_DATES.noMandates : (MANDATE.states[r.state] || r.state);
            const p = r.progress;
            return (
              <div key={r.round} className="rounded-xl border border-border bg-background/60 p-5 min-w-0">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-lg font-semibold text-foreground font-sans">
                    {MANDATE.roundLabel.replace('{round}', String(r.round))}
                  </h3>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${STATE_CLS[r.state] || 'bg-muted text-muted-foreground'}`}>
                    {chip}
                  </span>
                </div>

                <div className="mt-3 text-sm">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">{ROUND_DATES.payoutsOpenLabel}</div>
                  <div className="font-medium text-foreground">{utc(r.opensAt) || ROUND_DATES.noDate}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {p
                      ? ROUND_DATES.people.replace('{financers}', String(r.mandateCount)).replace('{budgets}', String(p.budgets))
                      : `${ROUND_DATES.mandates}: ${r.mandateCount}`}
                  </div>
                </div>

                {p && p.money.length > 0 && (
                  <div className="mt-4 rounded-lg border border-border bg-card p-4">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{ROUND_DATES.paidOutTitle}</div>
                    {p.money.map((m, i) => <MoneyBlock key={m.currency} line={m} primary={i === 0} />)}
                  </div>
                )}

                {p ? (
                  <div className="mt-4">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{ROUND_DATES.lanaTitle}</div>
                    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">{ROUND_DATES.lanaReceived}</dt>
                      <dd className="text-right font-mono text-foreground">{lana(p.lanaReceived)}</dd>
                      <dt className="text-muted-foreground">{ROUND_DATES.lanaAcquired}</dt>
                      <dd className="text-right font-mono text-foreground">{lana(p.lanaAcquired)} <span className="text-muted-foreground">· {percent(p.acquiredPercent)}</span></dd>
                      <dt className="text-muted-foreground">{ROUND_DATES.lanaPaid}</dt>
                      <dd className="text-right font-mono text-foreground">{lana(p.lanaPaid)} <span className="text-muted-foreground">· {percent(p.paidPercent)}</span></dd>
                      {p.lanaInProgress > 0 && (
                        <>
                          <dt className="text-muted-foreground">{ROUND_DATES.lanaInProgress}</dt>
                          <dd className="text-right font-mono text-foreground">{lana(p.lanaInProgress)}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{ROUND_DATES.lanaUnsold}</dt>
                      <dd className="text-right font-mono text-foreground">{lana(p.lanaUnsold)}</dd>
                    </dl>
                  </div>
                ) : (
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{ROUND_DATES.expectedLabel}</dt>
                    <dd className="text-right font-mono text-foreground">{lana(r.expectedLana)}</dd>
                    <dt className="text-muted-foreground">{ROUND_DATES.remainingLabel}</dt>
                    <dd className="text-right font-mono text-foreground">{lana(r.remainingLana)}</dd>
                    <dt className="text-muted-foreground">{ROUND_DATES.acceptedLabel}</dt>
                    <dd className="text-right font-mono text-foreground">{lana(r.acceptedLana)}</dd>
                    <dt className="text-muted-foreground">{ROUND_DATES.settledLabel}</dt>
                    <dd className="text-right font-mono text-foreground">{lana(r.settledLana)}</dd>
                  </dl>
                )}
              </div>
            );
          })}
        </div>

        {anyMoney && <p className="mt-6 text-xs text-muted-foreground">{ROUND_DATES.moneyNote}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{MANDATE.openNoRight}</p>
      </div>
    </section>
  );
}
