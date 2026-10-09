// @vitest-environment node
/**
 * GET /api/session/role — WHO A SIGNED-IN KEY IS HERE (owner, 9 Oct 2026).
 *
 * lana.discount is now only for the companies that finance purchases and for
 * the administrators. The page keeps a session only on 'admin' or 'financer'
 * (src/pages/Login.gate.test.tsx); this pins what the server says:
 *   - only the key that signed is asked about; unsigned or replayed is 403;
 *   - an administrator is this site's own roster, asked first, so Direct.Fund
 *     away does not keep an administrator out;
 *   - a financer is Direct.Fund's isInvestor && financer, asked fresh; a
 *     Direct.Fund before the flag reads as before (isInvestor);
 *   - anyone else is 'none'; Direct.Fund not answering about a key that is no
 *     administrator is 502, never a guess either way.
 * And what must NOT change with it: GET /api/user/:hexId/sales, which another
 * app reads, stays public and unsigned for every key, and the router is
 * mounted where express reaches it (before the SPA catch-all).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { readFileSync } from 'fs';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

const sales = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../lib/roundMandateTestKit');
  return {
    ...dbModuleStub(createMandateTestDb()),
    getUserSalesWithPayouts: (hex: string) => {
      sales.asked.push(hex);
      return [{ id: 7, lanaAmount: 1000, currency: 'EUR', netFiat: 12.5, status: 'paid', payouts: [], totalPaid: 12.5, remaining: 0 }];
    },
  };
});

import { getDbHandle } from '../db/index.js';
import apiRouter from './api';
import { createSessionRouter } from './session';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';

const db: Database.Database = getDbHandle();
const admin = newSigner();
const financer = newSigner();
const investor = newSigner();
const stranger = newSigner();

/** Direct.Fund's investors: `financer` absent is a Direct.Fund before the flag. */
const people = new Map<string, Record<string, unknown>>();
const df = { hits: [] as string[], down: false };
let dfServer: http.Server;
let server: http.Server;
let base = '';

beforeAll(async () => {
  dfServer = http.createServer((req, res) => {
    const url = String(req.url);
    df.hits.push(url);
    res.setHeader('content-type', 'application/json');
    if (df.down) { res.statusCode = 503; res.end('{}'); return; }
    const m = /^\/api\/admin\/financers\/([0-9a-f]{64})$/.exec(url);
    if (!m) { res.statusCode = 404; res.end('{}'); return; }
    const p = people.get(m[1]);
    res.end(JSON.stringify({ hexId: m[1], isInvestor: !!p, lanaDiscountWallet: null, lanaDiscountWalletSetAt: null, wallets: {}, ...(p ?? {}) }));
  });
  await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
  const dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use('/api', apiRouter);
  app.use('/api/session', createSessionRouter({ df: { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) } }));
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => dfServer.close(() => r()));
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_users').run();
  // The administrator's own roster, as requireAdmin reads it (db/index.ts isAdminUser).
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  people.clear();
  people.set(financer.hex, { financer: true });
  people.set(investor.hex, { financer: false });
  df.hits = [];
  df.down = false;
  sales.asked = [];
});

const URL_ = '/api/session/role';
const role = async (who: TestSigner | null, header?: string) => {
  const r = await fetch(base + URL_, { headers: who ? { authorization: header ?? nip98Header(who, { method: 'GET', url: URL_ }) } : {} });
  return { status: r.status, body: await r.json() as any };
};

describe('GET /api/session/role', () => {
  it('unsigned, or signed for another address, is refused 403 and Direct.Fund is not asked', async () => {
    expect(await role(null)).toMatchObject({ status: 403, body: { code: 'SIGNATURE_REQUIRED', reason: 'MISSING' } });
    const elsewhere = nip98Header(financer, { method: 'GET', url: '/api/financer/me' });
    expect((await role(financer, elsewhere)).status).toBe(403);
    expect(df.hits).toEqual([]);
  });

  it('the same signed request twice: the second is a replay, refused', async () => {
    const once = nip98Header(financer, { method: 'GET', url: URL_ });
    expect(await role(financer, once)).toEqual({ status: 200, body: { role: 'financer' } });
    expect(await role(financer, once)).toMatchObject({ status: 403, body: { code: 'SIGNATURE_REQUIRED', reason: 'REPLAYED' } });
  });

  it("an administrator: 'admin', from this site's roster, without asking Direct.Fund — even while it is away", async () => {
    df.down = true;
    expect(await role(admin)).toEqual({ status: 200, body: { role: 'admin' } });
    expect(df.hits).toEqual([]);
  });

  it("a financer (Direct.Fund: an investor with the financer flag on): 'financer', asked with the peer key, fresh", async () => {
    expect(await role(financer)).toEqual({ status: 200, body: { role: 'financer' } });
    expect(df.hits).toEqual([`/api/admin/financers/${financer.hex}`]);
    people.set(financer.hex, { financer: false });
    expect((await role(financer)).body).toEqual({ role: 'none' });
  });

  it("an investor whose flag is off, and a key Direct.Fund does not know: 'none'", async () => {
    expect(await role(investor)).toEqual({ status: 200, body: { role: 'none' } });
    expect(await role(stranger)).toEqual({ status: 200, body: { role: 'none' } });
  });

  it("a Direct.Fund before the flag: an investor is a financer, as before; anyone else 'none'", async () => {
    people.set(investor.hex, {});
    expect((await role(investor)).body).toEqual({ role: 'financer' });
    expect((await role(stranger)).body).toEqual({ role: 'none' });
  });

  it('Direct.Fund away, or answering with a flag that is not true or false: 502 DF_UNAVAILABLE — never a guess', async () => {
    df.down = true;
    for (const who of [financer, investor, stranger]) expect(await role(who)).toMatchObject({ status: 502, body: { code: 'DF_UNAVAILABLE' } });
    df.down = false;
    people.set(investor.hex, { financer: 1 });
    expect(await role(investor)).toMatchObject({ status: 502, body: { code: 'DF_UNAVAILABLE' } });
  });
});

describe('what the sign-in gate leaves alone', () => {
  it('GET /api/user/:hexId/sales stays public and unsigned, for a key the gate answers none as for any other', async () => {
    expect((await role(stranger)).body).toEqual({ role: 'none' });
    df.hits = [];
    const r = await fetch(`${base}/api/user/${stranger.hex}/sales`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sales: [{ id: 7, lanaAmount: 1000, currency: 'EUR', netFiat: 12.5, status: 'paid', payouts: [], totalPaid: 12.5, remaining: 0 }] });
    expect(sales.asked).toEqual([stranger.hex]);
    expect(df.hits).toEqual([]);
  });

  it('the router is mounted at /api/session, before the SPA catch-all (after it, express answers index.html)', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const mounted = index.indexOf("app.use('/api/session', createSessionRouter(");
    expect(mounted).toBeGreaterThan(-1);
    expect(mounted).toBeLessThan(index.indexOf("app.get('/{*path}'"));
  });
});
