// @vitest-environment node
/**
 * POST /api/peer/fund/purchase-sends — DIRECT.FUND READS THE LANA SIDE OF ITS PURCHASES, WITH ITS OWN READ KEY.
 *
 * The real router (routes/fundPeer.ts) on the production DDL (roundMandateTestKit), behind the JSON bodies and the
 * /api rate limiter exactly as server/index.ts mounts them. What is pinned:
 *   - the key: FUND_READ_KEY unset is 503 for everybody, and so is FUND_READ_KEY set to FUND_PEER_KEY's value (fails
 *     closed); FUND_PEER_KEY — the value brain and the auditor hold too — never opens it (401), nor does no key,
 *     another scheme or another key; the right key is 200 — compared timing-safe, a key of another length refused,
 *     never a throw;
 *   - the body: { tx_refs: string[1..500] } or 400 BAD_TX_REFS, nothing read;
 *   - the answer: a financer's purchase with its legs and the confirmed send that paid them, the treasury's, a send
 *     booked under a mined copy's id, a purchase nobody confirmed, each send's key_wallets — and never raw_tx, the
 *     coins, the legs a send carried, a leg's must-spend outpoints, or a cashback leg's customer key and wallet;
 *   - the limiter: the right key on this route is never counted nor refused; anybody else on the same IP still is,
 *     and so is the read key on any other path, a wrong key on this one and FUND_PEER_KEY;
 *   - the router is mounted at /api/peer/fund behind the limiter and before the SPA catch-all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { readFileSync } from 'fs';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../lib/roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { getDbHandle } from '../db/index.js';
import { createFundPeerRouter } from './fundPeer';
import { installJsonBodies } from '../lib/jsonBodies';
import { apiRateLimit } from '../lib/apiRateLimit';
import { FUND_READ_ROUTES } from '../lib/fundPeer';
import { COPY_OUTCOME } from '../lib/financer/sends';

const db: Database.Database = getDbHandle();
/** FUND_READ_KEY: Direct.Fund's key for this read. */
const KEY = 'read-test-0123456789abcdef';
/** FUND_PEER_KEY: Direct.Fund's PEER_API_KEY, which lana-brain and lana-audit hold too. */
const PEER = 'peer-test-0123456789abcdef';
const FIN = 'f1'.repeat(32);
const PATH = '/api/peer/fund/purchase-sends';
const RAW = '0100000001' + 'de'.repeat(120);
const COIN = `${'ab'.repeat(32)}:1`;
const MUST = `${'cd'.repeat(32)}:0`;
const tx = (c: string) => c.repeat(64);
const S_FIN = tx('a');
const S_TRE = tx('b');
const S_CPY = tx('c');
const COPY = tx('9');

/** An app as server/index.ts builds one: JSON bodies, the /api limiter (production numbers unless told), the router. */
function appWith(limiter = apiRateLimit()) {
  const app = express();
  installJsonBodies(app);
  app.use('/api', limiter);
  app.use('/api/peer/fund', createFundPeerRouter({ now: () => Date.parse('2026-11-11T09:30:00Z') }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  return app;
}

let server: http.Server;
let base = '';
async function serve(app: express.Express) {
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
  await new Promise<void>(r => server.close(() => r()));
}

const post = async (body: unknown, authorization: string | null = `Bearer ${KEY}`, path = PATH) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  const r = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, headers: r.headers };
};

function seed() {
  for (const t of ['brain_lana_orders', 'purchase_settlement', 'lana_sends', 'api_keys']) db.prepare(`DELETE FROM ${t}`).run();
  const own = (ref: string, by: string, owner: string, batch: string | null) =>
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-20 08:00:00')")
      .run(ref, owner, by, batch, by === 'financer' ? owner : 'migration');
  let seq = 0;
  const leg = (id: string, ref: string, type: string, lanoshis: number, status: string, txHash: string | null, sendTxid: string | null, mustSpend: string | null = null) =>
    db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate,
                  status, tx_hash, send_txid, must_spend_json, completed_at, brain_authorized, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 2.5, 'EUR', 0.128, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, ref, type, `L${id}`, type === 'investor_lana' ? FIN : 'c3'.repeat(32), lanoshis, status, txHash, sendTxid, mustSpend,
        status === 'sent' ? '2026-10-20 09:10:00' : null, `2026-10-20 08:00:0${++seq}`);
  const send = (txid: string, sender: string, owner: string | null, wallet: string, orderIds: string[], lastOutcome: string | null = null) =>
    db.prepare(`INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis,
                  state, broadcasts, last_outcome, block_height, confirmed_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 13343359375, 1060000, 'confirmed', 1, ?, 1067600, '2026-10-20 09:10:00', '2026-10-20 09:00:00', '2026-10-20 09:10:00')`)
      .run(txid, sender, owner, wallet, RAW, JSON.stringify(orderIds), JSON.stringify([COIN]), lastOutcome);

  // A financer's purchase: settled by them, two legs paid in their confirmed send.
  own('T-FIN', 'financer', FIN, 'B-FIN');
  leg('fin-inv', 'T-FIN', 'investor_lana', 10_338_867_187, 'sent', S_FIN, S_FIN);
  leg('fin-mer', 'T-FIN', 'merchant_commission', 3_004_492_188, 'sent', S_FIN, S_FIN);
  send(S_FIN, 'financer', FIN, 'LFinWallet', ['fin-inv', 'fin-mer']);
  // The treasury's: its send names no owner. A third leg pending again after a refused send, with its must-spend set.
  own('T-TRE', 'treasury', FIN, 'B-TRE');
  leg('tre-mer', 'T-TRE', 'merchant_commission', 13_343_359_375, 'sent', S_TRE, S_TRE);
  leg('tre-cb', 'T-TRE', 'customer_cashback', 900_000_000, 'pending', null, null, JSON.stringify([MUST]));
  send(S_TRE, 'treasury', null, 'LTreasuryWallet', ['tre-mer']);
  // A send booked under a mined copy's id.
  own('T-CPY', 'financer', FIN, 'B-FIN');
  leg('cpy-mer', 'T-CPY', 'merchant_commission', 13_343_359_375, 'sent', COPY, S_CPY);
  send(S_CPY, 'financer', FIN, 'LFinWallet', ['cpy-mer'], `${COPY_OUTCOME}${COPY}`);
  // Nobody has confirmed this one.
  leg('wait-mer', 'T-WAIT', 'merchant_commission', 1_000_000_000, 'pending', null, null);
}

const saved = { read: process.env.FUND_READ_KEY, peer: process.env.FUND_PEER_KEY };
beforeEach(() => {
  process.env.FUND_READ_KEY = KEY;
  process.env.FUND_PEER_KEY = PEER;
  seed();
});
afterAll(() => {
  for (const [name, value] of [['FUND_READ_KEY', saved.read], ['FUND_PEER_KEY', saved.peer]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ─── the key ──────────────────────────────────────────────────────────────

describe('who may read', () => {
  beforeAll(() => serve(appWith()));
  afterAll(stop);

  it('FUND_READ_KEY not configured here: 503 for everybody — a bearer of any key, FUND_PEER_KEY too, or of none, is not let in', async () => {
    for (const unset of ['', '   ']) {
      process.env.FUND_READ_KEY = unset;
      for (const auth of [`Bearer ${KEY}`, `Bearer ${PEER}`, 'Bearer ', null]) {
        const r = await post({ tx_refs: ['T-FIN'] }, auth);
        expect(r.status, `${JSON.stringify(unset)} ${auth}`).toBe(503);
        expect(r.body).toMatchObject({ code: 'READ_KEY_UNSET' });
        expect(r.text).not.toContain('T-FIN');
      }
    }
    delete process.env.FUND_READ_KEY;
    expect(await post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`)).toMatchObject({ status: 503, body: { code: 'READ_KEY_UNSET' } });
  });

  it('FUND_PEER_KEY never opens it: Direct.Fund, brain and the auditor all hold that value — 401', async () => {
    const r = await post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'READ_KEY_REFUSED' });
    expect(r.text).not.toContain('fin-inv');
  });

  it('FUND_READ_KEY set to FUND_PEER_KEY\'s value is no key of its own: 503 for everybody, that very key included', async () => {
    process.env.FUND_READ_KEY = PEER;
    for (const auth of [`Bearer ${PEER}`, `Bearer ${KEY}`, null]) {
      const r = await post({ tx_refs: ['T-FIN'] }, auth);
      expect(r.status, String(auth)).toBe(503);
      expect(r.body).toMatchObject({ code: 'READ_KEY_SHARED' });
      expect(r.text).not.toContain('fin-inv');
    }
    // Spaces around either value change nothing: both are read trimmed.
    process.env.FUND_READ_KEY = ` ${PEER} `;
    expect((await post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`)).body).toMatchObject({ code: 'READ_KEY_SHARED' });
    // With FUND_PEER_KEY unset there is nothing to share it with: the key reads.
    process.env.FUND_PEER_KEY = '';
    expect((await post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`)).status).toBe(200);
  });

  it('no key, another scheme, another key, a key of another length, the key padded inside: 401', async () => {
    for (const auth of [null, '', KEY, `Basic ${KEY}`, `bearer ${KEY}`, 'Bearer wrong', `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, `Bearer ${KEY.toUpperCase()}`,
      'Bearer ldk_contract_test', `Bearer ${KEY.slice(0, 8)} ${KEY.slice(8)}`]) {
      const r = await post({ tx_refs: ['T-FIN'] }, auth);
      expect(r.status, String(auth)).toBe(401);
      expect(r.body).toMatchObject({ code: 'READ_KEY_REFUSED' });
      expect(r.text).not.toContain('fin-inv');
    }
  });

  it('the key: 200 — around it, spaces as a header carries them are not part of it', async () => {
    expect((await post({ tx_refs: ['T-FIN'] })).status).toBe(200);
    expect((await post({ tx_refs: ['T-FIN'] }, `Bearer  ${KEY}  `)).status).toBe(200);
  });

  it('the key is checked before the body: a refused caller is not told what is wrong with what it sent', async () => {
    const r = await post({ tx_refs: [] }, 'Bearer wrong');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('READ_KEY_REFUSED');
  });
});

// ─── the body and the answer ──────────────────────────────────────────────

describe('what it answers', () => {
  beforeAll(() => serve(appWith()));
  afterAll(stop);

  it('400 BAD_TX_REFS for anything but 1 to 500 purchase ids; a body that is not JSON is the parser\'s 400', async () => {
    for (const body of [{}, { tx_refs: [] }, { tx_refs: 'T-FIN' }, { tx_refs: [1] }, { tx_refs: ['T FIN'] }, { tx_refs: Array(501).fill('T-FIN') }, ['T-FIN']]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(r.body.code).toBe('BAD_TX_REFS');
    }
    expect(await post('{"tx_refs": [')).toMatchObject({ status: 400, body: { code: 'BODY_NOT_JSON' } });
    // 500 of the longest ids fit the 50 kb every body is held to.
    const longest = Array.from({ length: 500 }, (_, i) => `${i}`.padStart(64, 'r'));
    const r = await post({ tx_refs: longest });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.purchases)).toHaveLength(500);
  });

  it('the purchases asked about, each as stored, and the sends their legs name — a mined copy under the send it copies', async () => {
    const r = await post({ tx_refs: ['T-FIN', 'T-TRE', 'T-CPY', 'T-WAIT', 'T-NONE', 'T-FIN'] });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toEqual({
      checked_at: '2026-11-11T09:30:00.000Z',
      purchases: {
        'T-FIN': {
          settlement: { settled_by: 'financer', owner_hex: FIN, batch_ref: 'B-FIN', created_at: '2026-10-20 08:00:00' },
          legs: [
            { id: 'fin-inv', order_type: 'investor_lana', to_hex: FIN, to_wallet: 'Lfin-inv', lana_amount: 10_338_867_187, fiat_value: 2.5, currency: 'EUR',
              exchange_rate: 0.128, status: 'sent', tx_hash: S_FIN, send_txid: S_FIN, completed_at: '2026-10-20 09:10:00' },
            { id: 'fin-mer', order_type: 'merchant_commission', to_hex: 'c3'.repeat(32), to_wallet: 'Lfin-mer', lana_amount: 3_004_492_188, fiat_value: 2.5,
              currency: 'EUR', exchange_rate: 0.128, status: 'sent', tx_hash: S_FIN, send_txid: S_FIN, completed_at: '2026-10-20 09:10:00' },
          ],
        },
        'T-TRE': {
          settlement: { settled_by: 'treasury', owner_hex: FIN, batch_ref: 'B-TRE', created_at: '2026-10-20 08:00:00' },
          legs: [
            expect.objectContaining({ id: 'tre-mer', to_wallet: 'Ltre-mer', status: 'sent', tx_hash: S_TRE, send_txid: S_TRE }),
            // The customer's key and wallet are not given out.
            expect.objectContaining({ id: 'tre-cb', order_type: 'customer_cashback', to_hex: null, to_wallet: null, lana_amount: 900_000_000,
              status: 'pending', tx_hash: null, send_txid: null, completed_at: null }),
          ],
        },
        'T-CPY': {
          settlement: { settled_by: 'financer', owner_hex: FIN, batch_ref: 'B-FIN', created_at: '2026-10-20 08:00:00' },
          legs: [expect.objectContaining({ id: 'cpy-mer', status: 'sent', tx_hash: COPY, send_txid: S_CPY })],
        },
        'T-WAIT': { settlement: null, legs: [expect.objectContaining({ id: 'wait-mer', status: 'pending' })] },
        'T-NONE': { settlement: null, legs: [] },
      },
      // RAW is no transaction, so no key to read: key_wallets is wallet_id alone (both forms of a real key: purchaseSends.test.ts).
      sends: {
        [S_FIN]: { sender: 'financer', owner_hex: FIN, wallet_id: 'LFinWallet', key_wallets: ['LFinWallet'], paying_lanoshis: 13_343_359_375,
          fee_lanoshis: 1_060_000, state: 'confirmed', block_height: 1_067_600, confirmed_at: '2026-10-20 09:10:00', created_at: '2026-10-20 09:00:00',
          chain_txid: S_FIN },
        [S_TRE]: { sender: 'treasury', owner_hex: null, wallet_id: 'LTreasuryWallet', key_wallets: ['LTreasuryWallet'], paying_lanoshis: 13_343_359_375,
          fee_lanoshis: 1_060_000, state: 'confirmed', block_height: 1_067_600, confirmed_at: '2026-10-20 09:10:00', created_at: '2026-10-20 09:00:00',
          chain_txid: S_TRE },
        [S_CPY]: { sender: 'financer', owner_hex: FIN, wallet_id: 'LFinWallet', key_wallets: ['LFinWallet'], paying_lanoshis: 13_343_359_375,
          fee_lanoshis: 1_060_000, state: 'confirmed', block_height: 1_067_600, confirmed_at: '2026-10-20 09:10:00', created_at: '2026-10-20 09:00:00',
          chain_txid: COPY },
      },
    });
    expect(r.body.sends[COPY]).toBeUndefined();
    expect(r.text).not.toContain('Ltre-cb');
  });

  it('never the signed bytes, the coins, the legs a send carried or a leg\'s must-spend outpoints — by name or by value', async () => {
    const r = await post({ tx_refs: ['T-FIN', 'T-TRE', 'T-CPY', 'T-WAIT'] });
    expect(r.status).toBe(200);
    for (const word of ['raw_tx', 'inputs_json', 'order_ids_json', 'must_spend', 'last_outcome', 'release_reason', 'confirmed_by', 'brain_authorized']) {
      expect(r.text).not.toContain(word);
    }
    for (const value of [RAW.slice(0, 40), 'dedede', COIN, MUST]) expect(r.text).not.toContain(value);
  });

  it('reads and writes nothing else: the tables are as they were', async () => {
    const snapshot = () => JSON.stringify(['purchase_settlement', 'brain_lana_orders', 'lana_sends', 'brain_callback_outbox'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    expect((await post({ tx_refs: ['T-FIN', 'T-TRE', 'T-CPY'] })).status).toBe(200);
    expect(snapshot()).toBe(before);
  });

  it('only POST: a GET on the path is not this route', async () => {
    const r = await fetch(base + PATH, { headers: { authorization: `Bearer ${KEY}` } });
    expect(r.status).toBe(404);
  });
});

// ─── the /api rate limit ─────────────────────────────────────────────────

describe('the /api rate limit', () => {
  afterEach(stop);
  const statuses = async (n: number, send: () => Promise<{ status: number }>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await send()).status);
    return out;
  };
  const anonymous = () => fetch(base + '/api/health').then(r => ({ status: r.status }));

  it('never refuses Direct.Fund with the key on this route — and it spends none of the IP\'s budget', async () => {
    await serve(appWith(apiRateLimit(3)));
    expect(await statuses(12, () => post({ tx_refs: ['T-FIN'] }))).toEqual(Array(12).fill(200));
    expect(await statuses(4, anonymous)).toEqual([200, 200, 200, 429]);
    expect(await statuses(3, () => post({ tx_refs: ['T-FIN'] }))).toEqual([200, 200, 200]);
  });

  it('counts and refuses a wrong key on this route, as anyone', async () => {
    await serve(appWith(apiRateLimit(3)));
    expect(await statuses(4, () => post({ tx_refs: ['T-FIN'] }, 'Bearer wrong'))).toEqual([401, 401, 401, 429]);
    expect((await post({ tx_refs: ['T-FIN'] })).status).toBe(200);
  });

  it('counts and refuses FUND_PEER_KEY on this route: it is not the read key', async () => {
    await serve(appWith(apiRateLimit(3)));
    expect(await statuses(4, () => post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`))).toEqual([401, 401, 401, 429]);
  });

  it('counts the right key on any other path: it opens this route only', async () => {
    await serve(appWith(apiRateLimit(3)));
    const elsewhere = () => fetch(base + '/api/health', { headers: { authorization: `Bearer ${KEY}` } }).then(r => ({ status: r.status }));
    expect(await statuses(4, elsewhere)).toEqual([200, 200, 200, 429]);
  });

  it('counts everyone while FUND_READ_KEY is not configured, or is FUND_PEER_KEY\'s value', async () => {
    process.env.FUND_READ_KEY = '';
    await serve(appWith(apiRateLimit(3)));
    expect(await statuses(4, () => post({ tx_refs: ['T-FIN'] }))).toEqual([503, 503, 503, 429]);
    await stop();
    process.env.FUND_READ_KEY = PEER;
    await serve(appWith(apiRateLimit(3)));
    expect(await statuses(4, () => post({ tx_refs: ['T-FIN'] }, `Bearer ${PEER}`))).toEqual([503, 503, 503, 429]);
  });

  it('the paths the limiter lets the key past are the paths the router answers', async () => {
    await serve(appWith(apiRateLimit(1)));
    for (const r of FUND_READ_ROUTES) {
      expect(r.method).toBe('POST');
      expect(await statuses(3, () => post({ tx_refs: ['T-FIN'] }, `Bearer ${KEY}`, r.path))).toEqual([200, 200, 200]);
    }
  });
});

describe('where server/index.ts mounts it', () => {
  it('at /api/peer/fund, behind the /api limiter, before the SPA catch-all (after it, express answers index.html)', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const mounted = index.indexOf("app.use('/api/peer/fund', createFundPeerRouter());");
    expect(mounted).toBeGreaterThan(-1);
    expect(mounted).toBeGreaterThan(index.indexOf("app.use('/api', apiRateLimit());"));
    expect(mounted).toBeLessThan(index.indexOf("app.get('/{*path}'"));
  });
});
