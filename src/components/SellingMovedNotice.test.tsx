/**
 * "NAPIŠI, DA STA ODKUP LAN PREVZELI FIRME KROG MENJAVE ALI RAVENA PLUS (BERI
 * IZ RELAYJEV) IN NAJ SE UPORABNIKI PRI ENEM OD PODJETIJ REGISTRIRAJO."
 *   — Brilly, 8 Oct 2026
 *
 * The notice names the firms the server read from the relays — never a name
 * written into the page — in Slovenian and in English, each with the page where
 * a person registers and the page where they sell. With no firm known it still
 * says selling here is closed and links to the list on BEF Explorer. It never
 * offers a form.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { SellingMovedNotice } from './SellingMovedNotice';
import { readBuyingDealers } from '@/lib/sellingClosed';
import { TWO_FIRMS, NO_FIRM, stubFetch } from '@/test/buyingDealersFixture';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const KROG = TWO_FIRMS.buyers[0];
const RAVENA = TWO_FIRMS.buyers[1];

describe('the two firms, read from the relays', () => {
  it('names both, in English, with where to register and where to sell', async () => {
    stubFetch(TWO_FIRMS);
    render(<SellingMovedNotice />);
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading.textContent).toBe(
      `The purchase of LANA has been taken over by ${KROG.name} and ${RAVENA.name}`,
    ));
    expect(screen.getByText(/LANA can no longer be sold on Lana\.discount\./)).toBeInTheDocument();
    expect(screen.getByText(/register with one of the two companies/)).toBeInTheDocument();
    const list = screen.getByTestId('buying-dealers');
    for (const firm of [KROG, RAVENA]) {
      const card = within(list).getByText(firm.name).closest('li')!;
      expect(within(card).getByRole('link', { name: 'Register or sign in' })).toHaveAttribute('href', firm.registerUrl);
      expect(within(card).getByRole('link', { name: 'Sell LANA' })).toHaveAttribute('href', firm.sellUrl);
    }
  });

  it('and in Slovenian, in the owner’s words', async () => {
    stubFetch(TWO_FIRMS);
    render(<SellingMovedNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'SL' }));
    const heading = screen.getByRole('heading', { level: 1 });
    await waitFor(() => expect(heading.textContent).toBe(
      `Odkup LAN sta prevzeli podjetji ${KROG.name} in ${RAVENA.name}`,
    ));
    expect(screen.getByText(/Na Lana\.discount LAN ni več mogoče prodati\./)).toBeInTheDocument();
    expect(screen.getByText(/se registrirajte pri enem od obeh podjetij\./)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Registracija in prijava' }).map(a => a.getAttribute('href')))
      .toEqual([KROG.registerUrl, RAVENA.registerUrl]);
    expect(screen.getAllByRole('link', { name: 'Prodaj LANE' }).map(a => a.getAttribute('href')))
      .toEqual([KROG.sellUrl, RAVENA.sellUrl]);
    expect(screen.getByRole('link', { name: 'Prijavite se in poglejte, kaj vam še dolgujemo.' })).toHaveAttribute('href', '/login');
  });

  it('agrees the Slovenian verb with one firm', async () => {
    stubFetch({ ...TWO_FIRMS, buyers: [RAVENA] });
    render(<SellingMovedNotice lang="sl" onLangChange={() => {}} />);
    const heading = screen.getByRole('heading', { level: 1 });
    await waitFor(() => expect(heading.textContent).toBe(`Odkup LAN je prevzelo podjetje ${RAVENA.name}`));
    expect(screen.getByText(/se registrirajte pri tem podjetju\./)).toBeInTheDocument();
  });

  it('ends the sentence once: a name ending in "d.o.o." gets no second full stop, any other name gets one', async () => {
    expect(RAVENA.name.endsWith('.')).toBe(true);
    stubFetch({ ...TWO_FIRMS, buyers: [{ ...RAVENA, name: 'Ravena Plus' }] });
    render(<SellingMovedNotice />);
    const heading = screen.getByRole('heading', { level: 1 });
    await waitFor(() => expect(heading.textContent).toBe('The purchase of LANA has been taken over by Ravena Plus.'));
  });

  it('a stale list is still the last good list, and is shown', async () => {
    stubFetch({ ...TWO_FIRMS, status: 'stale', staleSince: '2026-10-08T13:00:00.000Z' });
    render(<SellingMovedNotice />);
    const list = await screen.findByTestId('buying-dealers');
    expect(within(list).getByText(KROG.name)).toBeInTheDocument();
    expect(within(list).getByText(RAVENA.name)).toBeInTheDocument();
  });
});

describe('when no firm can be named', () => {
  for (const [why, answer] of [['the relays could not be read', NO_FIRM], ['the request failed', 'fail']] as const) {
    it(`${why}: selling here is still closed, and the list on BEF Explorer is linked`, async () => {
      stubFetch(answer);
      render(<SellingMovedNotice />);
      const link = await screen.findByRole('link', { name: 'Companies on BEF Explorer' });
      expect(link).toHaveAttribute('href', 'https://befexplorer.com/companies');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The purchase of LANA has been taken over by other companies.');
      expect(screen.getByText(/LANA can no longer be sold on Lana\.discount\./)).toBeInTheDocument();
      expect(screen.queryByTestId('buying-dealers')).not.toBeInTheDocument();
    });
  }

  it('while the first read is still on its way, it says so — and already says selling is closed', () => {
    stubFetch('hang');
    render(<SellingMovedNotice />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading the companies from the Lana relays…');
    expect(screen.getByText(/LANA can no longer be sold on Lana\.discount\./)).toBeInTheDocument();
  });

  it('in Slovenian too', async () => {
    stubFetch(NO_FIRM);
    render(<SellingMovedNotice lang="sl" onLangChange={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Podjetja na BEF Explorerju' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Odkup LAN so prevzela druga podjetja.');
  });
});

describe('what the notice never does', () => {
  it('offers no form, no field and no key', async () => {
    stubFetch(TWO_FIRMS);
    const { container } = render(<SellingMovedNotice />);
    await screen.findByTestId('buying-dealers');
    expect(container.querySelectorAll('form, input, textarea, select')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/WIF|private key/i);
  });

  it('shows no firm whose links leave its own https host', () => {
    const answer = readBuyingDealers({
      ...TWO_FIRMS,
      buyers: [
        KROG,
        { ...RAVENA, registerUrl: 'javascript:alert(1)' },
        { ...RAVENA, slug: 'x', sellUrl: 'https://elsewhere.test/ko-kreacija/prodaj' },
        { ...RAVENA, slug: 'y', website: 'http://ravenaplus.com/' },
        { ...RAVENA, slug: 'z', name: '' },
      ],
    });
    expect(answer.buyers.map(b => b.slug)).toEqual(['krog-menjave']);
    expect(readBuyingDealers('nonsense')).toEqual(NO_FIRM);
  });
});
