// @vitest-environment node
/**
 * POST /api/admin/brain-callbacks/rearm — »RE-SEND TO BRAIN«, FOR A PERSON.
 *
 * Review N9: a fiat-received that GAVE UP on a financer's batch (a brain
 * redeploy with a mismatched callback key: 401 for 7 days) had no way back the
 * administrator could take — the treasury's "received" is refused
 * OWNER_CONFLICT on a financer's batch, and only a hand-signed POST by the
 * financer brought it back. This route, signed by an admin, re-arms one row
 * and changes nothing else: no batch, no owner, no leg. The real router is
 * mounted on the production DDL (roundMandateTestKit), with real NIP-98
 * signatures.
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
vi.mock('../lib/electrum.js', () => ({
  electrumCall: async () => { throw new Error('no chain in this test'); },
  fetchBatchBalances: async () => [],
}));

import { getDbHandle } from '../db/index.js';
import apiRouter from './api';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';
import { enqueue, GAVE_UP } from '../lib/financer/brainOutbox';
import { recordTreasuryReceived } from '../lib/financer/confirm';
import { parseBatchByRef } from '../lib/financer/dfClient';

const PATH = '/api/admin/brain-callbacks/rearm';
const db: Database.Database = getDbHandle();
const admin = newSigner();
const stranger = newSigner();
const FIN = 'f1'.repeat(32);

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
afterAll(() => new Promise<void>(r => server.close(() => r())));

const rearm = async (who: TestSigner | null, body: unknown) => {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = nip98Header(who, { method: 'POST', url: PATH, body: raw });
  const r = await fetch(base + PATH, { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json() as any };
};
const row = (key: string) => db.prepare('SELECT * FROM brain_callback_outbox WHERE dedupe_key = ?').get(key) as any;
const snapshot = () => ({
  batches: db.prepare('SELECT * FROM incoming_batches ORDER BY id').all(),
  owners: db.prepare('SELECT * FROM purchase_settlement ORDER BY transaction_ref').all(),
  legs: db.prepare('SELECT * FROM brain_lana_orders ORDER BY id').all(),
});

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batch_payments', 'incoming_batches', 'purchase_settlement', 'brain_callback_outbox', 'admin_users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  // A financer's confirmed batch: its purchase is theirs, its leg not approved, its call given up.
  db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B1', ?, 10, 'EUR', 'received', 'financer')").run(FIN);
  db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by) VALUES ('T1', ?, 'financer', 'B1', ?)").run(FIN, FIN);
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized, batch_ref)
              VALUES ('O1', 'T1', 'investor_lana', 'L', ?, 100000000, 1, 'EUR', 1, 'pending', 0, 'B1')`).run(FIN);
  enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: Date.parse('2026-09-01T00:00:00Z') });
  db.prepare("UPDATE brain_callback_outbox SET last_error = ?, attempts = 300 WHERE dedupe_key = 'fiat-received:B1'").run(GAVE_UP);
});

describe('POST /api/admin/brain-callbacks/rearm', () => {
  it("brings back a financer batch's given-up fiat-received — the treasury's door cannot — and changes nothing else", async () => {
    // The way that was there before: refused, nothing changed.
    const df = parseBatchByRef({
      batch: { batchRef: 'B1', investorHex: FIN, totalAmount: 10, currency: 'EUR', status: 'paid', destinationType: 'lana_discount' },
      payments: [{ ppId: 1, amount: 10, currency: 'EUR', confirmed: true, transactionRef: 'T1', investorHex: FIN, destinationType: 'lana_discount', live: true }],
    }, 'B1');
    expect(recordTreasuryReceived(db, df, admin.hex)).toMatchObject({ ok: false, code: 'OWNER_CONFLICT' });
    expect(row('fiat-received:B1').last_error).toBe(GAVE_UP);

    const before = snapshot();
    const body = row('fiat-received:B1').body_json;
    const r = await rearm(admin, { dedupeKey: 'fiat-received:B1' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, dedupeKey: 'fiat-received:B1', kind: 'fiat-received', reopened: false });
    const after = row('fiat-received:B1');
    expect(after).toMatchObject({ done_at: null, last_error: null, accepted_at: null, body_json: body, attempts: 300 });
    expect(after.next_at).toBe(after.created_at);
    expect(Date.parse(after.created_at.replace(' ', 'T') + 'Z')).toBeGreaterThan(Date.now() - 60_000);
    expect(snapshot()).toEqual(before);
  });

  it('an unsigned request, or a signature by a key that is not an admin, changes nothing', async () => {
    const before = row('fiat-received:B1');
    const unsigned = await rearm(null, { dedupeKey: 'fiat-received:B1' });
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe('SIGNATURE_REQUIRED');
    const notAdmin = await rearm(stranger, { dedupeKey: 'fiat-received:B1' });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body.error).toBe('Admin access required');
    expect(row('fiat-received:B1')).toEqual(before);
  });

  it('a missing or malformed key is 400, an unknown one 404, a delivered call with nothing waiting 409', async () => {
    for (const body of [{}, { dedupeKey: '' }, { dedupeKey: 7 }, { dedupeKey: 'x'.repeat(201) }]) {
      const r = await rearm(admin, body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('BAD_DEDUPE_KEY');
    }
    const unknown = await rearm(admin, { dedupeKey: 'fiat-received:B9' });
    expect(unknown).toMatchObject({ status: 404, body: { code: 'UNKNOWN_CALLBACK' } });

    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1").run();
    db.prepare("UPDATE brain_callback_outbox SET last_error = NULL, done_at = '2026-10-08 12:00:00'").run();
    const done = row('fiat-received:B1');
    const r = await rearm(admin, { dedupeKey: 'fiat-received:B1' });
    expect(r).toMatchObject({ status: 409, body: { code: 'NOTHING_TO_REARM' } });
    expect(row('fiat-received:B1')).toEqual(done);
  });
});
