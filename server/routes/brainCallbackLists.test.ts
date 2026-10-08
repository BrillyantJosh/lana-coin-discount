// @vitest-environment node
/**
 * GET /api/admin/brain-callbacks — WHICH CALLS AND WHICH PURCHASES, FOR AN ADMIN ONLY.
 *
 * Recheck of 9 Oct 2026 (M4): /api/heartbeat-status needs no login, yet it
 * listed the keys of given-up brain calls ('fiat-received:<DF batch ref>') and
 * the references of financer purchases that need a person. It keeps only the
 * counts now; the lists are here, signed by an admin (NIP-98) — the keys the
 * page's »Re-send to brain« takes. The real router on the production DDL
 * (roundMandateTestKit), with real NIP-98 signatures.
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

const PATH = '/api/admin/brain-callbacks';
const db: Database.Database = getDbHandle();
const admin = newSigner();
const stranger = newSigner();
const FIN = 'f1'.repeat(32);
const OTHER = 'e2'.repeat(32);

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

const lists = async (who: TestSigner | null) => {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = nip98Header(who, { method: 'GET', url: PATH });
  const r = await fetch(base + PATH, { headers });
  return { status: r.status, body: await r.json() as any };
};

beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batch_payments', 'incoming_batches', 'purchase_settlement', 'brain_callback_outbox', 'admin_users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  // A financer's purchase whose investor leg the brain moved to another investor, a leg still pending.
  db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by) VALUES ('T1', ?, 'financer', 'B1', ?)").run(FIN, FIN);
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized, batch_ref)
              VALUES ('O1', 'T1', 'investor_lana', 'L', ?, 100000000, 1, 'EUR', 1, 'pending', 0, 'B1')`).run(OTHER);
  // A call given up, and one the brain took a month ago whose purchase is still not approved.
  enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: Date.parse('2026-09-01T00:00:00Z') });
  db.prepare("UPDATE brain_callback_outbox SET last_error = ? WHERE dedupe_key = 'fiat-received:B1'").run(GAVE_UP);
  enqueue(db, 'fiat-received', 'fiat-received:B2', { batch_ref: 'B2', transaction_refs: ['T1'] }, { nowMs: Date.parse('2026-09-01T00:00:00Z') });
  db.prepare("UPDATE brain_callback_outbox SET accepted_at = created_at WHERE dedupe_key = 'fiat-received:B2'").run();
});

describe('GET /api/admin/brain-callbacks', () => {
  it('names the given-up calls, those waiting over 7 days and the purchases nobody can send — to an admin', async () => {
    const r = await lists(admin);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      gaveUpKeys: ['fiat-received:B1'],
      waitingOver7dKeys: ['fiat-received:B2'],
      ownerMismatchRefs: ['T1'],
    });
  });

  it('an unsigned request, or one signed by a key that is not an admin, learns nothing', async () => {
    const unsigned = await lists(null);
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe('SIGNATURE_REQUIRED');
    expect(JSON.stringify(unsigned.body)).not.toContain('fiat-received:');
    const notAdmin = await lists(stranger);
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body).toEqual({ error: 'Admin access required' });
  });
});
