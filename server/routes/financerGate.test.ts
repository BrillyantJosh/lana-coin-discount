// @vitest-environment node
/**
 * /api/financer IS ONLY FOR THE FINANCERS — DIRECT.FUND'S isInvestor && financer.
 *
 * Owner, 9 Oct 2026: "zdaj pa lahko pri njem se logirajo samo zastopniki
 * podjetji ki financirajo … vsi ostali ne moremo več financirati". Direct.Fund
 * marks the financing companies' representatives with a financer flag; every
 * other investor keeps their row there and is no financer here any more.
 *
 * Pinned: every route but /me answers such an investor 403 NOT_FINANCER before
 * it reads or writes anything (the send machine is never asked, no batch is
 * read, nothing is written); /me answers them isFinancer: false and nothing of
 * theirs; a financer passes every route; a Direct.Fund before the flag is read
 * as before (isInvestor); and a flag that is not true or false is no yes.
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
import { createFinancerRouter } from './financer';
import type { Sends } from '../lib/financer/sends';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';

const db: Database.Database = getDbHandle();
const financer = newSigner();
const investor = newSigner();
const stranger = newSigner();
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';

// ─── a Direct.Fund: who is an investor, and whose financer flag is on ─────

/** `financer` absent: a Direct.Fund before the flag. Anything not listed is no investor. */
const people = new Map<string, Record<string, unknown>>();
const dfHits: string[] = [];
let dfServer: http.Server;
let dfBase = '';

// ─── the send machine, only listened to ───────────────────────────────────

const machineCalls: string[] = [];
const sends = {
  async sendable(owner: string) { machineCalls.push(`sendable ${owner}`); return { ok: true, body: { purchases: [], legCount: 0 } }; },
  async prepare(owner: string) { machineCalls.push(`prepare ${owner}`); return { ok: true, body: { prepared: true } }; },
  async announce(owner: string) { machineCalls.push(`announce ${owner}`); return { ok: true, send: { txid: 'a'.repeat(64) }, already: false }; },
  list(owner: string) { machineCalls.push(`list ${owner}`); return []; },
} as unknown as Sends;

let registrarAsks = 0;
const walletFetch = (async () => {
  registrarAsks++;
  return new Response(JSON.stringify({ registered: true, frozen: false, wallet_type: 'Lana.Discount', nostr_hex_id: financer.hex }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let server: http.Server;
let base = '';

beforeAll(async () => {
  dfServer = http.createServer((req, res) => {
    const url = String(req.url);
    dfHits.push(url);
    res.setHeader('content-type', 'application/json');
    const m = /^\/api\/admin\/financers\/([0-9a-f]{64})(\/lana-discount-batches)?$/.exec(url);
    if (!m) { res.statusCode = 404; res.end('{}'); return; }
    if (m[2]) { res.end(JSON.stringify({ batches: [] })); return; }
    const p = people.get(m[1]);
    res.end(JSON.stringify(p ? { hexId: m[1], isInvestor: true, lanaDiscountWallet: WALLET, lanaDiscountWalletSetAt: '2026-10-08', wallets: { EUR: { walletId: WALLET, setAt: null } }, ...p }
      : { hexId: m[1], isInvestor: false, lanaDiscountWallet: null, lanaDiscountWalletSetAt: null, wallets: {} }));
  });
  await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
  dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use('/api/financer', createFinancerRouter({
    walletCheckBaseUrl: 'http://check.test',
    df: { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) },
    walletFetch,
    sends,
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
  people.clear();
  people.set(financer.hex, { financer: true });
  people.set(investor.hex, { financer: false });
  dfHits.length = 0;
  machineCalls.length = 0;
  registrarAsks = 0;
});

const call = async (who: TestSigner, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const url = `/api/financer${path}`;
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: nip98Header(who, { method, url, body: raw }) }, body: raw });
  return { status: r.status, body: await r.json() as any };
};

/** Every route that acts on the signer's purchases, batches or sends. */
const ROUTES: Array<[string, 'GET' | 'POST', string, unknown?]> = [
  ['batches', 'GET', '/batches'],
  ['confirm', 'POST', '/batches/confirm', { batchRefs: ['B1'] }],
  ['sendable', 'GET', '/sendable?currency=EUR'],
  ['prepare', 'POST', '/sends/prepare', { orderIds: ['O1'] }],
  ['announce', 'POST', '/sends', { orderIds: ['O1'], rawTx: '00' }],
  ['list', 'GET', '/sends'],
];

const nothingWritten = () => {
  for (const t of ['incoming_batches', 'purchase_settlement', 'brain_callback_outbox']) {
    expect((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c, t).toBe(0);
  }
};

describe('a key that is no financer', () => {
  for (const [name, method, path, body] of ROUTES) {
    it(`${name}: an investor whose financer flag is off is refused 403 NOT_FINANCER, after one Direct.Fund question and nothing else`, async () => {
      const r = await call(investor, method, path, body);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('NOT_FINANCER');
      expect(dfHits).toEqual([`/api/admin/financers/${investor.hex}`]);
      expect(machineCalls).toEqual([]);
      expect(registrarAsks).toBe(0);
      nothingWritten();
    });

    it(`${name}: a key Direct.Fund does not know at all is refused the same`, async () => {
      const r = await call(stranger, method, path, body);
      expect(r).toMatchObject({ status: 403, body: { code: 'NOT_FINANCER' } });
      expect(machineCalls).toEqual([]);
    });
  }

  it('/me answers isFinancer: false and nothing of theirs — no wallet, no purchase, no Registrar question — though Direct.Fund lists a wallet for them', async () => {
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('P1', ?, 'financer', ?)").run(investor.hex, investor.hex);
    const r = await call(investor, 'GET', '/me');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      hexId: investor.hex, isFinancer: false, wallets: [], unknownCurrencyRefs: [],
      lanaDiscountWallet: null, lanaDiscountWalletSetAt: null, walletCheck: { ok: false, reason: 'NO_WALLET' },
    });
    expect(registrarAsks).toBe(0);
  });
});

describe('a financer', () => {
  for (const [name, method, path, body] of ROUTES) {
    it(`${name}: passes, and is answered about themselves`, async () => {
      const r = await call(financer, method, path, body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.code).toBeUndefined();
      expect(dfHits[0]).toBe(`/api/admin/financers/${financer.hex}`);
      if (['sendable', 'prepare', 'announce', 'list'].includes(name)) expect(machineCalls).toEqual([`${name} ${financer.hex}`]);
    });
  }

  it('/me: isFinancer true, with their wallet and the Registrar\'s word on it', async () => {
    const r = await call(financer, 'GET', '/me');
    expect(r.body).toMatchObject({ isFinancer: true, wallets: [{ currency: 'EUR', walletId: WALLET, walletCheck: { ok: true } }] });
    expect(registrarAsks).toBe(1);
  });
});

describe('what Direct.Fund says', () => {
  it('a Direct.Fund before the flag (field absent): an investor is a financer, as before; a key that is none is not', async () => {
    people.set(investor.hex, {});
    expect((await call(investor, 'GET', '/sends')).status).toBe(200);
    expect((await call(investor, 'GET', '/me')).body.isFinancer).toBe(true);
    expect((await call(stranger, 'GET', '/sends')).body.code).toBe('NOT_FINANCER');
  });

  it('a flag that is not true or false is no yes: Direct.Fund answered wrongly, refused DF_UNAVAILABLE, nothing asked of the machine', async () => {
    people.set(investor.hex, { financer: 'yes' });
    for (const [, method, path, body] of ROUTES) {
      const r = await call(investor, method, path, body);
      expect(r, path).toMatchObject({ status: 502, body: { code: 'DF_UNAVAILABLE' } });
    }
    expect((await call(investor, 'GET', '/me')).status).toBe(502);
    expect(machineCalls).toEqual([]);
  });

  it('the flag is read fresh every time: switched off on Direct.Fund, the next request is refused', async () => {
    expect((await call(financer, 'GET', '/sends')).status).toBe(200);
    people.set(financer.hex, { financer: false });
    expect((await call(financer, 'GET', '/sends')).body.code).toBe('NOT_FINANCER');
  });
});
