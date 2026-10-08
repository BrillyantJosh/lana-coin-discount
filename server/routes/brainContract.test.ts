// @vitest-environment node
/**
 * THE BRAIN'S CONTRACT, BYTE FOR BYTE — AND THE TREASURY'S DOOR, NARROWED.
 *
 * lana-brain books any non-2xx on POST /api/brain/lana-order as a FAILED leg
 * and closes the purchase (7–8 Oct 2026: ten cash purchases falsely settled).
 * It is being hardened to re-POST the same order with the same body after a
 * timeout, so the second answer must be exactly 409 {status:'exists'}. It knows
 * pending | sent | confirmed | cancelled and 404 {status:'not_found'}; our own
 * 'sending' must reach it as 'pending'. These tests mount the real router on
 * the production DDL and pin those answers, plus what 'sending' refuses
 * (cancel, redirect, fix-wallet) and the admin batch route's new rules: the
 * treasury confirms only money on its own account, says so, and gets its batch
 * from Direct.Fund — never from the body, never over a financer.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

const fake = vi.hoisted(() => ({ dfBase: '' }));
vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../lib/roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});
vi.mock('../lib/directFund.js', () => ({ DIRECT_FUND_URL: fake.dfBase }));
vi.mock('../lib/electrum.js', () => ({
  electrumCall: async () => { throw new Error('no chain in this test'); },
  fetchBatchBalances: async (_s: unknown, wallets: string[]) => wallets.map(w => ({ wallet_id: w, confirmedBalance: 1234.5, unconfirmedBalance: 6 })),
}));

// ─── a Direct.Fund, started before the router is loaded ───────────────────

const df = {
  batches: new Map<string, unknown>(),
  hits: [] as string[],
  auth: [] as Array<string | undefined>,
  down: false,
};
const dfServer = http.createServer((req, res) => {
  df.hits.push(String(req.url));
  df.auth.push(req.headers.authorization);
  res.setHeader('content-type', 'application/json');
  if (df.down) { res.statusCode = 503; res.end('{}'); return; }
  const m = /^\/api\/admin\/batch-by-ref\/([^/]+)$/.exec(String(req.url));
  const b = m && df.batches.get(decodeURIComponent(m[1]));
  if (!b) { res.statusCode = 404; res.end('{"error":"BATCH_NOT_FOUND"}'); return; }
  res.end(JSON.stringify(b));
});
await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
fake.dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;
process.env.FUND_PEER_KEY = 'peer-test';

const { getDbHandle } = await import('../db/index.js');
const { default: apiRouter } = await import('./api');
const { keepRawBody } = await import('../lib/nip98Auth');
const { newSigner, nip98Header } = await import('../lib/nip98TestKit');
const { privateKeyToPublicKey, publicKeyToAddress } = await import('../lib/transaction');

const db: Database.Database = getDbHandle();
const admin = newSigner();
const FIN = 'f'.repeat(64);
const OTHER = 'e'.repeat(64);
const API_KEY = 'ldk_contract_test';
const WALLET = publicKeyToAddress(privateKeyToPublicKey('1a'.repeat(32)));
const WALLET2 = publicKeyToAddress(privateKeyToPublicKey('2b'.repeat(32)));

const app = express();
app.use(express.json({ verify: keepRawBody }));
app.use('/api', apiRouter);
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => dfServer.close(() => r()));
});

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batch_payments', 'incoming_batches', 'purchase_settlement', 'brain_callback_outbox', 'api_keys', 'admin_users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO api_keys (key_hash, app_name, created_by) VALUES (?, 'lana-brain', 'test')").run(createHash('sha256').update(API_KEY).digest('hex'));
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('buyback_wallet_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(WALLET2);
  df.batches.clear();
  df.hits = [];
  df.auth = [];
  df.down = false;
});

const brain = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};
const asAdmin = async (method: string, path: string, body?: unknown) => {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: nip98Header(admin, { method, url: path, body: raw }) },
    body: raw,
  });
  return { status: r.status, body: await r.json() as any };
};
const ORDER = {
  order_id: 'lo-1', tx_ref: 'T1', order_type: 'investor_lana', to_wallet: WALLET, to_hex: FIN,
  lana_amount: 39062500, fiat_value: 5, currency: 'EUR', exchange_rate: 0.128,
};
const legRow = (id: string) => db.prepare('SELECT * FROM brain_lana_orders WHERE id = ?').get(id) as any;
const setStatus = (id: string, status: string, extra = '') => db.prepare(`UPDATE brain_lana_orders SET status = ?${extra} WHERE id = ?`).run(status, id);

// ─── the brain's own routes ───────────────────────────────────────────────

describe('POST /api/brain/lana-order', () => {
  it('201 {status, order_id, buyback_wallet}; the leg is stored pending, owned by nobody yet', async () => {
    const r = await brain('POST', '/api/brain/lana-order', ORDER);
    expect(r).toEqual({ status: 201, body: { status: 'pending', order_id: 'lo-1', buyback_wallet: WALLET2 } });
    expect(legRow('lo-1')).toMatchObject({ status: 'pending', transaction_ref: 'T1', send_txid: null, must_spend_json: null, brain_authorized: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM purchase_settlement').get()).toEqual({ c: 0 });
  });

  it('the same order again is exactly 409 {status:"exists"} — whatever became of the first, sending and sent included', async () => {
    await brain('POST', '/api/brain/lana-order', ORDER);
    for (const status of ['pending', 'sending', 'sent', 'cancelled']) {
      setStatus('lo-1', status);
      const r = await brain('POST', '/api/brain/lana-order', ORDER);
      expect(r).toEqual({ status: 409, body: { status: 'exists', error: 'Order already exists' } });
      expect(legRow('lo-1').status).toBe(status);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM brain_lana_orders').get()).toEqual({ c: 1 });
  });

  it('a leg of a purchase a financer settles is taken as before — 201, and the owner row covers it', async () => {
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('T1', ?, 'financer', ?)").run(FIN, FIN);
    const r = await brain('POST', '/api/brain/lana-order', { ...ORDER, order_id: 'lo-late', order_type: 'caretaker_commission' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
  });
});

describe('GET /api/brain/lana-order/:id', () => {
  beforeEach(async () => { await brain('POST', '/api/brain/lana-order', ORDER); });

  it("reports pending, sent and cancelled as they are, and 'sending' as 'pending'", async () => {
    const pending = await brain('GET', '/api/brain/lana-order/lo-1');
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'pending', order_id: 'lo-1', tx_hash: null, lana_amount: 39062500, to_wallet: WALLET, cancel_reason: null });
    expect(Object.keys(pending.body).sort()).toEqual(['cancel_reason', 'completed_at', 'created_at', 'lana_amount', 'order_id', 'status', 'to_wallet', 'tx_hash']);

    setStatus('lo-1', 'sending', ", send_txid = 'aa'");
    expect((await brain('GET', '/api/brain/lana-order/lo-1')).body).toMatchObject({ status: 'pending', tx_hash: null });

    setStatus('lo-1', 'sent', `, tx_hash = '${'cd'.repeat(32)}'`);
    expect((await brain('GET', '/api/brain/lana-order/lo-1')).body).toMatchObject({ status: 'sent', tx_hash: 'cd'.repeat(32) });

    setStatus('lo-1', 'cancelled', ", cancel_reason = 'safe window'");
    expect((await brain('GET', '/api/brain/lana-order/lo-1')).body).toMatchObject({ status: 'cancelled', cancel_reason: 'safe window' });
  });

  it('an unknown id is 404 {status:"not_found"}', async () => {
    expect(await brain('GET', '/api/brain/lana-order/no-such')).toEqual({ status: 404, body: { status: 'not_found' } });
  });
});

describe('POST /api/brain/authorize-send and GET /api/brain/buyback-balance', () => {
  it('authorises every leg of the refs, once', async () => {
    await brain('POST', '/api/brain/lana-order', ORDER);
    await brain('POST', '/api/brain/lana-order', { ...ORDER, order_id: 'lo-2', order_type: 'merchant_commission' });
    expect(await brain('POST', '/api/brain/authorize-send', { transaction_refs: ['T1'] })).toEqual({ status: 200, body: { success: true, authorized: 2 } });
    expect(await brain('POST', '/api/brain/authorize-send', { transaction_refs: ['T1'] })).toEqual({ status: 200, body: { success: true, authorized: 0 } });
    expect((await brain('POST', '/api/brain/authorize-send', { transaction_refs: [] })).status).toBe(400);
  });

  it("still names the treasury's wallet and its balance", async () => {
    expect(await brain('GET', '/api/brain/buyback-balance')).toEqual({ status: 200, body: { wallet: WALLET2, balance: 1234.5, unconfirmed: 6 } });
  });
});

describe("a 'sending' leg is past changing", () => {
  beforeEach(async () => {
    await brain('POST', '/api/brain/lana-order', ORDER);
    setStatus('lo-1', 'sending', ", send_txid = 'aa'");
  });

  it('cancel: 409 too_late, leg untouched', async () => {
    const r = await brain('POST', '/api/brain/lana-order/lo-1/cancel', { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: 'too_late' });
    expect(legRow('lo-1').status).toBe('sending');
  });

  it('redirect: 409, wallet untouched', async () => {
    const r = await brain('POST', '/api/brain/lana-order/lo-1/redirect', { to_wallet: WALLET2, to_hex: OTHER });
    expect(r.status).toBe(409);
    expect(legRow('lo-1')).toMatchObject({ to_wallet: WALLET, to_hex: FIN });
  });

  it('fix-wallet: 409 NOT_PENDING, wallet untouched — and a pending leg is still fixed', async () => {
    const body = { table: 'brain_lana_orders', id: 'lo-1', field: 'to_wallet', new_value: WALLET2 };
    const r = await asAdmin('POST', '/api/admin/fix-wallet', body);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_PENDING');
    expect(legRow('lo-1').to_wallet).toBe(WALLET);
    for (const status of ['sent', 'cancelled']) {
      setStatus('lo-1', status);
      expect((await asAdmin('POST', '/api/admin/fix-wallet', body)).status).toBe(409);
    }
    setStatus('lo-1', 'pending', ', send_txid = NULL');
    const ok = await asAdmin('POST', '/api/admin/fix-wallet', body);
    expect(ok.status).toBe(200);
    expect(legRow('lo-1').to_wallet).toBe(WALLET2);
  });

  it('pending (cancellable) legs are still cancelled as before', async () => {
    setStatus('lo-1', 'pending');
    expect(await brain('POST', '/api/brain/lana-order/lo-1/cancel', { reason: 'x' })).toEqual({ status: 200, body: { ok: true, status: 'cancelled' } });
  });
});

// ─── the treasury's door ──────────────────────────────────────────────────

describe('PUT /api/admin/incoming-batches/:batchRef/status', () => {
  const PATH = (ref: string) => `/api/admin/incoming-batches/${ref}/status`;
  const dfBatch = (ref: string, payments: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => df.batches.set(ref, {
    batch: { batchRef: ref, investorHex: FIN, totalAmount: 30, currency: 'EUR', paymentCount: payments.length, confirmedCount: payments.length,
      status: 'paid', destinationType: 'lana_discount', fundSettingId: 1, createdAt: 'c', paidAt: 'p', ...over },
    payments: payments.map((p, i) => ({ ppId: i + 1, amount: 10, currency: 'EUR', confirmed: true, investorHex: FIN, destinationType: 'lana_discount', orderStatus: 'pending', live: true, ...p })),
  });
  // What the page sends today. The server must not believe any of it.
  const pageBody = (extra: Record<string, unknown> = {}) => ({
    status: 'received', investorHex: OTHER, totalAmount: 99999, currency: 'GBP', paymentCount: 1,
    payments: [{ ppId: 99, transactionRef: 'T-FROM-BODY', amountFiat: 99999 }], ...extra,
  });
  const leg = (id: string, ref: string) =>
    db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate)
                VALUES (?, ?, 'merchant_commission', 'L', 'h', 1, 1, 'EUR', 1)`).run(id, ref);
  const owners = () => db.prepare('SELECT transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by FROM purchase_settlement ORDER BY transaction_ref').all();
  const outbox = () => db.prepare('SELECT dedupe_key, body_json FROM brain_callback_outbox').all();

  it('"received" without saying the money is on the treasury account: 400, Direct.Fund not even asked', async () => {
    dfBatch('B1', [{ transactionRef: 'T1' }]);
    const r = await asAdmin('PUT', PATH('B1'), pageBody());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TREASURY_FLAG_REQUIRED');
    expect(df.hits).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM incoming_batches').get()).toEqual({ c: 0 });
    expect(outbox()).toEqual([]);
  });

  it('"received" with the flag: the batch from Direct.Fund, the purchases the treasury\'s, one brain call queued', async () => {
    dfBatch('B1', [{ transactionRef: 'T1' }, { transactionRef: 'T2' }, { transactionRef: 'T1' }, { transactionRef: 'T-GONE', live: false }, { transactionRef: null }]);
    leg('L1', 'T1');
    leg('L2', 'T2');
    const r = await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true }));
    expect(r.status).toBe(200);
    expect(r.body.batch).toMatchObject({ batch_ref: 'B1', status: 'received', settled_by: 'treasury', investor_hex: FIN, total_amount: 30, currency: 'EUR', payment_count: 5 });
    expect(df.hits).toEqual(['/api/admin/batch-by-ref/B1']);
    expect(df.auth).toEqual(['Bearer peer-test']);
    expect(owners()).toEqual([
      { transaction_ref: 'T1', owner_hex: FIN, settled_by: 'treasury', batch_ref: 'B1', confirmed_by: admin.hex },
      { transaction_ref: 'T2', owner_hex: FIN, settled_by: 'treasury', batch_ref: 'B1', confirmed_by: admin.hex },
    ]);
    expect(db.prepare("SELECT id, batch_ref FROM brain_lana_orders ORDER BY id").all()).toEqual([{ id: 'L1', batch_ref: 'B1' }, { id: 'L2', batch_ref: 'B1' }]);
    expect(outbox()).toEqual([{ dedupe_key: 'fiat-received:B1', body_json: '{"batch_ref":"B1","transaction_refs":["T1","T2"]}' }]);
    // A second press: same rows, no second call.
    expect((await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true }))).status).toBe(200);
    expect(owners()).toHaveLength(2);
    expect(outbox()).toHaveLength(1);
  });

  it('refused (409) when any purchase is a financer\'s, or the batch was confirmed by one — and nothing is written', async () => {
    dfBatch('B1', [{ transactionRef: 'T1' }, { transactionRef: 'T2' }]);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('T2', ?, 'financer', ?)").run(FIN, FIN);
    const r = await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'OWNER_CONFLICT', refs: ['T2'] });
    expect(owners()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM incoming_batches').get()).toEqual({ c: 0 });
    expect(outbox()).toEqual([]);

    db.prepare('DELETE FROM purchase_settlement').run();
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B1', ?, 30, 'EUR', 'received', 'financer')").run(FIN);
    expect((await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true }))).body.code).toBe('OWNER_CONFLICT');
    expect(owners()).toEqual([]);
  });

  it('Direct.Fund unreachable or without the batch: nothing is written', async () => {
    expect((await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true })))).toMatchObject({ status: 404, body: { code: 'BATCH_NOT_FOUND' } });
    dfBatch('B1', [{ transactionRef: 'T1' }]);
    df.down = true;
    expect((await asAdmin('PUT', PATH('B1'), pageBody({ treasuryReceived: true })))).toMatchObject({ status: 502, body: { code: 'DF_UNAVAILABLE' } });
    expect(db.prepare('SELECT COUNT(*) c FROM incoming_batches').get()).toEqual({ c: 0 });
  });

  it("'lana_bought' releases legs to the auto-sender, so only on a batch the treasury settles", async () => {
    // No batch here yet.
    expect((await asAdmin('PUT', PATH('B1'), { status: 'lana_bought' })).body.code).toBe('BATCH_NOT_RECEIVED');

    // A financer's batch.
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B-FIN', ?, 1, 'EUR', 'received', 'financer')").run(FIN);
    expect((await asAdmin('PUT', PATH('B-FIN'), { status: 'lana_bought' })).body.code).toBe('OWNER_CONFLICT');

    // A batch from before 8 Oct whose purchase nobody owns yet, with a leg still to send.
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status) VALUES ('B-OLD', '', 1, 'EUR', 'received')").run();
    leg('L-OLD', 'T-OLD');
    db.prepare("UPDATE brain_lana_orders SET batch_ref = 'B-OLD' WHERE id = 'L-OLD'").run();
    expect((await asAdmin('PUT', PATH('B-OLD'), { status: 'lana_bought' })).body.code).toBe('NOT_TREASURY');
    expect((db.prepare("SELECT status FROM incoming_batches WHERE batch_ref = 'B-OLD'").get() as any).status).toBe('received');

    // The treasury's own: allowed.
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('T-OLD', '', 'treasury', 'migration')").run();
    const ok = await asAdmin('PUT', PATH('B-OLD'), { status: 'lana_bought', notes: "it's bought" });
    expect(ok.status).toBe(200);
    expect(ok.body.batch).toMatchObject({ status: 'lana_bought', notes: "it's bought" });
    expect(ok.body.batch.lana_bought_at).toBeTruthy();
  });
});
