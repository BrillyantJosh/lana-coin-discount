// @vitest-environment node
/**
 * "PROSIM DODELAJ TAKO, DA NIHČE VEČ NE MORE TAM PRODAJATI LAN." (Brilly, 8 Oct 2026)
 *
 * Every way a person sold LANA to lana.discount answers 410 SELLING_MOVED and
 * names the firms that buy LANA now — before it reads a field, asks a balance,
 * touches a private key or writes a row. Everything owed for sales already made
 * keeps working: a settlement is still recorded, a seller still sees and may
 * withdraw their own proposal, an admin may still decline one. A proposal
 * nobody can decide any more ends by itself on the next heartbeat.
 *
 * The real routers, mounted the way server/index.ts mounts them, on an
 * in-memory database; nothing reaches a relay, electrum or the chain. The
 * routers are built WITHOUT `sellingClosed`, so what is tested is the default
 * production runs with.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('./roundMandateTestKit');
  const db = createMandateTestDb();
  let payouts = 0;
  return {
    ...dbModuleStub(db),
    txHashExists: (hash: string) => !!db.prepare('SELECT 1 FROM buyback_transactions WHERE tx_hash = ?').get(hash),
    // A closed route that got this far would have booked a sale.
    insertExternalTransaction: () => { throw new Error('a closed route booked a sale'); },
    generatePayoutId: () => `PAY-TEST-${++payouts}`,
    insertSalePayout: (d: any) => {
      db.prepare('INSERT INTO sale_payouts (transaction_id, payout_id, amount, currency, paid_to_account, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(d.transactionId, d.payoutId, d.amount, d.currency, d.paidToAccount, d.note);
      return { payout_id: d.payoutId, amount: d.amount };
    },
  };
});

import { getDbHandle } from '../db/index.js';
import apiRouter from '../routes/api';
import { createAcquisitionsRouter } from '../routes/acquisitions';
import { createConsolidationRouter } from '../routes/consolidation';
import { WALLET_CONSOLIDATION_SCHEMA_SQL } from './consolidation';
import { keepRawBody } from './nip98Auth';
import { newSigner, nip98Header } from './nip98TestKit';
import { SELLING_CLOSED, SELLING_MOVED_CODE, sellingMovedSentence } from './sellingClosed';
import { BEF_DIRECTORY_URL, type BuyingDealersAnswer } from './buyingDealers';
import { expireStaleOffers, consumedByMandate, SELLING_CLOSED_UNDECIDED } from './acquisitionOffer';

const db: Database.Database = getDbHandle();
const admin = newSigner();
const SELLER = 'b'.repeat(64);
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const API_KEY = 'ldk_test_closed';

/** The two firms, as GET /api/buying-dealers names them on 8 Oct 2026. */
const FIRMS: BuyingDealersAnswer = {
  status: 'read',
  readAt: '2026-10-08T12:00:00.000Z',
  staleSince: null,
  directoryUrl: BEF_DIRECTORY_URL,
  buyers: [
    {
      slug: 'krog-menjave', name: 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.', host: 'krogmenjave.com',
      website: 'https://krogmenjave.com/', registerUrl: 'https://krogmenjave.com/prijava',
      sellUrl: 'https://krogmenjave.com/ko-kreacija/prodaj', eventId: '1'.repeat(64), signedAt: '2026-10-05T15:31:00.000Z',
    },
    {
      slug: 'ravena-plus', name: 'Ravena Plus d.o.o.', host: 'ravenaplus.com',
      website: 'https://ravenaplus.com/', registerUrl: 'https://ravenaplus.com/prijava',
      sellUrl: 'https://ravenaplus.com/ko-kreacija/prodaj', eventId: '2'.repeat(64), signedAt: '2026-10-08T08:12:00.000Z',
    },
  ],
};

/** Every I/O a sale would do. A closed route must call none of them. */
const io = { eligibility: 0, balances: 0, sends: 0, wallets: 0, gate: 0, electrum: [] as string[] };

const app = express();
app.use(express.json({ verify: keepRawBody }));
app.use('/api', apiRouter);
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: 'http://check.test',
  publishBuybackEvent: async () => undefined,
  checkSellerEligibility: async () => { io.eligibility++; return { ok: true, walletType: 'Main Wallet', walletClass: 'other', evidence: {} } as any; },
  fetchUserWallets: async () => { io.wallets++; return [{ walletId: WALLET, walletType: 'Main Wallet' }] as any; },
  fetchBatchBalances: async (_s, addresses) => { io.balances++; return addresses.map(a => ({ wallet_id: a, balance: 1_000_000, status: 'active' })) as any; },
  sendLanaTransaction: async () => { io.sends++; return { success: true, txHash: 'f'.repeat(64) } as any; },
  buyingDealers: () => FIRMS,
}));
app.use('/api/wallets', createConsolidationRouter({
  walletCheckBaseUrl: 'http://check.test',
  electrumCall: async (method) => {
    io.electrum.push(method);
    if (method === 'blockchain.address.listunspent') return [];
    if (method === 'blockchain.address.get_balance') return { confirmed: 0, unconfirmed: 0 };
    throw new Error(`unexpected electrum call: ${method}`);
  },
  walletGate: async () => { io.gate++; return { blocked: false }; },
  buyingDealers: () => FIRMS,
}));

let server: http.Server;
let base = '';
beforeAll(async () => {
  db.exec(WALLET_CONSOLIDATION_SCHEMA_SQL);
  // The two columns the external-sale lookup reads that the test kit's table leaves out.
  db.exec('ALTER TABLE buyback_transactions ADD COLUMN source TEXT');
  db.exec('ALTER TABLE buyback_transactions ADD COLUMN verified_at TEXT');
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server?.close(() => r())));

beforeEach(() => {
  for (const t of ['acquisition_offers', 'buyback_transactions', 'sale_payouts', 'admin_users', 'api_keys', 'wallet_consolidations']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  Object.assign(io, { eligibility: 0, balances: 0, sends: 0, wallets: 0, gate: 0, electrum: [] });
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  db.prepare("INSERT INTO api_keys (key_hash, app_name, created_by) VALUES (?, 'Brain', 'test')")
    .run(createHash('sha256').update(API_KEY).digest('hex'));
});

const offer = (ref: string, status: string) => db.prepare(`
  INSERT INTO acquisition_offers (offer_ref, user_hex_id, sender_wallet_id, wallet_class, lana_amount_lanoshis,
    lana_amount_display, currency, status, purchase_price_fiat, gross_fiat, reference_rate, discount_percent,
    offer_expires_at, settlement_due_at, accepted_at)
  VALUES (?, ?, ?, 'other', 100000000000, 1000, 'EUR', ?, 100, 128, 0.128, 22,
    datetime('now', '+8 days'), datetime('now', '+15 days'), CASE WHEN ? = 'accepted' THEN datetime('now') END)
`).run(ref, SELLER, WALLET, status, status);
const statusOf = (ref: string) => (db.prepare('SELECT status FROM acquisition_offers WHERE offer_ref = ?').get(ref) as any)?.status;
const offerCount = () => (db.prepare('SELECT COUNT(*) AS c FROM acquisition_offers').get() as any).c;
const saleCount = () => (db.prepare('SELECT COUNT(*) AS c FROM buyback_transactions').get() as any).c;

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() as any }));
const post = (p: string, body: unknown, headers: Record<string, string> = {}) => call('POST', p, body, headers);
const signedPost = (p: string, body: unknown) =>
  post(p, body, { authorization: nip98Header(admin, { method: 'POST', url: p, body: JSON.stringify(body) }) });
const signedGet = (p: string) => call('GET', p, undefined, { authorization: nip98Header(admin, { method: 'GET', url: p }) });

/** The refusal every closed route answers, naming both firms. */
function expectSellingMoved(r: { status: number; body: any }, firms = FIRMS) {
  expect(r.status).toBe(410);
  expect(r.body.code).toBe(SELLING_MOVED_CODE);
  expect(r.body.code).toBe('SELLING_MOVED');
  expect(r.body.buyers.map((b: any) => b.host)).toEqual(firms.buyers.map(b => b.host));
  expect(r.body.directoryUrl).toBe(BEF_DIRECTORY_URL);
  for (const b of firms.buyers) {
    expect(r.body.error).toContain(b.name);
    expect(r.body.error).toContain(b.registerUrl);
  }
  expect(r.body.error).toMatch(/can no longer be sold on Lana\.discount/);
}

const nothingTouched = () => {
  expect(io).toEqual({ eligibility: 0, balances: 0, sends: 0, wallets: 0, gate: 0, electrum: [] });
};

describe('the switch', () => {
  it('is on, in code', () => {
    expect(SELLING_CLOSED).toBe(true);
  });
});

describe('every way of selling LANA here is closed', () => {
  it('a new proposal: refused before a field is read, nothing asked, no row written', async () => {
    const r = await post('/api/acquisitions/offers', { hexId: SELLER, senderAddress: WALLET, lanaAmount: 1000, currency: 'EUR' });
    expectSellingMoved(r);
    expect(offerCount()).toBe(0);
    nothingTouched();
    // Even an empty body gets the refusal, not a validation error.
    expectSellingMoved(await post('/api/acquisitions/offers', {}));
  });

  it('accepting a purchase offer still standing: refused, and the offer is left to lapse by itself', async () => {
    offer('OFF-T-1', 'offered');
    const r = await post('/api/acquisitions/OFF-T-1/accept', { hexId: SELLER });
    expectSellingMoved(r);
    expect(statusOf('OFF-T-1')).toBe('offered');
    nothingTouched();
  });

  it('the transfer of an accepted offer: refused before the key is read — no LANA moves, nothing is owed', async () => {
    offer('OFF-T-2', 'accepted');
    const r = await post('/api/acquisitions/OFF-T-2/transfer', { hexId: SELLER, privateKey: 'not-a-real-key' });
    expectSellingMoved(r);
    expect(statusOf('OFF-T-2')).toBe('accepted');
    expect(saleCount()).toBe(0);
    expect(JSON.stringify(r.body)).not.toContain('not-a-real-key');
    nothingTouched();
  });

  it('an admin accepting or countering a proposal: refused, signed admin or not', async () => {
    offer('OFF-T-3', 'under_review');
    for (const action of ['accept', 'counter']) {
      expectSellingMoved(await signedPost('/api/acquisitions/admin/OFF-T-3/decide', { action, lanaAmount: 500 }));
    }
    expect(statusOf('OFF-T-3')).toBe('under_review');
    nothingTouched();
  });

  it('…and the admin signature is still asked first: unsigned is turned away exactly as before', async () => {
    offer('OFF-T-4', 'under_review');
    const r = await post('/api/acquisitions/admin/OFF-T-4/decide', { action: 'accept' }, { 'x-admin-hex-id': admin.hex });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
  });

  it('a partner app booking a sale (POST /api/external/sale): refused, with or without its key, and nothing booked', async () => {
    const sale = {
      tx_hash: 'c'.repeat(64), sender_wallet_id: WALLET, buyback_wallet_id: WALLET, lana_amount: 1000,
      currency: 'EUR', exchange_rate: 0.128, user_hex_id: SELLER,
    };
    for (const headers of [{ authorization: `Bearer ${API_KEY}` }, {} as Record<string, string>]) {
      const r = await post('/api/external/sale', sale, headers);
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('SELLING_MOVED');
      // The api router reads the process-wide dealer reader, which on this
      // database has no verified KIND 38888: no firm named, the list linked.
      expect(r.body.buyers).toEqual([]);
      expect(r.body.error).toContain(BEF_DIRECTORY_URL);
    }
    expect(saleCount()).toBe(0);
  });

  it('the two retired sell endpoints now say where selling went', async () => {
    for (const p of ['/api/sell/execute', '/api/sell/preview']) {
      const r = await post(p, { lanaAmount: 100, currency: 'EUR' });
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('SELLING_MOVED');
      expect(r.body.error).toMatch(/can no longer be sold on Lana\.discount/);
    }
  });

  it('merging a wallet for a transfer: refused before the key is read; the read-only view still answers', async () => {
    const r = await post('/api/wallets/consolidate', { hexId: SELLER, address: WALLET, privateKey: 'not-a-real-key', inputs: [] });
    expectSellingMoved(r);
    nothingTouched();
    const view = await post('/api/wallets/consolidation', { address: WALLET });
    expect(view.status).toBe(200);
    expect(view.body.success).toBe(true);
  });
});

describe('what was already sold keeps working', () => {
  it('a settlement of a completed sale is still recorded (POST /api/admin/payouts)', async () => {
    const tx = db.prepare(`INSERT INTO buyback_transactions (user_hex_id, sender_wallet_id, buyback_wallet_id, lana_amount_lanoshis,
      lana_amount_display, currency, exchange_rate, gross_fiat, commission_fiat, net_fiat, tx_hash, status)
      VALUES (?, ?, ?, 500000000000, 5000, 'EUR', 0.128, 640, 140, 500, ?, 'completed')`).run(SELLER, WALLET, WALLET, 'd'.repeat(64));
    const body = { transactionId: Number(tx.lastInsertRowid), amount: 200, currency: 'EUR', note: 'part' };
    const r = await signedPost('/api/admin/payouts', body);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect((db.prepare('SELECT SUM(amount) AS s FROM sale_payouts').get() as any).s).toBe(200);
    // …and still only by a signed admin.
    expect((await post('/api/admin/payouts', body, { 'x-admin-hex-id': admin.hex })).status).toBe(403);
  });

  it('a partner can still look up a sale it booked before', async () => {
    const tx = db.prepare(`INSERT INTO buyback_transactions (user_hex_id, sender_wallet_id, buyback_wallet_id, lana_amount_lanoshis,
      lana_amount_display, currency, exchange_rate, gross_fiat, commission_fiat, net_fiat, tx_hash, status, source)
      VALUES (?, ?, ?, 100000000000, 1000, 'EUR', 0.128, 128, 27, 101, ?, 'paid', 'external')`).run(SELLER, WALLET, WALLET, 'e'.repeat(64));
    const r = await call('GET', `/api/external/sale/${tx.lastInsertRowid}`, undefined, { authorization: `Bearer ${API_KEY}` });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('paid');
  });

  it('a seller still sees their proposals, may open one and may withdraw it', async () => {
    offer('OFF-T-5', 'under_review');
    const mine = await call('GET', `/api/acquisitions/mine/${SELLER}`);
    expect(mine.status).toBe(200);
    expect(mine.body.offers.map((o: any) => o.offerRef)).toEqual(['OFF-T-5']);
    expect((await call('GET', `/api/acquisitions/OFF-T-5?hexId=${SELLER}`)).status).toBe(200);
    const w = await post('/api/acquisitions/OFF-T-5/withdraw', { hexId: SELLER });
    expect(w.status).toBe(200);
    expect(statusOf('OFF-T-5')).toBe('withdrawn');
  });

  it('an admin may still decline a proposal, and still sees the list', async () => {
    offer('OFF-T-6', 'under_review');
    expect((await signedGet('/api/acquisitions/admin/queue')).status).toBe(200);
    const r = await signedPost('/api/acquisitions/admin/OFF-T-6/decide', { action: 'decline', reason: 'selling here has closed' });
    expect(r.status).toBe(200);
    expect(statusOf('OFF-T-6')).toBe('declined');
  });

  it('GET /api/buying-dealers answers, with a flag and the list link when no firm can be named yet', async () => {
    const r = await call('GET', '/api/buying-dealers');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'unknown', readAt: null, buyers: [], directoryUrl: BEF_DIRECTORY_URL });
  });
});

/**
 * A PROPOSAL UNDER REVIEW HAS NO OTHER END. Before the closure an admin's
 * accept, counter or decline ended it; accept and counter now answer 410, the
 * seller's page with the withdraw link (/offer) shows where selling went, and
 * the sweeper never touched a proposal under review. So the sweeper ends each
 * one, with a reason, on the next heartbeat — nothing had moved on it and it
 * reserved no mandate, so no money changes.
 */
describe('a proposal nobody can decide any more ends by itself', () => {
  const reasonOf = (ref: string) =>
    db.prepare('SELECT decision_reason, decision_reason_status FROM acquisition_offers WHERE offer_ref = ?').get(ref) as
      { decision_reason: string | null; decision_reason_status: string | null };

  it('under review or submitted → lapsed, with the reason the seller is shown; nothing else is touched', async () => {
    offer('OFF-T-10', 'under_review');
    db.prepare("UPDATE acquisition_offers SET decision_reason = 'This proposal is waiting for a person.', decision_reason_status = 'under_review', mandate_code = 'NO_MANDATE', mandate_ref = '8:1:x' WHERE offer_ref = 'OFF-T-10'").run();
    offer('OFF-T-11', 'submitted');
    offer('OFF-T-12', 'offered');
    offer('OFF-T-13', 'accepted');
    offer('OFF-T-14', 'declined');
    db.prepare("UPDATE acquisition_offers SET mandate_ref = '8:1:x' WHERE offer_ref = 'OFF-T-13'").run();
    const reservedBefore = consumedByMandate(db, ['8:1:x']).get('8:1:x');
    expect(reservedBefore).toBe(100_000_000_000); // the accepted one only

    expect(expireStaleOffers(db)).toBe(2);

    for (const ref of ['OFF-T-10', 'OFF-T-11']) {
      expect(statusOf(ref)).toBe('expired');
      expect(reasonOf(ref)).toEqual({ decision_reason: SELLING_CLOSED_UNDECIDED, decision_reason_status: 'expired' });
    }
    // Why it went to review is kept where it always was.
    const kept = db.prepare("SELECT mandate_code FROM acquisition_offers WHERE offer_ref = 'OFF-T-10'").get() as { mandate_code: string };
    expect(kept.mandate_code).toBe('NO_MANDATE');
    // A purchase offer still standing and an accepted one lapse on their own clocks, as before.
    expect(statusOf('OFF-T-12')).toBe('offered');
    expect(statusOf('OFF-T-13')).toBe('accepted');
    expect(statusOf('OFF-T-14')).toBe('declined');
    // A proposal under review reserved nothing, so ending it frees nothing.
    expect(consumedByMandate(db, ['8:1:x']).get('8:1:x')).toBe(reservedBefore);
    // Once, not every beat.
    expect(expireStaleOffers(db)).toBe(0);
  });

  it('the admin queue empties, and the seller sees why — not a review that never ends', async () => {
    offer('OFF-T-15', 'under_review');
    expireStaleOffers(db);
    const queue = await signedGet('/api/acquisitions/admin/queue');
    expect(queue.status).toBe(200);
    expect(queue.body.offers).toEqual([]);
    const mine = await call('GET', `/api/acquisitions/mine/${SELLER}`);
    expect(mine.body.offers).toEqual([expect.objectContaining({ offerRef: 'OFF-T-15', status: 'expired', decisionReason: SELLING_CLOSED_UNDECIDED })]);
    // Nothing is left for an admin to decline, nor for the seller to withdraw.
    expect((await signedPost('/api/acquisitions/admin/OFF-T-15/decide', { action: 'decline', reason: 'x' })).status).toBe(409);
    expect((await post('/api/acquisitions/OFF-T-15/withdraw', { hexId: SELLER })).status).toBe(409);
  });

  it('with selling open (the old flow) a proposal under review waits for its decision, as it always did', () => {
    offer('OFF-T-16', 'under_review');
    expect(expireStaleOffers(db, { sellingClosed: false })).toBe(0);
    expect(statusOf('OFF-T-16')).toBe('under_review');
  });
});

describe('the sentence an old page shows', () => {
  it('names one firm, two, or the list — never nothing', () => {
    expect(sellingMovedSentence(FIRMS)).toContain('register with one of the two');
    const one = { ...FIRMS, buyers: [FIRMS.buyers[1]] };
    expect(sellingMovedSentence(one)).toMatch(/taken over by Ravena Plus d\.o\.o\. \(https:\/\/ravenaplus\.com\/prijava\): .*register with it\./);
    expect(sellingMovedSentence({ ...FIRMS, buyers: [] })).toContain(BEF_DIRECTORY_URL);
  });
});

/**
 * WHAT STAYS OPEN IS PINNED BY NAME. A later edit that closes a settlement
 * route — or forgets to close a new sale route — changes this list in a
 * commit a reviewer reads.
 */
describe('exactly these handlers refuse', () => {
  const SERVER = path.resolve(__dirname, '..');
  const guarded = (rel: string): string[] => {
    const src = fs.readFileSync(path.join(SERVER, rel), 'utf8');
    const marks = [...src.matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)];
    return marks
      .filter((m, i) => /refuseClosedSale\(|refuseSelling\(/.test(src.slice(m.index!, i + 1 < marks.length ? marks[i + 1].index : src.length)))
      .map(m => `${m[1].toUpperCase()} ${m[2]}`);
  };

  it('in the acquisitions router', () => {
    expect(guarded('routes/acquisitions.ts')).toEqual(['POST /offers', 'POST /:ref/accept', 'POST /:ref/transfer', 'POST /admin/:ref/decide']);
  });
  it('in the main API router', () => {
    expect(guarded('routes/api.ts')).toEqual(['POST /sell/execute', 'POST /sell/preview', 'POST /external/sale']);
  });
  it('in the wallets router', () => {
    expect(guarded('routes/consolidation.ts')).toEqual(['POST /consolidate']);
  });
  it('and nowhere in the treasury router the brain pushes to', () => {
    expect(guarded('routes/treasury.ts')).toEqual([]);
  });
});
