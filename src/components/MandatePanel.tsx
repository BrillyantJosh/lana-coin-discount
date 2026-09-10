import { MANDATE, OFFER } from '@/copy';
import { formatFiat, formatLana } from '@/lib/money';
import type { RoundState } from '../../server/lib/roundMandate';

/**
 * WHAT A FINANCER SEES ABOUT THEIR OWN MANDATE.
 *
 * The treasury acquires from financing budgets round by round, each from its
 * published date and up to the LANA the budget received (owner's decision,
 * 4 Sep 2026; BEF P08 §2). This panel shows that to the one person it applies
 * to, per round, for the wallet they selected — and nothing here is a right:
 * a date OPENS a mandate (P08 §8), and an indicative figure is a projection
 * from public parameters, not a price, not a rate, not a guarantee (P08 §4).
 *
 * Everything shown comes from the signed GET /api/acquisitions/mandate; the
 * indicative amount alone is recomputed here, for the amount being typed, so
 * the figure moves with the field without a request per keystroke. The maths
 * is the server's: lana × reference × (1 − discount/100), rounded to cents.
 */

export interface MandateView {
  mandateRef: string;
  eventId: string;
  split: number;
  round: number;
  state: RoundState;
  /** ISO, or null when no date is set. */
  opensAt: string | null;
  discountPercent: number | null;
  released: boolean;
  inWindow: boolean;
  walletCurrency: string | null;
  walletShareLana: number | null;
  expectedLana: number;
  remainingLana: number;
  proposedLana: number;
  acceptedLana: number;
  settledLana: number;
  basis: 'projected_next_split' | 'current_split' | null;
  referenceRate: number | null;
  indicativeFor: { lanaAmount: number; currency: string; fiat: number } | null;
}

export interface MandateInfo {
  nonBinding: boolean;
  note: string;
  currentSplit: number | null;
  mandates: MandateView[];
}

/** `{name}` placeholders → values. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

/** The server's arithmetic, to the cent, half-up. */
export function indicativeFiat(lanaAmount: number, referenceRate: number, discountPercent: number): number {
  const raw = lanaAmount * referenceRate * (1 - discountPercent / 100);
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

/** "14 Sep 2026, 22:00 UTC" — the round date is a UTC instant and is shown as one. */
export function fmtUtc(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // By hand, not toLocaleString: ICU builds differ ("Sep" vs "Sept"), and a
  // date on a contract-shaped line must read the same on every machine.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

/**
 * One convention for a LANA amount, the same one src/lib/money.ts writes a
 * purchase price in. It used to follow the reader's locale, which on sl-SI
 * printed "20.070,5" — a point where the price beside it puts a comma, and
 * `counterBody` puts that number on the dashboard card directly under
 * "€6,498.88".
 */
const fmtLana = (n: number) => formatLana(n);
// Grouped the same way as the LANA figure it stands next to. `toLocaleString`
// with the reader's locale put a comma where formatLana puts a point, so one
// panel showed "20,070.5 LANA" beside "6.498,88 EUR" — the same two-convention
// glance the money helpers exist to prevent, moved one page across.
const fmtMoney = (n: number, currency: string) => `${formatFiat('', n)} ${currency}`;

/** The one sentence about timing, per state. */
export function timingLine(m: MandateView): string {
  switch (m.state) {
    case 'upcoming_split': return MANDATE.upcomingSplit;
    case 'not_open': return fill(MANDATE.notOpen, { round: m.round, date: fmtUtc(m.opensAt) });
    case 'open': return fill(MANDATE.open, { round: m.round, remaining: fmtLana(m.remainingLana) });
    case 'released': return MANDATE.released;
    case 'fully_acquired': return MANDATE.fullyAcquired;
    case 'terms_missing': return MANDATE.termsMissing;
    case 'window_passed': return MANDATE.windowPassed;
    case 'closed': return MANDATE.closed;
    default: return MANDATE.splitUnknown;
  }
}

/** The counteroffer sentence: "You proposed X; the treasury can acquire Y now…" */
export function counterBody(proposedLana: number, allowedLana: number): string {
  return fill(OFFER.counterBody, { proposed: fmtLana(proposedLana), allowed: fmtLana(allowedLana) });
}

export interface ProposalGate {
  allowed: boolean;
  /** Why not, when not — a timing line the amount step can show. */
  reason?: string;
  /** The lowest open round, when one is open. */
  openRound?: MandateView;
}

/**
 * Whether the propose button should be live. Mirrors the server's order in
 * evaluateRoundMandate: no mandate → the server decides (a NO_MANDATE
 * review); otherwise the lowest round that is open or
 * released with something left; else the first blocked round says why.
 */
export function proposalGate(info: MandateInfo | null): ProposalGate {
  if (!info || info.mandates.length === 0) return { allowed: true };
  const sorted = [...info.mandates].sort((a, b) => (a.split - b.split) || (a.round - b.round));
  const open = sorted.find(m => (m.state === 'open' || m.state === 'released') && m.remainingLana > 0);
  if (open) return { allowed: true, openRound: open };
  const blocked = sorted.find(m => m.state === 'not_open' || m.state === 'upcoming_split' || m.state === 'terms_missing')
    || sorted[0];
  return { allowed: false, reason: timingLine(blocked) };
}

/**
 * How much of this wallet's LANA the treasury will actually take a proposal for
 * TODAY, and how much has to wait.
 *
 * This is the question a holder cannot answer from the round rows on their own,
 * and getting it wrong costs them a rejected proposal. Rounds open one date at a
 * time, and a proposal draws on ONE round — the lowest-numbered open one. So
 * somebody holding LANA from round 1 and round 2 during round 1's window can
 * sell the round-1 share and not a lanoshi more, however much the wallet holds.
 * Unless the treasury released a round early, in which case it counts as open
 * like any other.
 *
 * `now` is what is open across every open round; `perProposal` is what a single
 * proposal can carry. They differ when two rounds are open at once, and the
 * difference is worth saying out loud rather than letting someone discover it
 * as a counteroffer.
 */
export interface Availability {
  nowLana: number;
  laterLana: number;
  perProposalLana: number;
  perProposalRound: number | null;
  openRounds: MandateView[];
  laterRounds: MandateView[];
  /** True when at least one open round is open only because it was released. */
  anyReleased: boolean;
}

export function availabilityOf(info: MandateInfo | null): Availability | null {
  if (!info || info.mandates.length === 0) return null;
  const sorted = [...info.mandates].sort((a, b) => (a.split - b.split) || (a.round - b.round));
  const openRounds = sorted.filter(m => (m.state === 'open' || m.state === 'released') && m.remainingLana > 0);
  // Waiting on a date, not spent and not gone: 'fully_acquired', 'window_passed'
  // and 'closed' are none of the holder's remaining business.
  const laterRounds = sorted.filter(
    m => (m.state === 'not_open' || m.state === 'upcoming_split' || m.state === 'terms_missing') && m.remainingLana > 0,
  );
  const sum = (rows: MandateView[]) => rows.reduce((t, m) => t + m.remainingLana, 0);
  const first = openRounds[0] || null;
  return {
    nowLana: sum(openRounds),
    laterLana: sum(laterRounds),
    perProposalLana: first ? first.remainingLana : 0,
    perProposalRound: first ? first.round : null,
    openRounds,
    laterRounds,
    anyReleased: openRounds.some(m => m.state === 'released' || m.released),
  };
}

const STATE_TONE: Record<string, string> = {
  open: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  released: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  not_open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  upcoming_split: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  fully_acquired: 'bg-muted text-muted-foreground',
  terms_missing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  window_passed: 'bg-muted text-muted-foreground',
  closed: 'bg-muted text-muted-foreground',
  split_unknown: 'bg-muted text-muted-foreground',
};

interface Props {
  info: MandateInfo | null;
  loading: boolean;
  error: string | null;
  /** The amount being typed on the amount step; null on the wallet step. */
  lanaAmount: number | null;
  currency: string;
  /** The indicative box is for the amount step only. */
  showIndicative: boolean;
}

export function MandatePanel({ info, loading, error, lanaAmount, currency, showIndicative }: Props) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent inline-block" />
        {MANDATE.loading}
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
        {MANDATE.unavailable}
      </div>
    );
  }
  if (!info) return null;

  if (info.mandates.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-1">
        <p className="text-sm font-semibold text-foreground">{MANDATE.noMandateTitle}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{MANDATE.noMandateBody}</p>
      </div>
    );
  }

  const mandates = [...info.mandates].sort((a, b) => (a.split - b.split) || (a.round - b.round));
  const gate = proposalGate(info);
  const availability = availabilityOf(info);
  // The indicative figure is for the round a proposal would land in: the open
  // one if any, otherwise the first upcoming one — still a projection.
  const indicativeRound = gate.openRound || mandates.find(m => m.basis && m.referenceRate && m.discountPercent !== null) || null;
  const indicativeAmount = indicativeRound
    ? (lanaAmount !== null && lanaAmount > 0 ? Math.min(lanaAmount, indicativeRound.remainingLana) : indicativeRound.remainingLana)
    : 0;
  const canShowIndicative = showIndicative && !!indicativeRound && indicativeRound.basis !== null
    && indicativeRound.referenceRate !== null && indicativeRound.discountPercent !== null && indicativeAmount > 0;

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-5 space-y-4" data-testid="mandate-panel">
      <div>
        <h3 className="text-base font-semibold text-foreground">{MANDATE.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{MANDATE.intro}</p>
      </div>

      {availability && (
        <div
          className={`rounded-xl border-2 p-3 sm:p-4 space-y-2 ${
            availability.nowLana > 0
              ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30'
              : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30'
          }`}
          data-testid="availability"
        >
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{MANDATE.availabilityTitle}</p>

          <p className="text-2xl font-bold font-mono text-foreground" data-testid="available-now">
            {fmtLana(availability.nowLana)} <span className="text-sm font-sans font-semibold">LANA</span>
          </p>
          <p className="text-xs text-foreground">
            {availability.nowLana > 0
              ? fill(MANDATE.availableNow, {
                  rounds: availability.openRounds.map(m => m.round).join(', '),
                  count: availability.openRounds.length,
                })
              : MANDATE.availableNone}
          </p>

          {availability.anyReleased && availability.nowLana > 0 && (
            <p className="text-xs font-medium text-green-800 dark:text-green-300">{MANDATE.availableReleased}</p>
          )}

          {/* Two rounds open at once still means one round per proposal. */}
          {availability.perProposalLana > 0 && availability.perProposalLana < availability.nowLana && (
            <p className="text-xs text-muted-foreground" data-testid="per-proposal">
              {fill(MANDATE.availablePerProposal, {
                amount: fmtLana(availability.perProposalLana),
                round: availability.perProposalRound,
              })}
            </p>
          )}

          {availability.laterRounds.length > 0 && (
            <div className="pt-1 border-t border-border/60 space-y-1" data-testid="available-later">
              <p className="text-xs font-semibold text-foreground">
                {fill(MANDATE.availableLater, { amount: fmtLana(availability.laterLana) })}
              </p>
              {availability.laterRounds.map(m => (
                <p key={m.mandateRef} className="text-[11px] text-muted-foreground">
                  {fill(MANDATE.availableLaterRound, {
                    amount: fmtLana(m.remainingLana),
                    round: m.round,
                    when: m.state === 'not_open' && m.opensAt ? fmtUtc(m.opensAt)
                      : m.state === 'upcoming_split' ? MANDATE.availableAfterSplit
                      : MANDATE.availableTermsPending,
                  })}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {mandates.map(m => (
          <div key={m.mandateRef} className="rounded-xl border border-border bg-background/60 p-3 space-y-2" data-testid={`mandate-round-${m.round}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-foreground">{fill(MANDATE.roundLabel, { round: m.round })}</span>
              <span className="text-[11px] text-muted-foreground">Split {m.split}</span>
              <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${STATE_TONE[m.state] || STATE_TONE.split_unknown}`}>
                {MANDATE.states[m.state] || m.state}
              </span>
            </div>
            <p className="text-sm text-foreground">{timingLine(m)}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
              <div className="min-w-0">
                <span className="block text-muted-foreground">{MANDATE.expectedLabel}</span>
                <span className="font-mono font-semibold">{fmtLana(m.expectedLana)} LANA</span>
              </div>
              <div className="min-w-0">
                <span className="block text-muted-foreground">{MANDATE.remainingLabel}</span>
                <span className="font-mono font-semibold">{fmtLana(m.remainingLana)} LANA</span>
              </div>
              <div className="min-w-0">
                <span className="block text-muted-foreground">{MANDATE.acceptedLabel}</span>
                <span className="font-mono">{fmtLana(m.acceptedLana)} LANA</span>
              </div>
              <div className="min-w-0">
                <span className="block text-muted-foreground">{MANDATE.settledLabel}</span>
                <span className="font-mono">{fmtLana(m.settledLana)} LANA</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {canShowIndicative && indicativeRound && (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-3 space-y-2" data-testid="indicative-box">
          <p className="text-xs font-bold text-foreground">{OFFER.indicativeLabel}</p>
          <p className="text-[11px] text-muted-foreground">
            {indicativeRound.basis === 'projected_next_split' ? OFFER.indicativeBasisProjected : OFFER.indicativeBasisCurrent}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">{OFFER.indicativeForLabel}</span>
            <span className="font-mono text-right">{fmtLana(indicativeAmount)} LANA</span>
            <span className="text-muted-foreground">{OFFER.indicativeReferenceLabel}</span>
            <span className="font-mono text-right">{indicativeRound.referenceRate} {currency}</span>
            <span className="text-muted-foreground">{OFFER.indicativeDiscountLabel}</span>
            <span className="font-mono text-right">{indicativeRound.discountPercent} %</span>
            <span className="font-semibold text-foreground">{OFFER.indicativeAmountLabel}</span>
            <span className="font-mono font-bold text-right" data-testid="indicative-amount">
              {fmtMoney(indicativeFiat(indicativeAmount, indicativeRound.referenceRate!, indicativeRound.discountPercent!), currency)}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{OFFER.indicativeNote}</p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{MANDATE.openNoRight}</p>
    </div>
  );
}

export default MandatePanel;
