/**
 * "JASNO POKAŽI, KATERA PONUDBA ME ČAKA NA ODOBRITEV."
 *
 * The owner opened /dashboard, saw a €6,498.88 purchase offer with seven days
 * left on it rendered through the same card as a settled acquisition from last
 * month, and could not tell which one was waiting for him. Two things were
 * wrong underneath: the clock was on the wire and never drawn, and the offer
 * was still repeating the verdict written when it was submitted — "This
 * proposal is under treasury review." — underneath a badge that said the offer
 * was open.
 *
 * These are the rules a later edit could silently undo, so they are pinned
 * here rather than described in a commit message: what waits on the seller
 * comes FIRST and carries its price and its clock, what does not is history,
 * and neither is ever both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

const HEX = 'a'.repeat(64);

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: { nostrHexId: HEX, profileDisplayName: 'Joshua Andrej Brilly', walletId: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB' },
    isAdmin: false,
    logout: () => {},
  }),
}));

/** The shape SQLite writes: `YYYY-MM-DD HH:MM:SS`, always UTC. */
const sqliteUtc = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const offer = (over: Record<string, unknown> = {}) => ({
  offerRef: 'OFF-2026-048',
  status: 'offered',
  lanaAmount: 20070,
  currency: 'EUR',
  purchasePrice: 6498.88,
  settlementDueAt: sqliteUtc(15 * DAY),
  offerExpiresAt: sqliteUtc(7 * DAY),
  actionDueAt: sqliteUtc(7 * DAY),
  decisionReason: null,
  senderWallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB',
  createdAt: sqliteUtc(-DAY),
  transactionId: null,
  isCounteroffer: false,
  proposedLanaAmount: null,
  ...over,
});

let offers: any[] = [];

beforeEach(() => {
  offers = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = String(url).includes('/acquisitions/mine') ? { offers } : { sales: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const show = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

describe('the offer that is waiting on the seller', () => {
  it('says whose turn it is, for how much, and for how long', async () => {
    offers = [offer()];
    show();

    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    // The two facts he named, and the amount they are for.
    expect(screen.getByText('€6,498.88')).toBeInTheDocument();
    expect(screen.getByText('Purchase price')).toBeInTheDocument();
    expect(screen.getByText('Time left to accept')).toBeInTheDocument();
    expect(screen.getByText(/^\d+d \d+h$/)).toBeInTheDocument();
    expect(screen.getByText('for 20,070 LANA')).toBeInTheDocument();
  });

  it('the price carries its thousands separator — it is read at a glance, not parsed', async () => {
    offers = [offer()];
    show();
    await waitFor(() => expect(screen.getByText('€6,498.88')).toBeInTheDocument());
    expect(screen.queryByText('€6498.88')).not.toBeInTheDocument();
  });

  it('sits ABOVE the standing invitation to submit another one', async () => {
    offers = [offer()];
    const { container } = show();
    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    const text = container.textContent || '';
    expect(text.indexOf('Waiting for your decision')).toBeLessThan(text.indexOf('Get Started'));
  });

  it('is lifted out of the record below, and the record says where it went', async () => {
    offers = [offer(), offer({ offerRef: 'OFF-2026-041', status: 'settled', actionDueAt: null, offerExpiresAt: null })];
    show();

    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    const record = screen.getByText('Your offers').closest('div')!;
    expect(within(record).getByText('OFF-2026-041')).toBeInTheDocument();
    expect(within(record).queryByText('OFF-2026-048')).not.toBeInTheDocument();
    expect(screen.getByText('Anything waiting on you is shown at the top of this page.')).toBeInTheDocument();
  });

  it('opens THAT offer, not whichever one the server listed first', async () => {
    offers = [offer()];
    show();
    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    const door = screen.getByRole('link', { name: /Open this purchase offer/ });
    expect(door.getAttribute('href')).toBe('/offer?ref=OFF-2026-048');
  });

  it('never repeats the verdict from when the proposal was submitted', async () => {
    /**
     * Belt for the server's own projection: a cached older API, or a row the
     * sweeper has not caught, must not put the sentence back.
     *
     * The sentinel is the half of this with teeth. `decision_reason` is a
     * STORED column, so what it holds is whatever the code wrote on the day —
     * the assertion below is about the CARD's contract (it says what waits on
     * you, never what a row once said about itself), and a sentinel proves the
     * card ignores the field rather than proving the field happens to be empty.
     */
    const STORED = 'PINNED-STORED-REASON-THE-CARD-MUST-NOT-PRINT';
    offers = [offer({ decisionReason: `This proposal is under treasury review. ${STORED}` })];
    show();
    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(STORED))).toBeNull();
    expect(screen.queryByText(/under treasury review/i)).not.toBeInTheDocument();
    // And what it DOES say comes from the code, so the state on screen is the
    // one this release ships and not one a stored row can rewrite.
    expect(screen.getByText(/Waiting for your decision/)).toBeInTheDocument();
  });

  it('is addressed to one offer when there is one, and does not claim nothing is owed', async () => {
    offers = [offer()];
    show();
    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    expect(screen.getByText('This is waiting on you, not on us.')).toBeInTheDocument();
    expect(screen.queryByText(/These are waiting on you/)).not.toBeInTheDocument();
  });

  it('names the do-nothing outcome instead of hurrying anyone', async () => {
    offers = [offer()];
    show();
    await waitFor(() => expect(
      screen.getByText(/If you do nothing it lapses at the time shown, and nothing is transferred/),
    ).toBeInTheDocument());
  });
});

describe('two of them, and none', () => {
  it('shows both, soonest deadline first, each opening its own offer', async () => {
    offers = [
      offer({ offerRef: 'OFF-2026-052', purchasePrice: 501.20, actionDueAt: sqliteUtc(7 * DAY + 9 * HOUR), offerExpiresAt: sqliteUtc(7 * DAY + 9 * HOUR) }),
      offer({ offerRef: 'OFF-2026-048', actionDueAt: sqliteUtc(7 * DAY), offerExpiresAt: sqliteUtc(7 * DAY) }),
    ];
    const { container } = show();

    await waitFor(() => expect(screen.getAllByText('Waiting for your decision')).toHaveLength(2));
    const text = container.textContent || '';
    // What runs out first is on top, whatever order the wire gave.
    expect(text.indexOf('OFF-2026-048')).toBeLessThan(text.indexOf('OFF-2026-052'));
    // No total across the two: a seller may accept one and decline the other,
    // so a sum would name an outcome nobody can choose.
    expect(screen.queryByText('€7,000.08')).not.toBeInTheDocument();

    const hrefs = screen.getAllByRole('link', { name: /Open this purchase offer/ }).map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['/offer?ref=OFF-2026-048', '/offer?ref=OFF-2026-052']);
  });

  it('with nothing waiting, the block is not there at all — no empty state', async () => {
    offers = [offer({ offerRef: 'OFF-2026-041', status: 'settled', actionDueAt: null })];
    show();

    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    expect(screen.queryByText('Waiting for your decision')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for your transfer')).not.toBeInTheDocument();
    expect(screen.queryByText(/These are waiting on you/)).not.toBeInTheDocument();
    expect(screen.queryByText('Anything waiting on you is shown at the top of this page.')).not.toBeInTheDocument();
  });

  it('a proposal still with the treasury is not called waiting — the seller cannot move it', async () => {
    offers = [offer({ status: 'under_review', purchasePrice: null, actionDueAt: null, offerExpiresAt: null })];
    show();
    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    expect(screen.queryByText('Waiting for your decision')).not.toBeInTheDocument();
  });
});

describe('the clock and the sweeper disagree for up to a minute', () => {
  /**
   * The device clock does not get to hide an offer. It used to: any row whose
   * deadline had passed by `Date.now()` was dropped out of the block and
   * buried in the history with no clock on it — which on a phone a few minutes
   * fast is the original complaint, reproduced by the fix for it, on the
   * thirty-minute automatic offers this page mostly carries.
   */
  it('a window that has closed says so, where it can be seen — it does not go missing', async () => {
    offers = [offer({ actionDueAt: sqliteUtc(-60_000), offerExpiresAt: sqliteUtc(-60_000) })];
    show();

    await waitFor(() => expect(screen.getByText('This purchase offer has lapsed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByText('OFF-2026-048')).toBeInTheDocument();
    // And it is still not in two places at once.
    expect(screen.queryByText('Purchase offer open')).not.toBeInTheDocument();
    // Nor does the line above it insist the shut window is waiting on him.
    expect(screen.queryByText(/waiting on you, not on us/)).not.toBeInTheDocument();
  });

  it('so the pointer over the record below is telling the truth', async () => {
    offers = [
      offer({ actionDueAt: sqliteUtc(-60_000), offerExpiresAt: sqliteUtc(-60_000) }),
      offer({ offerRef: 'OFF-2026-041', status: 'settled', actionDueAt: null, offerExpiresAt: null }),
    ];
    show();
    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    const record = screen.getByText('Your offers').closest('div')!;
    expect(within(record).queryByText('OFF-2026-048')).not.toBeInTheDocument();
    expect(screen.getByText('Anything waiting on you is shown at the top of this page.')).toBeInTheDocument();
  });
});

describe('the record below, once an offer is over', () => {
  it('a lapsed row does not promise a settlement date for an acquisition that never happened', async () => {
    offers = [offer({
      offerRef: 'OFF-2026-045', status: 'expired', actionDueAt: null, offerExpiresAt: null,
      decisionReason: 'TRANSFER_NOT_COMPLETED',
    })];
    show();
    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    expect(screen.queryByText(/We settle by/)).not.toBeInTheDocument();
  });

  it('and explains itself in English, not in the token the sweeper wrote', async () => {
    offers = [offer({
      offerRef: 'OFF-2026-045', status: 'expired', actionDueAt: null, offerExpiresAt: null,
      decisionReason: 'TRANSFER_NOT_COMPLETED',
    })];
    show();
    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    expect(screen.queryByText('TRANSFER_NOT_COMPLETED')).not.toBeInTheDocument();
    expect(screen.getByText(/did not reach our treasury wallet in time/)).toBeInTheDocument();
  });

  it('a sentence a person wrote is shown as they wrote it', async () => {
    offers = [offer({
      offerRef: 'OFF-2026-044', status: 'declined', purchasePrice: null,
      actionDueAt: null, offerExpiresAt: null, settlementDueAt: null,
      decisionReason: 'Above the amount this mandate covers.',
    })];
    show();
    await waitFor(() => expect(screen.getByText('Your offers')).toBeInTheDocument());
    expect(screen.getByText('Above the amount this mandate covers.')).toBeInTheDocument();
  });
});

describe('accepted, and the LANA has not moved', () => {
  it('asks for the transfer, on the deadline the server worked out', async () => {
    offers = [offer({ status: 'accepted', actionDueAt: sqliteUtc(4 * HOUR) })];
    show();

    await waitFor(() => expect(screen.getByText('Waiting for your transfer')).toBeInTheDocument());
    expect(screen.getByText('Time left to transfer')).toBeInTheDocument();
    expect(screen.getByText(/^\d+h \d{2}m$/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Finish the transfer/ }).getAttribute('href'))
      .toBe('/offer?ref=OFF-2026-048');
    expect(screen.getByText(/The LANA has not reached our treasury wallet yet/)).toBeInTheDocument();
    // Not "Offer stands until": on a mandate-bound row the sweep closes the
    // transfer window long before the offer's own eight days are up.
    expect(screen.getByText(/Transfer by/)).toBeInTheDocument();
    expect(screen.queryByText(/Offer stands until/)).not.toBeInTheDocument();
  });

  it('in the last minutes the clock is amber — and never red, from a page that cannot accept', async () => {
    offers = [offer({ status: 'accepted', actionDueAt: sqliteUtc(6 * 60_000) })];
    const { container } = show();

    await waitFor(() => expect(screen.getByText('Waiting for your transfer')).toBeInTheDocument());
    expect(container.querySelector('.text-amber-700')).not.toBeNull();
    expect(container.querySelector('[class*="text-red"]')).toBeNull();
  });
});

/**
 * AN AUTOMATIC OFFER STANDS THIRTY MINUTES.
 *
 * That is the commonest card on this page, so whatever it does is what this
 * block is. It was born amber, at 24-30px, counting "28:59, 28:58" at somebody
 * who had just landed on their dashboard — an urgency signal that is on for
 * 100% of an offer's life carries no information, and the seconds are the
 * pressure the brief rules out in as many words.
 */
describe('the thirty minutes an automatic offer stands', () => {
  /** The clock is the figure directly above its own label. */
  const clockFace = () => screen.getByText('Time left to accept').previousElementSibling!.textContent;

  it('is not urgent at birth, and does not count seconds at anyone', async () => {
    offers = [offer({ actionDueAt: sqliteUtc(29 * 60_000), offerExpiresAt: sqliteUtc(29 * 60_000) })];
    const { container } = show();

    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    // Minutes, not mm:ss. (The fixture floors to the second, so 28 or 29.)
    expect(clockFace()).toMatch(/^(28|29)m$/);
    expect(container.querySelector('.text-amber-700')).toBeNull();
  });

  it('and the seconds come back for the final minute, where they are the story', async () => {
    offers = [offer({ actionDueAt: sqliteUtc(45_000), offerExpiresAt: sqliteUtc(45_000) })];
    const { container } = show();

    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    expect(clockFace()).toMatch(/^0:\d{2}$/);
    expect(container.querySelector('.text-amber-700')).not.toBeNull();
  });
});

describe('a counteroffer among them', () => {
  it('says the amount is not the one that was proposed, before the price is read', async () => {
    offers = [offer({ isCounteroffer: true, proposedLanaAmount: 30000, lanaAmount: 20070 })];
    show();

    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    expect(screen.getByText('Counteroffer — for your remaining mandate')).toBeInTheDocument();
    expect(screen.getByText(/You proposed 30,000 LANA/)).toBeInTheDocument();
  });

  it('stops asking once it has been accepted — there is no accept button on this card', async () => {
    offers = [offer({
      status: 'accepted', isCounteroffer: true, proposedLanaAmount: 30000, lanaAmount: 20070,
      actionDueAt: sqliteUtc(4 * HOUR),
    })];
    show();

    await waitFor(() => expect(screen.getByText('Waiting for your transfer')).toBeInTheDocument());
    expect(screen.queryByText('Counteroffer — for your remaining mandate')).not.toBeInTheDocument();
    expect(screen.queryByText(/Accept 20,070 LANA or not now/)).not.toBeInTheDocument();
  });
});

describe('a server that predates the field', () => {
  it('an open offer still gets its clock from the window, which is the same moment', async () => {
    // Belt for the deploy order only: on an `offered` row actionDueAt and the
    // offer window are the same timestamp by definition.
    offers = [offer({ actionDueAt: undefined })];
    show();
    await waitFor(() => expect(screen.getByText('Waiting for your decision')).toBeInTheDocument());
    expect(screen.getByText('Time left to accept')).toBeInTheDocument();
    expect(screen.getByText(/^\d+d \d+h$/)).toBeInTheDocument();
  });

  it('an accepted one gets no invented deadline — the sweep is not this page\'s to guess', async () => {
    offers = [offer({ status: 'accepted', actionDueAt: undefined })];
    show();
    await waitFor(() => expect(screen.getByText('Waiting for your transfer')).toBeInTheDocument());
    expect(screen.queryByText('Time left to transfer')).not.toBeInTheDocument();
  });
});
