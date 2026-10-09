// @vitest-environment node
/**
 * /api/financer — A FINANCER CONFIRMS THEIR OWN INTERNAL BATCHES, AND NOTHING ELSE.
 *
 * The router is real, so are the NIP-98 signatures (nip98TestKit) and the
 * SQLite DDL (roundMandateTestKit → db/financerSchema.ts). Direct.Fund is a
 * real HTTP server in this process, so every confirm is seen to ASK it, and
 * the Registrar is a stand-in fetch.
 *
 * What is pinned: the signer is the only identity; a batch is built from
 * Direct.Fund's fresh answer and never from the body; every refusal in the
 * confirm rules leaves no trace (no batch, no owner, no brain call); a repeat by
 * the same financer changes nothing but an unfinished brain call; ownership of
 * a purchase cannot pass from the treasury to a financer, or from one financer
 * to another; a key that is not a financer costs Direct.Fund one call, and
 * only the signer's own batches are read (C9); a payment Direct.Fund no longer
 * counts is left out, not a reason to refuse the batch (C14); and a held batch
 * (2026002293) is the administrator's to decide (C12).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../lib/roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { getDbHandle } from '../db/index.js';
import { createFinancerRouter, chooseWaitingBatches } from './financer';
import { recordTreasuryReceived, heldBatches } from '../lib/financer/confirm';
import { parseBatchByRef } from '../lib/financer/dfClient';
import { ownerMismatchPurchases, forgetUnownedMismatches } from '../lib/financer/sends';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';

const db: Database.Database = getDbHandle();
const me = newSigner();
const other = newSigner();
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';

// ─── a Direct.Fund that answers what each test says ───────────────────────

interface FakePayment {
  ppId: number; amount: number; currency: string; confirmed: boolean; transactionRef: string | null;
  investorHex: string; destinationType: string; orderStatus: string; live: boolean; orderType?: string;
}
const dfWorld = {
  batches: new Map<string, { batch: Record<string, unknown>; payments: FakePayment[] }>(),
  /** `wallets`: Direct.Fund's wallets per currency (9 Oct 2026); absent, a Direct.Fund before them. */
  financers: new Map<string, { isInvestor: boolean; lanaDiscountWallet: string | null; wallets?: Record<string, { walletId: string; setAt: string | null }> }>(),
  hits: [] as string[],
  auth: [] as Array<string | undefined>,
  down: false,
  /** Only batch-by-ref fails (the financer and their list still answer). */
  batchDown: false,
  /** Listed for the signer, but batch-by-ref no longer knows it. */
  ghosts: [] as string[],
  /** What unpaid-parts knows as not paid yet (answered for the asked references only), and how it answers. */
  unpaid: [] as Array<Record<string, unknown>>,
  unpaidStatus: 200,
  /** The references each unpaid-parts call asked about, in order. */
  unpaidAsks: [] as string[][],
};
let dfServer: http.Server;
let dfBase = '';

function dfBatch(ref: string, investor: TestSigner | string, over: Record<string, unknown> = {}, payments?: Partial<FakePayment>[]) {
  const hex = typeof investor === 'string' ? investor : investor.hex;
  const pays: FakePayment[] = (payments ?? [{}, {}]).map((p, i) => ({
    ppId: i + 1, amount: 10, currency: 'EUR', confirmed: true, transactionRef: `${ref}-T${i + 1}`,
    investorHex: hex, destinationType: 'lana_discount', orderStatus: 'pending', live: true, orderType: 'cash', ...p,
  }));
  dfWorld.batches.set(ref, {
    batch: { batchRef: ref, investorHex: hex, totalAmount: pays.reduce((s, p) => s + p.amount, 0), currency: 'EUR',
      paymentCount: pays.length, confirmedCount: pays.filter(p => p.confirmed).length, status: 'paid',
      destinationType: 'lana_discount', fundSettingId: 5, createdAt: '2026-10-08 09:00:00', paidAt: '2026-10-08 10:00:00', ...over },
    payments: pays,
  });
}

// ─── the app ──────────────────────────────────────────────────────────────

let registrar: (walletId: string) => unknown;
/** The wallets the Registrar was asked about, in order. */
let registrarAsks: string[] = [];
const walletFetch = (async (_url: any, init: any) => {
  const { wallet_id } = JSON.parse(String(init.body));
  registrarAsks.push(wallet_id);
  return new Response(JSON.stringify(registrar(wallet_id)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let server: http.Server;
let base = '';

beforeAll(async () => {
  dfServer = http.createServer((req, res) => {
    const url = String(req.url);
    dfWorld.hits.push(url);
    dfWorld.auth.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    if (dfWorld.down) { res.statusCode = 503; res.end('{}'); return; }
    let m = /^\/api\/admin\/batch-by-ref\/([^/]+)$/.exec(url);
    if (m) {
      if (dfWorld.batchDown) { res.statusCode = 503; res.end('{}'); return; }
      const b = dfWorld.batches.get(decodeURIComponent(m[1]));
      if (!b) { res.statusCode = 404; res.end('{"error":"BATCH_NOT_FOUND"}'); return; }
      res.end(JSON.stringify(b));
      return;
    }
    m = /^\/api\/admin\/financers\/([0-9a-f]{64})\/unpaid-parts\?refs=(.*)$/.exec(url);
    if (m) {
      const refs = m[2].split(',').map(decodeURIComponent);
      dfWorld.unpaidAsks.push(refs);
      if (dfWorld.unpaidStatus !== 200) { res.statusCode = dfWorld.unpaidStatus; res.end('{}'); return; }
      res.end(JSON.stringify({ parts: dfWorld.unpaid.filter(p => refs.includes(String(p.transactionRef))) }));
      return;
    }
    m = /^\/api\/admin\/financers\/([0-9a-f]{64})(\/lana-discount-batches)?$/.exec(url);
    if (m) {
      if (m[2]) {
        const batches = [...dfWorld.batches.values()]
          .filter(b => b.batch.investorHex === m![1])
          .map(b => ({ ...b.batch, closedAt: null, transactionRefs: b.payments.map(p => p.transactionRef).filter(Boolean) }));
        for (const ghost of dfWorld.ghosts) batches.push({ batchRef: ghost, status: 'paid', transactionRefs: [] } as any);
        res.end(JSON.stringify({ batches }));
        return;
      }
      const f = dfWorld.financers.get(m[1]) ?? { isInvestor: false, lanaDiscountWallet: null };
      res.end(JSON.stringify({ hexId: m[1], ...f, lanaDiscountWalletSetAt: f.lanaDiscountWallet ? '2026-10-08' : null }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
  dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use('/api/financer', createFinancerRouter({
    walletCheckBaseUrl: 'http://check.test',
    df: { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) },
    walletFetch,
  }));
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => dfServer.close(() => r()));
});

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batch_payments', 'incoming_batches', 'purchase_settlement', 'brain_callback_outbox']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  dfWorld.batches.clear();
  dfWorld.financers.clear();
  dfWorld.hits = [];
  dfWorld.auth = [];
  dfWorld.down = false;
  dfWorld.batchDown = false;
  dfWorld.ghosts = [];
  dfWorld.unpaid = [];
  dfWorld.unpaidStatus = 200;
  dfWorld.unpaidAsks = [];
  registrar = () => ({ registered: true, frozen: false, wallet_type: 'Lana.Discount', nostr_hex_id: me.hex });
  registrarAsks = [];
});

// ─── helpers ──────────────────────────────────────────────────────────────

const call = async (who: TestSigner | null, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const url = `/api/financer${path}`;
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = nip98Header(who, { method, url, body: raw });
  const r = await fetch(base + url, { method, headers, body: raw });
  return { status: r.status, body: await r.json() as any };
};
const confirm = (who: TestSigner, batchRefs: unknown, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', '/batches/confirm', { batchRefs, ...extra });

let n = 0;
const leg = (ref: string, o: { type?: string; toHex?: string; status?: string; auth?: 0 | 1 } = {}) =>
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized)
              VALUES (?, ?, ?, 'L', ?, 100000000, 1, 'EUR', 1, ?, ?)`)
    .run(`O${++n}`, ref, o.type ?? 'merchant_commission', o.toHex ?? 'x', o.status ?? 'pending', o.auth ?? 0);
const owners = () => db.prepare('SELECT transaction_ref, owner_hex, settled_by, batch_ref FROM purchase_settlement ORDER BY transaction_ref').all() as any[];
const outbox = () => db.prepare('SELECT kind, dedupe_key, body_json FROM brain_callback_outbox ORDER BY id').all() as any[];
const localBatch = (ref: string) => db.prepare('SELECT * FROM incoming_batches WHERE batch_ref = ?').get(ref) as any;
const nothingWritten = () => {
  expect(owners()).toEqual([]);
  expect(outbox()).toEqual([]);
  expect((db.prepare('SELECT COUNT(*) c FROM incoming_batches').get() as any).c).toBe(0);
};
/** The Direct.Fund reads of single batches (the per-reference calls). */
const batchHits = () => dfWorld.hits.filter(h => h.startsWith('/api/admin/batch-by-ref/'));
const financers = (...who: TestSigner[]) => { for (const w of who) dfWorld.financers.set(w.hex, { isInvestor: true, lanaDiscountWallet: null }); };

// ─── confirm ──────────────────────────────────────────────────────────────

describe('POST /api/financer/batches/confirm', () => {
  beforeEach(() => financers(me, other));

  it('an unsigned request, or one signed for another body, changes nothing', async () => {
    dfBatch('B1', me);
    const r = await call(null, 'POST', '/batches/confirm', { batchRefs: ['B1'] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
    const forged = await fetch(`${base}/api/financer/batches/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: nip98Header(me, { method: 'POST', url: '/api/financer/batches/confirm', body: '{"batchRefs":["B9"]}' }) },
      body: JSON.stringify({ batchRefs: ['B1'] }),
    });
    expect(forged.status).toBe(403);
    expect(dfWorld.hits).toEqual([]);
    nothingWritten();
  });

  it('a paid internal batch of the signer: the batch, its owners, the leg links and the brain call, all from Direct.Fund', async () => {
    dfBatch('B1', me);
    leg('B1-T1', { type: 'investor_lana', toHex: me.hex });
    leg('B1-T1');
    leg('B1-T2');
    const r = await confirm(me, ['B1']);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ batchRef: 'B1', ok: true, alreadyConfirmed: false, transactionRefs: ['B1-T1', 'B1-T2'] }]);

    expect(dfWorld.hits).toEqual([`/api/admin/financers/${me.hex}`, `/api/admin/financers/${me.hex}/lana-discount-batches`, '/api/admin/batch-by-ref/B1']);
    expect(dfWorld.auth).toEqual(['Bearer peer-test', 'Bearer peer-test', 'Bearer peer-test']);
    expect(localBatch('B1')).toMatchObject({ status: 'received', settled_by: 'financer', investor_hex: me.hex, total_amount: 20, currency: 'EUR', payment_count: 2 });
    expect(localBatch('B1').received_at).toBeTruthy();
    expect((db.prepare('SELECT pp_id, amount_fiat FROM incoming_batch_payments ORDER BY pp_id').all())).toEqual([{ pp_id: 1, amount_fiat: 10 }, { pp_id: 2, amount_fiat: 10 }]);
    expect(owners()).toEqual([
      { transaction_ref: 'B1-T1', owner_hex: me.hex, settled_by: 'financer', batch_ref: 'B1' },
      { transaction_ref: 'B1-T2', owner_hex: me.hex, settled_by: 'financer', batch_ref: 'B1' },
    ]);
    expect((db.prepare("SELECT COUNT(*) c FROM brain_lana_orders WHERE batch_ref = 'B1'").get() as any).c).toBe(3);
    expect(outbox()).toEqual([{ kind: 'fiat-received', dedupe_key: 'fiat-received:B1', body_json: '{"batch_ref":"B1","transaction_refs":["B1-T1","B1-T2"]}' }]);
  });

  it('a repeat by the same financer is a quiet yes that changes nothing', async () => {
    dfBatch('B1', me);
    await confirm(me, ['B1']);
    db.prepare("UPDATE incoming_batches SET status = 'lana_sent' WHERE batch_ref = 'B1'").run();
    const r = await confirm(me, ['B1']);
    expect(r.body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect(localBatch('B1').status).toBe('lana_sent'); // not set back
    expect((db.prepare('SELECT COUNT(*) c FROM incoming_batch_payments').get() as any).c).toBe(2);
    expect(owners()).toHaveLength(2);
    expect(outbox()).toHaveLength(1);
    expect(batchHits()).toHaveLength(2); // asked afresh both times
  });

  const refusals: Array<[string, () => void, string]> = [
    ['another financer\'s batch', () => dfBatch('B1', other), 'NOT_YOUR_BATCH'],
    ['a bank batch, not an internal one', () => dfBatch('B1', me, { destinationType: 'bank' }), 'NOT_LANA_DISCOUNT'],
    ['a batch DF does not say is internal', () => dfBatch('B1', me, { destinationType: undefined }), 'NOT_LANA_DISCOUNT'],
    ['a batch not yet paid on Direct.Fund (closed)', () => dfBatch('B1', me, { status: 'closed' }), 'BATCH_NOT_PAID'],
    ['a batch still collecting (open)', () => dfBatch('B1', me, { status: 'open' }), 'BATCH_NOT_PAID'],
    ['a batch with no payments', () => dfBatch('B1', me, {}, []), 'NO_PAYMENTS'],
    ['a payment of another financer inside it', () => dfBatch('B1', me, {}, [{}, { investorHex: other.hex }]), 'PAYMENT_NOT_YOURS'],
    ['a bank payment inside it', () => dfBatch('B1', me, {}, [{}, { destinationType: 'bank' }]), 'NOT_LANA_DISCOUNT'],
    ['an unconfirmed payment', () => dfBatch('B1', me, {}, [{}, { confirmed: false }]), 'PAYMENT_NOT_CONFIRMED'],
    ['a payment naming no purchase', () => dfBatch('B1', me, {}, [{}, { transactionRef: null }]), 'PAYMENT_WITHOUT_REF'],
    ['a batch whose every payment Direct.Fund no longer counts', () => dfBatch('B1', me, {}, [{ live: false }, { live: false }]), 'NO_TRANSACTIONS'],
    ['a batch Direct.Fund does not list as the signer\'s', () => { /* nothing */ }, 'NOT_YOUR_BATCH'],
    ['a batch listed, but gone when it is read', () => { dfWorld.ghosts = ['B1']; }, 'BATCH_NOT_FOUND'],
    ['Direct.Fund answering the list but not the batch', () => { dfBatch('B1', me); dfWorld.batchDown = true; }, 'DF_UNAVAILABLE'],
  ];
  for (const [what, arrange, code] of refusals) {
    it(`refuses ${what} (${code}) and writes nothing`, async () => {
      arrange();
      leg('B1-T1');
      const r = await confirm(me, ['B1']);
      expect(r.status).toBe(200);
      expect(r.body.results).toHaveLength(1);
      expect(r.body.results[0]).toMatchObject({ batchRef: 'B1', ok: false, code });
      expect(typeof r.body.results[0].error).toBe('string');
      nothingWritten();
      expect((db.prepare('SELECT batch_ref FROM brain_lana_orders').get() as any).batch_ref).toBeNull();
    });
  }

  it('a purchase the treasury settles cannot pass to a financer (OWNER_CONFLICT)', async () => {
    dfBatch('B1', me);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('B1-T2', ?, 'treasury', 'admin')").run(me.hex);
    const r = await confirm(me, ['B1']);
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    expect(owners()).toHaveLength(1);
    expect(outbox()).toEqual([]);
    expect(localBatch('B1')).toBeUndefined();
  });

  it("one financer's purchase cannot pass to another (OWNER_CONFLICT)", async () => {
    dfBatch('B1', me);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('B1-T1', ?, 'financer', ?)").run(other.hex, other.hex);
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    expect(owners()).toEqual([{ transaction_ref: 'B1-T1', owner_hex: other.hex, settled_by: 'financer', batch_ref: null }]);
  });

  it('a batch the treasury already confirmed, or another financer, is refused whole', async () => {
    dfBatch('B1', me);
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B1', ?, 20, 'EUR', 'received', 'treasury')").run(me.hex);
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    db.prepare("UPDATE incoming_batches SET settled_by = NULL, status = 'lana_sent' WHERE batch_ref = 'B1'").run(); // a batch from before 8 Oct
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    db.prepare("UPDATE incoming_batches SET settled_by = 'financer', investor_hex = ? WHERE batch_ref = 'B1'").run(other.hex);
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    expect(owners()).toEqual([]);
    expect(outbox()).toEqual([]);
  });

  it('a batch only marked incoming here, by nobody, may still be taken', async () => {
    dfBatch('B1', me);
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status) VALUES ('B1', '', 0, 'EUR', 'incoming')").run();
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: false });
    expect(localBatch('B1')).toMatchObject({ status: 'received', settled_by: 'financer', investor_hex: me.hex, payment_count: 2 });
  });

  it('LANA of an unowned purchase already sent by the treasury: never owned now (OWNER_CONFLICT)', async () => {
    dfBatch('B1', me);
    leg('B1-T1', { status: 'sent' });
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    nothingWritten();
  });

  it("a purchase whose investor leg pays another financer is not the signer's (OWNER_MISMATCH)", async () => {
    dfBatch('B1', me);
    leg('B1-T2', { type: 'investor_lana', toHex: other.hex });
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_MISMATCH' });
    nothingWritten();
  });

  it('an empty, missing or malformed list of batches is refused before Direct.Fund is asked', async () => {
    for (const refs of [[], undefined, 'B1', [''], ['../x'], [7]]) {
      const r = await confirm(me, refs);
      expect(r.status).toBe(400);
      expect(['EMPTY_BATCH_REFS', 'BAD_BATCH_REF']).toContain(r.body.code);
    }
    expect((await confirm(me, Array.from({ length: 101 }, (_, i) => `B${i}`))).body.code).toBe('TOO_MANY_BATCHES');
    expect(dfWorld.hits).toEqual([]);
    nothingWritten();
  });

  it('a batch in the body is ignored: only what Direct.Fund says counts', async () => {
    dfBatch('B1', me);
    const r = await confirm(me, ['B1'], {
      investorHex: other.hex, totalAmount: 99999, status: 'paid',
      payments: [{ transactionRef: 'T-SMUGGLED', investorHex: me.hex, confirmed: true, live: true, destinationType: 'lana_discount' }],
    });
    expect(r.body.results[0].ok).toBe(true);
    expect(owners().map(o => o.transaction_ref)).toEqual(['B1-T1', 'B1-T2']);
    expect(localBatch('B1').total_amount).toBe(20);
    expect(JSON.parse(outbox()[0].body_json).transaction_refs).toEqual(['B1-T1', 'B1-T2']);
  });

  it('Direct.Fund is asked afresh every time — a batch paid a moment ago is seen paid', async () => {
    // With any cached read the second confirm would still see 'closed'.
    dfBatch('B1', me, { status: 'closed' });
    expect((await confirm(me, ['B1'])).body.results[0].code).toBe('BATCH_NOT_PAID');
    dfBatch('B1', me, { status: 'paid' });
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true });
    expect(batchHits()).toEqual(['/api/admin/batch-by-ref/B1', '/api/admin/batch-by-ref/B1']);
  });

  it('several batches: each judged on its own, one refusal stops none of the others', async () => {
    dfBatch('B1', me);
    dfBatch('B2', other);
    dfBatch('B3', me);
    const r = await confirm(me, ['B1', 'B2', 'B3', 'B1']);
    expect(r.body.results.map((x: any) => [x.batchRef, x.ok, x.code ?? null])).toEqual([
      ['B1', true, null], ['B2', false, 'NOT_YOUR_BATCH'], ['B3', true, null],
    ]);
    expect(outbox().map(o => o.dedupe_key)).toEqual(['fiat-received:B1', 'fiat-received:B3']);
  });

  // ── review C9: any key can sign, and every LD→DF call spends one shared
  // Direct.Fund rate-limit allowance — 15 requests of 100 made-up references
  // used to be 1,500 calls and a 15-minute stop for every financer and the treasury.

  it('a key Direct.Fund does not know as a financer: 403 NOT_FINANCER after ONE Direct.Fund call', async () => {
    const stranger = newSigner();
    dfBatch('B1', me);
    const r = await confirm(stranger, Array.from({ length: 100 }, (_, i) => `a${i + 1}`));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_FINANCER');
    expect(dfWorld.hits).toEqual([`/api/admin/financers/${stranger.hex}`]);
    nothingWritten();
  });

  it("only the signer's own batches are read: made-up references and another financer's answer NOT_YOUR_BATCH unasked", async () => {
    dfBatch('B1', me);
    dfBatch('B2', other);
    const refs = ['B1', 'B2', ...Array.from({ length: 98 }, (_, i) => `x${i}`)];
    const r = await confirm(me, refs);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(100);
    expect(r.body.results[0]).toMatchObject({ batchRef: 'B1', ok: true });
    expect(r.body.results.slice(1).every((x: any) => x.ok === false && x.code === 'NOT_YOUR_BATCH')).toBe(true);
    expect(dfWorld.hits).toHaveLength(3);
    expect(batchHits()).toEqual(['/api/admin/batch-by-ref/B1']);
  });

  it('Direct.Fund down: 502 DF_UNAVAILABLE, no batch asked about, nothing written', async () => {
    dfBatch('B1', me);
    leg('B1-T1');
    dfWorld.down = true;
    const r = await confirm(me, ['B1']);
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('DF_UNAVAILABLE');
    expect(batchHits()).toEqual([]);
    nothingWritten();
  });

  // ── review C14: a reallocation whose cancel of the old Direct.Fund order
  // failed leaves a stale order in the old financer's batch; Direct.Fund then
  // counts neither it nor the new one (live false). One such order must not
  // hold every other purchase of a batch for good.

  it('a payment Direct.Fund no longer counts is left out — the rest of the batch is confirmed, and the page is told', async () => {
    dfBatch('B1', me, {}, [{}, { live: false }, {}]);
    leg('B1-T1');
    leg('B1-T2');
    const r = await confirm(me, ['B1']);
    expect(r.body.results).toEqual([{
      batchRef: 'B1', ok: true, alreadyConfirmed: false, transactionRefs: ['B1-T1', 'B1-T3'],
      skippedRefs: ['B1-T2'], skippedPaymentIds: [2],
    }]);
    expect(owners().map(o => o.transaction_ref)).toEqual(['B1-T1', 'B1-T3']);
    expect(JSON.parse(outbox()[0].body_json).transaction_refs).toEqual(['B1-T1', 'B1-T3']);
    // Owned by nobody here, and not linked to this batch.
    expect(db.prepare("SELECT transaction_ref, batch_ref FROM brain_lana_orders ORDER BY transaction_ref").all())
      .toEqual([{ transaction_ref: 'B1-T1', batch_ref: 'B1' }, { transaction_ref: 'B1-T2', batch_ref: null }]);
  });

  it("a stale payment holds nothing, whoever it names: another financer's, unconfirmed, a bank one", async () => {
    dfBatch('B1', me, {}, [{}, { live: false, investorHex: other.hex, confirmed: false, destinationType: 'bank' }]);
    const r = await confirm(me, ['B1']);
    expect(r.body.results[0]).toMatchObject({ ok: true, transactionRefs: ['B1-T1'], skippedRefs: ['B1-T2'] });
    // A payment Direct.Fund DOES count keeps every check.
    dfBatch('B2', me, {}, [{}, { investorHex: other.hex }]);
    expect((await confirm(me, ['B2'])).body.results[0]).toMatchObject({ ok: false, code: 'PAYMENT_NOT_YOURS' });
  });

  it('a stale order and its counted replacement in one batch: the purchase is taken, not left out', async () => {
    dfBatch('B1', me, {}, [{ transactionRef: 'T-P', live: false }, { transactionRef: 'T-P' }]);
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, transactionRefs: ['T-P'], skippedRefs: [], skippedPaymentIds: [1] });
    expect(owners().map(o => o.transaction_ref)).toEqual(['T-P']);
  });

  it('once Direct.Fund counts the left-out purchase again, a repeat confirmation takes it in and tells the brain about it', async () => {
    dfBatch('B1', me, {}, [{}, { live: false }]);
    leg('B1-T2');
    await confirm(me, ['B1']);
    expect(owners().map(o => o.transaction_ref)).toEqual(['B1-T1']);

    dfBatch('B1', me); // untangled on Direct.Fund
    const r = await confirm(me, ['B1']);
    expect(r.body.results[0]).toEqual({ batchRef: 'B1', ok: true, alreadyConfirmed: true, transactionRefs: ['B1-T1', 'B1-T2'] });
    expect(owners().map(o => [o.transaction_ref, o.owner_hex])).toEqual([['B1-T1', me.hex], ['B1-T2', me.hex]]);
    expect(outbox()).toEqual([
      { kind: 'fiat-received', dedupe_key: 'fiat-received:B1', body_json: '{"batch_ref":"B1","transaction_refs":["B1-T1"]}' },
      { kind: 'fiat-received', dedupe_key: 'fiat-received:B1:2', body_json: '{"batch_ref":"B1","transaction_refs":["B1-T2"]}' },
    ]);
    expect((db.prepare("SELECT batch_ref FROM brain_lana_orders WHERE transaction_ref = 'B1-T2'").get() as any).batch_ref).toBe('B1');
  });

  // ── review C6/C11/C19: the way back for a fiat-received that stopped.

  it("a repeat confirmation brings back the batch's fiat-received when it gave up and a purchase still waits for approval", async () => {
    dfBatch('B1', me);
    leg('B1-T1', { auth: 0 });
    await confirm(me, ['B1']);
    db.prepare("UPDATE brain_callback_outbox SET last_error = 'GAVE_UP', created_at = '2026-09-01 00:00:00'").run();
    const r = await confirm(me, ['B1']);
    expect(r.body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: true });
    const row = db.prepare('SELECT done_at, last_error, created_at FROM brain_callback_outbox').get() as any;
    expect(row).toMatchObject({ done_at: null, last_error: null });
    expect(row.created_at > '2026-09-01 00:00:00').toBe(true);
    expect(outbox()).toHaveLength(1);
  });

  it("the treasury's repeat \"received\" does the same for a batch it settles", () => {
    dfBatch('B1', me);
    leg('B1-T1', { auth: 0 });
    const df = parseBatchByRef(dfWorld.batches.get('B1'), 'B1');
    expect(recordTreasuryReceived(db, df, 'admin-hex')).toMatchObject({ ok: true, created: true });
    db.prepare("UPDATE brain_callback_outbox SET done_at = '2026-10-08 12:00:00'").run(); // closed too early
    expect(recordTreasuryReceived(db, df, 'admin-hex')).toMatchObject({ ok: true, created: false });
    expect(db.prepare('SELECT done_at, last_error FROM brain_callback_outbox').get()).toEqual({ done_at: null, last_error: null });
  });

  // ── review C12/C16/C23: 2026002293 was closed while Direct.Fund still showed
  // the treasury's bank account. Until the administrator decides it, a
  // financer cannot take it — the treasury can.

  it('a held batch is refused BATCH_HELD, shown held and never confirmable, while the treasury may still take it', async () => {
    const saved = process.env.FINANCER_HELD_BATCHES;
    process.env.FINANCER_HELD_BATCHES = '2026002293';
    try {
    dfBatch('2026002293', me);
    leg('2026002293-T1');
    const r = await confirm(me, ['2026002293']);
    expect(r.body.results[0]).toMatchObject({ batchRef: '2026002293', ok: false, code: 'BATCH_HELD' });
    expect(r.body.results[0].error).toMatch(/treasury bank account; the administrator decides it/);
    nothingWritten();

    const listed = (await call(me, 'GET', '/batches')).body.batches.find((b: any) => b.batchRef === '2026002293');
    expect(listed).toMatchObject({ held: true, canConfirm: false, ld: { confirmed: false, settledBy: null } });

    const df = parseBatchByRef(dfWorld.batches.get('2026002293'), '2026002293');
    expect(recordTreasuryReceived(db, df, 'admin-hex')).toMatchObject({ ok: true });
    expect(owners().map(o => o.settled_by)).toEqual(['treasury', 'treasury']);
    } finally {
      if (saved === undefined) delete process.env.FINANCER_HELD_BATCHES; else process.env.FINANCER_HELD_BATCHES = saved;
    }
  });

  it('since the owner decided it (9 Oct 2026) nothing is held by default: 2026002293 is the financer\'s like any other', async () => {
    const saved = process.env.FINANCER_HELD_BATCHES;
    delete process.env.FINANCER_HELD_BATCHES;
    try {
      dfBatch('2026002293', me);
      leg('2026002293-T1');
      const listed = (await call(me, 'GET', '/batches')).body.batches.find((b: any) => b.batchRef === '2026002293');
      expect(listed).toMatchObject({ held: false, canConfirm: true });
      expect((await confirm(me, ['2026002293'])).body.results[0]).toMatchObject({ batchRef: '2026002293', ok: true });
      expect(owners().map(o => o.settled_by)).toEqual(['financer', 'financer']);
    } finally {
      if (saved !== undefined) process.env.FINANCER_HELD_BATCHES = saved;
    }
  });

  it('FINANCER_HELD_BATCHES replaces the list; set empty, it holds nothing', async () => {
    const saved = process.env.FINANCER_HELD_BATCHES;
    try {
      dfBatch('2026002293', me);
      dfBatch('B7', me);
      process.env.FINANCER_HELD_BATCHES = ' B7 , B8';
      const r = await confirm(me, ['B7', '2026002293']);
      expect(r.body.results.map((x: any) => [x.batchRef, x.ok, x.code ?? null])).toEqual([['B7', false, 'BATCH_HELD'], ['2026002293', true, null]]);
      process.env.FINANCER_HELD_BATCHES = '';
      expect((await confirm(me, ['B7'])).body.results[0]).toMatchObject({ ok: true });
      expect(heldBatches({ FINANCER_HELD_BATCHES: '' })).toEqual(new Set());
      expect(heldBatches({})).toEqual(new Set());
    } finally {
      if (saved === undefined) delete process.env.FINANCER_HELD_BATCHES; else process.env.FINANCER_HELD_BATCHES = saved;
    }
  });
});

// ─── me / batches ─────────────────────────────────────────────────────────

describe('GET /api/financer/me', () => {
  it('who Direct.Fund says the signer is, and whether their wallet may pay', async () => {
    dfWorld.financers.set(me.hex, { isInvestor: true, lanaDiscountWallet: WALLET });
    const r = await call(me, 'GET', '/me');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      hexId: me.hex, isFinancer: true, lanaDiscountWallet: WALLET, lanaDiscountWalletSetAt: '2026-10-08',
      walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false },
      // A Direct.Fund before wallets per currency, and nothing to send yet: no currency known.
      wallets: [], unknownCurrencyRefs: [],
    });
  });

  it('one wallet per currency (owner, 9 Oct 2026): each currency with a wallet or a purchase to send, its wallet and the Registrar\'s word on it — one question per wallet', async () => {
    const GBP_WALLET = 'LGbpWa11etXXXXXXXXXXXXXXXXXXXXXXXX';
    dfWorld.financers.set(me.hex, { isInvestor: true, lanaDiscountWallet: WALLET, wallets: {
      EUR: { walletId: WALLET, setAt: '2026-10-08 10:00:00' }, GBP: { walletId: GBP_WALLET, setAt: '2026-10-09 08:00:00' }, CHF: { walletId: WALLET, setAt: null },
    } });
    registrar = w => (w === GBP_WALLET
      ? { registered: true, frozen: true, freeze_reason: 'frozen_unreg_Lanas', wallet_type: 'Lana.Discount', nostr_hex_id: me.hex }
      : { registered: true, frozen: false, wallet_type: 'Lana.Discount', nostr_hex_id: me.hex });
    // A USD purchase of theirs still to send (not approved yet), and one whose legs carry two currencies.
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('U1', ?, 'financer', ?), ('X1', ?, 'financer', ?)").run(me.hex, me.hex, me.hex, me.hex);
    leg('U1');
    db.prepare("UPDATE brain_lana_orders SET currency = 'USD' WHERE transaction_ref = 'U1'").run();
    leg('X1');
    leg('X1');
    db.prepare("UPDATE brain_lana_orders SET currency = 'GBP' WHERE rowid = (SELECT MAX(rowid) FROM brain_lana_orders WHERE transaction_ref = 'X1')").run();
    const r = await call(me, 'GET', '/me');
    expect(r.status).toBe(200);
    expect(r.body.wallets).toEqual([
      { currency: 'CHF', walletId: WALLET, walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false } },
      { currency: 'EUR', walletId: WALLET, walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false } },
      { currency: 'GBP', walletId: GBP_WALLET, walletCheck: { ok: false, reason: 'WALLET_FROZEN', walletType: 'Lana.Discount', frozen: true, freezeReason: 'frozen_unreg_Lanas' } },
      { currency: 'USD', walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } },
    ]);
    expect(r.body.unknownCurrencyRefs).toEqual(['X1']);
    // A page from before: the first currency's wallet.
    expect(r.body).toMatchObject({ lanaDiscountWallet: WALLET, lanaDiscountWalletSetAt: '2026-10-08', walletCheck: { ok: true } });
    // The wallet chosen for CHF and EUR was asked about once.
    expect(registrarAsks.sort()).toEqual([GBP_WALLET, WALLET].sort());
  });

  it('wallets per currency, none chosen: every currency with a purchase to send says NO_WALLET, and the old single wallet is not used for any', async () => {
    dfWorld.financers.set(me.hex, { isInvestor: true, lanaDiscountWallet: WALLET, wallets: {} });
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('G1', ?, 'financer', ?)").run(me.hex, me.hex);
    leg('G1');
    db.prepare("UPDATE brain_lana_orders SET currency = 'GBP' WHERE transaction_ref = 'G1'").run();
    const r = await call(me, 'GET', '/me');
    expect(r.body).toMatchObject({
      wallets: [{ currency: 'GBP', walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } }],
      lanaDiscountWallet: null, lanaDiscountWalletSetAt: null, walletCheck: { ok: false, reason: 'NO_WALLET' },
    });
    expect(registrarAsks).toEqual([]);
    // A Direct.Fund before wallets per currency: its one wallet, for that currency too.
    dfWorld.financers.set(me.hex, { isInvestor: true, lanaDiscountWallet: WALLET });
    expect((await call(me, 'GET', '/me')).body).toMatchObject({
      wallets: [{ currency: 'GBP', walletId: WALLET, walletCheck: { ok: true } }], lanaDiscountWallet: WALLET,
    });
  });

  it("a wallet registered to somebody else is not the financer's to pay from", async () => {
    dfWorld.financers.set(me.hex, { isInvestor: true, lanaDiscountWallet: WALLET });
    registrar = () => ({ registered: true, frozen: false, wallet_type: 'Lana.Discount', nostr_hex_id: other.hex });
    expect((await call(me, 'GET', '/me')).body.walletCheck).toMatchObject({ ok: false, reason: 'WRONG_OWNER' });
  });

  it('no wallet chosen, not a financer, Direct.Fund down', async () => {
    expect((await call(me, 'GET', '/me')).body).toMatchObject({ isFinancer: false, lanaDiscountWallet: null, walletCheck: { ok: false, reason: 'NO_WALLET' } });
    dfWorld.down = true;
    const r = await call(me, 'GET', '/me');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('DF_UNAVAILABLE');
    expect((await call(null, 'GET', '/me')).status).toBe(403);
  });
});

describe('GET /api/financer/batches', () => {
  it("the signer's internal batches, with where each stands here", async () => {
    dfBatch('B-NEW', me);
    dfBatch('B-MINE', me);
    dfBatch('B-UNPAID', me, { status: 'closed' });
    dfBatch('B-TREASURY', me);
    dfBatch('B-OTHER', other);
    financers(me);
    await confirm(me, ['B-MINE']);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('B-TREASURY-T1', ?, 'treasury', 'admin')").run(me.hex);
    leg('B-MINE-T1', { auth: 1 });
    leg('B-MINE-T1', { status: 'sending', auth: 1 });
    leg('B-MINE-T2', { status: 'sent', auth: 1 });

    const r = await call(me, 'GET', '/batches');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.batches.map((b: any) => [b.batchRef, b]));
    expect(Object.keys(by).sort()).toEqual(['B-MINE', 'B-NEW', 'B-TREASURY', 'B-UNPAID']);
    expect(by['B-NEW']).toMatchObject({ canConfirm: true, held: false, ld: { confirmed: false, settledBy: null } });
    expect(by['B-UNPAID']).toMatchObject({ canConfirm: false, ld: { confirmed: false } });
    expect(by['B-TREASURY']).toMatchObject({ canConfirm: false, ld: { settledBy: 'treasury', purchases: { total: 2, treasury: 1 } } });
    expect(by['B-MINE']).toMatchObject({
      canConfirm: false,
      canConfirmAgain: false,
      ld: { confirmed: true, settledBy: 'financer', status: 'received', purchases: { total: 2, mine: 2, unclaimed: 0 }, unclaimedRefs: [],
        legs: { total: 3, pending: 1, authorized: 1, sending: 1, sent: 1, cancelled: 0 } },
    });
    expect(by['B-NEW']).toMatchObject({ canConfirmAgain: false, ld: { purchases: { total: 2, mine: 0, unclaimed: 2 } } });
  });

  // ── review N7: a purchase Direct.Fund did not count at the confirmation (C14)
  // is owned by nobody here. Counted in the batch's legs it showed the batch
  // "waiting for approval" for good, for a purchase that was not the
  // financer's, and nothing offered the repeat that takes it in.

  const batches = async () => Object.fromEntries((await call(me, 'GET', '/batches')).body.batches.map((b: any) => [b.batchRef, b]));

  it('a confirmed batch counts only the legs of purchases the signer owns; the rest is unclaimed, and a repeat is offered', async () => {
    financers(me);
    dfBatch('B1', me, {}, [{}, { live: false }]);
    leg('B1-T1', { type: 'investor_lana', toHex: me.hex, auth: 1 });
    leg('B1-T2', { auth: 0 }); // the purchase left out: no approval of the signer's is coming
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, skippedRefs: ['B1-T2'] });

    let b1 = (await batches())['B1'];
    expect(b1.ld).toMatchObject({
      confirmed: true,
      purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 1 },
      unclaimedRefs: ['B1-T2'],
      legs: { total: 1, pending: 1, authorized: 1, sending: 0, sent: 0, cancelled: 0 },
    });
    expect(b1).toMatchObject({ canConfirm: false, canConfirmAgain: true });

    // Still left out on Direct.Fund: the repeat takes nothing, and says so.
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: true, transactionRefs: ['B1-T1'], skippedRefs: ['B1-T2'] });
    expect((await batches())['B1'].canConfirmAgain).toBe(true);

    // Untangled on Direct.Fund: the repeat takes it in and tells the brain; nothing more to offer.
    dfBatch('B1', me);
    expect((await confirm(me, ['B1'])).body.results[0]).toEqual({ batchRef: 'B1', ok: true, alreadyConfirmed: true, transactionRefs: ['B1-T1', 'B1-T2'] });
    expect(outbox().map(o => o.dedupe_key)).toEqual(['fiat-received:B1', 'fiat-received:B1:2']);
    b1 = (await batches())['B1'];
    expect(b1).toMatchObject({ canConfirmAgain: false, ld: { purchases: { total: 2, mine: 2, unclaimed: 0 }, unclaimedRefs: [], legs: { total: 2, pending: 2, authorized: 1 } } });
  });

  it("a purchase the treasury or another financer settles is theirs, not unclaimed, and offers no repeat", async () => {
    financers(me);
    dfBatch('B1', me, {}, [{}, { live: false }, { live: false }]);
    await confirm(me, ['B1']);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('B1-T2', ?, 'treasury', 'admin'), ('B1-T3', ?, 'financer', ?)")
      .run(me.hex, other.hex, other.hex);
    leg('B1-T2', { auth: 0 });
    leg('B1-T3', { auth: 0 });
    expect((await batches())['B1']).toMatchObject({
      canConfirmAgain: false,
      ld: { purchases: { total: 3, mine: 1, treasury: 1, other: 1, unclaimed: 0 }, legs: { total: 0, pending: 0 } },
    });
  });

  it('the unclaimed list stops at 50; the count is whole', async () => {
    financers(me);
    dfBatch('B1', me, {}, Array.from({ length: 60 }, (_, i) => (i === 0 ? {} : { live: false })));
    await confirm(me, ['B1']);
    const b1 = (await batches())['B1'];
    expect(b1.ld.purchases).toMatchObject({ total: 60, mine: 1, unclaimed: 59 });
    expect(b1.ld.unclaimedRefs).toHaveLength(50);
    expect(b1.ld.unclaimedRefs[0]).toBe('B1-T2');
  });

  it("a stopped call to the brain is offered again while a purchase of it still waits — and the repeat brings it back", async () => {
    financers(me);
    dfBatch('B1', me);
    leg('B1-T1', { auth: 0 });
    leg('B1-T2', { auth: 1 });
    await confirm(me, ['B1']);
    expect((await batches())['B1'].canConfirmAgain).toBe(false); // alive: it posts by itself

    db.prepare("UPDATE brain_callback_outbox SET last_error = 'GAVE_UP', created_at = '2026-09-01 00:00:00'").run();
    expect((await batches())['B1'].canConfirmAgain).toBe(true);

    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect(db.prepare('SELECT done_at, last_error FROM brain_callback_outbox').get()).toEqual({ done_at: null, last_error: null });
    expect((await batches())['B1'].canConfirmAgain).toBe(false);

    // Given up, but nothing of it waits any more: a repeat would change nothing, so none is offered.
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1").run();
    db.prepare("UPDATE brain_callback_outbox SET last_error = 'GAVE_UP'").run();
    expect((await batches())['B1'].canConfirmAgain).toBe(false);
  });

  // ── recheck of 9 Oct 2026 (M2/M5): »Confirm again« stayed on for good for a
  // purchase no repeat can ever take — one the brain cancelled after the batch
  // was paid, or one whose investor leg the brain moved to another financer.

  it('a purchase nobody owns whose every leg here is cancelled or failed is finished: counted apart (cancelled), not unclaimed, and offers no repeat (M5)', async () => {
    financers(me);
    dfBatch('B1', me, {}, [{}, { live: false }]);
    leg('B1-T1', { type: 'investor_lana', toHex: me.hex, auth: 1 });
    leg('B1-T2', { status: 'cancelled' });
    leg('B1-T2', { type: 'investor_lana', toHex: me.hex, status: 'failed' });
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, skippedRefs: ['B1-T2'] });
    expect((await batches())['B1']).toMatchObject({
      canConfirmAgain: false,
      resendStopped: false,
      ld: { purchases: { total: 2, mine: 1, treasury: 0, other: 0, unclaimed: 0, retakeable: 0, cancelled: 1 }, unclaimedRefs: [] },
    });
    // A leg of it alive here again: unclaimed, and a repeat could take it.
    leg('B1-T2', { auth: 0 });
    expect((await batches())['B1']).toMatchObject({
      canConfirmAgain: true,
      ld: { purchases: { unclaimed: 1, retakeable: 1, cancelled: 0 }, unclaimedRefs: ['B1-T2'] },
    });
  });

  it('a purchase nobody owns whose investor leg names another financer offers no repeat (it would be refused OWNER_MISMATCH) and is named to the administrator; one with no leg here is not offered either (M2)', async () => {
    forgetUnownedMismatches();
    financers(me);
    dfBatch('B1', me, {}, [{}, { live: false }, { live: false }]);
    leg('B1-T1', { type: 'investor_lana', toHex: me.hex, auth: 1 });
    leg('B1-T2', { auth: 0 });
    leg('B1-T2', { type: 'investor_lana', toHex: other.hex, auth: 0 });
    await confirm(me, ['B1']);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 0, refs: [] });
    expect((await batches())['B1']).toMatchObject({
      canConfirmAgain: false,
      ld: { purchases: { total: 3, mine: 1, unclaimed: 2, retakeable: 0, cancelled: 0 }, unclaimedRefs: ['B1-T2', 'B1-T3'] },
    });
    expect(ownerMismatchPurchases(db)).toEqual({ count: 1, refs: ['B1-T2'] });
    // Counted again on Direct.Fund: the repeat is refused whole — the button could only fail.
    dfBatch('B1', me, {}, [{}, {}, { live: false }]);
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: false, code: 'OWNER_MISMATCH' });
    expect((await batches())['B1'].canConfirmAgain).toBe(false);
    // The other financer's leg cancelled: a repeat can take it, and it is nobody's problem any more.
    db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE transaction_ref = 'B1-T2' AND order_type = 'investor_lana'").run();
    expect((await batches())['B1']).toMatchObject({ canConfirmAgain: true, ld: { purchases: { unclaimed: 2, retakeable: 1 } } });
    expect(ownerMismatchPurchases(db)).toEqual({ count: 0, refs: [] });
    // Taken: forgotten.
    expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, transactionRefs: ['B1-T1', 'B1-T2'] });
    db.prepare("UPDATE brain_lana_orders SET status = 'pending' WHERE transaction_ref = 'B1-T2'").run();
    expect(ownerMismatchPurchases(db)).toEqual({ count: 1, refs: ['B1-T2'] }); // owned now: judged against its owner
    db.prepare("UPDATE brain_lana_orders SET to_hex = ? WHERE transaction_ref = 'B1-T2' AND order_type = 'investor_lana'").run(me.hex);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 0, refs: [] });
  });

  it('resendStopped says apart that the call to the brain stopped — beside an unclaimed purchase too — and only where a repeat can bring it back (M7)', async () => {
    const saved = process.env.FINANCER_HELD_BATCHES;
    try {
      financers(me);
      dfBatch('B1', me, {}, [{}, { live: false }]);
      leg('B1-T1', { type: 'investor_lana', toHex: me.hex, auth: 0 }); // the signer's, waiting for approval
      leg('B1-T2', { auth: 0 }); // left out on Direct.Fund (a refund, say)
      await confirm(me, ['B1']);
      expect((await batches())['B1']).toMatchObject({ canConfirmAgain: true, resendStopped: false, ld: { purchases: { unclaimed: 1, retakeable: 1 } } });

      db.prepare("UPDATE brain_callback_outbox SET last_error = 'GAVE_UP', created_at = '2026-09-01 00:00:00'").run();
      expect((await batches())['B1']).toMatchObject({ canConfirmAgain: true, resendStopped: true });
      // Held: the repeat is refused BATCH_HELD — nothing offered.
      process.env.FINANCER_HELD_BATCHES = 'B1';
      expect((await batches())['B1']).toMatchObject({ canConfirmAgain: false, resendStopped: false });
      process.env.FINANCER_HELD_BATCHES = '';
      // Without the unclaimed purchase, the stopped call alone offers the repeat; the repeat brings it back.
      db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE transaction_ref = 'B1-T2'").run();
      expect((await batches())['B1']).toMatchObject({ canConfirmAgain: true, resendStopped: true, ld: { purchases: { unclaimed: 0, cancelled: 1 } } });
      expect((await confirm(me, ['B1'])).body.results[0]).toMatchObject({ ok: true, alreadyConfirmed: true });
      expect((await batches())['B1']).toMatchObject({ canConfirmAgain: false, resendStopped: false });
    } finally {
      if (saved === undefined) delete process.env.FINANCER_HELD_BATCHES; else process.env.FINANCER_HELD_BATCHES = saved;
    }
  });

  it('never offered on a batch the signer did not confirm, one not paid, or one held', async () => {
    const saved = process.env.FINANCER_HELD_BATCHES;
    try {
      financers(me);
      dfBatch('B1', me, {}, [{}, { live: false }]);
      await confirm(me, ['B1']);
      process.env.FINANCER_HELD_BATCHES = 'B1';
      expect((await batches())['B1']).toMatchObject({ held: true, canConfirmAgain: false, ld: { purchases: { unclaimed: 1 } } });
      process.env.FINANCER_HELD_BATCHES = '';
      dfBatch('B1', me, { status: 'closed' }, [{}, { live: false }]);
      expect((await batches())['B1'].canConfirmAgain).toBe(false);
      dfBatch('B2', me, {}, [{}, { live: false }]); // never confirmed: canConfirm, not again
      expect((await batches())['B2']).toMatchObject({ canConfirm: true, canConfirmAgain: false });
    } finally {
      if (saved === undefined) delete process.env.FINANCER_HELD_BATCHES; else process.env.FINANCER_HELD_BATCHES = saved;
    }
  });
});

// ─── what the approval waits on at Direct.Fund (owner, 9 Oct 2026) ─────────
// Batch 2026002432 confirmed, and the brain did not approve: the purchase's
// €0.25 merchant's commission by bank sat in Direct.Fund batch 2026002433,
// closed and not marked paid. The page said only "when every part is paid".

describe('GET /api/financer/batches: ld.waitingOn', () => {
  const COMMISSION = { transactionRef: 'B-OLD-T1', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR', batchRef: '2026002433', batchStatus: 'closed' };
  const INVOICE = { transactionRef: 'B-OLD-T1', orderType: 'merchant_payment', destinationType: 'bank', amount: 12, currency: 'EUR', batchRef: '2026002433', batchStatus: 'closed' };
  const CARETAKER = { transactionRef: 'B-NEW-T1', orderType: 'caretaker_via_discount', destinationType: 'lana_discount', amount: 1.5, currency: 'EUR', batchRef: null, batchStatus: null };
  const unpaidHits = () => dfWorld.hits.filter(h => h.includes('/unpaid-parts'));
  const batches = async () => {
    const r = await call(me, 'GET', '/batches');
    expect(r.status).toBe(200);
    return Object.fromEntries(r.body.batches.map((b: any) => [b.batchRef, b]));
  };

  /**
   * Two batches waiting for the approval (Direct.Fund lists the newer first), one ready to send, one not confirmed.
   * Of B-OLD, T1 waits and T2 is sent; B-NEW's one purchase has no approval yet. B-READY has one purchase approved
   * and one not: it is ready to send, not waiting, so nothing of it is asked about.
   */
  async function world() {
    financers(me);
    dfBatch('B-NEW', me, { createdAt: '2026-10-08 09:00:00' }, [{}]);
    dfBatch('B-OLD', me, { createdAt: '2026-10-07 09:00:00' });
    dfBatch('B-READY', me, {}, [{}, {}]);
    dfBatch('B-FRESH', me, {}, [{}]);
    for (const ref of ['B-NEW', 'B-OLD', 'B-READY']) expect((await confirm(me, [ref])).body.results[0]).toMatchObject({ ok: true });
    leg('B-OLD-T1', { auth: 0 });
    leg('B-OLD-T2', { status: 'sent', auth: 1 });
    leg('B-NEW-T1', { auth: 0 });
    leg('B-READY-T1', { auth: 1 });
    leg('B-READY-T2', { auth: 0 });
    leg('B-FRESH-T1', { auth: 0 });
    dfWorld.hits = [];
  }

  it('names the unpaid parts per batch — its own purchases only — from ONE Direct.Fund call, oldest batch first', async () => {
    await world();
    dfWorld.unpaid = [COMMISSION, INVOICE, CARETAKER, { ...COMMISSION, transactionRef: 'B-READY-T2' }, { ...COMMISSION, transactionRef: 'B-FRESH-T1' }];
    const by = await batches();

    expect(unpaidHits()).toHaveLength(1);
    expect(unpaidHits()[0]).toBe(`/api/admin/financers/${me.hex}/unpaid-parts?refs=B-OLD-T1,B-NEW-T1`);
    expect(dfWorld.auth.at(-1)).toBe('Bearer peer-test');
    expect(by['B-OLD'].ld.waitingOn).toEqual([
      { batchRef: '2026002433', batchStatus: 'closed', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR', transactionRef: 'B-OLD-T1' },
      { batchRef: '2026002433', batchStatus: 'closed', orderType: 'merchant_payment', destinationType: 'bank', amount: 12, currency: 'EUR', transactionRef: 'B-OLD-T1' },
    ]);
    expect(by['B-NEW'].ld.waitingOn).toEqual([
      { batchRef: null, batchStatus: null, orderType: 'caretaker_via_discount', destinationType: 'lana_discount', amount: 1.5, currency: 'EUR', transactionRef: 'B-NEW-T1' },
    ]);
    // Ready to send, or not confirmed by the signer: nothing waits on Direct.Fund for them here, and nothing is asked.
    expect(by['B-READY'].ld.waitingOn).toBeNull();
    expect(by['B-FRESH'].ld.waitingOn).toBeNull();
  });

  it('an empty list when Direct.Fund has every part paid: the approval comes by itself', async () => {
    await world();
    const by = await batches();
    expect(unpaidHits()).toHaveLength(1);
    expect(by['B-OLD'].ld.waitingOn).toEqual([]);
    expect(by['B-NEW'].ld.waitingOn).toEqual([]);
  });

  it('null — the page keeps its general sentence — when Direct.Fund has no such route (404, 403) or does not answer; the list itself still answers', async () => {
    await world();
    for (const status of [404, 403, 503]) {
      dfWorld.unpaidStatus = status;
      const by = await batches();
      expect(by['B-OLD'].ld.waitingOn, String(status)).toBeNull();
      expect(by['B-NEW'].ld.waitingOn, String(status)).toBeNull();
      expect(by['B-OLD'].ld.confirmed).toBe(true);
    }
    expect(unpaidHits()).toHaveLength(3);
  });

  it('no Direct.Fund call when no batch waits for the approval', async () => {
    financers(me);
    dfBatch('B-READY', me, {}, [{}, {}]);
    dfBatch('B-FRESH', me, {}, [{}]);
    await confirm(me, ['B-READY']);
    leg('B-READY-T1', { auth: 1 });
    leg('B-READY-T2', { auth: 0 }); // ready to send (T1): not waiting, though T2 is not approved yet
    leg('B-FRESH-T1', { auth: 0 }); // not confirmed: nothing of it is the signer's to wait for
    dfWorld.hits = [];
    const by = await batches();
    expect(unpaidHits()).toEqual([]);
    expect(by['B-READY'].ld.waitingOn).toBeNull();
    // All sent: done, nothing to ask either.
    db.prepare("UPDATE brain_lana_orders SET status = 'sent'").run();
    await batches();
    expect(unpaidHits()).toEqual([]);
  });

  it('a confirmed purchase whose legs have not come yet waits too, and is asked about', async () => {
    financers(me);
    dfBatch('B1', me, {}, [{}]);
    await confirm(me, ['B1']);
    dfWorld.unpaid = [{ ...COMMISSION, transactionRef: 'B1-T1' }];
    const by = await batches();
    expect(dfWorld.unpaidAsks).toEqual([['B1-T1']]);
    expect(by['B1'].ld.waitingOn).toEqual([{ ...COMMISSION, transactionRef: 'B1-T1' }]);
  });

  it('at most 200 purchases in one call, whole batches only, oldest first; a batch that does not fit stays null', () => {
    const batch = (createdAt: string, n: number, prefix: string, len = 8) => ({
      batch: { createdAt },
      refs: Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(len, '0')}`),
    });
    // Direct.Fund's order: newest first.
    const listed = [batch('2026-10-09 10:00:00', 50, 'c'), batch('2026-10-08 10:00:00', 100, 'b'), batch('2026-10-07 10:00:00', 150, 'a')]
      .map((b, index) => ({ ...b, index }));
    const { refs, chosen } = chooseWaitingBatches(listed);
    expect(chosen.map(c => c.index)).toEqual([2, 0]); // the oldest (150), then the 50 that still fit; the 100 do not
    expect(refs).toHaveLength(200);
    expect(refs[0]).toBe('a00000000');

    // A purchase in two batches is asked once.
    const shared = chooseWaitingBatches([
      { batch: { createdAt: '2026-10-08' }, index: 0, refs: ['T1', 'T2'] },
      { batch: { createdAt: '2026-10-07' }, index: 1, refs: ['T2', 'T3'] },
    ]);
    expect(shared.refs).toEqual(['T2', 'T3', 'T1']);
    expect(shared.chosen.map(c => c.index)).toEqual([1, 0]);

    // Long references: the query stays short enough for a proxy to read it (MAX_UNPAID_REFS_CHARS), whole batches still.
    const long = chooseWaitingBatches([{ ...batch('2026-10-07', 80, 'L', 120), index: 0 }, { ...batch('2026-10-08', 2, 'S'), index: 1 }]);
    expect(long.chosen.map(c => c.index)).toEqual([1]);
    // A reference with a comma cannot be asked about: its batch stays null.
    expect(chooseWaitingBatches([{ batch: { createdAt: null }, index: 0, refs: ['a,b'] }]).chosen).toEqual([]);
  });
});
