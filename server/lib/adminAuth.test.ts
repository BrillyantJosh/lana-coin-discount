// @vitest-environment node
/**
 * THE ADMIN GATE BELIEVES A SIGNATURE, NOT A NAME.
 *
 * Until 2 Oct 2026 requireAdmin() took the hex in `x-admin-hex-id` at its word,
 * and GET /api/request-logs did the same with `x-admin-hex` / `?admin_hex=`.
 * A hex is a public key, so knowing it was being it. These tests pin the gate
 * that replaced it: the identity is the key that SIGNED this exact request
 * (method, path + query, body), once — and nothing a request merely says.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import DatabaseCtor from 'better-sqlite3';

const admins = vi.hoisted(() => new Set<string>());
vi.mock('../db/index.js', () => ({ isAdminUser: (hex: string) => admins.has(hex) }));

import { requireAdmin } from './adminAuth';
import { keepRawBody } from './nip98Auth';
import { newSigner, nip98Header } from './nip98TestKit';
import { installRequestLogging } from '../shared/requestLogging';

/** Root as hard-coded in shared/requestLogging.ts. Nobody here holds its key. */
const ROOT = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
const admin = newSigner();
const stranger = newSigner();

const app = express();
app.use(express.json({ verify: keepRawBody }));
installRequestLogging(app, new DatabaseCtor(':memory:'));
const thing = (req: express.Request, res: express.Response) => {
  const hex = requireAdmin(req, res);
  if (!hex) return;
  res.json({ hex, adminHex: (req as any).adminHex });
};
app.get('/api/admin/thing', thing);
app.post('/api/admin/thing', thing);

let server: http.Server;
let base = '';
beforeEach(async () => {
  if (!server) {
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  admins.clear();
  admins.add(admin.hex);
});
afterAll(() => new Promise<void>(r => server?.close(() => r())));

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  fetch(base + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body })
    .then(async r => ({ status: r.status, body: await r.json() as any }));

describe('requireAdmin', () => {
  it('refuses an unsigned request that names a real admin in the old header', async () => {
    const r = await call('GET', '/api/admin/thing', { 'x-admin-hex-id': admin.hex, 'x-admin-hex': admin.hex });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'SIGNATURE_REQUIRED', reason: 'MISSING' });
  });

  it('refuses ?admin_hex= naming a real admin', async () => {
    const r = await call('GET', `/api/admin/thing?admin_hex=${admin.hex}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
  });

  it('lets a correctly signed admin in, as the signer — bare path or this host\'s absolute URL', async () => {
    const a = await call('GET', '/api/admin/thing', { authorization: nip98Header(admin, { method: 'GET', url: '/api/admin/thing' }) });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ hex: admin.hex, adminHex: admin.hex });

    // What the browser sends in production: the absolute URL, bound to the Host.
    const body = JSON.stringify({ x: 1 });
    const b = await call('POST', '/api/admin/thing', { authorization: nip98Header(admin, { method: 'POST', url: `${base}/api/admin/thing`, body }) }, body);
    expect(b.status).toBe(200);
    expect(b.body.hex).toBe(admin.hex);
  });

  it('a header works once: the same one again is a replay', async () => {
    const h = { authorization: nip98Header(admin, { method: 'GET', url: '/api/admin/thing' }) };
    expect((await call('GET', '/api/admin/thing', h)).status).toBe(200);
    const again = await call('GET', '/api/admin/thing', h);
    expect(again.status).toBe(403);
    expect(again.body.reason).toBe('REPLAYED');
  });

  it('refuses a valid signature by a key that is not an admin, whatever header it adds', async () => {
    const r = await call('GET', '/api/admin/thing', {
      authorization: nip98Header(stranger, { method: 'GET', url: '/api/admin/thing' }),
      'x-admin-hex-id': admin.hex,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Admin access required');
  });

  it('refuses a token signed for a different body', async () => {
    const signed = JSON.stringify({ transaction_refs: ['T1'] });
    const sent = JSON.stringify({ transaction_refs: ['T1', 'T2'] });
    const r = await call('POST', '/api/admin/thing', { authorization: nip98Header(admin, { method: 'POST', url: '/api/admin/thing', body: signed }) }, sent);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('PAYLOAD_MISMATCH');
  });

  it('refuses a token signed for another path or another host', async () => {
    const other = await call('GET', '/api/admin/thing', { authorization: nip98Header(admin, { method: 'GET', url: '/api/admin/users' }) });
    expect(other.body.reason).toBe('PATH_MISMATCH');
    const host = await call('GET', '/api/admin/thing', { authorization: nip98Header(admin, { method: 'GET', url: 'https://direct.lana.fund/api/admin/thing' }) });
    expect(host.body.reason).toBe('HOST_MISMATCH');
  });

  it('logs a refusal by path and reason only — never the query or the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = nip98Header(admin, { method: 'GET', url: '/api/admin/elsewhere' });
    await call('GET', '/api/admin/thing?secret=1', { authorization: h });
    const line = warn.mock.calls.map(c => c.join(' ')).find(l => l.includes('[admin-auth]'));
    warn.mockRestore();
    expect(line).toBe('[admin-auth] REJECT GET /api/admin/thing reason=PATH_MISMATCH');
  });
});

describe('GET /api/request-logs', () => {
  it('refuses the root hex named in the old header or the query', async () => {
    expect((await call('GET', '/api/request-logs', { 'x-admin-hex': ROOT, 'x-admin-hex-id': ROOT })).status).toBe(403);
    expect((await call('GET', `/api/request-logs?admin_hex=${ROOT}`)).status).toBe(403);
  });

  it('refuses a signed admin who is not root', async () => {
    const r = await call('GET', '/api/request-logs', { authorization: nip98Header(admin, { method: 'GET', url: '/api/request-logs' }) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });
});
