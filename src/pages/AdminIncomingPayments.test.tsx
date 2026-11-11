/**
 * NO "CONFIRM RECEIVED" ON THIS PAGE.
 *
 * Owner, 8 Oct 2026: a financer's Lana Discount share is internal — they pay
 * themselves, confirm on /financer and send the LANA from their own wallet.
 * On 20 Oct 2026 an administrator confirmed another financer's batch here and
 * the Lana.Discount account's wallet paid what that financer owed; owner,
 * 21 Oct 2026: not possible through this page any more. So:
 *   - an incoming batch has no button to confirm it, only who confirms it;
 *   - a batch a financer settles shows who settles it, its legs 'Sending' while
 *     a signed send waits for a block, and none of the treasury's buttons.
 *
 * Owner, 11 Nov 2026: where the financer is a company, who paid a batch, who
 * settles it and who sends its legs name the company — from the company's
 * `since` on, by the batch's date — with the person as its representative.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminIncomingPayments from './AdminIncomingPayments';
import { FINANCER_COMPANIES_URL, forgetFinancerCompanies, loadFinancerCompanies } from '@/lib/financerCompanies';

const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'c'.repeat(64), profileDisplayName: 'Admin' },
  isLoading: false,
  isAdmin: true,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const FINANCER_HEX = 'f1'.repeat(32);

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o-1',
  transactionRef: 'TX-1',
  investorHex: FINANCER_HEX,
  fundSettingId: 7,
  budgetNote: '',
  amountFiat: 243.89,
  currency: 'EUR',
  orderType: 'lana_purchase',
  paymentType: 'cash',
  destinationType: 'lana_discount',
  destinationName: null,
  recipientWallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB',
  recipientHex: null,
  shopName: 'Shop',
  receiptUrl: null,
  receiptType: null,
  receiptDescription: null,
  status: 'confirmed',
  lanaTxHash: null,
  rpcVerified: false,
  ppConfirmed: true,
  ppId: 1,
  batchId: 11,
  batchRef: '2026002293',
  batchStatus: 'paid',
  discountStatus: null,
  createdAt: '2026-10-08 09:00:00',
  ...over,
});

let feed: Record<string, unknown> = {};
let puts: Array<{ url: string; body: any }> = [];
let heartbeat: Record<string, unknown> = {};
let heartbeatReads = 0;
let rearms: Array<{ body: any; authorization: string | null }> = [];
let rearmReply: { status: number; body: unknown } = { status: 200, body: { ok: true } };
/** What the signed admin route GET /api/admin/brain-callbacks answers, and each time it was asked. */
let adminLists: Record<string, unknown> = {};
let listReads: Array<{ authorization: string | null }> = [];
/** Direct.Fund's company list: null = not there yet (404), 'down' = no answer at all. */
let companies: unknown = null;
/** The financer's own name, as their profile gives it. */
let profileName = 'Firma d.o.o.';

beforeEach(() => {
  forgetFinancerCompanies();
  companies = null;
  profileName = 'Firma d.o.o.';
  puts = [];
  heartbeat = { nextAutoSendMin: 3, nextHeartbeatSec: 30 };
  heartbeatReads = 0;
  rearms = [];
  rearmReply = { status: 200, body: { ok: true } };
  adminLists = { gaveUpKeys: [], waitingOver7dKeys: [], ownerMismatchRefs: [] };
  listReads = [];
  feed = { orders: [order()], lanaOrders: [], localBatches: [], buybackBalance: { wallet: '', balanceLana: 0 }, lanaObligations: { pendingLanoshis: 0, sentLanoshis: 0 } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as any;
      if (url === FINANCER_COMPANIES_URL) {
        if (companies === 'down') throw new TypeError('Failed to fetch');
        return companies ? reply(companies) : reply({ error: 'Not found' }, 404);
      }
      if (url === '/api/admin/incoming-payments') return reply(feed);
      if (url === '/api/admin/reference-rates') return reply({ exchangeRates: { EUR: 0.01 } });
      if (url === '/api/heartbeat-status') { heartbeatReads++; return reply(heartbeat); }
      if (url === '/api/acquisitions/admin/queue') return reply({ offers: [] });
      if (String(url).startsWith('/api/user/')) return reply({ fullName: profileName });
      if (method === 'GET' && url === '/api/admin/brain-callbacks') {
        listReads.push({ authorization: new Headers(init.headers).get('Authorization') });
        return reply(adminLists);
      }
      if (method === 'POST' && url === '/api/admin/brain-callbacks/rearm') {
        rearms.push({ body: JSON.parse(init.body), authorization: new Headers(init.headers).get('Authorization') });
        return reply(rearmReply.body, rearmReply.status);
      }
      if (method === 'PUT' && String(url).startsWith('/api/admin/incoming-batches/')) {
        puts.push({ url: String(url), body: JSON.parse(init.body) });
        return reply({ success: true, batch: {} });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const draw = () => render(<MemoryRouter><AdminIncomingPayments /></MemoryRouter>);

describe('an incoming batch', () => {
  it('has no Confirm Received button — the financer confirms it on /financer — and nothing is sent', async () => {
    draw();
    expect(await screen.findByTestId('financer-confirms-2026002293')).toHaveTextContent('the financer confirms it on /financer');
    expect(screen.queryByRole('button', { name: 'Confirm Received' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toEqual([]);
  });

  it('a batch a financer already settles says so', async () => {
    feed = {
      ...feed,
      lanaOrders: [
        { id: 'leg-1', transactionRef: 'TX-1', orderType: 'customer_cashback', toWallet: 'L1', toHex: 'a', lanaAmount: 1_004_492_188, fiatValue: 1, currency: 'EUR', exchangeRate: 0.01, txHash: null, status: 'pending', brainAuthorized: false, batchRef: null, createdAt: '2026-10-08 09:00:00', settledBy: 'financer', settlementOwnerHex: FINANCER_HEX, sendTxid: null },
      ],
    };
    draw();
    expect(await screen.findByTestId('settled-by-2026002293')).toHaveTextContent(/Financer settles/);
    expect(screen.queryByRole('button', { name: 'Confirm Received' })).toBeNull();
    expect(screen.getByText('confirmed by the financer on /financer')).toBeInTheDocument();
  });
});

describe('a financer’s batch on its way', () => {
  it('shows who sends each leg, a leg in a signed send as Sending with its transaction, and none of the treasury’s buttons', async () => {
    const sendTxid = 'ab'.repeat(32);
    feed = {
      ...feed,
      localBatches: [
        { id: 11, batchRef: '2026002293', investorHex: FINANCER_HEX, totalAmount: 243.89, currency: 'EUR', paymentCount: 1, status: 'received', receivedAt: '2026-10-08 10:00:00', lanaBoughtAt: null, lanaSentAt: null, lanaTxHash: null, notes: null, createdAt: '2026-10-08 10:00:00', settledBy: 'financer' },
      ],
      lanaOrders: [
        { id: 'leg-1', transactionRef: 'TX-1', orderType: 'customer_cashback', toWallet: 'L1', toHex: 'a', lanaAmount: 1_004_492_188, fiatValue: 1, currency: 'EUR', exchangeRate: 0.01, txHash: null, status: 'sending', brainAuthorized: true, batchRef: '2026002293', createdAt: '2026-10-08 09:00:00', settledBy: 'financer', settlementOwnerHex: FINANCER_HEX, sendTxid },
        { id: 'leg-2', transactionRef: 'TX-1', orderType: 'caretaker_commission', toWallet: 'L2', toHex: 'b', lanaAmount: 3_446_289_063, fiatValue: 1, currency: 'EUR', exchangeRate: 0.01, txHash: null, status: 'pending', brainAuthorized: false, batchRef: '2026002293', createdAt: '2026-10-08 09:00:00', settledBy: 'financer', settlementOwnerHex: FINANCER_HEX, sendTxid: null },
      ],
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Awaiting LANA/ }));
    const badge = await screen.findByTestId('settled-by-2026002293');
    expect(badge).toHaveTextContent('Financer settles · Firma d.o.o.');
    // The brain has not approved leg-2, but this is the financer's batch: no "Release by hand", no "Send now".
    expect(screen.queryByRole('button', { name: 'Release by hand' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(screen.getByText(/1 sending/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('2026002293'));
    expect(await screen.findByTestId('leg-status-leg-1')).toHaveTextContent('Sending');
    expect(screen.getByTestId('leg-owner-leg-1')).toHaveTextContent('by financer Firma d.o.o.');
    const link = screen.getByRole('link', { name: `${sendTxid.slice(0, 8)}...` });
    expect(link).toHaveAttribute('href', `https://chainz.cryptoid.info/lana/tx.dws?${sendTxid}`);
  });
});

describe('the financer’s company (owner, 11 Nov 2026)', () => {
  const KROG = 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.';
  const listCompany = () => {
    companies = {
      companies: [{
        hex: FINANCER_HEX, name: KROG, registrationNumber: '7593074000', taxNumber: '88629830', country: 'SI',
        host: 'krogmenjave.com', website: 'https://krogmenjave.com/', since: '2026-10-08T23:50:00Z',
      }],
      checkedAt: '2026-11-11T10:00:00Z',
    };
  };
  const leg = (over: Record<string, unknown>) => ({
    transactionRef: 'TX-1', toHex: 'a'.repeat(64), lanaAmount: 1_000_000_000, fiatValue: 1, currency: 'EUR', exchangeRate: 0.01,
    txHash: null, status: 'pending', brainAuthorized: true, batchRef: '2026002293', createdAt: '2026-10-09 09:00:00',
    settledBy: 'financer', settlementOwnerHex: FINANCER_HEX, sendTxid: null, ...over,
  });
  /** One batch of the financer's, confirmed by them on /financer, its purchase made at `at` — and its caretaker is the financer too. */
  const onTheWay = (at: string) => {
    feed = {
      ...feed,
      orders: [order({ createdAt: at })],
      localBatches: [
        { id: 11, batchRef: '2026002293', investorHex: FINANCER_HEX, totalAmount: 243.89, currency: 'EUR', paymentCount: 1, status: 'received', receivedAt: '2026-10-09 10:00:00', lanaBoughtAt: null, lanaSentAt: null, lanaTxHash: null, notes: null, createdAt: '2026-10-09 10:00:00', settledBy: 'financer' },
      ],
      lanaOrders: [
        leg({ id: 'leg-1', orderType: 'customer_cashback', toWallet: 'LBuyerWa11etAAAAAAAAAAAAAAAAAAAAAA', createdAt: at }),
        leg({ id: 'leg-2', orderType: 'caretaker_commission', toWallet: 'LCaretakerWa11etBBBBBBBBBBBBBBBBBB', toHex: FINANCER_HEX, createdAt: at }),
      ],
    };
  };
  const krogLinks = () => screen.queryAllByRole('link', { name: /Krog menjave/ });

  it('a batch from the company’s time names it as who paid, who settles and who sends each leg — the person as its representative — and never renames where a leg goes', async () => {
    listCompany();
    profileName = 'Boris';
    onTheWay('2026-10-09 09:00:00');
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Awaiting LANA/ }));
    const badge = await screen.findByTestId('settled-by-2026002293');
    const settles = await within(badge).findByRole('link', { name: /Krog menjave/ });
    expect(badge).toHaveTextContent(`Financer settles · ${KROG} krogmenjave.com`);
    expect(badge.getAttribute('title')).toContain('representative: Boris');
    expect(settles).toHaveAttribute('href', 'https://krogmenjave.com/');
    expect(settles).toHaveAttribute('target', '_blank');
    expect(settles).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(settles).toHaveAttribute('referrerpolicy', 'no-referrer');
    // Who paid it: the company, the person beside it.
    await waitFor(() => expect(krogLinks()).toHaveLength(2));
    expect(screen.getByText('representative: Boris')).toBeInTheDocument();

    fireEvent.click(screen.getByText('2026002293'));
    const sender = await screen.findByTestId('leg-owner-leg-1');
    expect(sender).toHaveTextContent(`by financer ${KROG}`);
    expect(sender).toHaveAttribute('title', `representative: Boris · ${FINANCER_HEX}`);
    expect(screen.getByTestId('leg-owner-leg-2')).toHaveTextContent(`by financer ${KROG}`);
    // The caretaker of this purchase is the financer: the leg TO them is still their wallet, never the company.
    expect(screen.getByTitle('LCaretakerWa11etBBBBBBBBBBBBBBBBBB')).toHaveTextContent('→ LCaretak...BBBBBB');
    expect(screen.getByTitle('LBuyerWa11etAAAAAAAAAAAAAAAAAAAAAA')).toHaveTextContent('→ LBuyerWa...AAAAAA');
    expect(krogLinks()).toHaveLength(4);
    for (const a of krogLinks()) expect(a).toHaveAttribute('href', 'https://krogmenjave.com/');
  });

  it('a batch from before the company’s `since` keeps the person everywhere, beside one of the same financer’s from that moment on', async () => {
    listCompany();
    profileName = 'Boris';
    feed = {
      ...feed,
      orders: [
        order({ id: 'o-old', transactionRef: 'TX-OLD', batchRef: '2026002201', batchId: 10, ppId: 7, createdAt: '2026-10-08 23:49:00' }),
        order({ id: 'o-new', transactionRef: 'TX-1', batchRef: '2026002293', createdAt: '2026-10-08 23:50:00' }),
      ],
      lanaOrders: [
        leg({ id: 'leg-old', transactionRef: 'TX-OLD', orderType: 'customer_cashback', toWallet: 'L1', batchRef: '2026002201', createdAt: '2026-10-08 23:49:00' }),
        leg({ id: 'leg-new', transactionRef: 'TX-1', orderType: 'customer_cashback', toWallet: 'L2', createdAt: '2026-10-08 23:50:00' }),
      ],
    };
    draw();
    const newBadge = await screen.findByTestId('settled-by-2026002293');
    await within(newBadge).findByRole('link', { name: /Krog menjave/ });
    const newBatch = newBadge.closest('div.rounded-xl') as HTMLElement;
    expect(within(newBatch).getByText('representative: Boris')).toBeInTheDocument();

    const oldBadge = screen.getByTestId('settled-by-2026002201');
    expect(oldBadge).toHaveTextContent('Financer settles · Boris');
    expect(within(oldBadge).queryByRole('link')).toBeNull();
    const oldBatch = oldBadge.closest('div.rounded-xl') as HTMLElement;
    expect(within(oldBatch).getByText('Boris')).toBeInTheDocument();
    expect(within(oldBatch).queryByText(/representative/)).toBeNull();
    expect(krogLinks()).toHaveLength(2);
  });

  it('a click on the company opens its site and does nothing else: the batch does not open or close under it', async () => {
    listCompany();
    profileName = 'Boris';
    onTheWay('2026-10-09 09:00:00');
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Awaiting LANA/ }));
    await waitFor(() => expect(krogLinks()).toHaveLength(2));
    // jsdom cannot open a tab; what is under test is that the page itself does nothing with the click.
    const noNavigation = (e: Event) => e.preventDefault();
    window.addEventListener('click', noNavigation, true);
    try {
      for (const link of krogLinks()) {
        fireEvent.click(link);
        expect(screen.queryByText(/LANA Recipients/)).toBeNull();
      }
    } finally {
      window.removeEventListener('click', noNavigation, true);
    }
    fireEvent.click(screen.getByText('2026002293'));
    expect(await screen.findByText(/LANA Recipients/)).toBeInTheDocument();
  });

  it('Direct.Fund not answering: the person, as before — no blank, no error', async () => {
    companies = 'down';
    profileName = 'Boris';
    onTheWay('2026-10-09 09:00:00');
    const { toast } = await import('sonner');
    vi.mocked(toast.error).mockClear();
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Awaiting LANA/ }));
    expect((await loadFinancerCompanies()).size).toBe(0);
    const badge = await screen.findByTestId('settled-by-2026002293');
    await waitFor(() => expect(badge).toHaveTextContent('Financer settles · Boris'));
    expect(krogLinks()).toHaveLength(0);
    expect(screen.queryByText(/representative/)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// Review N8/N9: what a person has to look at, said in the heartbeat line —
// and the given-up brain calls, each with its way back. Recheck of 9 Oct 2026
// (M4): the public heartbeat carries the counts only; which calls and which
// purchases come from the signed admin route, asked only while a count is > 0.
describe('the heartbeat line', () => {
  const withWallet = () => { feed = { ...feed, buybackBalance: { wallet: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', balanceLana: 0 } }; };
  /** A session that holds its key, so signedFetch signs (src/lib/nip98Fetch.ts reads it from here). */
  const withKey = () => {
    const session = JSON.stringify({ nostrPrivateKey: '01'.repeat(32), expiresAt: Date.now() + 60_000 });
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'lana_discount_session' ? session : null), setItem: () => {}, removeItem: () => {} });
  };

  it('says when brain calls were taken but are still not approved after 7 days (amber), and when financer purchases name another investor (red) — which ones from the signed admin route', async () => {
    withWallet();
    withKey();
    heartbeat = { ...heartbeat, brainCallbacksWaitingOver7d: 2, ownerMismatchPurchases: 1 };
    adminLists = { gaveUpKeys: [], waitingOver7dKeys: ['fiat-received:B1', 'fiat-received:B2'], ownerMismatchRefs: ['TX-9'] };
    draw();
    const waiting = await screen.findByTestId('hb-callbacks-waiting');
    expect(waiting).toHaveTextContent('2 brain calls accepted but still waiting for approval after 7 days');
    expect(waiting).toHaveClass('text-amber-500');
    await waitFor(() => expect(waiting).toHaveAttribute('title', 'fiat-received:B1\nfiat-received:B2'));
    const mismatch = screen.getByTestId('hb-owner-mismatch');
    expect(mismatch).toHaveTextContent('1 financer purchase now names another investor — needs a person');
    expect(mismatch).toHaveClass('text-red-500');
    expect(mismatch).toHaveAttribute('title', 'TX-9');
    expect(listReads.length).toBeGreaterThan(0);
    for (const r of listReads) expect(r.authorization).toMatch(/^Nostr /);
  });

  it('says nothing of either while there is nothing (or the server does not send them yet) — and asks the admin route nothing', async () => {
    withWallet();
    draw();
    expect(await screen.findByText(/Next heartbeat in/)).toBeInTheDocument();
    await waitFor(() => expect(heartbeatReads).toBeGreaterThan(0));
    expect(screen.queryByTestId('hb-callbacks-waiting')).toBeNull();
    expect(screen.queryByTestId('hb-owner-mismatch')).toBeNull();
    expect(screen.queryByRole('button', { name: /to brain/ })).toBeNull();
    expect(listReads).toEqual([]);
  });

  it('keys a public heartbeat may still carry are never used: the buttons come from the admin route only', async () => {
    withWallet();
    heartbeat = { ...heartbeat, brainCallbacksGaveUp: 1, brainCallbacksGaveUpKeys: ['fiat-received:FROM-HEARTBEAT'] };
    adminLists = { gaveUpKeys: ['fiat-received:FROM-ADMIN'], waitingOver7dKeys: [], ownerMismatchRefs: [] };
    draw();
    expect(await screen.findByRole('button', { name: 'Re-send fiat-received:FROM-ADMIN to brain' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-send fiat-received:FROM-HEARTBEAT to brain' })).toBeNull();
  });

  it('»Re-send to brain« beside each given-up call: a signed POST of its key, then the line is read again', async () => {
    withWallet();
    withKey();
    heartbeat = { ...heartbeat, brainCallbacksGaveUp: 2 };
    adminLists = { gaveUpKeys: ['fiat-received:2026002293', 'lana-sent:' + 'ab'.repeat(32)], waitingOver7dKeys: [], ownerMismatchRefs: [] };
    draw();
    expect(await screen.findByTestId('hb-callbacks-gave-up')).toHaveTextContent('2 brain callbacks given up after 7 days — look');
    const button = await screen.findByRole('button', { name: 'Re-send fiat-received:2026002293 to brain' });
    expect(button).toHaveTextContent('Re-send to brain');
    expect(screen.getByRole('button', { name: `Re-send lana-sent:${'ab'.repeat(32)} to brain` })).toBeInTheDocument();

    const readsBefore = heartbeatReads;
    const listsBefore = listReads.length;
    fireEvent.click(button);
    await waitFor(() => expect(rearms).toHaveLength(1));
    expect(rearms[0].body).toEqual({ dedupeKey: 'fiat-received:2026002293' });
    expect(rearms[0].authorization).toMatch(/^Nostr /);
    await waitFor(() => expect(heartbeatReads).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(listReads.length).toBeGreaterThan(listsBefore));
  });

  it('a refused re-send says why', async () => {
    withWallet();
    const { toast } = await import('sonner');
    heartbeat = { ...heartbeat, brainCallbacksGaveUp: 1 };
    adminLists = { gaveUpKeys: ['lana-sent:x'], waitingOver7dKeys: [], ownerMismatchRefs: [] };
    rearmReply = { status: 409, body: { error: 'The brain already has this call, and nothing of it waits for approval here.', code: 'NOTHING_TO_REARM' } };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-send lana-sent:x to brain' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The brain already has this call, and nothing of it waits for approval here.'));
  });
});
