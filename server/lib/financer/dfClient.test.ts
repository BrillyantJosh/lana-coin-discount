// @vitest-environment node
/**
 * DIRECT.FUND, ASKED FRESH, READ STRICTLY.
 *
 * These answers decide who sends a purchase's LANA. So: this server's own peer
 * key on every call; a real request every time (no cache — a batch can be
 * reopened or a purchase moved in the two minutes the admin page's copy
 * lives); and every failure a DfError the caller refuses on. A field DF did not
 * send reads as the safe value: a payment is live only when DF says `true`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { fetchBatchByRef, fetchFinancer, fetchFinancerBatches, fetchFinancerUnpaidParts, DfError, parseBatchByRef, parseFinancer, currencyCode, MAX_UNPAID_REFS } from './dfClient';

const HEX = 'c'.repeat(64);
let base = '';
let server: http.Server;
const seen: Array<{ url: string; auth: string | undefined; cacheControl: string | undefined }> = [];
let reply: (url: string) => { status: number; body: unknown } | 'hang';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: String(req.url), auth: req.headers.authorization, cacheControl: req.headers['cache-control'] });
    const r = reply(String(req.url));
    if (r === 'hang') return;
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { seen.length = 0; });

const opts = () => ({ baseUrl: base, headers: () => ({ Authorization: 'Bearer peer-key' }), timeoutMs: 300 });
const batchAnswer = (over: Record<string, unknown> = {}, payments: unknown[] = [{
  ppId: 7, amount: 12.5, currency: 'EUR', confirmed: true, transactionRef: 'T1', orderType: 'cash',
  investorHex: HEX.toUpperCase(), destinationType: 'lana_discount', orderStatus: 'pending', live: true,
}]) => ({
  batch: { batchRef: '2026002417', investorHex: HEX, totalAmount: 12.5, currency: 'EUR', paymentCount: 1, confirmedCount: 1,
    status: 'paid', destinationType: 'lana_discount', fundSettingId: 33, createdAt: '2026-10-08 10:00:00', paidAt: '2026-10-08 11:00:00', ...over },
  payments,
});

describe('fetchBatchByRef', () => {
  it('asks with the peer key, every time — two calls, two requests', async () => {
    reply = () => ({ status: 200, body: batchAnswer() });
    const a = await fetchBatchByRef('2026002417', opts());
    reply = () => ({ status: 200, body: batchAnswer({ status: 'closed' }) });
    const b = await fetchBatchByRef('2026002417', opts());
    expect(seen.map(s => s.url)).toEqual(['/api/admin/batch-by-ref/2026002417', '/api/admin/batch-by-ref/2026002417']);
    expect(seen.every(s => s.auth === 'Bearer peer-key' && s.cacheControl === 'no-cache')).toBe(true);
    expect(a.batch.status).toBe('paid');
    expect(b.batch.status).toBe('closed');
    expect(a.payments[0]).toMatchObject({ ppId: 7, transactionRef: 'T1', investorHex: HEX, destinationType: 'lana_discount', confirmed: true, live: true });
    expect(a.batch).toMatchObject({ investorHex: HEX, destinationType: 'lana_discount', fundSettingId: 33 });
  });

  it('a field DF did not send reads as the safe value', () => {
    const d = parseBatchByRef(batchAnswer({ destinationType: undefined }, [{ ppId: 1, confirmed: 1, live: 'yes', transactionRef: '' }]), '2026002417');
    expect(d.batch.destinationType).toBeNull();
    expect(d.payments[0]).toMatchObject({ confirmed: false, live: false, transactionRef: null, investorHex: '', destinationType: null });
  });

  it('404 is DF_NOT_FOUND; 401/403 DF_REFUSED; 5xx, silence and a dead host DF_UNAVAILABLE; garbage DF_BAD_RESPONSE', async () => {
    const codeOf = async (r: typeof reply, o = opts()) => {
      reply = r;
      try { await fetchBatchByRef('2026002417', o); return 'resolved'; } catch (e) { return e instanceof DfError ? e.code : 'other'; }
    };
    expect(await codeOf(() => ({ status: 404, body: { error: 'BATCH_NOT_FOUND' } }))).toBe('DF_NOT_FOUND');
    expect(await codeOf(() => ({ status: 403, body: {} }))).toBe('DF_REFUSED');
    expect(await codeOf(() => ({ status: 401, body: {} }))).toBe('DF_REFUSED');
    expect(await codeOf(() => ({ status: 502, body: {} }))).toBe('DF_UNAVAILABLE');
    expect(await codeOf(() => 'hang')).toBe('DF_UNAVAILABLE');
    expect(await codeOf(() => ({ status: 200, body: 'not json' }))).toBe('DF_BAD_RESPONSE');
    expect(await codeOf(() => ({ status: 200, body: { batch: null, payments: [] } }))).toBe('DF_BAD_RESPONSE');
    expect(await codeOf(() => ({ status: 200, body: { ...batchAnswer(), payments: undefined } }))).toBe('DF_BAD_RESPONSE');
    // An answer about another batch is not an answer about this one.
    expect(await codeOf(() => ({ status: 200, body: batchAnswer({ batchRef: '2026000001' }) }))).toBe('DF_BAD_RESPONSE');
    expect(await codeOf(() => ({ status: 200, body: {} }), { ...opts(), baseUrl: 'http://127.0.0.1:1' })).toBe('DF_UNAVAILABLE');
  });

  it('a reference that is not one is never sent anywhere', async () => {
    await expect(fetchBatchByRef('../admin/users', opts())).rejects.toMatchObject({ code: 'DF_NOT_FOUND' });
    expect(seen).toEqual([]);
  });
});

describe('fetchFinancer / fetchFinancerBatches', () => {
  it('the financer, checked to be the one asked about', async () => {
    reply = () => ({ status: 200, body: { hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LWallet', lanaDiscountWalletSetAt: '2026-10-08' } });
    expect(await fetchFinancer(HEX, opts())).toMatchObject({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LWallet', lanaDiscountWalletSetAt: '2026-10-08', wallets: {}, perCurrency: false });
    expect(seen[0].url).toBe(`/api/admin/financers/${HEX}`);
    reply = () => ({ status: 200, body: { hexId: 'd'.repeat(64), isInvestor: true } });
    await expect(fetchFinancer(HEX, opts())).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
    reply = () => ({ status: 200, body: { hexId: HEX } });
    await expect(fetchFinancer(HEX, opts())).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
  });

  it('the financer flag (owner, 9 Oct 2026): a financer is an investor Direct.Fund marks one — isFinancer is both', async () => {
    reply = () => ({ status: 200, body: { hexId: HEX, isInvestor: true, financer: true, lanaDiscountWallet: null, wallets: {} } });
    expect(await fetchFinancer(HEX, opts())).toMatchObject({ isInvestor: true, financer: true, isFinancer: true });
    // An investor whose flag is off (every investor but the financing companies' representatives) is no financer.
    reply = () => ({ status: 200, body: { hexId: HEX, isInvestor: true, financer: false, lanaDiscountWallet: 'LOld', wallets: { EUR: { walletId: 'LEur' } } } });
    expect(await fetchFinancer(HEX, opts())).toMatchObject({ isInvestor: true, financer: false, isFinancer: false });
    // A flag on a key that is no investor makes nobody a financer.
    expect(parseFinancer({ hexId: HEX, isInvestor: false, financer: true }, HEX)).toMatchObject({ financer: true, isFinancer: false });
  });

  it('a Direct.Fund before the flag (the field ABSENT): isInvestor stands for it, as before; a flag that is not true or false fails the answer', () => {
    expect(parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: null }, HEX)).toMatchObject({ financer: true, isFinancer: true });
    expect(parseFinancer({ hexId: HEX, isInvestor: false, lanaDiscountWallet: null }, HEX)).toMatchObject({ financer: false, isFinancer: false });
    for (const financer of [null, 1, 0, 'true', 'yes', {}, []]) {
      expect(() => parseFinancer({ hexId: HEX, isInvestor: true, financer }, HEX), JSON.stringify(financer)).toThrow(DfError);
    }
  });

  it('wallets per currency (owner, 9 Oct 2026): each currency its own, read from the peer route', async () => {
    reply = () => ({ status: 200, body: {
      hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LOld', lanaDiscountWalletSetAt: '2026-10-08',
      wallets: { EUR: { walletId: 'LEur', setAt: '2026-10-08 10:00:00' }, GBP: { walletId: 'LGbp', setAt: '2026-10-09 08:00:00' } },
    } });
    const f = await fetchFinancer(HEX, opts());
    expect(f).toMatchObject({ wallets: { EUR: 'LEur', GBP: 'LGbp' }, perCurrency: true, lanaDiscountWallet: 'LOld' });
    expect([f.walletFor('EUR'), f.walletFor('GBP'), f.walletFor(' gbp '), f.walletFor('USD'), f.walletFor(null), f.walletFor('EURO')])
      .toEqual(['LEur', 'LGbp', 'LGbp', null, null, null]);
  });

  it('a Direct.Fund before wallets per currency (the field ABSENT): every currency falls back to its one wallet; an EMPTY list ({}) means none, never the fallback', () => {
    const old = parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LOld', lanaDiscountWalletSetAt: null }, HEX);
    expect(old.perCurrency).toBe(false);
    expect([old.walletFor('EUR'), old.walletFor('GBP'), old.walletFor(null)]).toEqual(['LOld', 'LOld', 'LOld']);
    const none = parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LOld', lanaDiscountWalletSetAt: null, wallets: {} }, HEX);
    expect(none.perCurrency).toBe(true);
    expect([none.walletFor('EUR'), none.walletFor('GBP'), none.walletFor(null)]).toEqual([null, null, null]);
    // Neither wallet: nothing for any currency, either way.
    const nothing = parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: null }, HEX);
    expect(nothing.walletFor('EUR')).toBeNull();
  });

  it('an entry that is no currency or names no wallet is no wallet (as Direct.Fund counts it); wallets that are not a list by currency fail the answer', () => {
    const f = parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LOld', wallets: {
      EUR: { walletId: 'LEur' }, gbp: { walletId: 'LLower' }, USD: { walletId: '' }, CHF: { walletId: 7 }, JPY: null, EURO: { walletId: 'LLong' }, SEK: 'LBare',
    } }, HEX);
    expect(f.wallets).toEqual({ EUR: 'LEur', SEK: 'LBare' });
    expect([f.walletFor('GBP'), f.walletFor('USD'), f.walletFor('CHF'), f.walletFor('JPY')]).toEqual([null, null, null, null]);
    for (const wallets of [null, [], 'LEur', 5]) {
      expect(() => parseFinancer({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LOld', wallets }, HEX), JSON.stringify(wallets)).toThrow(DfError);
    }
    expect(currencyCode(' eur ')).toBe('EUR');
    expect([currencyCode('EURO'), currencyCode(''), currencyCode(null), currencyCode(978)]).toEqual([null, null, null, null]);
  });

  it('the batches, with their purchases deduplicated and blanks dropped', async () => {
    reply = () => ({ status: 200, body: { batches: [
      { batchRef: '2026002417', status: 'paid', currency: 'EUR', totalAmount: 10, paymentCount: 2, confirmedCount: 2, fundSettingId: 3,
        createdAt: 'c', closedAt: null, paidAt: 'p', transactionRefs: ['T1', 'T1', '', 7, 'T2'] },
      { batchRef: 'bad ref', status: 'paid', transactionRefs: ['T3'] },
    ] } });
    const list = await fetchFinancerBatches(HEX, opts());
    expect(seen[0].url).toBe(`/api/admin/financers/${HEX}/lana-discount-batches`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ batchRef: '2026002417', status: 'paid', transactionRefs: ['T1', 'T2'], closedAt: null });
  });
});

describe('fetchFinancerUnpaidParts (9 Oct 2026: what a confirmed batch waits on)', () => {
  const part = (over: Record<string, unknown> = {}) => ({
    transactionRef: 'T1', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR',
    batchRef: '2026002433', batchStatus: 'closed', ...over,
  });

  it('asks for the purchases in one call — each once, encoded — with the peer key, and reads the parts', async () => {
    reply = () => ({ status: 200, body: { parts: [part(), part({ transactionRef: 'T 2/x', batchRef: null, batchStatus: 'open', orderType: null, destinationType: '' })] } });
    const parts = await fetchFinancerUnpaidParts(HEX, ['T1', 'T 2/x', 'T1', '', 'a,b'], opts());
    expect(seen.map(s => s.url)).toEqual([`/api/admin/financers/${HEX}/unpaid-parts?refs=T1,T%202%2Fx`]);
    expect(seen[0].auth).toBe('Bearer peer-key');
    expect(seen[0].cacheControl).toBe('no-cache');
    expect(parts).toEqual([
      { transactionRef: 'T1', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR', batchRef: '2026002433', batchStatus: 'closed' },
      // In no batch: no batch status either; what Direct.Fund did not say reads as unknown.
      { transactionRef: 'T 2/x', orderType: '', destinationType: null, amount: 0.25, currency: 'EUR', batchRef: null, batchStatus: null },
    ]);
  });

  it('nothing to ask: no call at all', async () => {
    expect(await fetchFinancerUnpaidParts(HEX, [], opts())).toEqual([]);
    expect(await fetchFinancerUnpaidParts(HEX, ['', ' '], opts())).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('a part about a purchase not asked about is dropped; a part it cannot read whole fails the answer — never a shorter list', async () => {
    reply = () => ({ status: 200, body: { parts: [part(), part({ transactionRef: 'NOT-ASKED' })] } });
    expect((await fetchFinancerUnpaidParts(HEX, ['T1'], opts())).map(p => p.transactionRef)).toEqual(['T1']);
    for (const bad of [{ amount: '0.25' }, { amount: null }, { currency: '' }, { transactionRef: null }]) {
      reply = () => ({ status: 200, body: { parts: [part(), part(bad)] } });
      await expect(fetchFinancerUnpaidParts(HEX, ['T1'], opts()), JSON.stringify(bad)).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
    }
    reply = () => ({ status: 200, body: { list: [] } });
    await expect(fetchFinancerUnpaidParts(HEX, ['T1'], opts())).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
  });

  it('a Direct.Fund without the route: 404 DF_NOT_FOUND, 403 DF_REFUSED; more than it takes is never sent', async () => {
    reply = () => ({ status: 404, body: {} });
    await expect(fetchFinancerUnpaidParts(HEX, ['T1'], opts())).rejects.toMatchObject({ code: 'DF_NOT_FOUND' });
    reply = () => ({ status: 403, body: {} });
    await expect(fetchFinancerUnpaidParts(HEX, ['T1'], opts())).rejects.toMatchObject({ code: 'DF_REFUSED' });
    seen.length = 0;
    const many = Array.from({ length: MAX_UNPAID_REFS + 1 }, (_, i) => `T${i}`);
    await expect(fetchFinancerUnpaidParts(HEX, many, opts())).rejects.toBeInstanceOf(DfError);
    await expect(fetchFinancerUnpaidParts(HEX, ['x'.repeat(8000)], opts())).rejects.toBeInstanceOf(DfError);
    await expect(fetchFinancerUnpaidParts('not-hex', ['T1'], opts())).rejects.toBeInstanceOf(DfError);
    expect(seen).toEqual([]);
  });
});
