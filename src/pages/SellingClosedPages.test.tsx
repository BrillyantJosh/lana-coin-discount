/**
 * EVERY DOOR TO A SALE NOW OPENS ONTO THE NOTICE (8 Oct 2026).
 *
 * The places a person went to sell LANA here — /offer (and the old /sell that
 * leads to it, which MejmoSeFajn and being3 still link to), the landing page's
 * call to action and the sign-in page — show where selling went instead: the
 * firms read from the relays, with no wallet list and no field to sell with.
 * Signing in still works, for sellers who are still owed and for the admins.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { AuthProvider } from '@/contexts/AuthContext';
import Login from './Login';
import Index from './Index';
import { TWO_FIRMS, stubFetch } from '@/test/buyingDealersFixture';

const KROG = TWO_FIRMS.buyers[0];
const RAVENA = TWO_FIRMS.buyers[1];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

const expectBothFirms = async () => {
  const list = await screen.findByTestId('buying-dealers');
  expect(within(list).getByText(KROG.name)).toBeInTheDocument();
  expect(within(list).getByText(RAVENA.name)).toBeInTheDocument();
  expect(within(list).getAllByRole('link', { name: 'Register or sign in' }).map(a => a.getAttribute('href')))
    .toEqual(['https://krogmenjave.com/prijava', 'https://ravenaplus.com/prijava']);
};

describe('/offer, where other apps still send people to sell', () => {
  for (const path of ['/offer', '/offer?ref=OFF-2026-113', '/sell']) {
    it(`${path} names the firms and has nothing to sell with`, async () => {
      stubFetch(TWO_FIRMS);
      window.history.pushState({}, '', path);
      const { container } = render(<App />);
      await expectBothFirms();
      expect(container.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
      expect(container.textContent).not.toMatch(/WIF/);
      expect(screen.queryByText('Select the wallet you are offering from')).not.toBeInTheDocument();
      expect(window.location.pathname).toBe('/offer');
    });
  }
});

describe('the sign-in page', () => {
  it('says first where selling went, then keeps the sign-in for what is still owed', async () => {
    stubFetch(TWO_FIRMS, url => (url.includes('/api/relays') ? { relays: ['wss://relay.test'] } : {}));
    const { container } = render(<AuthProvider><MemoryRouter><Login /></MemoryRouter></AuthProvider>);
    await expectBothFirms();
    const notice = screen.getByTestId('selling-moved');
    const form = container.querySelector('form')!;
    // Above the form, in the page's order.
    expect(notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(notice).getByText(/Sign in below to see what we still owe you\./)).toBeInTheDocument();
    expect(screen.getByText(/Signing in is only for seeing the LANA you have already sold here/)).toBeInTheDocument();
    // The sign-in itself is untouched: one key field, one button.
    expect(within(form).getByLabelText('WIF Private Key')).toHaveAttribute('type', 'password');
    expect(within(form).getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('in Slovenian, the notice and the form together', async () => {
    stubFetch(TWO_FIRMS);
    const { container } = render(<AuthProvider><MemoryRouter><Login /></MemoryRouter></AuthProvider>);
    await expectBothFirms();
    fireEvent.click(screen.getByRole('button', { name: 'SL' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toBe(`Odkup LAN sta prevzeli podjetji ${KROG.name} in ${RAVENA.name}`));
    expect(screen.getByText(/Spodaj se prijavite in poglejte, kaj vam še dolgujemo\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Prijava' })).toBeInTheDocument();
    const form = container.querySelector('form')!;
    expect(within(form).getByLabelText('Zasebni ključ WIF')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Prijava' })).toBeInTheDocument();
  });
});

describe('the landing page', () => {
  it('opens on where selling went, invites no offer, and keeps what we owe', async () => {
    // The boards' own sources are down here: they are not what is tested.
    stubFetch(TWO_FIRMS, () => undefined);
    const { container } = render(<MemoryRouter><Index /></MemoryRouter>);
    await expectBothFirms();
    expect(screen.queryByRole('link', { name: 'Submit an Offer' })).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/offer"]')).toBeNull();
    // The sections that describe selling to us are gone…
    expect(container.textContent).not.toContain('Holders may submit an offer');
    expect(screen.queryByText('How an acquisition works')).not.toBeInTheDocument();
    expect(screen.queryByText('What we acquire')).not.toBeInTheDocument();
    expect(container.querySelector('#how-we-acquire')).toBeNull();
    // …and what we owe and what we settled are still there.
    expect(screen.getByText('Outstanding purchase-price settlements')).toBeInTheDocument();
    expect(screen.getByText('Completed treasury acquisitions')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See what we owe' })).toHaveAttribute('href', '#settlements');
  });
});
