/**
 * THE SELLER'S DASHBOARD SINCE SELLING CLOSED (8 Oct 2026).
 *
 * What a seller sold and what we still owe him is all still here. What changed:
 * the invitation to submit another offer is now the notice naming the firms
 * that buy LANA, and nothing is drawn as "waiting on you" — the server refuses
 * accepting a purchase offer and transferring an accepted one, so a card that
 * asked him to do either would ask for what cannot be done. Such a row stays in
 * the record with its status, and leads nowhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { TWO_FIRMS, stubFetch } from '@/test/buyingDealersFixture';
import { describeDecisionReason, describeOfferError } from '@/lib/offerErrors';

// One session object for every render, as the real context keeps it.
const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'a'.repeat(64), profileDisplayName: 'Seller', walletId: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB' },
  isAdmin: false,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const sqliteUtc = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
const DAY = 86_400_000;

const sale = {
  id: 113, lanaAmount: 5000, currency: 'EUR', netFiat: 649.18, txHash: 'f'.repeat(64), status: 'completed',
  createdAt: sqliteUtc(-DAY), completedAt: sqliteUtc(-DAY), senderWallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB',
  offerRef: 'OFF-2026-113', settlementDueAt: sqliteUtc(15 * DAY), totalPaid: 0, remaining: 649.18, payouts: [],
};
const openOffer = {
  offerRef: 'OFF-2026-120', status: 'offered', lanaAmount: 1000, currency: 'EUR', purchasePrice: 99.5,
  settlementDueAt: sqliteUtc(15 * DAY), offerExpiresAt: sqliteUtc(7 * DAY), actionDueAt: sqliteUtc(7 * DAY),
  decisionReason: null, senderWallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', createdAt: sqliteUtc(-DAY),
  transactionId: null, isCounteroffer: false, proposedLanaAmount: null,
};

const show = (path = '/dashboard', offers: unknown[] = [openOffer]) => {
  stubFetch(TWO_FIRMS, url => (url.includes('/acquisitions/mine') ? { offers } : { sales: [sale] }));
  return render(<MemoryRouter initialEntries={[path]}><Dashboard /></MemoryRouter>);
};

describe('the dashboard, selling closed', () => {
  it('names the firms where the invitation to submit an offer was', async () => {
    const { container } = show();
    const list = await screen.findByTestId('buying-dealers');
    expect(within(list).getByText(TWO_FIRMS.buyers[0].name)).toBeInTheDocument();
    expect(within(list).getByText(TWO_FIRMS.buyers[1].name)).toBeInTheDocument();
    expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit an Offer')).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/offer"]')).toBeNull();
  });

  it('still shows what was sold and what is still owed', async () => {
    show();
    expect(await screen.findByText('5,000 LANA')).toBeInTheDocument();
    expect(screen.getAllByText(/€649\.18/).length).toBeGreaterThan(0);
  });

  it('draws nothing as waiting on the seller; an open offer stays in the record and leads nowhere', async () => {
    const { container } = show('/dashboard?tab=offers');
    const record = await screen.findByTestId('offers-record');
    expect(within(record).getByText('OFF-2026-120')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your decision')).not.toBeInTheDocument();
    expect(within(record).queryByRole('link', { name: /Open/ })).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/offer"]')).toBeNull();
  });

  /**
   * A proposal under review when selling closed is ended by the server's
   * sweeper (expireStaleOffers, decision_reason SELLING_CLOSED). It leaves the
   * list for the one line that counts what came to nothing, and its code never
   * reaches a person.
   */
  it('a proposal the closure ended is counted with what came to nothing; its code is never shown', async () => {
    const ended = {
      ...openOffer, offerRef: 'OFF-2026-121', status: 'expired', purchasePrice: null, settlementDueAt: null,
      offerExpiresAt: null, actionDueAt: null, decisionReason: 'SELLING_CLOSED',
    };
    show('/dashboard?tab=offers', [ended]);
    expect(await screen.findByTestId('came-to-nothing')).toHaveTextContent(/1 earlier proposal came to nothing/);
    expect(screen.queryByText('OFF-2026-121')).not.toBeInTheDocument();
    expect(screen.queryByText(/SELLING_CLOSED/)).not.toBeInTheDocument();
  });
});

describe('the words for the closure', () => {
  it('the code the sweeper writes reads as a sentence', () => {
    expect(describeDecisionReason('SELLING_CLOSED')).toBe(
      'Selling LANA on Lana.discount has closed, so this proposal lapsed without a decision. Nothing was transferred.',
    );
  });

  it('…and the refusal still shows the server\'s own sentence, which names the firms', () => {
    const error = 'LANA can no longer be sold on Lana.discount. The purchase of LANA has been taken over by Ravena Plus d.o.o. (https://ravenaplus.com/prijava): to sell your LANA, register with it.';
    expect(describeOfferError({ code: 'SELLING_MOVED', error })).toBe(error);
  });
});
