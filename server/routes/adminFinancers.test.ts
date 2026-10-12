// @vitest-environment node
/**
 * GET /api/admin/financers-overview — WHAT EACH FINANCER STILL HAS TO DO, AND ONLY FOR AN ADMINISTRATOR.
 *
 * The router is real, so are the NIP-98 signatures (nip98TestKit) and the SQLite DDL (roundMandateTestKit →
 * db/financerSchema.ts). Direct.Fund is a real HTTP server in this process (as in financer.test.ts).
 *
 * What is pinned: every stage counts what it says and nothing of the next (1 to pay on Direct.Fund, 2 paid there and
 * not confirmed here, 3 confirmed and not approved — with what Direct.Fund still has unpaid, 4 approved and in no
 * send, 5 signed and not in a block); the financers are read from the data, never a list; an unsigned or non-admin
 * request is refused 403; a Direct.Fund that does not answer costs stages 1–2 only (dfUnavailable), never the page.
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
import { createAdminFinancersRouter, unpaidQuestion } from './adminFinancers';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';
import { MAX_UNPAID_REFS } from '../lib/financer/dfClient';

const db: Database.Database = getDbHandle();
const admin = newSigner();
const outsider = newSigner();
const boris = newSigner();
const gorazd = newSigner();

// ─── a Direct.Fund that answers what each test says ───────────────────────

const dfWorld = {
  financers: new Map<string, { isInvestor: boolean; financer?: boolean; lanaDiscountWallet: string | null; wallets?: Record<string, string> }>(),
  batches: new Map<string, Array<Record<string, unknown>>>(),
  unpaid: [] as Array<Record<string, unknown>>,
  unpaidAsks: [] as string[][],
  down: false,
  unpaidDown: false,
  hits: [] as string[],
};
let dfServer: http.Server;
let server: http.Server;
let base = '';

beforeAll(async () => {
  dfServer = http.createServer((req, res) => {
    const url = String(req.url);
    dfWorld.hits.push(url);
    res.setHeader('content-type', 'application/json');
    if (dfWorld.down) { res.statusCode = 503; res.end('{}'); return; }
    let m = /^\/api\/admin\/financers\/([0-9a-f]{64})\/unpaid-parts\?refs=(.*)$/.exec(url);
    if (m) {
      const refs = m[2].split(',').map(decodeURIComponent);
      dfWorld.unpaidAsks.push(refs);
      if (dfWorld.unpaidDown) { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ parts: dfWorld.unpaid.filter(p => refs.includes(String(p.transactionRef))) }));
      return;
    }
    m = /^\/api\/admin\/financers\/([0-9a-f]{64})(\/lana-discount-batches)?$/.exec(url);
    if (m) {
      if (m[2]) { res.end(JSON.stringify({ batches: dfWorld.batches.get(m[1]) ?? [] })); return; }
      const f = dfWorld.financers.get(m[1]) ?? { isInvestor: false, lanaDiscountWallet: null };
      res.end(JSON.stringify({ hexId: m[1], lanaDiscountWalletSetAt: null, ...f }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
  const dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use('/api/admin', createAdminFinancersRouter({ df: { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) } }));
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => dfServer.close(() => r()));
});

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batches', 'purchase_settlement', 'lana_sends', 'admin_users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO admin_users (hex_id, label, added_by) VALUES (?, 'owner', 'test')").run(admin.hex);
  dfWorld.financers.clear();
  dfWorld.batches.clear();
  dfWorld.unpaid = [];
  dfWorld.unpaidAsks = [];
  dfWorld.down = false;
  dfWorld.unpaidDown = false;
  dfWorld.hits = [];
});

// ─── helpers ──────────────────────────────────────────────────────────────

const get = async (who: TestSigner | null) => {
  const url = '/api/admin/financers-overview';
  const headers: Record<string, string> = {};
  if (who) headers.authorization = nip98Header(who, { method: 'GET', url });
  const r = await fetch(base + url, { headers });
  return { status: r.status, body: await r.json() as any };
};

let n = 0;
const leg = (ref: string, o: {
  type?: string; toHex?: string; status?: string; auth?: 0 | 1; lana?: number; currency?: string; wallet?: string;
  sendTxid?: string; createdAt?: string; authorizedAt?: string;
} = {}) => db.prepare(`
  INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate,
    status, brain_authorized, brain_authorized_at, send_txid, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?)
`).run(`O${++n}`, ref, o.type ?? 'merchant_commission', o.wallet ?? 'LWallet1', o.toHex ?? 'x', o.lana ?? 100_000_000,
  o.currency ?? 'EUR', o.status ?? 'pending', o.auth ?? 0, o.authorizedAt ?? null, o.sendTxid ?? null, o.createdAt ?? '2026-10-12 08:00:00');
const own = (ref: string, who: TestSigner, settledBy: 'financer' | 'treasury' = 'financer', createdAt = '2026-10-12 08:00:00') =>
  db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ref, who.hex, settledBy, who.hex, createdAt);
const send = (txid: string, who: TestSigner, state: string, orderIds: string[], lanoshis: number, at = '2026-10-12 09:00:00') =>
  db.prepare(`INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis,
      state, confirmed_at, created_at, updated_at) VALUES (?, 'financer', ?, 'LFrom', '00', ?, '[]', ?, 1000, ?, ?, ?, ?)`)
    .run(txid, who.hex, JSON.stringify(orderIds), lanoshis, state, state === 'confirmed' ? at : null, at, at);
const dfBatch = (who: TestSigner, ref: string, status: string, refs: string[], over: Record<string, unknown> = {}) => {
  const list = dfWorld.batches.get(who.hex) ?? [];
  list.push({ batchRef: ref, status, currency: 'EUR', totalAmount: 25, paymentCount: refs.length, confirmedCount: 0,
    fundSettingId: 5, createdAt: '2026-10-11 10:00:00', closedAt: null, paidAt: status === 'paid' ? '2026-10-11 12:00:00' : null,
    transactionRefs: refs, ...over });
  dfWorld.batches.set(who.hex, list);
};
const financer = (who: TestSigner, wallets: Record<string, string> = { EUR: 'LBorisEur' }) =>
  dfWorld.financers.set(who.hex, { isInvestor: true, financer: true, lanaDiscountWallet: null, wallets });
const of = (body: any, who: TestSigner) => body.financers.find((f: any) => f.hex === who.hex);

/** Boris on every stage at once; each test reads the stage it is about. */
function borisEverywhere() {
  financer(boris);
  // 1. To pay on Direct.Fund: an open batch, its purchase's legs here, nobody owns it yet.
  dfBatch(boris, '2026003001', 'open', ['P1']);
  leg('P1', { type: 'investor_lana', toHex: boris.hex, lana: 200_000_000 });
  leg('P1', { lana: 50_000_000 });
  // 2. Paid on Direct.Fund, not confirmed here.
  dfBatch(boris, '2026003002', 'paid', ['P2']);
  leg('P2', { type: 'investor_lana', toHex: boris.hex, lana: 300_000_000 });
  // …and a paid one already confirmed here (incoming_batches row): not stage 2.
  dfBatch(boris, '2026003003', 'paid', ['P9']);
  db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, settled_by, status) VALUES ('2026003003', ?, 25, 'EUR', 'financer', 'incoming')").run(boris.hex);
  own('P9', boris);
  leg('P9', { type: 'investor_lana', toHex: boris.hex, status: 'sent' });
  // 3. Confirmed by Boris, not approved by the brain; Direct.Fund still lacks its merchant commission.
  own('P3', boris);
  leg('P3', { type: 'investor_lana', toHex: boris.hex, lana: 400_000_000, createdAt: '2026-10-10 08:00:00' });
  dfWorld.unpaid = [{ transactionRef: 'P3', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR', batchRef: '2026003010', batchStatus: 'open' }];
  // 4. Approved, in no send: two wallets, two currencies.
  own('P4', boris);
  leg('P4', { type: 'investor_lana', toHex: boris.hex, auth: 1, lana: 500_000_000, wallet: 'LBorisInvestor', authorizedAt: '2026-10-10 09:00:00' });
  leg('P4', { auth: 1, lana: 70_000_000, wallet: 'LMerchant' });
  own('P4b', boris);
  leg('P4b', { type: 'investor_lana', toHex: boris.hex, auth: 1, lana: 10_000_000, currency: 'GBP', wallet: 'LBorisInvestor' });
  // 5. On the way.
  own('P5', boris);
  leg('P5', { type: 'investor_lana', toHex: boris.hex, auth: 1, status: 'sending', sendTxid: 'a'.repeat(64), lana: 600_000_000 });
  send('a'.repeat(64), boris, 'mempool', ['O-x'], 600_000_000);
  // Last confirmed send.
  send('b'.repeat(64), boris, 'confirmed', ['O-y'], 1, '2026-10-11 07:00:00');
}

// ─── the gate ─────────────────────────────────────────────────────────────

describe('only an administrator', () => {
  it('refuses an unsigned request 403, and asks Direct.Fund nothing', async () => {
    borisEverywhere();
    const r = await get(null);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
    expect(dfWorld.hits).toEqual([]);
  });
  it('refuses a signed key that is not an admin 403 — a financer included', async () => {
    borisEverywhere();
    for (const who of [outsider, boris]) {
      const r = await get(who);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('Admin access required');
    }
    expect(dfWorld.hits).toEqual([]);
  });
});

// ─── the stages ───────────────────────────────────────────────────────────

describe('per financer, per stage', () => {
  it('reads the financers from the data, never a list', async () => {
    borisEverywhere();
    financer(gorazd, {});
    own('G1', gorazd); // Gorazd owns one purchase, nothing else
    leg('G1', { type: 'investor_lana', toHex: gorazd.hex, status: 'sent' });
    leg('Z1', { type: 'investor_lana', toHex: 'not-a-hex' }); // no financer from a leg that names nobody
    const r = await get(admin);
    expect(r.status).toBe(200);
    expect(r.body.financers.map((f: any) => f.hex).sort()).toEqual([boris.hex, gorazd.hex].sort());
    expect(r.body.dfUnavailable).toBe(false);
    expect(of(r.body, boris).wallets).toEqual({ EUR: 'LBorisEur' });
    expect(of(r.body, boris).isFinancer).toBe(true);
  });

  it('1. to pay on Direct.Fund: the open and closed batches, with the LANA of their purchases here', async () => {
    borisEverywhere();
    dfBatch(boris, '2026003004', 'closed', ['P6']);
    const s = of((await get(admin)).body, boris).stages.toPayOnDf;
    expect(s.batches.map((b: any) => [b.batchRef, b.status])).toEqual([['2026003001', 'open'], ['2026003004', 'closed']]);
    expect(s.purchases).toBe(2);
    expect(s.legs).toBe(2);
    expect(s.lana).toEqual({ EUR: '250000000' });
    expect(s.oldestAt).toBe('2026-10-11 10:00:00');
  });

  it('2. paid on Direct.Fund and not confirmed here; a batch confirmed here, or every purchase owned, is not', async () => {
    borisEverywhere();
    dfBatch(boris, '2026003005', 'paid', ['P4']); // P4 already Boris's: nothing left to confirm
    dfBatch(boris, '2026003006', 'paid', ['P7']); // P7: every leg cancelled — finished
    leg('P7', { status: 'cancelled' });
    const s = of((await get(admin)).body, boris).stages.toConfirm;
    expect(s.batches.map((b: any) => b.batchRef)).toEqual(['2026003002']);
    expect(s.purchases).toBe(1);
    expect(s.lana).toEqual({ EUR: '300000000' });
    expect(s.oldestAt).toBe('2026-10-11 12:00:00');
    expect(s.batches[0].held).toBe(false);
  });

  it('3. confirmed and not approved, with what Direct.Fund still has unpaid — and a confirmed purchase with no leg yet', async () => {
    borisEverywhere();
    own('P8', boris, 'financer', '2026-10-09 08:00:00');
    const s = of((await get(admin)).body, boris).stages.waitingApproval;
    expect(s.purchases).toBe(2);
    expect(s.legs).toBe(1);
    expect(s.withoutLegs).toBe(1);
    expect(s.lana).toEqual({ EUR: '400000000' });
    expect(s.oldestAt).toBe('2026-10-09 08:00:00');
    expect(s.waitingOn).toEqual([{ batchRef: '2026003010', batchStatus: 'open', orderType: 'merchant_commission', destinationType: 'bank', amount: 0.25, currency: 'EUR', transactionRef: 'P3' }]);
    expect(s.waitingOnPartial).toBe(false);
    // Oldest first, one call.
    expect(dfWorld.unpaidAsks).toEqual([['P8', 'P3']]);
  });

  it('3. Direct.Fund not answering the unpaid parts leaves waitingOn null, nothing else', async () => {
    borisEverywhere();
    dfWorld.unpaidDown = true;
    const f = of((await get(admin)).body, boris);
    expect(f.stages.waitingApproval.waitingOn).toBeNull();
    expect(f.stages.waitingApproval.legs).toBe(1);
    expect(f.dfUnavailable).toBe(false);
  });

  it('4. approved and in no send: what they must sign now, per currency, wallets, and since when', async () => {
    borisEverywhere();
    const s = of((await get(admin)).body, boris).stages.toSend;
    expect(s.purchases).toBe(2);
    expect(s.legs).toBe(3);
    expect(s.lana).toEqual({ EUR: '570000000', GBP: '10000000' });
    expect(s.wallets).toBe(2);
    expect(s.oldestAt).toBe('2026-10-12 08:00:00');
    expect(s.oldestApprovedAt).toBe('2026-10-10 09:00:00');
    expect(s.ownerMismatch).toBe(0);
  });

  it('4. a purchase whose investor leg now names somebody else is not to send; it is counted apart', async () => {
    borisEverywhere();
    own('PX', boris);
    leg('PX', { type: 'investor_lana', toHex: gorazd.hex, auth: 1 });
    const s = of((await get(admin)).body, boris).stages.toSend;
    expect(s.purchases).toBe(2);
    expect(s.ownerMismatch).toBe(1);
  });

  it('5. on the way: their sends not in a block, with txid, legs and LANA; the last confirmed send apart', async () => {
    borisEverywhere();
    const f = of((await get(admin)).body, boris);
    const s = f.stages.onTheWay;
    expect(s.sends).toEqual([{ txid: 'a'.repeat(64), state: 'mempool', walletId: 'LFrom', legs: 1, lanoshis: '600000000', since: '2026-10-12 09:00:00' }]);
    expect(s.legs).toBe(1);
    expect(s.lana).toEqual({ EUR: '600000000' });
    expect(f.lastConfirmedSend).toEqual({ txid: 'b'.repeat(64), at: '2026-10-11 07:00:00' });
  });

  it('open legs nobody owns: per financer by their investor leg, and in all — those naming nobody apart', async () => {
    borisEverywhere();
    leg('Q1', { lana: 9 }); // no investor leg at all
    const r = await get(admin);
    const u = of(r.body, boris).unowned;
    expect(u.purchases).toBe(2); // P1, P2
    expect(u.legs).toBe(3);
    expect(u.lana).toEqual({ EUR: '550000000' });
    expect(r.body.unowned.purchases).toBe(3);
    expect(r.body.unowned.withoutFinancer).toMatchObject({ purchases: 1, legs: 1, lana: { EUR: '9' } });
  });

  it("the treasury's purchases are not a financer's work", async () => {
    financer(boris);
    own('T1', boris, 'treasury');
    leg('T1', { type: 'investor_lana', toHex: boris.hex, auth: 1 });
    const f = of((await get(admin)).body, boris);
    expect(f.stages.toSend.legs).toBe(0);
    expect(f.stages.waitingApproval.legs).toBe(0);
    expect(f.unowned.legs).toBe(0);
  });
});

// ─── Direct.Fund away ─────────────────────────────────────────────────────

describe('Direct.Fund not answering', () => {
  it('flags dfUnavailable and still answers every stage this database knows', async () => {
    borisEverywhere();
    dfWorld.down = true;
    const r = await get(admin);
    expect(r.status).toBe(200);
    expect(r.body.dfUnavailable).toBe(true);
    const f = of(r.body, boris);
    expect(f.dfUnavailable).toBe(true);
    expect(f.isFinancer).toBeNull();
    expect(f.wallets).toBeNull();
    expect(f.stages.toPayOnDf).toBeNull();
    expect(f.stages.toConfirm).toBeNull();
    expect(f.stages.waitingApproval.legs).toBe(1);
    expect(f.stages.waitingApproval.waitingOn).toBeNull();
    expect(f.stages.toSend.legs).toBe(3);
    expect(f.stages.onTheWay.sends).toHaveLength(1);
    expect(f.unowned.legs).toBe(3);
  });
});

describe('unpaidQuestion', () => {
  it('asks at most MAX_UNPAID_REFS, oldest first, and says when some were left out', () => {
    const refs = Array.from({ length: MAX_UNPAID_REFS + 5 }, (_, i) => `R${i}`);
    const q = unpaidQuestion(refs);
    expect(q.asked).toHaveLength(MAX_UNPAID_REFS);
    expect(q.asked[0]).toBe('R0');
    expect(q.partial).toBe(true);
    expect(unpaidQuestion(['A', 'B'])).toEqual({ asked: ['A', 'B'], partial: false });
  });
});
