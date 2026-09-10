/**
 * "PISALO JE 8 DNI, ZDAJ PIŠE 19 UR."
 *
 * The owner accepted a €6,498.88 purchase offer that said it stood for eight
 * days, and the next screen said nineteen hours. Both numbers were true: a
 * purchase offer a person made stands MANUAL_OFFER_VALIDITY_DAYS, and
 * accepting it closes that window and opens the ACCEPTED_TRANSFER_WINDOW_HOURS
 * one for the transfer, after which expireStaleOffers voids the row. Nothing
 * on any screen joined the two facts, so the only way to learn it was to
 * accept and watch the figure collapse.
 *
 * This card is where a seller meets the second number days later, on a phone,
 * with no memory of having changed anything — so it is where the sentence has
 * to survive. What is pinned here is the discipline as much as the sentence:
 * the card compares TWO MOMENTS THE SERVER SENT and says the clock changed
 * only where it actually did. A card that announced a change on every accepted
 * row would be manufacturing urgency on the legacy rows, which nothing sweeps.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WaitingOffer, type WaitingOfferSummary } from './WaitingOffer';

/** The shape SQLite writes: `YYYY-MM-DD HH:MM:SS`, always UTC. */
const sqliteUtc = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const offer = (over: Partial<WaitingOfferSummary> = {}): WaitingOfferSummary => ({
  offerRef: 'OFF-2026-048',
  status: 'offered',
  lanaAmount: 20070,
  currency: 'EUR',
  purchasePrice: 6498.88,
  settlementDueAt: sqliteUtc(15 * DAY),
  offerExpiresAt: sqliteUtc(7 * DAY),
  actionDueAt: sqliteUtc(7 * DAY),
  ...over,
});

const show = (o: WaitingOfferSummary) =>
  render(
    <MemoryRouter>
      <WaitingOffer offer={o} currencySymbol="€" onRefresh={() => {}} />
    </MemoryRouter>,
  );

describe('the clock that changed when he accepted', () => {
  it('says which window is running, when it is no longer the offer window', () => {
    // Accepted a day into an eight-day offer: the sweep is 19 hours away and
    // the offer window is six days away, so the number on the card is the
    // sweep and the card owes him the reason.
    show(offer({ status: 'accepted', actionDueAt: sqliteUtc(19 * HOUR), offerExpiresAt: sqliteUtc(6 * DAY) }));
    const line = screen.getByTestId('window-moved');
    expect(line.textContent).toMatch(/transfer window, not the offer window/i);
    expect(line.textContent).toMatch(/accepting started it/i);
  });

  it('prints the moment the offer itself stood until, not just the word "longer"', () => {
    // "It used to say eight days" is only checkable against a date. The moment
    // he remembers is offerExpiresAt, so that is the one reprinted.
    const stoodUntil = sqliteUtc(6 * DAY);
    show(offer({ status: 'accepted', actionDueAt: sqliteUtc(19 * HOUR), offerExpiresAt: stoodUntil }));
    const day = new Date(stoodUntil.replace(' ', 'T') + 'Z').getDate();
    expect(screen.getByTestId('window-moved').textContent).toContain(String(day).padStart(2, '0'));
  });

  it('invents no change on a row nothing sweeps', () => {
    // A legacy offer carries no mandate, expireStaleOffers never voids it, and
    // sellerActionDeadline hands back the offer window unchanged. Nothing
    // moved, so nothing is announced.
    const same = sqliteUtc(6 * DAY);
    show(offer({ status: 'accepted', actionDueAt: same, offerExpiresAt: same }));
    expect(screen.queryByTestId('window-moved')).toBeNull();
  });

  it('says nothing before the decision is made — there is no second clock yet', () => {
    // On an `offered` row the two moments are the same by definition and the
    // seller has not started anything. The warning that belongs here belongs
    // on /offer, in front of the accept button, not on this card.
    show(offer({ status: 'offered', actionDueAt: sqliteUtc(7 * DAY), offerExpiresAt: sqliteUtc(7 * DAY) }));
    expect(screen.queryByTestId('window-moved')).toBeNull();
  });

  it('holds no opinion when the server sent only one of the two moments', () => {
    // A server that predates `offerExpiresAt` on this card, or a row that has
    // none. Two moments are needed to say one is earlier than the other; with
    // one, the honest answer is silence.
    show(offer({ status: 'accepted', actionDueAt: sqliteUtc(19 * HOUR), offerExpiresAt: null }));
    expect(screen.queryByTestId('window-moved')).toBeNull();
  });

  it('still says whose turn it is and what the transfer is worth', () => {
    // The new line is an explanation bolted under the existing sentence, not a
    // replacement for it: the card's own job is unchanged.
    show(offer({ status: 'accepted', actionDueAt: sqliteUtc(19 * HOUR), offerExpiresAt: sqliteUtc(6 * DAY) }));
    expect(screen.getByText(/Waiting for your transfer/i)).toBeInTheDocument();
    expect(screen.getByText('€6,498.88')).toBeInTheDocument();
    expect(screen.getByText(/Time left to transfer/i)).toBeInTheDocument();
  });
});
