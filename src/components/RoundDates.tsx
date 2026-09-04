import { useEffect, useState } from 'react';
import { ROUND_DATES, MANDATE } from '@/copy';

/**
 * THE ROUND DATES, ON THE LANDING PAGE.
 *
 * Read from the public GET /api/treasury/rounds: for each financing round of
 * the Split the treasury is acquiring from, the date it opens, its state and
 * the LANA totals across all its mandates. Dates and totals only — the round
 * discount is deliberately not on this page. A published percentage next to a
 * date would read as a standing rate, which is the one thing a public page
 * must never do (BEF P08 §4); the only binding figure is the purchase price on
 * an accepted offer. A date opens a mandate; it grants no right to sell.
 */
interface RoundRow {
  round: number;
  opensAt: string | null;
  state: string;
  mandateCount: number;
  expectedLana: number;
  remainingLana: number;
  acceptedLana: number;
  settledLana: number;
}
interface RoundsData {
  split: number;
  currentSplit: number | null;
  splitEndsAt: string | null;
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
const lana = (n: number) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const STATE_CLS: Record<string, string> = {
  open: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  released: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  fully_acquired: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
};

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

  return (
    <section id="round-dates" className="py-16 md:py-20 border-y border-border bg-card">
      <div className="container mx-auto px-6 max-w-4xl">
        <div className="mb-8">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground">
            {ROUND_DATES.title.replace('{split}', String(data.split))}
          </h2>
          <p className="mt-2 text-muted-foreground max-w-2xl">{ROUND_DATES.intro}</p>
          {data.splitEndsAt && (
            <p className="mt-1 text-sm text-muted-foreground">
              {ROUND_DATES.splitEndsAt}: <span className="font-medium text-foreground">{utc(data.splitEndsAt)}</span>
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {rounds.map(r => {
            const chip = r.state === 'no_mandates' ? ROUND_DATES.noMandates : (MANDATE.states[r.state] || r.state);
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
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">{ROUND_DATES.opensLabel}</div>
                  <div className="font-medium text-foreground">{utc(r.opensAt) || ROUND_DATES.noDate}</div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{ROUND_DATES.mandates}</dt>
                  <dd className="text-right font-mono text-foreground">{r.mandateCount}</dd>
                  <dt className="text-muted-foreground">{ROUND_DATES.expectedLabel}</dt>
                  <dd className="text-right font-mono text-foreground">{lana(r.expectedLana)}</dd>
                  <dt className="text-muted-foreground">{ROUND_DATES.remainingLabel}</dt>
                  <dd className="text-right font-mono text-foreground">{lana(r.remainingLana)}</dd>
                  <dt className="text-muted-foreground">{ROUND_DATES.acceptedLabel}</dt>
                  <dd className="text-right font-mono text-foreground">{lana(r.acceptedLana)}</dd>
                  <dt className="text-muted-foreground">{ROUND_DATES.settledLabel}</dt>
                  <dd className="text-right font-mono text-foreground">{lana(r.settledLana)}</dd>
                </dl>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-xs text-muted-foreground">{MANDATE.openNoRight}</p>
      </div>
    </section>
  );
}
