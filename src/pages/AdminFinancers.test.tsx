/**
 * /admin/financers — ONE CARD PER FINANCER, ONE ROW PER STEP, STEP 4 DRAWN STRONGEST.
 *
 * Pinned: the page asks the signed overview route; every financer the server names gets a card (a name, else a short
 * hex — never an npub); step 4 (what they must send now) is the highlighted row; a step that has waited over a day
 * says so; txids link to the explorer; a Direct.Fund that could not be read is said, not hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminFinancers, { ageText, lanaText, parseAt, type OverviewResponse } from './AdminFinancers';

const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'c'.repeat(64), profileDisplayName: 'Admin' },
  isLoading: false,
  isAdmin: true,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const BORIS = '816b8dcf'.padEnd(64, '1');
const GORAZD = '4af96237'.padEnd(64, '2');
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3_600_000;
const none = () => ({ purchases: 0, legs: 0, lana: {}, oldestAt: null });

const financer = (hex: string, over: Record<string, unknown> = {}) => ({
  hex,
  name: null,
  isFinancer: true,
  dfUnavailable: false,
  wallets: { EUR: 'LBorisEurWallet' },
  stages: {
    toPayOnDf: { ...none(), purchases: 1, legs: 2, lana: { EUR: '250000000' }, oldestAt: at(-2 * HOUR),
      batches: [{ batchRef: '2026003001', status: 'open', currency: 'EUR', totalAmount: 25, purchases: 1, createdAt: at(-2 * HOUR), closedAt: null, paidAt: null, held: false }] },
    toConfirm: { ...none(), batches: [] },
    waitingApproval: { ...none(), withoutLegs: 0, waitingOn: null, waitingOnPartial: false },
    toSend: { purchases: 2, legs: 3, lana: { EUR: '570000000', GBP: '10000000' }, oldestAt: at(-30 * HOUR), wallets: 2, oldestApprovedAt: at(-26 * HOUR), ownerMismatch: 0 },
    onTheWay: { purchases: 1, legs: 1, lana: { EUR: '600000000' }, oldestAt: at(-1 * HOUR),
      sends: [{ txid: 'a'.repeat(64), state: 'mempool', walletId: 'LFrom', legs: 1, lanoshis: '600000000', since: at(-1 * HOUR) }] },
  },
  unowned: none(),
  lastConfirmedSend: { txid: 'b'.repeat(64), at: at(-5 * HOUR) },
  ...over,
});

let body: OverviewResponse;
const urls: string[] = [];
const reply = (value: unknown) =>
  new Promise<Response>(resolve => setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve(value) } as Response), 0));

beforeEach(() => {
  urls.length = 0;
  body = {
    generatedAt: new Date().toISOString(),
    dfUnavailable: false,
    financers: [
      financer(BORIS, { name: 'Boris d.o.o.' }),
      financer(GORAZD, {
        dfUnavailable: true, wallets: null, isFinancer: null,
        stages: { ...financer(GORAZD).stages, toPayOnDf: null, toConfirm: null,
          toSend: { ...none(), wallets: 0, oldestApprovedAt: null, ownerMismatch: 0 }, onTheWay: { ...none(), sends: [] } },
        lastConfirmedSend: null,
      }),
    ],
    unowned: { ...none(), withoutFinancer: none() },
  } as unknown as OverviewResponse;
  body.dfUnavailable = true;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = String(url);
    urls.push(path);
    if (path.includes('/admin/financers-overview')) return reply(body);
    if (path.includes('/profiles')) return reply({ names: {} });
    return reply({ offers: [] });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const show = () => render(<MemoryRouter><AdminFinancers /></MemoryRouter>);
const card = async (hex: string) => {
  await waitFor(() => expect(document.querySelector(`[data-financer="${hex}"]`)).not.toBeNull());
  return document.querySelector(`[data-financer="${hex}"]`) as HTMLElement;
};

describe('AdminFinancers', () => {
  it('asks the overview route, and draws one card per financer: a name, else a short hex', async () => {
    show();
    const boris = await card(BORIS);
    expect(urls.some(u => u.includes('/api/admin/financers-overview'))).toBe(true);
    expect(within(boris).getByRole('heading', { name: 'Boris d.o.o.' })).toBeInTheDocument();
    const gorazd = await card(GORAZD);
    expect(within(gorazd).getByRole('heading', { name: `${GORAZD.slice(0, 8)}…${GORAZD.slice(-6)}` })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/npub1/);
  });

  it('highlights step 4 — what they must send now — with its LANA per currency, and an age over 24 h', async () => {
    show();
    const boris = await card(BORIS);
    const step4 = boris.querySelector('[data-stage="4"]') as HTMLElement;
    expect(step4.className).toContain('border-primary');
    expect(step4.textContent).toContain('Approved, to send now');
    expect(step4.textContent).toContain('2 purchases · 3 legs');
    expect(step4.textContent).toContain('5.7 LANA (EUR) · 0.1 LANA (GBP)');
    expect(step4.textContent).toContain('over 24 h');
    expect(step4.textContent).toContain('to 2 wallets');
  });

  it('lists batch refs, links txids to the explorer, and says when Direct.Fund could not be read', async () => {
    show();
    const boris = await card(BORIS);
    expect(boris.querySelector('[data-stage="1"]')?.textContent).toContain('2026003001');
    const link = within(boris).getAllByRole('link').find(a => a.getAttribute('href')?.includes('a'.repeat(64)));
    expect(link).toHaveAttribute('href', `https://chainz.cryptoid.info/lana/tx.dws?${'a'.repeat(64)}`);
    const gorazd = await card(GORAZD);
    expect(gorazd.querySelector('[data-stage="1"]')?.textContent).toContain('Direct.Fund could not be read');
    expect(gorazd.querySelector('[data-stage="4"]')?.getAttribute('data-empty')).toBe('true');
    expect(screen.getByText(/Direct.Fund could not be read for every financer/)).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('reads SQLite times as UTC, and words ages', () => {
    expect(parseAt('2026-10-12 08:00:00')).toBe(Date.parse('2026-10-12T08:00:00Z'));
    expect(parseAt(null)).toBeNull();
    const now = Date.parse('2026-10-12T08:00:00Z');
    expect(ageText('2026-10-12 07:30:00', now)).toBe('30 min');
    expect(ageText('2026-10-11 06:00:00', now)).toBe('1 d 2 h');
  });
  it('writes lanoshis as LANA per currency', () => {
    expect(lanaText({ GBP: '10000000', EUR: '123456700000' })).toBe('1,234.57 LANA (EUR) · 0.1 LANA (GBP)');
    expect(lanaText({})).toBe('—');
  });
});
