/**
 * /admin/mandates — A FINANCER THAT IS A COMPANY (owner, 11 Nov 2026).
 *
 * Pinned: a financer with a verified company is shown as the company — a link
 * to its own site, built from the host Direct.Fund verified and nothing else —
 * with the person under it as its representative and the key as before. A
 * mandate has no date of its own (it is whose the mandate is now), so it is the
 * company as it is now; the dialogs say the same. A financer without one, or a
 * Direct.Fund that does not answer, is the person exactly as before. The export
 * keeps "Financer" and "Nostr hex" and gains "Company".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminMandates from './AdminMandates';
import { ADMIN_MANDATES } from '@/copy';
import { FINANCER_COMPANIES_URL, forgetFinancerCompanies, loadFinancerCompanies } from '@/lib/financerCompanies';
import { downloadSpreadsheet } from '@/lib/spreadsheet';

const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'c'.repeat(64), profileDisplayName: 'Admin' },
  isLoading: false,
  isAdmin: true,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/spreadsheet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/spreadsheet')>()),
  downloadSpreadsheet: vi.fn(),
}));

const BORIS = '816b8dcf'.padEnd(64, '1');
const GORAZD = '4af96237'.padEnd(64, '2');
const KROG = 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.';

const mandate = (hex: string) => ({
  mandateRef: `MR-${hex.slice(0, 6)}`,
  eventId: hex.slice(0, 8).padEnd(64, 'e'),
  status: 'announced',
  split: 8,
  round: 1,
  financerHex: hex,
  wallets: [{ address: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', currency: 'EUR', fundSettingId: '1', lanaReceived: 1000, onchainLana: 1000, balanceUnavailable: false }],
  currencies: ['EUR'],
  expectedLana: 1000, unsoldLana: 1000, unsoldSellable: true, proposedLana: 0, acceptedLana: 0, settledLana: 0, remainingLana: 1000,
  money: [{ currency: 'EUR', lana: 1000, paidIn: 100, payout: 120, returnPercent: 20, modelReturnPercent: 20, offModel: false }],
  state: 'open',
  opensAt: '2026-09-10T08:00:00Z',
  discountPercent: 30,
  released: null,
  restricted: null,
  warnings: [],
  offers: [],
});

const mandates = {
  split: 8,
  currentSplit: 8,
  lastSyncAt: '2026-11-11 10:00:00',
  degraded: { noEvents: false, noTerms: false, splitUnknown: false, staleSync: false, balancesPartial: false },
  totals: { expectedLana: 2000, remainingLana: 2000, proposedLana: 0, acceptedLana: 0, settledLana: 0 },
  rounds: [{ round: 1, opensAt: '2026-09-10T08:00:00Z', discountPercent: 30 }],
  funding: [{ round: 1, mandateCount: 2, modelReturnPercent: 20, currencies: [], totalsByCurrency: {} }],
  settlementCounts: { all: 2, none: 2, partly: 0, paid: 0, owedLana: 2000 },
  mandates: [mandate(BORIS), mandate(GORAZD)],
  updated_at: '2026-11-11T10:00:00Z',
};

/** Direct.Fund's company list: null = not there yet (404), 'down' = no answer at all. */
let companies: unknown = null;
const listCompany = () => {
  companies = {
    companies: [{
      hex: BORIS, name: KROG, registrationNumber: '7593074000', taxNumber: '88629830', country: 'SI',
      host: 'krogmenjave.com', website: 'https://krogmenjave.com/', since: '2026-10-08T23:50:00Z',
    }],
    checkedAt: '2026-11-11T10:00:00Z',
  };
};

beforeEach(() => {
  forgetFinancerCompanies();
  companies = null;
  vi.mocked(downloadSpreadsheet).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
    const path = String(url);
    if (path === FINANCER_COMPANIES_URL) {
      if (companies === 'down') throw new TypeError('Failed to fetch');
      return companies ? reply(companies) : reply({ error: 'Not found' }, 404);
    }
    if (path.startsWith('/api/treasury/admin/mandates')) return reply(mandates);
    if (path === '/api/users/profiles') return reply({ names: { [BORIS]: 'Boris', [GORAZD]: 'Gorazd' } });
    throw new Error(`unexpected ${path}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const draw = () => render(<MemoryRouter><AdminMandates /></MemoryRouter>);
/** The row of a financer's mandate, found by the key it shows. */
const rowOf = async (hex: string) => (await screen.findByTitle(hex)).closest('tr') as HTMLElement;

/** The cells of every row of the exported sheet, as text. */
const sheetRows = (xml: string) =>
  [...xml.matchAll(/<Row>([\s\S]*?)<\/Row>/g)].map(r =>
    [...r[1].matchAll(/<Cell\/>|<Cell><Data ss:Type="\w+">([\s\S]*?)<\/Data><\/Cell>/g)].map(c => c[1] ?? ''));

describe('a financer that is a company', () => {
  it('the row names the company — a link to its own site — with the person under it as its representative, and the key as before', async () => {
    listCompany();
    draw();
    const boris = await rowOf(BORIS);
    const link = await within(boris).findByRole('link', { name: /Krog menjave/ });
    expect(link).toHaveAttribute('href', 'https://krogmenjave.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(link).toHaveTextContent(`${KROG} krogmenjave.com`);
    expect(await within(boris).findByText('representative: Boris')).toBeInTheDocument();
    expect(within(boris).getByTitle(BORIS)).toHaveTextContent(`${BORIS.slice(0, 12)}…`);
    // A financer without a company: the person, exactly as before.
    const gorazd = await rowOf(GORAZD);
    expect(await within(gorazd).findByText('Gorazd')).toBeInTheDocument();
    expect(within(gorazd).queryByRole('link')).toBeNull();
    expect(within(gorazd).queryByText(/representative/)).toBeNull();
  });

  it('the restrict and the release dialogs name the same company, with the same representative', async () => {
    listCompany();
    draw();
    const boris = await rowOf(BORIS);
    await within(boris).findByText('representative: Boris');
    fireEvent.click(within(boris).getByRole('button', { name: ADMIN_MANDATES.restrictNow }));
    const restrict = screen.getByRole('heading', { name: ADMIN_MANDATES.restrictTitle }).parentElement as HTMLElement;
    expect(within(restrict).getByRole('link', { name: /Krog menjave/ })).toHaveAttribute('href', 'https://krogmenjave.com/');
    expect(within(restrict).getByText('representative: Boris')).toBeInTheDocument();
    fireEvent.click(within(restrict).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(boris).getByRole('button', { name: ADMIN_MANDATES.releaseNow }));
    const release = screen.getByRole('heading', { name: ADMIN_MANDATES.releaseTitle }).parentElement as HTMLElement;
    expect(within(release).getByRole('link', { name: /Krog menjave/ })).toHaveAttribute('href', 'https://krogmenjave.com/');
    expect(release).toHaveTextContent(`Round 1 · ${KROG} krogmenjave.com representative: Boris ·`);
    expect(release).toHaveTextContent(/· [\d.,\s]+ LANA remaining/);
  });

  it('the export keeps "Financer" and "Nostr hex" and adds "Company": the company as the row shows it, empty without one', async () => {
    listCompany();
    draw();
    const boris = await rowOf(BORIS);
    await within(boris).findByRole('link', { name: /Krog menjave/ });
    await within(boris).findByText('representative: Boris');
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MANDATES.exportCta }));
    expect(downloadSpreadsheet).toHaveBeenCalledTimes(1);
    const rows = sheetRows(vi.mocked(downloadSpreadsheet).mock.calls[0][1]);
    expect(rows[0].slice(0, 4)).toEqual(['Financer', 'Nostr hex', 'Company', 'Split']);
    expect(rows[1].slice(0, 3)).toEqual(['Boris', BORIS, KROG]);
    expect(rows[2].slice(0, 3)).toEqual(['Gorazd', GORAZD, '']);
  });

  it('Direct.Fund not answering: the person, as before — no blank, no error — and the export’s Company column is empty', async () => {
    companies = 'down';
    const { toast } = await import('sonner');
    vi.mocked(toast.error).mockClear();
    draw();
    const boris = await rowOf(BORIS);
    expect((await loadFinancerCompanies()).size).toBe(0);
    await waitFor(() => expect(within(boris).getByText('Boris')).toBeInTheDocument());
    expect(within(boris).queryByRole('link')).toBeNull();
    expect(screen.queryByText(/representative/)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MANDATES.exportCta }));
    const rows = sheetRows(vi.mocked(downloadSpreadsheet).mock.calls[0][1]);
    expect(rows[0].slice(0, 3)).toEqual(['Financer', 'Nostr hex', 'Company']);
    expect(rows[1].slice(0, 3)).toEqual(['Boris', BORIS, '']);
  });
});
