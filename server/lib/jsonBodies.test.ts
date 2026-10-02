// @vitest-environment node
/**
 * A BATCH OF 288 PAYMENTS MUST BE CONFIRMABLE — and a body that is refused must
 * say so, in JSON, and leave a trace.
 *
 * 2 Oct 2026: "Confirm Received" for batch 2026002256 (288 payments, €5,435.49)
 * failed on every press. The body was ~70 kb, the server read at most 50 kb,
 * and the refusal happened before the route and before the request logger —
 * so the page said "Failed to update batch status" and the logs said nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { installJsonBodies, LARGE_BODY_PATHS } from './jsonBodies';
import { installRequestLogging } from '../shared/requestLogging';
import { verifyRequestNip98 } from './nip98Auth';
import { newSigner, nip98Header } from './nip98TestKit';

const db = new Database(':memory:');
const seen: Array<{ path: string; count: number; rawBytes: number; sig: string }> = [];

const app = express();
// Same order as server/index.ts: the logger first, so a refused body is logged.
installRequestLogging(app, db);
installJsonBodies(app);
app.put('/api/admin/incoming-batches/:ref/status', (req, res) => {
  const v = verifyRequestNip98(req as any);
  seen.push({ path: req.path, count: req.body?.payments?.length ?? -1, rawBytes: (req as any).rawBody?.length ?? 0, sig: v.ok ? 'ok' : (v as any).reason });
  res.json({ success: true });
});
app.post('/api/admin/send-batch-lana', (req, res) => res.json({ refs: req.body?.transaction_refs?.length ?? -1 }));
app.post('/api/elsewhere', (_req, res) => res.json({ reached: true }));

const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => { server.close(); db.close(); });

/** The body AdminIncomingPayments.tsx sends for a batch of n payments. */
function batchBody(n: number) {
  return JSON.stringify({
    status: 'received',
    investorHex: 'b'.repeat(64),
    totalAmount: 5435.49,
    currency: 'EUR',
    paymentCount: n,
    payments: Array.from({ length: n }, (_, i) => ({
      ppId: 9_000_000 + i,
      orderType: i % 3 === 0 ? 'caretaker_via_discount' : 'lana_purchase',
      amountFiat: 18.87,
      currency: 'EUR',
      recipientWallet: 'LcaNwohXLJ8TvKBeX7QLCQrXTzxx2cPhPZ',
      shopName: 'Eko veganska trgovina Živa Center',
      transactionRef: `${String(i).padStart(8, '0')}-b249-41e0-a459-60fdc4804434`,
    })),
  });
}

const send = (method: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });

describe('the batch route takes a whole batch', () => {
  it('288 payments — the batch that could not be confirmed — reaches the route, signed and whole', async () => {
    const body = batchBody(288);
    expect(Buffer.byteLength(body)).toBeGreaterThan(50 * 1024);
    const signer = newSigner();
    const path = '/api/admin/incoming-batches/2026002256/status';
    const r = await send('PUT', path, body, { Authorization: nip98Header(signer, { method: 'PUT', url: path, body }) });
    expect(r.status).toBe(200);
    const last = seen[seen.length - 1];
    expect(last.count).toBe(288);
    // The exact bytes are kept, so the signature over them still verifies.
    expect(last.rawBytes).toBe(Buffer.byteLength(body));
    expect(last.sig).toBe('ok');
  });

  it('room for thousands: 6,000 payments still go through', async () => {
    const r = await send('PUT', '/api/admin/incoming-batches/X/status', batchBody(6000));
    expect(r.status).toBe(200);
    expect(seen[seen.length - 1].count).toBe(6000);
  });

  it('send-batch-lana takes a long list of transactions too', async () => {
    const refs = Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(8, '0')}-b249-41e0-a459-60fdc4804434`);
    const r = await send('POST', '/api/admin/send-batch-lana', JSON.stringify({ transaction_refs: refs }));
    expect(await r.json()).toEqual({ refs: 3000 });
  });

  it('the larger limit is for those routes only', () => {
    expect([...LARGE_BODY_PATHS]).toEqual(['/api/admin/incoming-batches', '/api/admin/send-batch-lana']);
  });
});

describe('a refused body says so, and is logged', () => {
  it('everywhere else 50 kb still holds — answered in JSON with a code, the route never runs', async () => {
    const r = await send('POST', '/api/elsewhere', batchBody(288));
    expect(r.status).toBe(413);
    const data = (await r.json()) as any;
    expect(data.code).toBe('BODY_TOO_LARGE');
    expect(data.error).toMatch(/Nothing was changed/);
  });

  it('even the batch route has a ceiling', async () => {
    const r = await send('PUT', '/api/admin/incoming-batches/X/status', batchBody(12_000));
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).code).toBe('BODY_TOO_LARGE');
  });

  it('a body that is not JSON is a 400 in JSON, not an HTML page', async () => {
    const r = await send('POST', '/api/elsewhere', '{"status": ');
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).code).toBe('BODY_NOT_JSON');
  });

  it('the refusal is in request_logs — it was invisible before', async () => {
    await send('POST', '/api/elsewhere', batchBody(400));
    await new Promise(r => setTimeout(r, 50));
    const rows = db.prepare("SELECT method, path, status FROM request_logs WHERE status = 413").all();
    expect(rows).toContainEqual({ method: 'POST', path: '/api/elsewhere', status: 413 });
  });
});
