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
import { fetchBatchByRef, fetchFinancer, fetchFinancerBatches, fetchFinancerUnpaidParts, DfError, parseBatchByRef, MAX_UNPAID_REFS } from './dfClient';

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
    expect(await fetchFinancer(HEX, opts())).toEqual({ hexId: HEX, isInvestor: true, lanaDiscountWallet: 'LWallet', lanaDiscountWalletSetAt: '2026-10-08' });
    expect(seen[0].url).toBe(`/api/admin/financers/${HEX}`);
    reply = () => ({ status: 200, body: { hexId: 'd'.repeat(64), isInvestor: true } });
    await expect(fetchFinancer(HEX, opts())).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
    reply = () => ({ status: 200, body: { hexId: HEX } });
    await expect(fetchFinancer(HEX, opts())).rejects.toMatchObject({ code: 'DF_BAD_RESPONSE' });
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
