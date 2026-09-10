import { Link } from 'react-router-dom';
import { OFFER } from '@/copy';
import { counterBody, fill } from '@/components/MandatePanel';
import { formatDate, formatLeftToMinute, formatMoment, parseSqliteUtc, useCountdown } from '@/lib/offerClock';
import { formatFiat, formatLana } from '@/lib/money';

/**
 * ONE offer that is waiting on the seller — the card, not the list.
 *
 * The complaint this answers, in the owner's words: a purchase offer waiting
 * for his approval was "preveč zlita z zgodovino", too blended into the
 * history. It was: every offer, live or long dead, rendered through the same
 * row, told apart only by a ten-pixel pill, and the one fact that would have
 * separated them — how long the live one still stands — was on the wire and
 * never drawn.
 *
 * So this card is built around the two facts he named, at the same size and on
 * the same baseline, with nothing between the title and them: WHAT it is worth
 * and HOW LONG it has. It is written for a 375px phone held in one hand, and
 * the desktop is the same stack with more air, not a second layout — every
 * horizontal contest between money and words is removed rather than negotiated,
 * because at that width the current row loses that contest and truncates the
 * offer reference to nothing while the badge survives intact.
 *
 * It has one door, and the door navigates. Accepting is the contract moment: it
 * happens on /offer, in front of the terms, where the server records which
 * version was shown. A dashboard card must never be able to sign anything.
 */

/** The fields of an offer this card reads. A subset of what /mine sends. */
export interface WaitingOfferSummary {
  offerRef: string;
  status: string;
  lanaAmount: number;
  currency: string;
  purchasePrice: number | null;
  settlementDueAt: string | null;
  /** The server's own deadline for what the seller must do next. */
  actionDueAt: string | null;
  /**
   * The window the OFFER stood for, which on an accepted row is no longer the
   * deadline. Both moments are needed to say the clock changed — see below.
   * Optional so a caller that does not carry it simply says nothing.
   */
  offerExpiresAt?: string | null;
  isCounteroffer?: boolean;
  proposedLanaAmount?: number | null;
}

/**
 * Under this, and only then, the clock changes colour. Amber is the ceiling.
 *
 * Ten minutes, not the hour it started as. An offer the machine made stands
 * THIRTY minutes (OFFER_VALIDITY_MINUTES), so an hour-wide threshold made the
 * commonest card on this page amber from the instant it existed — a signal
 * that is on for the whole life of an offer says nothing at all, and saying it
 * in amber is manufactured urgency, which this product does not do. At ten
 * minutes it means what it looks like: this one is nearly out of time.
 */
const URGENT_BELOW_MS = 10 * 60_000;

const Chevron = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

export const WaitingOffer = ({
  offer,
  currencySymbol,
  onRefresh,
}: {
  offer: WaitingOfferSummary;
  currencySymbol: string;
  onRefresh: () => void;
}) => {
  // The clock is per card, which is why this is a component and not a branch
  // inside a .map(): useCountdown is a hook and each waiting offer owns one.
  const { msLeft } = useCountdown(offer.actionDueAt);
  const transfer = offer.status === 'accepted';
  const lapsed = msLeft !== null && msLeft <= 0;

  // The window closed while this page was open. The card does not vanish out
  // from under someone reading a purchase price, and it does not keep offering
  // a door the server will refuse. It says so, and offers to re-read.
  if (lapsed) {
    return (
      <div className="rounded-2xl border-2 border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
        <h3 className="text-base font-bold text-foreground">{OFFER.lapsedTitle}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{OFFER.lapsedBody}</p>
        <button
          onClick={onRefresh}
          className="mt-3 text-sm font-semibold text-primary underline-offset-2 hover:underline"
        >
          {OFFER.waitingRefresh}
        </button>
        <div className="mt-3 font-mono text-[11px] text-muted-foreground">{offer.offerRef}</div>
      </div>
    );
  }

  const urgent = msLeft !== null && msLeft < URGENT_BELOW_MS;
  /**
   * WHY THE NUMBER IS SMALLER THAN THE ONE HE REMEMBERS.
   *
   * "Pisalo je 8 dni, zdaj piše 19 ur." Accepting ends the offer window and
   * starts the transfer window, and this card is where a seller most often
   * meets the second number — days later, on a phone, with no memory of having
   * changed anything. Neither moment is worked out here: `actionDueAt` is the
   * server's deadline and `offerExpiresAt` is the window the offer stood for,
   * and this only asks whether the first is earlier than the second. On a
   * legacy row nothing sweeps, the two are the same timestamp, and the line is
   * not drawn — because nothing changed.
   */
  const windowMoved = (() => {
    if (!transfer || !offer.offerExpiresAt || !offer.actionDueAt) return false;
    const now = parseSqliteUtc(offer.actionDueAt)?.getTime();
    const was = parseSqliteUtc(offer.offerExpiresAt)?.getTime();
    return now !== undefined && was !== undefined && now < was;
  })();
  const settleBy = offer.settlementDueAt ? formatDate(offer.settlementDueAt) : null;
  // Only while the decision is still ahead of him. On an accepted row the
  // counteroffer strip asks him to "Accept 20,070 LANA or not now" about a
  // choice he already made, on a card with no accept button — which is the
  // same defect as the stale verdict, written fresh. /offer keeps this strip
  // inside its `offered` branch for exactly that reason.
  const isCounter = Boolean(!transfer && offer.isCounteroffer && offer.proposedLanaAmount);

  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-primary/5 px-4 py-4 sm:px-6 sm:py-5">
      {/* Whose turn it is, in words, as the card's own title. The status pill
          is deliberately absent: the pill is the token that made these rows
          read as items in a list. */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="text-base font-bold text-foreground">
          {transfer ? OFFER.waitingTransferTitle : OFFER.waitingDecisionTitle}
        </h3>
      </div>

      {/* The amount is not the one the seller proposed. Saying so before the
          figure is read is the whole point of the strip. */}
      {isCounter && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            {OFFER.counterTitle}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
            {counterBody(offer.proposedLanaAmount as number, offer.lanaAmount)}
          </p>
        </div>
      )}

      {/* THE TWO FACTS HE NAMED — this amount, this long. Same size, same
          baseline, side by side, nothing between them and the title. Both are
          whitespace-nowrap and neither is allowed to shrink: at 375px the
          clock drops onto its own line rather than either number truncating. */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
        <div>
          <div className="whitespace-nowrap font-mono text-2xl font-bold text-foreground sm:text-3xl">
            {offer.purchasePrice !== null ? formatFiat(currencySymbol, offer.purchasePrice) : '—'}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {OFFER.offeredPriceLabel}
          </div>
        </div>

        {/* No clock at all rather than an invented one: a legacy row with no
            deadline gets no line, never a dash beside "Time left". */}
        {msLeft !== null && (
          <div>
            <div
              className={`whitespace-nowrap font-mono text-2xl font-bold sm:text-3xl ${
                urgent ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'
              }`}
            >
              {formatLeftToMinute(msLeft)}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {transfer ? OFFER.timeLeftTransferLabel : OFFER.timeLeftLabel}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-1">
        <div className="text-sm text-foreground">
          <span className="whitespace-nowrap">{fill(OFFER.waitingAmount, { amount: formatLana(offer.lanaAmount) })}</span>
        </div>
        {/* A relative number cannot be checked against a calendar, so the
            moment itself is printed under it. */}
        {offer.actionDueAt && (
          <div className="text-xs text-muted-foreground">
            {transfer ? OFFER.waitingTransferByLabel : OFFER.offeredExpiryLabel}{' '}
            <span className="whitespace-nowrap font-medium text-foreground">{formatMoment(offer.actionDueAt)}</span>
          </div>
        )}
      </div>

      {/* What happens if he does nothing. Naming the default is the opposite
          of pressure — it is what lets someone take the time they have. */}
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {transfer ? OFFER.waitingTransferBody : OFFER.waitingDecisionBody}
      </p>

      {/* And which clock this is, when it is not the one the offer carried.
          Small and after the sentence above: it explains a number he has
          already read, it is not a new demand on him. */}
      {windowMoved && (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground" data-testid="window-moved">
          {fill(OFFER.windowChangedShort, { was: formatMoment(offer.offerExpiresAt) })}
        </p>
      )}

      {/* The ref travels with the link. /offer resumes whichever live offer
          comes first in a created_at DESC list, so without it a card showing
          one price opens another. */}
      <Link
        to={`/offer?ref=${encodeURIComponent(offer.offerRef)}`}
        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-1 rounded-xl bg-primary px-6 text-sm font-semibold text-white transition-colors hover:bg-primary/90 sm:w-auto"
      >
        {transfer ? OFFER.waitingFinishTransfer : OFFER.waitingOpen}
        <Chevron />
      </Link>

      {/* Bookkeeping, last and smallest: it matters in a support conversation,
          never in the decision. */}
      <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="whitespace-nowrap font-mono">{offer.offerRef}</span>
        {settleBy && (
          <>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">{OFFER.offeredDueLabel} {settleBy}</span>
          </>
        )}
      </div>
    </div>
  );
};

export default WaitingOffer;
