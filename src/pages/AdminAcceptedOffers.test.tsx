/**
 * "KOLIKO DENARJA ČAKAŠ TER DA GLEDAŠ GDAJ POTEČE."
 *
 * The owner asked for a list of what the treasury has accepted, how much money
 * is owed on it, and when each one runs out. The last third of that sentence is
 * where the screen could have gone wrong: an accepted offer has TWO deadlines,
 * they point at different people, and a column headed "Expires" would have to
 * pick one and be read as the other.
 *
 * So these are the rules the arrangement has to keep, pinned here rather than
 * described in a comment a later edit can ignore:
 *
 *   - the money owed is the first figure on the page;
 *   - both deadlines are drawn, under two names, and neither is called
 *     "expires";
 *   - the one that runs out FIRST is the one in bold, whichever of the two it
 *     happens to be — that emphasis is not decoration, it is the answer;
 *   - a row whose transfer window has already closed is still listed, and is
 *     not in the money.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminAcceptedOffers from './AdminAcceptedOffers';

const SELLER = 'a'.repeat(64);

/**
 * ONE session object, for the life of the file. The page reloads whenever
 * `session` changes identity, so a mock that built a fresh literal on every
 * render would put it in a refetch loop and prove nothing about the page.
 */
const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'c'.repeat(64), profileDisplayName: 'Admin' },
  isLoading: false,
  isAdmin: true,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

/** The shape SQLite writes: `YYYY-MM-DD HH:MM:SS`, always UTC. */
const at = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const offer = (over: Record<string, unknown> = {}) => ({
  offerRef: 'OFF-2026-059',
  userHexId: SELLER,
  senderWallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB',
  walletClass: 'lanapays',
  currency: 'EUR',
  lanaAmount: 3261.797,
  purchasePrice: 651.32,
  createdAt: at(-2 * DAY),
  acceptedAt: at(-1 * HOUR),
  transferDueAt: at(23 * HOUR),
  settlementDueAt: at(15 * DAY),
  nextDue: 'transfer',
  nextDueAt: at(23 * HOUR),
  sweepsItself: true,
  transferLapsed: false,
  round: 1,
  mandateRef: `9:1:${SELLER}`,
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  offers: [offer()],
  totals: { EUR: { owed: 651.32, lana: 3261.797, count: 1, unpriced: 0 } },
  lapsed: { count: 0, byCurrency: {} },
  stillWithSellers: { count: 0, byCurrency: {}, offers: [] },
  transferWindowHours: 24,
  updated_at: new Date().toISOString(),
  ...over,
});

let body: any = payload();

/**
 * A REPLY THAT ARRIVES LATER, WHICH IS THE ONLY KIND THERE IS.
 *
 * `Promise.resolve(...)` settles on a microtask, so a page fed by it can be
 * fully populated before the assertion after `render()` runs — on a quiet
 * machine. On a busy one it is not, and a query written as though the data
 * were already there fails perhaps one run in twenty: this file went red once
 * in a full-suite run with a dev server compiling beside it ("Unable to find
 * an element with the text: €651.32", the card reading "—" and "0 accepted
 * offers"), and passed fifteen times alone.
 *
 * A test that is right only while the machine is idle is not evidence. So the
 * reply is put on a macrotask, where a real one lives: every query for fetched
 * data must now wait for it, and any that does not fails EVERY run rather than
 * a rare one. The flake becomes a fact.
 */
const reply = (value: unknown) =>
  new Promise<Response>(resolve =>
    setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(value) } as Response), 0),
  );

beforeEach(() => {
  body = payload();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = String(url);
    // AdminNav polls the review list; the name lookup is a POST. Neither is
    // what this file is about, and both must not make it fail.
    if (path.includes('/admin/accepted')) return reply(body);
    if (path.includes('/profiles')) return reply({ names: {} });
    return reply({ offers: [] });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const show = () => render(<MemoryRouter><AdminAcceptedOffers /></MemoryRouter>);

/**
 * THE REQUEST HAS COME BACK — waited for once, here, rather than assumed.
 *
 * The heading "Owed on accepted offers" is printed by the empty shell before
 * anything is fetched, so waiting for IT and then reading the figure beneath
 * it is waiting for the frame around the answer instead of the answer. The
 * page's own signal that the fetch is over is its Refresh button: it reads
 * "Loading…" until `loading` goes false in the `finally`, in the same batch as
 * `setData`. Every figure this file asserts on exists by then, whatever the
 * body was — including the bodies where the right answer is a dash.
 */
const settled = () =>
  waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument());

/** The card carrying the bottom line, so a figure in it is not confused with
    the same figure on a row. Await it before reading anything inside. */
const hero = async () => {
  await settled();
  return screen.getByText('Owed on accepted offers').closest('div') as HTMLElement;
};

/** Render, then the `<tr>` one offer reference sits in. */
const rowOf = async (ref: string) => {
  show();
  await settled();
  return (await screen.findByText(ref)).closest('tr') as HTMLTableRowElement;
};

describe('the money, first', () => {
  it('leads with what is owed on accepted offers', async () => {
    show();
    const card = await hero();
    expect(within(card).getByText('€651.32')).toBeInTheDocument();
    expect(within(card).getByText(/1 accepted offer · waiting on the seller's transfer/)).toBeInTheDocument();
  });

  it('keeps two currencies as two figures — a sum of them is owed to nobody', async () => {
    body = payload({
      totals: {
        EUR: { owed: 651.32, lana: 3261.797, count: 1, unpriced: 0 },
        GBP: { owed: 40, lana: 200, count: 1, unpriced: 0 },
      },
    });
    show();
    const card = await hero();
    expect(within(card).getByText('€651.32')).toBeInTheDocument();
    expect(within(card).getByText('£40.00')).toBeInTheDocument();
    expect(screen.queryByText('€691.32')).not.toBeInTheDocument();
  });

  it('says so when a row carries no price, rather than letting the total look complete', async () => {
    body = payload({ totals: { EUR: { owed: 651.32, lana: 3261.797, count: 2, unpriced: 1 } } });
    show();
    await settled();
    // One, which is the commonest count here, reads as one.
    expect(
      screen.getByText('1 of them carries no purchase price and is not in the figure above.'),
    ).toBeInTheDocument();
  });

  it('still reads as English when there is more than one of them', async () => {
    body = payload({ totals: { EUR: { owed: 651.32, lana: 3261.797, count: 5, unpriced: 3 } } });
    show();
    await settled();
    expect(
      screen.getByText('3 of them carry no purchase price and are not in the figure above.'),
    ).toBeInTheDocument();
  });
});

describe('two clocks, kept apart', () => {
  it('gives each deadline its own column and calls neither of them "expires"', async () => {
    show();
    await waitFor(() => expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0));
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent || '');
    expect(headers).toContain('Seller transfers by');
    expect(headers).toContain('We settle by');
    for (const header of headers) expect(header).not.toMatch(/expire/i);
  });

  it('says in words that they are not the same clock, and what each one costs', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Two clocks, and they are not the same one.')).toBeInTheDocument());
    expect(screen.getByText(/the acquisition simply does not happen and we owe nothing/)).toBeInTheDocument();
    expect(screen.getByText(/when it runs out we are late/)).toBeInTheDocument();
  });

  it('takes the length of the seller\'s window from the server rather than typing 24 in', async () => {
    body = payload({ transferWindowHours: 36 });
    show();
    await waitFor(() =>
      expect(screen.getByText(/window is 36 hours from the moment they accept/)).toBeInTheDocument(),
    );
  });

  it('draws both on the row, counting down separately', async () => {
    const row = await rowOf('OFF-2026-059');
    // 23 hours reads in hours and minutes; 15 days reads in days and hours.
    expect(within(row).getByText(/^\d+h \d\dm$/)).toBeInTheDocument();
    expect(within(row).getByText(/^\d+d \d+h$/)).toBeInTheDocument();
  });
});

/**
 * The emphasis IS the answer to "which of these runs out first", so it is
 * asserted on the class rather than trusted. The two clock cells are the last
 * two in the row, in the order of their headings.
 */
const clockCells = (row: HTMLTableRowElement) => {
  const cells = [...row.querySelectorAll('td')];
  return { transfer: cells[cells.length - 2], settlement: cells[cells.length - 1] };
};
const boldFigure = (cell: Element) =>
  Boolean(cell.querySelector('span.font-mono')?.className.includes('font-bold'));

describe('which one is running out first', () => {
  it('bolds the seller\'s window when the seller\'s window is nearer', async () => {
    const row = await rowOf('OFF-2026-059');
    const { transfer, settlement } = clockCells(row);
    expect(boldFigure(transfer)).toBe(true);
    expect(boldFigure(settlement)).toBe(false);
  });

  it('bolds OUR date instead when ours is nearer — the emphasis follows the fact', async () => {
    body = payload({
      offers: [offer({ settlementDueAt: at(2 * HOUR), nextDue: 'settlement', nextDueAt: at(2 * HOUR) })],
    });
    const row = await rowOf('OFF-2026-059');
    const { transfer, settlement } = clockCells(row);
    expect(boldFigure(settlement)).toBe(true);
    expect(boldFigure(transfer)).toBe(false);
  });
});

/**
 * A WINDOW THAT HAS ALREADY CLOSED IS NOT ON THE LIST.
 *
 * Owner, 11 Sept 2026: "primere, ki so overdue, ne rabiš sploh prikazovati."
 * A row past its transfer window owes nobody anything and can never complete;
 * listing it fills the page with rows that are only in the way. It is counted
 * in one line, with the door to void it, and that is all.
 *
 * These asserted the row's own presentation until that day. The presentation
 * is still live — a row can run out while the page is open, and then its own
 * clock says so — but it is no longer how a lapsed row arrives here.
 */
describe('a window that has already closed', () => {
  const lapsedBody = (over = {}) => payload({
    offers: [offer({ transferDueAt: at(-1 * HOUR), nextDueAt: at(-1 * HOUR), transferLapsed: true, ...over })],
    totals: {},
    lapsed: { count: 1, byCurrency: { EUR: 651.32 } },
  });

  it('is not listed at all', async () => {
    body = lapsedBody();
    show();
    await hero();
    expect(screen.queryByText('OFF-2026-059')).not.toBeInTheDocument();
  });

  it('but its money is named, out of the figure at the top, with where to go', async () => {
    body = lapsedBody();
    show();
    const card = await hero();
    // The bottom line is a dash, not the price of a row that can never
    // complete; the money is named below it as explicitly not listed.
    expect(within(card).getByText('—')).toBeInTheDocument();
    expect(within(card).getByText(/is past its transfer window and is not listed above/)).toBeInTheDocument();
    expect(within(card).getByText(/€651\.32/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Offers' })).toHaveAttribute('href', '/admin/offers');
  });

  it('says it in the plural when more than one has run out', async () => {
    body = payload({
      offers: [offer({ transferDueAt: at(-1 * HOUR), nextDueAt: at(-1 * HOUR), transferLapsed: true })],
      totals: {},
      lapsed: { count: 2, byCurrency: { EUR: 951.32 } },
    });
    show();
    const card = await hero();
    expect(within(card).getByText(/are past their transfer window and are not listed above/)).toBeInTheDocument();
  });

  it('leaves the settlement date alone on a row that can still complete', async () => {
    body = payload({ offers: [offer({ settlementDueAt: at(2 * DAY) })] });
    const row = await rowOf('OFF-2026-059');
    const figure = clockCells(row).settlement.querySelector('span.font-mono') as HTMLElement;
    expect(figure.className).toMatch(/amber/);
    expect(figure.className).not.toMatch(/line-through/);
  });

  /**
   * The one way a closed window still reaches the table: it closes while
   * somebody is reading the page. The server said it was live when the list
   * was fetched, and the row's own clock is what notices.
   */
  it('a row that runs out while the page is open still says so on itself', async () => {
    body = payload({ offers: [offer({ transferDueAt: at(-1 * HOUR), nextDueAt: at(-1 * HOUR) })] });
    const row = await rowOf('OFF-2026-059');
    expect(within(row).getByText('window closed')).toBeInTheDocument();
  });
});

describe('read on a phone', () => {
  /**
   * At 375 px this table is about 870 px wide inside a 340 px window, so the
   * two deadline columns — the whole point of the page — can only be reached
   * by scrolling sideways, and that used to carry the offer reference off the
   * left edge. A deadline you cannot attach to a row is not an answer.
   */
  it('keeps the offer reference beside the clocks when the table is scrolled sideways', async () => {
    const row = await rowOf('OFF-2026-059');
    const ref = screen.getByText('OFF-2026-059').closest('td') as HTMLElement;
    expect(ref.className).toMatch(/sticky/);
    expect(ref.className).toMatch(/left-0/);
    // Opaque, or the scrolling cells show through it.
    expect(ref.className).toMatch(/bg-card/);
    expect(row.querySelectorAll('td')[0]).toBe(ref);

    const header = screen.getByRole('columnheader', { name: 'Offer' });
    expect(header.className).toMatch(/sticky/);
  });

  it('keeps the round badge on one line so it stays a pill', async () => {
    await rowOf('OFF-2026-059');
    const badge = screen.getByText(/^Round 1$/);
    expect(badge.className).toMatch(/whitespace-nowrap/);
  });
});

describe('what this page is NOT', () => {
  it('points at Payouts for the money owed after the transfer lands', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/Once the LANA arrives an offer becomes a sale/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Payouts' })).toHaveAttribute('href', '/admin/payouts');
  });

  /** A waiting offer, as the server now ships it. */
  const waiting = (over: Record<string, unknown> = {}) => ({
    offerRef: 'OFF-2026-073', userHexId: 'b'.repeat(64), senderWallet: 'LV3gKHtyahtZSP1g56FSCgYrJjCDj6WJtW',
    currency: 'EUR', lanaAmount: 32488.67, purchasePrice: 6487.34, discountPercent: 22,
    round: 1, mandateRef: '8:1:' + 'b'.repeat(64),
    createdAt: at(-6 * HOUR), pricedAt: at(-3 * HOUR), standsUntil: at(7 * DAY), ...over,
  });

  it('names what is still out with sellers as separate, uncounted money', async () => {
    body = payload({ stillWithSellers: { count: 2, byCurrency: { EUR: 300 }, offers: [waiting()] } });
    show();
    await waitFor(() =>
      expect(screen.getByText(/Waiting on sellers/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/not counted above/)).toBeInTheDocument();
  });

  /**
   * THE ROWS, NOT THE SUM — 11 Sept 2026.
   *
   * The owner remembered an offer by name and could not find it on any screen:
   * a summary line said two were out with sellers and named neither. What he
   * needed was whose, how much, and how long it still stands.
   */
  it('LISTS the offers waiting on sellers, with who and how long', async () => {
    body = payload({ stillWithSellers: { count: 1, byCurrency: { EUR: 6487.34 }, offers: [waiting()] } });
    show();
    await waitFor(() => expect(screen.getByText('Waiting on the seller')).toBeInTheDocument());
    // Scoped to the block: the same figure also appears in the summary line
    // above it, and the point of this test is that the ROW exists.
    const section = screen.getByText('Waiting on the seller').closest('section') as HTMLElement;
    expect(within(section).getByText('OFF-2026-073')).toBeInTheDocument();
    expect(within(section).getByText(/32,488\.67/)).toBeInTheDocument();
    expect(within(section).getByText(/6,487\.34/)).toBeInTheDocument();
    expect(within(section).getByText(/at 22%/)).toBeInTheDocument();
    // And it must not be mistaken for money the treasury owes.
    expect(screen.getByText(/Nothing is owed yet/)).toBeInTheDocument();
  });

  it('says nothing at all when no offer is waiting', async () => {
    body = payload();
    show();
    await waitFor(() => expect(screen.getByText(/Once the LANA arrives/)).toBeInTheDocument());
    expect(screen.queryByText('Waiting on the seller')).not.toBeInTheDocument();
  });

  it('has an empty state that explains when a row appears and when it leaves', async () => {
    body = payload({ offers: [], totals: {} });
    show();
    await waitFor(() => expect(screen.getByText('Nothing is waiting on a transfer')).toBeInTheDocument());
    expect(screen.getByText(/leaves it the moment their\s+LANA arrives/)).toBeInTheDocument();
  });
});
