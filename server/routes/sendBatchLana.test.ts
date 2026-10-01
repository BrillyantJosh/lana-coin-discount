// @vitest-environment node
/**
 * POST /api/admin/send-batch-lana — THE ROUTE THAT SPENDS THE TREASURY WALLET.
 *
 * Until 2 Oct 2026 it took ANY non-empty `x-admin-hex-id` (not even checked
 * against admin_users) and broadcast LANA from BUYBACK_WIF to every pending
 * order of the refs it was handed, whether or not the money behind them had
 * arrived. These tests mount the real router (db/index.ts replaced by an
 * in-memory SQLite, the chain by a stand-in) and pin both gates: a signed
 * admin, then the auto-sender's authorisation for EVERY requested order.
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
const chain = vi.hoisted(() => ({ calls: [] as string[], broadcast: [] as string[] }));
vi.mock('../lib/electrum.js', () => ({
  electrumCall: async (method: string, params: any[]) => {
    chain.calls.push(method);
    // An empty wallet: an authorised request gets as far as the wallet and stops there.
    if (method === 'blockchain.address.listunspent') return [];
    if (method === 'blockchain.transaction.broadcast') { chain.broadcast.push(params[0]); return 'ab'.repeat(32); }
    throw new Error(`unexpected electrum call: ${method}`);
  },
  fetchBatchBalances: async () => [],
}));

import { getDbHandle } from '../db/index.js';
import apiRouter from './api';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header } from '../lib/nip98TestKit';
import { sendLockHolder } from '../lib/sendLock';
import { base58CheckEncode, hexToUint8Array } from '../lib/transaction';

const PATH = '/api/admin/send-batch-lana';
const db: Database.Database = getDbHandle();
const admin = newSigner();
const stranger = newSigner();

const app = express();
app.use(express.json({ verify: keepRawBody }));
app.use('/api', apiRouter);

let server: http.Server;
let base = '';
const savedWif = process.env.BUYBACK_WIF;
beforeAll(async () => {
  // A throwaway key in this chain's WIF form; the stand-in chain holds nothing for it.
  process.env.BUYBACK_WIF = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array('3c'.repeat(32))]));
  db.exec(`CREATE TABLE IF NOT EXISTS incoming_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_ref TEXT NOT NULL UNIQUE, investor_hex TEXT NOT NULL DEFAULT '',
    total_amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', payment_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'incoming', received_at TEXT, lana_bought_at TEXT, lana_sent_at TEXT, lana_tx_hash TEXT,
    notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => {
  if (savedWif === undefined) delete process.env.BUYBACK_WIF; else process.env.BUYBACK_WIF = savedWif;
  server?.close(() => r());
}));

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batches', 'admin_users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  db.prepare("INSERT INTO incoming_batches (batch_ref, status) VALUES ('B-BOUGHT', 'lana_bought'), ('B-RECEIVED', 'received')").run();
  let n = 0;
  const order = (txRef: string, batchRef: string) => db.prepare(`
    INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, batch_ref)
    VALUES (?, ?, 'investor_lana', 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', '', 100000000, 1, 'EUR', 0.01, ?)`).run(`O-${txRef}-${++n}`, txRef, batchRef);
  order('T-PAID', 'B-BOUGHT');
  order('T-PAID', 'B-BOUGHT');
  order('T-UNPAID', 'B-RECEIVED');
  chain.calls = []; chain.broadcast = [];
});

const send = (refs: string[], headers: Record<string, string>) =>
  fetch(base + PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ transaction_refs: refs }) })
    .then(async r => ({ status: r.status, body: await r.json() as any }));
const signed = (who: typeof admin, refs: string[]) =>
  ({ authorization: nip98Header(who, { method: 'POST', url: PATH, body: JSON.stringify({ transaction_refs: refs }) }) });
const pendingCount = () => (db.prepare("SELECT COUNT(*) c FROM brain_lana_orders WHERE status = 'pending'").get() as any).c;

describe('POST /api/admin/send-batch-lana', () => {
  it('an unsigned request naming a real admin moves nothing and never takes the send lock', async () => {
    const r = await send(['T-PAID'], { 'x-admin-hex-id': admin.hex });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
    expect(chain.calls).toEqual([]);
    expect(sendLockHolder()).toBeNull();
    expect(pendingCount()).toBe(3);
  });

  it('a valid signature by a key that is not an admin is refused', async () => {
    const r = await send(['T-PAID'], signed(stranger, ['T-PAID']));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Admin access required');
    expect(chain.calls).toEqual([]);
  });

  it('a signed admin cannot send orders whose money is not confirmed — and nothing of the request goes', async () => {
    const r = await send(['T-PAID', 'T-UNPAID'], signed(admin, ['T-PAID', 'T-UNPAID']));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: '1 of these LANA orders are not authorised yet (money not confirmed) — nothing was sent',
      code: 'NOT_AUTHORISED',
    });
    expect(chain.calls).toEqual([]);
    expect(pendingCount()).toBe(3);
    expect(sendLockHolder()).toBeNull();
  });

  it('brain authorisation is enough on its own, as for the auto-sender', async () => {
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE transaction_ref = 'T-UNPAID'").run();
    const r = await send(['T-UNPAID'], signed(admin, ['T-UNPAID']));
    // Through both gates to the wallet, which the stand-in chain leaves empty.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('No UTXOs available in buyback wallet');
    expect(chain.calls).toContain('blockchain.address.listunspent');
  });

  it('a signed admin with every order authorised gets through to the wallet', async () => {
    const r = await send(['T-PAID'], signed(admin, ['T-PAID']));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('No UTXOs available in buyback wallet');
    expect(chain.calls).toContain('blockchain.address.listunspent');
    expect(chain.broadcast).toEqual([]);
    expect(sendLockHolder()).toBeNull();
  });

  it('a token signed for other refs does not carry over to these', async () => {
    const r = await send(['T-PAID', 'T-UNPAID'], signed(admin, ['T-PAID']));
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('PAYLOAD_MISMATCH');
    expect(chain.calls).toEqual([]);
  });
});
