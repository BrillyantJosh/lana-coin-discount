/**
 * /financer AS A FINANCER USES IT — the server answered by a stubbed fetch,
 * the key and the coins real (throwaway wallets, src/test/financerFixtures.ts).
 *
 * Owner, 8 Oct 2026: "Ključ nikoli ne pride do nas; strežnik transakcijo samo
 * odda in preveri na verigi." What is pinned here, end to end:
 *   - the WIF goes into NO request — not a body, not a URL, not a header — at
 *     any step: reading, preparing, signing, announcing; what goes is the signed
 *     transaction and the legs' ids, and the bytes are signed by the wallet and
 *     pay the legs exactly;
 *   - »Potrdi vse« confirms exactly the batches that may be confirmed — the
 *     references only — and words each answer;
 *   - an announce without an answer keeps the SAME signed bytes and sends them
 *     again; nothing new can be prepared meanwhile (never two signatures over
 *     the same legs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Financer, { CONFIRM_CHUNK, sectionsOf } from './Financer';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FINANCER, FINANCER_SL } from '@/copy';
import { fill } from '@/components/financer/financerText';
import { FinancerBatches, batchStateOf } from '@/components/financer/FinancerBatches';
import { FinancerWalletCard } from '@/components/financer/FinancerWalletCard';
import type { FinancerBatch, WaitingPart } from '@/lib/financer/financerApi';
import { POLL_MS } from '@/lib/financer/payoutView';
import { bytesToHex } from '../../server/shared/lana-tx/bytes.ts';
import { decodeTx, txidOfRaw } from '../../server/shared/lana-tx/codec.ts';
import { addressOfScript, scriptOfAddress } from '../../server/shared/lana-tx/address.ts';
import { verifyTxSignedBy } from '../../server/shared/lana-tx/verify.ts';
import {
  LANA, SIGNER, batchOf, meOf, prepareOf, purchaseOf, sendViewOf, sendableOf, throwawayAddress, throwawayWallet, wifOf,
} from '@/test/financerFixtures';

// Signing checks every input with two libraries; give a slow machine room.
vi.setConfig({ testTimeout: 60_000 });

const auth = vi.hoisted(() => ({
  session: { nostrHexId: 'f1'.repeat(32), profileDisplayName: 'Financer' },
  isLoading: false,
  isAdmin: false,
  logout: () => {},
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const t = FINANCER;
const ROOT = resolve(__dirname, '..', '..');

type Reply = { status: number; body: unknown } | 'no-answer';
type Route = (body: any) => Reply | Promise<Reply>;
let routes: Record<string, Route> = {};
let calls: Array<{ url: string; method: string; body: string | null; headers: string }> = [];

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const body = typeof init.body === 'string' ? init.body : null;
      calls.push({ url: String(url), method, body, headers: JSON.stringify([...new Headers(init.headers).entries()]) });
      const route = routes[`${method} ${url}`];
      if (!route) throw new Error(`unexpected ${method} ${url}`);
      const reply = await route(body ? JSON.parse(body) : null);
      if (reply === 'no-answer') throw new TypeError('Failed to fetch');
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as any;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body: unknown): Reply => ({ status: 200, body });
const draw = () => render(<MemoryRouter><Financer /></MemoryRouter>);

describe('the key never leaves the browser', () => {
  it('signs in the page and sends only the signed transaction and the legs — the WIF is in no request', async () => {
    const wallet = throwawayWallet(true);
    const wif = wifOf(wallet.privateKey, true);
    const [buyer, caretaker] = [throwawayAddress(), throwawayAddress()];
    const purchases = [
      purchaseOf('TX-1', [
        { id: 'leg-1', type: 'customer_cashback', to: buyer, lanoshis: 1_004_492_188n },
        { id: 'leg-2', type: 'caretaker_commission', to: caretaker, lanoshis: 3_446_289_063n },
      ]),
    ];
    const prepared = prepareOf(wallet, purchases, [100n * LANA, 3n * LANA]);
    let announced: any = null;
    routes = {
      'GET /api/financer/me': () => ok(meOf(wallet.address)),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(wallet.address, purchases, 103n * LANA)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': (b) => {
        expect(b).toEqual({ orderIds: ['leg-1', 'leg-2'] });
        return ok(prepared);
      },
      'POST /api/financer/sends': (b) => {
        announced = b;
        return ok({ send: sendViewOf(txidOfRaw(b.rawTx), { state: 'mempool', wallet: wallet.address }), already: false });
      },
    };
    draw();

    fireEvent.click(await screen.findByRole('button', { name: t.prepare }));
    fireEvent.click(await screen.findByRole('button', { name: t.continue }));
    const field = screen.getByLabelText(t.keyLabel) as HTMLInputElement;
    fireEvent.change(field, { target: { value: wif } });
    expect(screen.getByTestId('financer-key-check').textContent).toContain(t.keyStates.opens);
    fireEvent.click(screen.getByRole('button', { name: t.sign }));
    expect(field.value).toBe('');

    expect(await screen.findByText(t.sentOk, {}, { timeout: 30_000 })).toBeInTheDocument();
    expect(announced).not.toBeNull();

    // What went: the legs and the signed bytes, nothing else.
    expect(Object.keys(announced).sort()).toEqual(['orderIds', 'rawTx']);
    expect(announced.orderIds).toEqual(['leg-1', 'leg-2']);
    const tx = decodeTx(announced.rawTx);
    const paid = tx.outputs.map((o) => [addressOfScript(o.scriptPubKeyHex), o.value]);
    expect(paid.slice(0, 2)).toEqual([[buyer, 1_004_492_188n], [caretaker, 3_446_289_063n]]);
    expect(paid.slice(2).every(([to]) => to === wallet.address)).toBe(true);
    const prevouts = tx.inputs.map(() => ({ scriptPubKeyHex: scriptOfAddress(wallet.address) }));
    expect(verifyTxSignedBy(announced.rawTx, prevouts, wallet.address)).toEqual([]);

    // And never the key: in no body, no URL, no header of ANY request this page made.
    const secretHex = bytesToHex(wallet.privateKey);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) {
      for (const part of [c.url, c.body ?? '', c.headers]) {
        expect(part).not.toContain(wif);
        expect(part.toLowerCase()).not.toContain(secretHex);
      }
    }
  });

  it('an announce with no answer keeps the SAME bytes and sends them again; nothing new is prepared meanwhile', async () => {
    const wallet = throwawayWallet(true);
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    const bodies: string[] = [];
    let answer: 'none' | 'yes' = 'none';
    routes = {
      'GET /api/financer/me': () => ok(meOf(wallet.address)),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(wallet.address, purchases, 103n * LANA)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': () => ok(prepareOf(wallet, purchases)),
      'POST /api/financer/sends': (b) => {
        bodies.push(JSON.stringify(b));
        if (answer === 'none') return { status: 503, body: { error: 'busy', code: 'ANNOUNCE_FAILED' } };
        return ok({ send: sendViewOf(txidOfRaw(b.rawTx)), already: true });
      },
    };
    draw();

    fireEvent.click(await screen.findByRole('button', { name: t.prepare }));
    fireEvent.click(await screen.findByRole('button', { name: t.continue }));
    fireEvent.change(screen.getByLabelText(t.keyLabel), { target: { value: wifOf(wallet.privateKey, true) } });
    fireEvent.click(screen.getByRole('button', { name: t.sign }));

    const doubt = await screen.findByTestId('financer-in-doubt', {}, { timeout: 30_000 });
    expect(within(doubt).getByText(t.inDoubt)).toBeInTheDocument();
    // No key field and no new prepare while the bytes may be on their way.
    expect(screen.queryByLabelText(t.keyLabel)).toBeNull();
    expect(screen.getByText(t.pendingBlock)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.prepare })).toBeNull();

    answer = 'yes';
    fireEvent.click(within(doubt).getByRole('button', { name: t.resend }));
    expect(await screen.findByText(t.sentOk)).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});

describe('one Lana.Discount wallet per currency (owner, 9 Oct 2026)', () => {
  const okCheck = { ok: true, walletType: 'Lana.Discount', frozen: false };

  it('one part per currency: each wallet card with the Registrar\'s word and its balance, each list read for its currency, and a GBP purchase signed with the GBP wallet\'s key — the EUR key named as another wallet\'s', async () => {
    const eur = throwawayWallet(true);
    const gbp = throwawayWallet(true);
    const [buyerE, buyerG] = [throwawayAddress(), throwawayAddress()];
    const eurList = [purchaseOf('TX-E', [{ id: 'e-1', type: 'customer_cashback', to: buyerE, lanoshis: 1_004_492_188n }])];
    const gbpList = [purchaseOf('TX-G', [{ id: 'g-1', type: 'customer_cashback', to: buyerG, lanoshis: 3_446_289_063n }])];
    let announced: any = null;
    let prepared: any = null;
    routes = {
      'GET /api/financer/me': () => ok(meOf(eur.address, { wallets: [
        { currency: 'EUR', walletId: eur.address, walletCheck: okCheck },
        { currency: 'GBP', walletId: gbp.address, walletCheck: okCheck },
      ] })),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(eur.address, eurList, 103n * LANA)),
      'GET /api/financer/sendable?currency=GBP': () => ok(sendableOf(gbp.address, gbpList, 7n * LANA, { currency: 'GBP' })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': (b) => {
        prepared = b;
        return ok({ ...prepareOf(gbp, gbpList, [100n * LANA]), currency: 'GBP' });
      },
      'POST /api/financer/sends': (b) => {
        announced = b;
        return ok({ send: sendViewOf(txidOfRaw(b.rawTx), { wallet: gbp.address }), already: false });
      },
    };
    draw();

    const part = await screen.findByTestId('financer-part-GBP');
    const cards = screen.getAllByTestId('financer-wallet');
    expect(cards.map((c) => c.getAttribute('data-currency'))).toEqual(['EUR', 'GBP']);
    expect(within(cards[0]).getByText(fill(t.walletTitleCurrency, { currency: 'EUR' }))).toBeInTheDocument();
    expect(within(cards[1]).getByText(fill(t.walletTitleCurrency, { currency: 'GBP' }))).toBeInTheDocument();
    expect(within(cards[1]).getByTestId('financer-wallet-id').textContent).toBe(gbp.address);
    expect(within(cards[1]).getByText(`✓ ${t.walletOk}`)).toBeInTheDocument();
    await waitFor(() => expect(within(cards[1]).getByTestId('financer-balance').textContent).toContain('7'));
    expect(within(cards[0]).getByTestId('financer-balance').textContent).toContain('103');
    // Each currency's own list.
    expect(within(part).getByText(fill(t.sendTitleCurrency, { currency: 'GBP' }))).toBeInTheDocument();
    expect(within(part).getByRole('checkbox', { name: /TX-G/ })).toBeInTheDocument();
    expect(within(part).queryByRole('checkbox', { name: /TX-E/ })).toBeNull();
    const eurPart = screen.getByTestId('financer-part-EUR');
    expect(within(eurPart).getByRole('checkbox', { name: /TX-E/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith('/api/financer/sendable')).map((c) => c.url).sort()).toEqual([
      '/api/financer/sendable?currency=EUR', '/api/financer/sendable?currency=GBP',
    ]);

    // Prepare in GBP: only its purchases; the plan opens in its part, and the EUR part waits for it.
    fireEvent.click(within(part).getByRole('button', { name: t.prepare }));
    fireEvent.click(await within(part).findByRole('button', { name: t.continue }));
    expect(prepared).toEqual({ orderIds: ['g-1'] });
    expect(within(eurPart).queryByRole('button', { name: t.prepare })).toBeNull();
    expect(within(eurPart).getByText(fill(t.otherSendOpen, { currency: 'GBP' }))).toBeInTheDocument();

    // The EUR wallet's key does not open the GBP wallet: named, nothing signed.
    const field = within(part).getByLabelText(t.keyLabel) as HTMLInputElement;
    fireEvent.change(field, { target: { value: wifOf(eur.privateKey, true) } });
    expect(within(part).getByTestId('financer-key-check').textContent).toContain(eur.address);
    expect(within(part).getByRole('button', { name: t.sign })).toBeDisabled();
    // The GBP wallet's key: signed with it, sent.
    fireEvent.change(field, { target: { value: wifOf(gbp.privateKey, true) } });
    expect(within(part).getByTestId('financer-key-check').textContent).toContain(t.keyStates.opens);
    fireEvent.click(within(part).getByRole('button', { name: t.sign }));
    expect(await within(part).findByText(t.sentOk, {}, { timeout: 30_000 })).toBeInTheDocument();
    expect(announced.orderIds).toEqual(['g-1']);
    const tx = decodeTx(announced.rawTx);
    expect(verifyTxSignedBy(announced.rawTx, tx.inputs.map(() => ({ scriptPubKeyHex: scriptOfAddress(gbp.address) })), gbp.address)).toEqual([]);
    expect(addressOfScript(tx.outputs[0].scriptPubKeyHex)).toBe(buyerG);
    expect(within(eurPart).queryByTestId('financer-send-notice')).toBeNull();
  });

  it('a currency without a wallet says so in its own card and its purchases wait; a refusal names the currency (NO_WALLET), and purchases of no known currency are named', async () => {
    const eur = throwawayWallet(true);
    const gbpWallet = throwawayAddress();
    const gbpList = [purchaseOf('TX-G', [{ id: 'g-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 3_446_289_063n }])];
    let gbpChosen = false;
    routes = {
      'GET /api/financer/me': () => ok(meOf(eur.address, {
        wallets: [
          { currency: 'EUR', walletId: eur.address, walletCheck: okCheck },
          { currency: 'GBP', walletId: gbpChosen ? gbpWallet : null, walletCheck: gbpChosen ? okCheck : { ok: false, reason: 'NO_WALLET' } },
          { currency: 'USD', walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } },
        ],
        unknownCurrencyRefs: ['TX-9'],
      })),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(eur.address, [], 103n * LANA)),
      'GET /api/financer/sendable?currency=GBP': () => ok(sendableOf(gbpChosen ? gbpWallet : null, gbpList, 50n * LANA, { currency: 'GBP' })),
      'GET /api/financer/sendable?currency=USD': () => ok(sendableOf(null, [], 0n, { currency: 'USD' })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      // Direct.Fund lost the GBP wallet between the page's read and the prepare.
      'POST /api/financer/sends/prepare': () => ({ status: 409, body: { code: 'NO_WALLET', currency: 'GBP', error: 'x' } }),
    };
    draw();
    const gbpCard = (await screen.findAllByTestId('financer-wallet')).find((c) => c.getAttribute('data-currency') === 'GBP') as HTMLElement;
    expect(within(gbpCard).getByText(fill(t.walletNoneCurrency, { currency: 'GBP' }))).toBeInTheDocument();
    expect(within(gbpCard).getByRole('link', { name: t.walletChoose })).toHaveAttribute('href', 'https://direct.lana.fund');
    const part = screen.getByTestId('financer-part-GBP');
    expect(await within(part).findByRole('button', { name: t.prepare })).toBeDisabled();
    expect(within(part).getByText(t.walletBlock)).toBeInTheDocument();
    expect(screen.getByTestId('financer-part-USD')).toBeInTheDocument();
    expect(screen.getByTestId('financer-unknown-currency').textContent).toBe(fill(t.unknownCurrency, { count: 1, refs: 'TX-9' }));
    expect(screen.getByText(t.walletsPerCurrency)).toBeInTheDocument();

    // Chosen on Direct.Fund, »Refresh«: the part may prepare; the server's NO_WALLET names the currency, no placeholder left.
    gbpChosen = true;
    fireEvent.click(screen.getByRole('button', { name: t.refresh }));
    const prepare = await within(screen.getByTestId('financer-part-GBP')).findByRole('button', { name: t.prepare });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    const notice = await within(screen.getByTestId('financer-part-GBP')).findByTestId('financer-send-notice');
    expect(notice.textContent).toBe(fill(t.sendCodes.NO_WALLET, { currency: 'GBP' }));
    expect(notice.textContent).not.toMatch(/\{\w+\}/);
    expect(within(screen.getByTestId('financer-part-EUR')).queryByTestId('financer-send-notice')).toBeNull();
  });

  it('a server before wallets per currency (no list): one part as before — the single wallet, /sendable asked without a currency', async () => {
    const wallet = throwawayWallet(true);
    routes = {
      'GET /api/financer/me': () => ok(meOf(wallet.address, { wallets: undefined, unknownCurrencyRefs: undefined })),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable': () => ok(sendableOf(wallet.address, [], 5n * LANA, { currency: undefined })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    const card = await screen.findByTestId('financer-wallet');
    expect(within(card).getByText(t.walletTitle)).toBeInTheDocument();
    expect(await screen.findByText(t.sendTitle)).toBeInTheDocument();
    expect(screen.getByTestId('financer-part-one')).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain('/api/financer/sendable');
    expect(sectionsOf(meOf(null, { wallets: [] }))).toEqual([{ key: '', currency: null, walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } }]);
  });

  it('a financer with no wallet yet and nothing confirmed: the one card names no currency, so its hint speaks of none — and a currency\'s card names its own', async () => {
    routes = {
      'GET /api/financer/me': () => ok(meOf(null, { wallets: [] })),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable': () => ok(sendableOf(null, [], 0n, { currency: null })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    const card = await screen.findByTestId('financer-wallet');
    expect(card.getAttribute('data-currency')).toBeNull();
    expect(within(card).getByText(t.walletNone)).toBeInTheDocument();
    expect(within(card).getByText(t.walletNoneHint)).toBeInTheDocument();
    expect(card.textContent).toContain('nothing can be sent from here');
    expect(card.textContent).not.toMatch(/that currency/);

    // The same card in Slovenian, and a currency's card in both: it names the currency, the single one names none.
    const none = { ok: false, reason: 'NO_WALLET' } as const;
    for (const [tt, lang] of [[FINANCER, 'en'], [FINANCER_SL, 'sl']] as const) {
      const single = render(<FinancerWalletCard t={tt} currency={null} walletId={null} walletCheck={none} balance={undefined} />);
      expect(single.container.textContent).not.toMatch(/that currency|tej valuti|\{\w+\}/);
      expect(single.container.textContent).toContain(lang === 'en' ? 'Until then nothing can be sent from here.' : 'Do takrat od tukaj ni mogoče poslati ničesar.');
      single.unmount();
      const gbp = render(<FinancerWalletCard t={tt} currency="GBP" walletId={null} walletCheck={none} balance={undefined} />);
      expect(within(gbp.container).getByText(fill(tt.walletNoneHintCurrency, { currency: 'GBP' }))).toBeInTheDocument();
      expect(fill(tt.walletNoneHintCurrency, { currency: 'GBP' })).toContain('GBP');
      expect(gbp.container.textContent).not.toMatch(/that currency|tej valuti|\{\w+\}/);
      gbp.unmount();
    }
  });

  it('a batch confirmed in a new currency: /me is read again, and that currency\'s part appears with its purchases', async () => {
    const eur = throwawayWallet(true);
    let confirmed = false;
    const gbpList = [purchaseOf('TX-G', [{ id: 'g-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 3_446_289_063n }])];
    routes = {
      'GET /api/financer/me': () => ok(meOf(eur.address, { wallets: [
        { currency: 'EUR', walletId: eur.address, walletCheck: okCheck },
        ...(confirmed ? [{ currency: 'GBP', walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } }] : []),
      ] })),
      'GET /api/financer/batches': () => ok({ batches: [batchOf('2026002500', { currency: 'GBP' })] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(eur.address, [], 103n * LANA)),
      'GET /api/financer/sendable?currency=GBP': () => ok(sendableOf(null, gbpList, 0n, { currency: 'GBP' })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': () => {
        confirmed = true;
        return ok({ results: [{ batchRef: '2026002500', ok: true, transactionRefs: ['TX-G'] }] });
      },
    };
    draw();
    const row = await screen.findByTestId('financer-batch-2026002500');
    expect(screen.queryByTestId('financer-part-GBP')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: t.confirm }));
    const part = await screen.findByTestId('financer-part-GBP');
    expect(await within(part).findByRole('checkbox', { name: /TX-G/ })).toBeInTheDocument();
  });
});

describe('the choice, send after send (review M8)', () => {
  it('a purchase unticked by hand stays out of the next round; what »Choose what fits« left out is chosen again', async () => {
    // The two rounds of review M8, with a send of at most 4 payments: TX-0 is held by an earlier refused send, so the
    // financer unticks it; »Choose what fits« keeps TX-1 and TX-2, and they are signed and sent.
    const wallet = throwawayWallet(true);
    const [a, b] = [throwawayAddress(), throwawayAddress()];
    const list = Array.from({ length: 6 }, (_, i) =>
      purchaseOf(`TX-${i}`, [
        { id: `l${i}-1`, type: 'customer_cashback', to: a, lanoshis: 1_004_492_188n },
        { id: `l${i}-2`, type: 'investor_lana', to: b, lanoshis: 3_446_289_063n },
      ]),
    );
    const limits = { maxWallets: 98, maxLegs: 4, maxInputs: 20, dustLanoshis: '500000', stepLanoshis: '1' };
    let left = list;
    const prepares: string[][] = [];
    routes = {
      'GET /api/financer/me': () => ok(meOf(wallet.address)),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(wallet.address, left, 1_000n * LANA, { limits })),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': (body) => {
        prepares.push(body.orderIds);
        return ok(prepareOf(wallet, list.filter((p) => p.legs.some((l) => body.orderIds.includes(l.orderId))), [1_000n * LANA]));
      },
      'POST /api/financer/sends': (body) => {
        // Sent: the server lists what is left.
        left = list.filter((p) => !p.legs.some((l) => body.orderIds.includes(l.orderId)));
        return ok({ send: sendViewOf(txidOfRaw(body.rawTx), { wallet: wallet.address }), already: false });
      },
    };
    draw();

    fireEvent.click(await screen.findByRole('checkbox', { name: /TX-0/ }));
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    fireEvent.click(screen.getByRole('button', { name: t.prepare }));
    fireEvent.click(await screen.findByRole('button', { name: t.continue }));
    fireEvent.change(screen.getByLabelText(t.keyLabel), { target: { value: wifOf(wallet.privateKey, true) } });
    fireEvent.click(screen.getByRole('button', { name: t.sign }));
    expect(await screen.findByText(t.sentOk, {}, { timeout: 30_000 })).toBeInTheDocument();
    expect(prepares[0]).toEqual(['l1-1', 'l1-2', 'l2-1', 'l2-2']);

    // Round 2: TX-0, TX-3, TX-4, TX-5 are left. TX-0 stays unticked; the ones the button left out are chosen again.
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /TX-1/ })).toBeNull());
    expect(screen.getByRole('checkbox', { name: /TX-0/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-3/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-5/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-0/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: t.prepare }));
    await waitFor(() => expect(prepares).toHaveLength(2));
    expect(prepares[1]).toEqual(['l3-1', 'l3-2', 'l4-1', 'l4-2']);
  });
});

describe('confirming batches', () => {
  it('»Confirm all« confirms exactly the batches that may be confirmed — references only — and words each answer', async () => {
    let confirmed: any = null;
    let batchReads = 0;
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => {
        batchReads++;
        return ok({
          batches: [
            batchOf('2026002417'),
            batchOf('2026002389'),
            // Not paid on Direct.Fund yet: never confirmable here.
            batchOf('2026002325', { status: 'closed', canConfirm: false, paidAt: null }),
            // Settled by the treasury: neither.
            batchOf('2026002293', { canConfirm: false }, { settledBy: 'treasury', purchases: { total: 1, mine: 0, treasury: 1, other: 0, unclaimed: 0 }, unclaimedRefs: [] }),
          ],
        });
      },
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': (b) => {
        confirmed = b;
        return ok({
          results: [
            { batchRef: '2026002417', ok: true, transactionRefs: ['TX-1'] },
            { batchRef: '2026002389', ok: false, code: 'OWNER_CONFLICT', error: 'x' },
          ],
        });
      },
    };
    draw();

    const all = await screen.findByRole('button', { name: 'Confirm all (2)' });
    const notPaid = screen.getByTestId('financer-batch-2026002325');
    expect(within(notPaid).getByText(t.batchState.notPaid)).toBeInTheDocument();
    expect(within(notPaid).getByRole('link', { name: t.openDf })).toHaveAttribute('href', 'https://direct.lana.fund');
    expect(within(notPaid).queryByRole('button', { name: t.confirm })).toBeNull();

    fireEvent.click(all);
    await waitFor(() => expect(confirmed).not.toBeNull());
    expect(confirmed).toEqual({ batchRefs: ['2026002417', '2026002389'] });

    const notice = await screen.findByTestId('financer-batch-notice');
    expect(notice.textContent).toContain('2026002417');
    expect(notice.textContent).toContain(t.confirmCodes.OWNER_CONFLICT);
    await waitFor(() => expect(batchReads).toBe(2));
  });

  it('one confirmable batch is confirmed with its own button, and only that one', async () => {
    let confirmed: any = null;
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [batchOf('2026002417'), batchOf('2026002325', { status: 'open', canConfirm: false })] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': (b) => {
        confirmed = b;
        return ok({ results: [{ batchRef: '2026002417', ok: true }] });
      },
    };
    draw();
    const row = await screen.findByTestId('financer-batch-2026002417');
    expect(screen.queryByRole('button', { name: /Confirm all/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: t.confirm }));
    await waitFor(() => expect(confirmed).toEqual({ batchRefs: ['2026002417'] }));
  });
});

describe('confirming many batches at once', () => {
  it('»Confirm all« over more batches than one request may carry sends them in requests of at most the server’s limit, every one once', async () => {
    const serverLimit = Number(/MAX_CONFIRM_BATCHES = (\d+)/.exec(readFileSync(join(ROOT, 'server/routes/financer.ts'), 'utf8'))?.[1]);
    expect(serverLimit).toBe(CONFIRM_CHUNK);
    const refs = Array.from({ length: CONFIRM_CHUNK + 1 }, (_, i) => `B${String(i).padStart(4, '0')}`);
    const asked: string[][] = [];
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: refs.map((r) => batchOf(r)) }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': (b) => {
        asked.push(b.batchRefs);
        if (b.batchRefs.length > serverLimit) return { status: 400, body: { code: 'TOO_MANY_BATCHES' } };
        return ok({ results: b.batchRefs.map((batchRef: string) => ({ batchRef, ok: true })) });
      },
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: `Confirm all (${refs.length})` }));
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked.map((a) => a.length)).toEqual([CONFIRM_CHUNK, 1]);
    expect(asked.flat()).toEqual(refs);
    const notice = await screen.findByTestId('financer-batch-notice');
    expect(notice.textContent).toContain(refs[refs.length - 1]);
  });
});

describe('who the page is for', () => {
  it('a key that is no financer on Direct.Fund is told so, and nothing else is read', async () => {
    routes = { 'GET /api/financer/me': () => ok(meOf(null, { isFinancer: false })) };
    draw();
    expect(await screen.findByText(t.notFinancer)).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(['/api/financer/me']);
    expect(SIGNER).toBe(auth.session.nostrHexId);
  });

  it('a wallet the Registrar refuses is said with its reason, and nothing can be prepared', async () => {
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine', { walletCheck: { ok: false, reason: 'WRONG_WALLET_TYPE', walletType: 'Wallet' } })),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', purchases, 100n * LANA)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    const card = await screen.findByTestId('financer-wallet');
    expect(card.textContent).toContain('The Registrar has this wallet as Wallet, not as Lana.Discount.');
    expect(await screen.findByRole('button', { name: t.prepare })).toBeDisabled();
    expect(screen.getByText(t.walletBlock)).toBeInTheDocument();
  });
});

describe('the page reads the wallet again by itself while a payment waits for a block (review C22)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an unconfirmed top-up blocks the send, the page asks again every half minute, and the block lifts by itself', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    let unconfirmed = String(50n * LANA);
    let reads = 0;
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => {
        reads++;
        return ok(sendableOf('L-mine', purchases, 100n * LANA, { balance: { confirmed: String(100n * LANA), unconfirmed } }));
      },
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    expect(await screen.findByText(t.sendCodes.WALLET_UNCONFIRMED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.prepare })).toBeDisabled();
    expect(reads).toBe(1);

    // The top-up confirms; nobody presses »Refresh«.
    unconfirmed = '0';
    vi.advanceTimersByTime(POLL_MS);
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: t.prepare })).toBeEnabled());
    expect(screen.queryByText(t.sendCodes.WALLET_UNCONFIRMED)).toBeNull();

    // Confirmed and nothing on its way: the page stops asking.
    vi.advanceTimersByTime(POLL_MS * 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(2);
  });

  it('a prepare refused because a payment is unconfirmed reads the wallet again, so the page sees it and keeps asking', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    // The list was read before the payment showed; the prepare is the first to see it.
    let unconfirmed = '0';
    let reads = 0;
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => {
        reads++;
        return ok(sendableOf('L-mine', purchases, 100n * LANA, { balance: { confirmed: String(100n * LANA), unconfirmed } }));
      },
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': () => {
        unconfirmed = String(5n * LANA);
        return { status: 409, body: { code: 'WALLET_UNCONFIRMED', error: 'x', unconfirmed } };
      },
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: t.prepare }));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: t.prepare })).toBeDisabled());
    // The refusal is said; the read it set off still sees the payment waiting, so it stays.
    expect(screen.getByTestId('financer-send-notice').textContent).toBe(t.sendCodes.WALLET_UNCONFIRMED);
    unconfirmed = '0';
    vi.advanceTimersByTime(POLL_MS);
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.getByRole('button', { name: t.prepare })).toBeEnabled());
    // Confirmed now: the red »not confirmed yet« goes with it, never left beside a Prepare that is on (review N14).
    expect(screen.queryByTestId('financer-send-notice')).toBeNull();
  });

  it('another refusal is not taken down by the wallet read that follows it', async () => {
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', purchases, 100n * LANA)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': () => ({ status: 503, body: { code: 'CHAIN_UNKNOWN', error: 'x' } }),
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: t.prepare }));
    await waitFor(() => expect(screen.getByTestId('financer-send-notice').textContent).toBe(t.sendCodes.CHAIN_UNKNOWN));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('financer-send-notice').textContent).toBe(t.sendCodes.CHAIN_UNKNOWN);
  });
});

describe('»Confirm again« on a batch already confirmed (review N7/N9)', () => {
  const done = { total: 3, pending: 0, authorized: 0, sending: 0, sent: 3, cancelled: 0 };
  const mineConfirmed = (over: Partial<FinancerBatch['ld']> = {}) => ({
    confirmed: true,
    settledBy: 'financer' as const,
    status: 'received',
    purchases: { total: 1, mine: 1, treasury: 0, other: 0, unclaimed: 0 },
    unclaimedRefs: [],
    legs: done,
    ...over,
  });

  it('a purchase Direct.Fund left out is said by reference, and »Confirm again« posts the same reference — the batch is not folded away', async () => {
    let confirmed: any = null;
    let batchReads = 0;
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => {
        batchReads++;
        return ok({
          batches: [
            // Its own purchase sent, one more Direct.Fund did not count at the confirmation: »done« by its legs.
            batchOf('2026002417', { canConfirm: false, canConfirmAgain: true, transactionRefs: ['TX-1', 'TX-7'] },
              mineConfirmed({ purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 1 }, unclaimedRefs: ['TX-7'] })),
            // Nothing left out, but the notice to the brain stopped while its purchases wait for approval.
            batchOf('2026002389', { canConfirm: false, canConfirmAgain: true, resendStopped: true }, mineConfirmed({ legs: { ...done, pending: 3, sent: 0 } })),
            // Left out, and nothing a repeat would change now (not paid on Direct.Fund any more, say): said, no button.
            batchOf('2026002325', { canConfirm: false, canConfirmAgain: false, transactionRefs: ['TX-3', 'TX-4'] },
              mineConfirmed({ purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 1 }, unclaimedRefs: ['TX-4'] })),
            // Not confirmed yet: its purchases are nobody's here, which is no news — nothing said of them.
            batchOf('2026002293'),
          ],
        });
      },
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': (b) => {
        confirmed = b;
        return ok({ results: [{ batchRef: '2026002417', ok: true, alreadyConfirmed: true, transactionRefs: ['TX-1', 'TX-7'] }] });
      },
    };
    draw();

    const row = await screen.findByTestId('financer-batch-2026002417');
    expect(row.closest('details')).toBeNull();
    expect(within(row).getByTestId('financer-batch-unclaimed-2026002417').textContent).toBe(fill(t.unclaimed, { count: 1, refs: 'TX-7' }));
    expect(within(row).getByTestId('financer-batch-again-2026002417').textContent).toBe(fill(t.againUnclaimed, { button: t.confirmAgain }));

    const resend = screen.getByTestId('financer-batch-2026002389');
    expect(within(resend).getByTestId('financer-batch-again-2026002389').textContent).toBe(fill(t.againResend, { button: t.confirmAgain }));
    expect(within(resend).queryByTestId('financer-batch-unclaimed-2026002389')).toBeNull();

    const noRepeat = screen.getByTestId('financer-batch-2026002325');
    expect(within(noRepeat).getByTestId('financer-batch-unclaimed-2026002325').textContent).toBe(fill(t.unclaimed, { count: 1, refs: 'TX-4' }));
    expect(within(noRepeat).queryByRole('button', { name: t.confirmAgain })).toBeNull();

    const fresh = screen.getByTestId('financer-batch-2026002293');
    expect(within(fresh).queryByTestId('financer-batch-unclaimed-2026002293')).toBeNull();
    expect(within(fresh).queryByRole('button', { name: t.confirmAgain })).toBeNull();
    // »Confirm all« is for batches nobody confirmed yet — never a repeat.
    expect(screen.queryByRole('button', { name: /Confirm all/ })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: t.confirmAgain }));
    await waitFor(() => expect(confirmed).toEqual({ batchRefs: ['2026002417'] }));
    const notice = await screen.findByTestId('financer-batch-notice');
    expect(notice.textContent).toBe(fill(t.confirmAgainDone, { refs: '2026002417' }));
    await waitFor(() => expect(batchReads).toBe(2));
  });

  it('each reason for »Confirm again« is said when it holds — both when both do — and a cancelled purchase needs nothing (review M5/M7)', async () => {
    const waiting = { ...done, pending: 3, sent: 0 };
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () =>
        ok({
          batches: [
            // P1 mine, waiting for approval, its notice to the brain stopped; TX-7 left out; TX-8 cancelled for good.
            batchOf('2026002417', { canConfirm: false, canConfirmAgain: true, resendStopped: true, transactionRefs: ['TX-1', 'TX-7', 'TX-8'] },
              mineConfirmed({ purchases: { total: 3, mine: 1, treasury: 0, other: 0, unclaimed: 1, retakeable: 1, cancelled: 1 }, unclaimedRefs: ['TX-7'], legs: waiting })),
            // Only the notice stopped. TX-9 is left out too, but pays its budget's LANA to another financer: no repeat
            // can take it (it is the administrator's), so only the notice is the reason.
            batchOf('2026002389', { canConfirm: false, canConfirmAgain: true, resendStopped: true, transactionRefs: ['TX-2', 'TX-9'] },
              mineConfirmed({ purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 1, retakeable: 0, cancelled: 0 }, unclaimedRefs: ['TX-9'], legs: waiting })),
            // Only a purchase left out, the notice going as it should.
            batchOf('2026002325', { canConfirm: false, canConfirmAgain: true, resendStopped: false, transactionRefs: ['TX-3', 'TX-4'] },
              mineConfirmed({ purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 1, retakeable: 1, cancelled: 0 }, unclaimedRefs: ['TX-4'] })),
            // Its own purchase sent, the other one cancelled: nothing to do, folded away — and never »not sent by you yet«.
            batchOf('2026002293', { canConfirm: false, canConfirmAgain: false, resendStopped: false, transactionRefs: ['TX-5', 'TX-6'] },
              mineConfirmed({ purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 0, retakeable: 0, cancelled: 1 } })),
            // A server that does not say `retakeable` and `resendStopped` yet: the old reading — nothing left out, so the notice.
            batchOf('2026002201', { canConfirm: false, canConfirmAgain: true, resendStopped: undefined }, mineConfirmed({ legs: waiting })),
          ],
        }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    const sentences = (ref: string) => [...screen.getByTestId(`financer-batch-again-${ref}`).querySelectorAll('p')].map((p) => p.textContent);
    const take = fill(t.againUnclaimed, { button: t.confirmAgain });
    const resend = fill(t.againResend, { button: t.confirmAgain });

    const both = await screen.findByTestId('financer-batch-2026002417');
    expect(sentences('2026002417')).toEqual([take, resend]);
    expect(within(both).getByTestId('financer-batch-unclaimed-2026002417').textContent).toBe(fill(t.unclaimed, { count: 1, refs: 'TX-7' }));
    expect(within(both).getByTestId('financer-batch-cancelled-2026002417').textContent).toBe(fill(t.cancelledPurchases, { count: 1 }));
    expect(within(both).getAllByRole('button', { name: t.confirmAgain })).toHaveLength(1);

    expect(sentences('2026002389')).toEqual([resend]);
    expect(screen.getByTestId('financer-batch-unclaimed-2026002389').textContent).toBe(fill(t.unclaimed, { count: 1, refs: 'TX-9' }));
    expect(sentences('2026002325')).toEqual([take]);
    expect(sentences('2026002201')).toEqual([resend]);

    const cancelled = screen.getByTestId('financer-batch-2026002293');
    expect(cancelled.closest('details')).not.toBeNull();
    expect(within(cancelled).getByTestId('financer-batch-cancelled-2026002293').textContent).toBe(fill(t.cancelledPurchases, { count: 1 }));
    expect(within(cancelled).queryByTestId('financer-batch-unclaimed-2026002293')).toBeNull();
    expect(within(cancelled).queryByTestId('financer-batch-again-2026002293')).toBeNull();
    expect(within(cancelled).queryByRole('button', { name: t.confirmAgain })).toBeNull();
    // Said plainly, in both languages: cancelled, nothing to do — not »you do not send yet«.
    for (const tt of [FINANCER, FINANCER_SL]) expect(tt.cancelledPurchases).not.toMatch(/not send yet|še ne pošiljate/);
    expect(FINANCER_SL.cancelledPurchases).toMatch(/preklicani.*ni treba storiti ničesar/);
  });

  it('a confirmed batch whose own purchases are all sent and whose other one nobody settles is not waiting for an approval that never comes', () => {
    const b = batchOf('2026002417', { canConfirm: false, transactionRefs: ['TX-7'] }, mineConfirmed({
      purchases: { total: 1, mine: 0, treasury: 0, other: 0, unclaimed: 1 },
      unclaimedRefs: ['TX-7'],
      legs: { total: 0, pending: 0, authorized: 0, sending: 0, sent: 0, cancelled: 0 },
    }));
    expect(batchStateOf(b)).not.toBe('awaitingApproval');
    // Its own purchase whose legs have not come yet: that one waits.
    expect(batchStateOf({ ...b, ld: { ...b.ld, purchases: { ...b.ld.purchases, mine: 1 } } })).toBe('awaitingApproval');
  });
});

describe('what the server answers now, said', () => {
  it('a held batch says the administrator decides it, offers no Confirm, and is left out of »Confirm all«', async () => {
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () =>
        ok({ batches: [batchOf('2026002293', { held: true, canConfirm: false }), batchOf('2026002417'), batchOf('2026002389')] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();
    const row = await screen.findByTestId('financer-batch-2026002293');
    expect(within(row).getByText(t.batchState.held)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: t.confirm })).toBeNull();
    expect(within(row).queryByText(t.batchState.notPaid)).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm all (2)' })).toBeInTheDocument();
  });

  it('a confirm that left purchases out says how many and which; a refused held batch and a key that is no financer are worded', async () => {
    let answer: 'results' | 'not-financer' = 'results';
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [batchOf('2026002417'), batchOf('2026002389')] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/batches/confirm': () =>
        answer === 'not-financer'
          ? { status: 403, body: { error: 'x', code: 'NOT_FINANCER' } }
          : ok({
              results: [
                { batchRef: '2026002417', ok: true, transactionRefs: ['TX-1'], skippedRefs: ['TX-7', 'TX-9'], skippedPaymentIds: [70, 90] },
                { batchRef: '2026002389', ok: false, code: 'BATCH_HELD', error: 'x' },
              ],
            }),
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm all (2)' }));
    const notice = await screen.findByTestId('financer-batch-notice');
    expect(notice.textContent).toContain(fill(t.confirmSkipped, { ref: '2026002417', count: 2, refs: 'TX-7, TX-9' }));
    expect(notice.textContent).toContain(t.confirmCodes.BATCH_HELD);

    answer = 'not-financer';
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm all (2)' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all (2)' }));
    await waitFor(() => expect(screen.getByTestId('financer-batch-notice').textContent).toContain(t.confirmCodes.NOT_FINANCER));
  });

  it('a send refusal names the wallet of the earlier refused send, and a too-long send the limit — never a raw {placeholder}', async () => {
    const wallet = throwawayWallet(true);
    const old = throwawayAddress();
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n }])];
    let refusal: { status: number; body: unknown } = { status: 409, body: { code: 'MUST_SPEND_OTHER_WALLET', error: 'x', wallet: old, mustSpend: [['ab:0']] } };
    routes = {
      'GET /api/financer/me': () => ok(meOf(wallet.address)),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf(wallet.address, purchases, 103n * LANA)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
      'POST /api/financer/sends/prepare': () => refusal,
    };
    draw();
    fireEvent.click(await screen.findByRole('button', { name: t.prepare }));
    const notice = await screen.findByTestId('financer-send-notice');
    expect(notice.textContent).toBe(fill(t.sendCodes.MUST_SPEND_OTHER_WALLET, { wallet: old }));

    refusal = { status: 400, body: { code: 'BAD_ORDER_IDS', error: 'x' } };
    fireEvent.click(screen.getByRole('button', { name: t.prepare }));
    await waitFor(() => expect(screen.getByTestId('financer-send-notice').textContent).toBe(fill(t.sendCodes.BAD_ORDER_IDS, { max: 400, button: t.chooseFits })));
    expect(screen.getByTestId('financer-send-notice').textContent).not.toMatch(/\{\w+\}/);
  });

  it('a send confirmed as a copy links to the transaction on the chain, and says the id that was signed', async () => {
    const signed = 'aa'.repeat(32);
    const onChain = 'bb'.repeat(32);
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () => ok({ batches: [] }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [sendViewOf(signed, { state: 'confirmed', blockHeight: 100, chainTxid: onChain })] }),
    };
    draw();
    const row = await screen.findByTestId(`financer-send-${signed}`);
    expect(within(row).getByRole('link')).toHaveAttribute('href', `https://chainz.cryptoid.info/lana/tx.dws?${onChain}`);
    expect(row.textContent).toContain(fill(t.copyNote, { txid: signed }));
  });
});

describe('what a confirmed batch waits on at Direct.Fund, named (owner, 9 Oct 2026)', () => {
  // Batch 2026002432 confirmed; the brain did not approve, because the purchase's €0.25 merchant's commission by bank
  // sat in Direct.Fund batch 2026002433, closed and not marked paid — and the page said only "when every part is paid".
  const waitingLegs = { total: 3, pending: 3, authorized: 0, sending: 0, sent: 0, cancelled: 0 };
  const confirmedWaiting = (ref: string, waitingOn: WaitingPart[] | null | undefined) =>
    batchOf(ref, { canConfirm: false }, {
      confirmed: true, settledBy: 'financer', status: 'received',
      purchases: { total: 1, mine: 1, treasury: 0, other: 0, unclaimed: 0, retakeable: 0, cancelled: 0 },
      unclaimedRefs: [], legs: waitingLegs, waitingOn,
    });
  const part = (over: Partial<WaitingPart>): WaitingPart => ({
    batchRef: '2026002433', batchStatus: 'closed', orderType: 'merchant_commission', destinationType: 'bank',
    amount: 0.25, currency: 'EUR', transactionRef: 'TX-1', ...over,
  });
  const lines = (ref: string) => [...screen.getByTestId(`financer-batch-waiting-${ref}`).querySelectorAll('p')].map((p) => p.textContent);

  it('the unpaid part by its Direct.Fund batch, amount, what and how; every part paid; and the general sentence when Direct.Fund could not say', async () => {
    routes = {
      'GET /api/financer/me': () => ok(meOf('L-mine')),
      'GET /api/financer/batches': () =>
        ok({
          batches: [
            confirmedWaiting('2026002432', [part({})]),
            // Two parts in one Direct.Fund batch, one in another (in GBP), one in no batch yet: a line each batch, a line for it.
            confirmedWaiting('2026002440', [
              part({ transactionRef: 'TX-2' }),
              part({ transactionRef: 'TX-2', orderType: 'merchant_payment', amount: 1234.5 }),
              part({ transactionRef: 'TX-3', batchRef: '2026002450', orderType: 'lana_purchase', destinationType: 'lana_discount', amount: 9.75, currency: 'GBP' }),
              part({ transactionRef: 'TX-4', batchRef: null, batchStatus: null, orderType: 'caretaker_via_discount', destinationType: 'lana_discount', amount: 1.5, currency: 'CHF' }),
              part({ transactionRef: 'TX-5', batchRef: '2026002450', orderType: 'something_new', destinationType: null, amount: 2, currency: 'GBP' }),
            ]),
            confirmedWaiting('2026002389', []),
            confirmedWaiting('2026002325', null),
            // A server before `waitingOn`.
            confirmedWaiting('2026002201', undefined),
          ],
        }),
      'GET /api/financer/sendable?currency=EUR': () => ok(sendableOf('L-mine', [], 0n)),
      'GET /api/financer/sends': () => ok({ sends: [] }),
    };
    draw();

    const live = await screen.findByTestId('financer-batch-2026002432');
    expect(lines('2026002432')).toEqual([
      'Waiting for Direct.Fund: batch 2026002433 (€0.25 — merchant’s commission, bank transfer) is not marked paid yet. ' +
        'Pay it there and press »I Have Paid This Batch«; the LANA can be sent about 10–20 minutes later.',
    ]);
    expect(within(live).queryByText(t.batchState.awaitingApproval)).toBeNull();

    expect(lines('2026002440')).toEqual([
      fill(t.waitingOn.inBatch, { batch: '2026002433', parts: '€0.25 — merchant’s commission, bank transfer; €1,234.50 — payment to the merchant, bank transfer' }),
      fill(t.waitingOn.inBatch, { batch: '2026002450', parts: '£9.75 — LANA purchase, internal; £2.00 — other payment' }),
      fill(t.waitingOn.noBatch, { part: 'CHF 1.50 — payment to the caretaker, internal' }),
    ]);
    expect(lines('2026002440')[2]).toBe(
      'Waiting for Direct.Fund: a part of the purchase (CHF 1.50 — payment to the caretaker, internal) is not in a batch on ' +
        'Direct.Fund yet. Once it is in one, pay that batch there and press »I Have Paid This Batch«; the LANA can be sent ' +
        'about 10–20 minutes later.',
    );

    expect(lines('2026002389')).toEqual(['Every part is paid on Direct.Fund. Approval comes on its own within about 10–20 minutes.']);

    for (const ref of ['2026002325', '2026002201']) {
      const row = screen.getByTestId(`financer-batch-${ref}`);
      expect(within(row).getByText(t.batchState.awaitingApproval)).toBeInTheDocument();
      expect(within(row).queryByTestId(`financer-batch-waiting-${ref}`)).toBeNull();
    }
    // Nothing unfilled anywhere.
    for (const ref of ['2026002432', '2026002440', '2026002389']) for (const l of lines(ref)) expect(l).not.toMatch(/\{\w+\}/);
  });

  it('in Slovenian, in a business reader’s words', () => {
    render(
      <FinancerBatches
        t={FINANCER_SL}
        lang="sl"
        batches={[
          confirmedWaiting('2026002432', [part({})]),
          confirmedWaiting('2026002440', [part({ batchRef: null, batchStatus: null, orderType: 'caretaker_via_discount', destinationType: 'lana_discount', amount: 1.5 })]),
          confirmedWaiting('2026002389', []),
          confirmedWaiting('2026002325', null),
        ]}
        confirming={new Set()}
        results={{}}
        onConfirm={() => {}}
      />,
    );
    expect(lines('2026002432')).toEqual([
      'Čaka še Direct.Fund: paket 2026002433 (€0.25 — provizija trgovcu, bančno nakazilo) še ni označen kot plačan. ' +
        'Plačajte ga tam in pritisnite »I Have Paid This Batch«; LANE boste lahko poslali približno 10–20 minut zatem.',
    ]);
    expect(lines('2026002440')).toEqual([
      'Čaka še Direct.Fund: del nakupa (€1.50 — plačilo skrbniku, interno) na Direct.Fund še ni v nobenem paketu. ' +
        'Ko bo v paketu, ga tam plačajte in pritisnite »I Have Paid This Batch«; LANE boste lahko poslali približno 10–20 minut zatem.',
    ]);
    expect(lines('2026002389')).toEqual(['Na Direct.Fund so plačani vsi deli. Odobritev pride sama, v približno 10–20 minutah.']);
    expect(within(screen.getByTestId('financer-batch-2026002325')).getByText(FINANCER_SL.batchState.awaitingApproval)).toBeInTheDocument();
  });

  it('only a batch waiting for the approval says it: one ready to send keeps its own sentence', () => {
    const ready = { ...confirmedWaiting('2026002432', [part({})]) };
    ready.ld = { ...ready.ld, legs: { ...waitingLegs, authorized: 3 } };
    expect(batchStateOf(ready)).toBe('ready');
    render(<FinancerBatches t={t} lang="en" batches={[ready]} confirming={new Set()} results={{}} onConfirm={() => {}} />);
    expect(screen.queryByTestId('financer-batch-waiting-2026002432')).toBeNull();
    expect(screen.getByText(t.batchState.ready)).toBeInTheDocument();
  });
});
