// @vitest-environment node
/**
 * THE MANDATE PATH THROUGH POST /api/acquisitions/offers, END TO END.
 *
 * The router is real; the world around it is not: db/index.ts is replaced by
 * an in-memory SQLite carrying the production DDL, and the relays, electrum
 * and the chain are injected stand-ins. What is under test is the wiring —
 * signature → ownership → the transaction that reads the cap and writes the
 * offer → accept → transfer — and the two properties the plan calls out:
 * two racing proposals cannot both take the last of a mandate, and a
 * counteroffer can never empty a wallet.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('./roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { getDbHandle } from '../db/index.js';
import { createAcquisitionsRouter, OFFERS_SIGNED_PATH } from '../routes/acquisitions';
import { createTreasuryRouter } from '../routes/treasury';
import { ingestMandateEvent } from './roundMandateSync';
import { GATE_SETTING_KEY } from '../db/roundMandateSchema';
import { createReplayCache } from './requestSignature';
import { expireStaleOffers, ACCEPTED_TRANSFER_WINDOW_HOURS, TRANSFER_NOT_COMPLETED } from './acquisitionOffer';
import { makeKey, mandateEvent, signedHeaders, setSplit, setSetting, setRoundTerms, type TestKey } from './roundMandateTestKit';
import { createHash } from 'crypto';

const LANA = 100_000_000;
const W1 = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const W_OTHER = 'LdY5W1Qm6xXoTmr3hjCkGyeJ7YqTx6Zv4t';
const ADMIN = 'c'.repeat(64);
const API_KEY = 'ldk_test_key';

const db: Database.Database = getDbHandle();
const lanapays = makeKey();
const seller = makeKey();

// ── the injected world ──────────────────────────────────────────────────
const world = {
  eligible: true as boolean,
  listedWallets: [W1] as string[] | 'throw',
  balances: {} as Record<string, number>,
  balancesThrow: false,
  /** When set, the raw electrum answer — for the shapes that must read as unverifiable. */
  balanceShape: null as null | ((addresses: string[]) => any[]),
  sent: [] as any[],
};

const app = express();
app.use(express.json());
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: 'http://check.test',
  publishBuybackEvent: async () => undefined,
  checkSellerEligibility: async () => world.eligible
    ? { ok: true, walletType: 'LanaPays.Us', walletClass: 'lanapays', evidence: { splitCode: 'OK' } }
    : { ok: false, httpStatus: 403, code: 'WALLET_FROZEN', error: 'frozen' },
  fetchUserWallets: async () => {
    if (world.listedWallets === 'throw') throw new Error('relay down');
    return world.listedWallets.map(w => ({ walletId: w, walletType: 'LanaPays.Us' }));
  },
  fetchBatchBalances: async (_s, addresses) => {
    if (world.balancesThrow) throw new Error('electrum down');
    if (world.balanceShape) return world.balanceShape(addresses);
    return addresses.map(a => ({ wallet_id: a, balance: world.balances[a] ?? 0, status: 'active' }));
  },
  sendLanaTransaction: async (args) => { world.sent.push(args); return { success: true, txHash: 'ab'.repeat(32), fee: 33600 } as any; },
  // A fresh replay memory for this test server, so nothing leaks in from
  // other files sharing the process-wide default.
  replayCache: createReplayCache(),
}));
app.use('/api/treasury', createTreasuryRouter({
  fetchBatchBalances: async (_s, addresses) => addresses.map(a => ({ wallet_id: a, balance: world.balances[a] ?? 0, status: 'active' })),
}));

let server: http.Server;
let base = '';
beforeEach(async () => {
  if (!server) {
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  // Fresh world per test.
  for (const t of ['acquisition_offers', 'acquisition_mandates', 'acquisition_mandate_releases', 'acquisition_rounds', 'app_settings', 'buyback_transactions', 'admin_users', 'api_keys']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  world.eligible = true; world.listedWallets = [W1]; world.balances = {}; world.balancesThrow = false; world.balanceShape = null; world.sent = [];
  setSplit(db, 9, { EUR: 0.256 });
  setSetting(db, 'active_currencies', '["EUR"]');
  setSetting(db, 'acq_EUR_enabled', 'true');
  setSetting(db, 'acq_EUR_lanapays_enabled', 'true');
  // No per-offer auto cap: the round mandate is the cap under test. The
  // auto cap stays the OUTER ceiling — see 'the auto cap still rules' below.
  setSetting(db, 'acq_EUR_lanapays_auto_cap', '');
  setSetting(db, 'acq_EUR_lanapays_due_days', '15');
  setSetting(db, 'buyback_wallet_id', 'LTreasuryWalletXXXXXXXXXXXXXXXXXXX');
  setSetting(db, GATE_SETTING_KEY, '9');
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(ADMIN);
  db.prepare("INSERT INTO api_keys (key_hash, app_name, created_by) VALUES (?, 'brain', 'test')").run(createHash('sha256').update(API_KEY).digest('hex'));
  // Split-8 mandate for the seller: 1000 LANA in W1, round 1 open at 22 %.
  announce(1, [{ address: W1, currency: 'EUR', lana: '1000', fundSettingId: '52' }]);
  setRoundTerms(db, 8, 1, Math.floor(Date.now() / 1000) - 3600, 22);
});
afterAll(() => new Promise<void>(r => server?.close(() => r())));

function announce(round: number, wallets: Parameters<typeof mandateEvent>[1]['wallets'], createdAt = 1_757_000_000) {
  const e = mandateEvent(lanapays, { split: 8, round, hex: seller.pub, wallets, createdAt });
  const r = ingestMandateEvent(db, e, { authorizedPubkey: lanapays.pub });
  if (!r.stored) throw new Error(`fixture not stored: ${r.reason}`);
  return e;
}

const post = (path: string, body: any, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }));
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers }).then(async r => ({ status: r.status, body: await r.json() as any }));

const nowSec = () => Math.floor(Date.now() / 1000);
/** The v2 scheme signs the BODY, so the body is built first and signed as sent. */
const proposalBody = (key: TestKey, lanaAmount: number, wallet = W1) =>
  ({ hexId: key.pub, senderAddress: wallet, lanaAmount, currency: 'EUR' });
const propose = (lanaAmount: number, over: { key?: TestKey; wallet?: string; headers?: Record<string, string> | null } = {}) => {
  const key = over.key || seller;
  const body = proposalBody(key, lanaAmount, over.wallet || W1);
  const headers = over.headers === null ? {} : (over.headers || signedHeaders(key, 'POST', OFFERS_SIGNED_PATH, nowSec(), body));
  return post('/api/acquisitions/offers', body, headers);
};
/** POST to an offer endpoint, signed by `key` over the body it sends. */
const signedPost = (path: string, body: any, key: TestKey = seller) =>
  post(path, body, signedHeaders(key, 'POST', path, nowSec(), body));
const acceptOffer = (ref: string, key: TestKey = seller) =>
  signedPost(`/api/acquisitions/${ref}/accept`, { hexId: key.pub }, key);
const row = (ref: string) => db.prepare('SELECT * FROM acquisition_offers WHERE offer_ref = ?').get(ref) as any;

describe('proposal under a mandate', () => {
  it('within the cap → a purchase offer at the ROUND discount, from the live fx', async () => {
    const r = await propose(600);
    expect(r.status).toBe(200);
    const o = r.body.offer;
    expect(o.status).toBe('offered');
    expect(o.mandateCode).toBe('WITHIN_MANDATE');
    expect(o.round).toBe(1);
    expect(o.mandateRef).toBe(`8:1:${seller.pub}`);
    expect(o.isCounteroffer).toBe(false);
    expect(o.proposedLanaAmount).toBeNull();
    expect(o.lanaAmount).toBe(600);
    // 600 × 0.256 = 153.60 gross; 22 % off → 119.81
    expect(o.purchasePrice).toBe(119.81);
    const stored = row(o.offerRef);
    expect(stored.discount_percent).toBe(22);
    expect(stored.reference_rate).toBe(0.256);
    expect(stored.reference_basis).toBe('current_split');
  });

  it('above the cap → a counteroffer for the remaining, remembering what was asked', async () => {
    const r = await propose(1500);
    const o = r.body.offer;
    expect(o.status).toBe('offered');
    expect(o.mandateCode).toBe('COUNTER_MANDATE_CAP');
    expect(o.isCounteroffer).toBe(true);
    expect(o.lanaAmount).toBe(1000);
    expect(o.proposedLanaAmount).toBe(1500);
    expect(row(o.offerRef).proposed_lana_lanoshis).toBe(1500 * LANA);
  });

  it('two proposals inside 30 minutes share the cap', async () => {
    const a = await propose(600);
    expect(a.body.offer.status).toBe('offered');
    const b = await propose(600);
    expect(b.body.offer.status).toBe('offered');
    expect(b.body.offer.isCounteroffer).toBe(true);
    expect(b.body.offer.lanaAmount).toBe(400);
  });

  it('two RACING proposals cannot both consume the last remaining', async () => {
    const [a, b] = await Promise.all([propose(1000), propose(1000)]);
    const statuses = [a.body.offer, b.body.offer].map(o => `${o.status}:${o.mandateCode}`).sort();
    expect(statuses).toEqual(['declined:FULLY_ACQUIRED', 'offered:WITHIN_MANDATE']);
    const reserved = (db.prepare("SELECT COALESCE(SUM(lana_amount_lanoshis),0) s FROM acquisition_offers WHERE status = 'offered'").get() as any).s;
    expect(reserved).toBe(1000 * LANA);
  });

  it('before the round date → declined with the date, and no row reserves anything', async () => {
    const opensAt = Math.floor(Date.now() / 1000) + 86400;
    setRoundTerms(db, 8, 1, opensAt, 22);
    const r = await propose(100);
    expect(r.body.offer.status).toBe('declined');
    expect(r.body.offer.mandateCode).toBe('MANDATE_NOT_OPEN');
    expect(r.body.offer.decisionReason).toContain(new Date(opensAt * 1000).toISOString());
  });

  it('a released mandate opens before its date', async () => {
    setRoundTerms(db, 8, 1, Math.floor(Date.now() / 1000) + 86400, 22);
    const rel = await post(`/api/treasury/admin/mandates/${encodeURIComponent(`8:1:${seller.pub}`)}/release`, { released: true, reason: 'owner said so' }, { 'x-admin-hex-id': ADMIN });
    expect(rel.status).toBe(200);
    expect((await propose(100)).body.offer.status).toBe('offered');
    // …and the release needs a reason.
    const noReason = await post(`/api/treasury/admin/mandates/${encodeURIComponent(`8:1:${seller.pub}`)}/release`, { released: false, reason: '' }, { 'x-admin-hex-id': ADMIN });
    expect(noReason.status).toBe(400);
  });

  it('no mandate for the wallet → under review (NO_MANDATE), and it cannot be transferred', async () => {
    world.listedWallets = [W1, W_OTHER];
    const r = await propose(100, { wallet: W_OTHER });
    expect(r.body.offer.status).toBe('under_review');
    expect(r.body.offer.mandateCode).toBe('NO_MANDATE');
    const t = await post(`/api/acquisitions/${r.body.offer.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'x' });
    expect(t.status).toBe(409);
    expect(t.body.code).toBe('NOT_ACCEPTED');
    expect(world.sent).toHaveLength(0);
  });

  it('the currency kill-switch still declines under a mandate', async () => {
    setSetting(db, 'acq_EUR_enabled', 'false');
    const r = await propose(100);
    expect(r.body.offer.status).toBe('declined');
    expect(r.body.offer.mandateCode).toBe('CURRENCY_CLOSED');
  });

  it('a mandate whose split is still running is closed, whatever the date', async () => {
    setSplit(db, 8, { EUR: 0.128 });
    setSetting(db, GATE_SETTING_KEY, '8');
    const r = await propose(100);
    expect(r.body.offer.mandateCode).toBe('SPLIT_WINDOW');
  });

  /**
   * The auto cap still rules ON TOP of the mandate: a 'review' from the
   * per-currency settings is honoured as review, never upgraded to an
   * automatic offer. The mandate fields survive so the admin's decision is
   * still priced at the round discount and checked against the cap.
   */
  it('the auto cap still rules: auto_cap=0 (MANUAL_ONLY) → under review, mandate fields kept, nothing reserved', async () => {
    setSetting(db, 'acq_EUR_lanapays_auto_cap', '0');
    const r = await propose(600);
    expect(r.status).toBe(200);
    const o = r.body.offer;
    expect(o.status).toBe('under_review');
    expect(o.mandateCode).toBe('MANUAL_ONLY');
    expect(o.mandateRef).toBe(`8:1:${seller.pub}`);
    expect(o.round).toBe(1);
    expect(o.purchasePrice).toBeNull();
    const stored = row(o.offerRef);
    expect(stored.mandate_ref).toBe(`8:1:${seller.pub}`);
    expect(stored.round).toBe(1);
    expect(stored.proposed_lana_lanoshis).toBeNull();
    // Under review reserves nothing on the mandate…
    expect((await propose(1000)).body.offer.status).toBe('under_review');
    // …and the admin's acceptance prices it at the round discount (22 %), not the class one.
    const ok = await post(`/api/acquisitions/admin/${o.offerRef}/decide`, { action: 'accept' }, { 'x-admin-hex-id': ADMIN });
    expect(ok.status).toBe(200);
    expect(ok.body.offer.status).toBe('offered');
    expect(row(o.offerRef).discount_percent).toBe(22);
    expect(ok.body.offer.purchasePrice).toBe(119.81);
  });

  it('the auto cap still rules: above it (ABOVE_AUTO_CAP) → under review; a counter above it keeps what was asked', async () => {
    setSetting(db, 'acq_EUR_lanapays_auto_cap', '100'); // 600 × 0.256 = 153.60 > 100
    const r = await propose(600);
    expect(r.body.offer.status).toBe('under_review');
    expect(r.body.offer.mandateCode).toBe('ABOVE_AUTO_CAP');
    expect(r.body.offer.mandateRef).toBe(`8:1:${seller.pub}`);
    const c = await propose(1500);
    expect(c.body.offer.status).toBe('under_review');
    expect(c.body.offer.lanaAmount).toBe(1000);
    expect(c.body.offer.proposedLanaAmount).toBe(1500);
  });
});

describe('who may propose', () => {
  it('a wallet not on the signed KIND 30889 list of this hex is refused', async () => {
    world.listedWallets = [W_OTHER];
    const r = await propose(100);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('WALLET_NOT_OWNED');
  });

  it('relay failure or an empty list is not a clearance (503, fail closed)', async () => {
    world.listedWallets = 'throw';
    expect((await propose(100)).body.code).toBe('WALLET_OWNERSHIP_UNVERIFIABLE');
    world.listedWallets = [];
    expect((await propose(100)).status).toBe(503);
  });

  it('a missing signature is refused before any relay is asked', async () => {
    world.listedWallets = 'throw';
    const r = await propose(100, { headers: null });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
  });

  it('a signature by another key, or for another path, is refused', async () => {
    const other = makeKey();
    expect((await propose(100, { headers: signedHeaders(other, 'POST', OFFERS_SIGNED_PATH) })).status).toBe(401);
    expect((await propose(100, { headers: signedHeaders(seller, 'POST', '/api/acquisitions/x/accept') })).status).toBe(401);
  });

  it('a signature over a different body than the one sent is refused', async () => {
    const signedFor = proposalBody(seller, 100);
    const headers = signedHeaders(seller, 'POST', OFFERS_SIGNED_PATH, nowSec(), signedFor);
    const r = await post('/api/acquisitions/offers', { ...signedFor, lanaAmount: 1000 }, headers);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SIGNATURE_REQUIRED');
    expect(r.body.detail).toBe('INVALID');
  });

  it('the same signed request twice → the second is SIGNATURE_REPLAYED and reserves nothing', async () => {
    const body = proposalBody(seller, 100);
    const headers = signedHeaders(seller, 'POST', OFFERS_SIGNED_PATH, nowSec(), body);
    const first = await post('/api/acquisitions/offers', body, headers);
    expect(first.body.offer.status).toBe('offered');
    const again = await post('/api/acquisitions/offers', body, headers);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('SIGNATURE_REPLAYED');
    expect((db.prepare('SELECT COUNT(*) c FROM acquisition_offers').get() as any).c).toBe(1);
  });

  it('with the gate off the legacy path needs no signature (today\'s UI keeps working)', async () => {
    setSetting(db, GATE_SETTING_KEY, '');
    setSetting(db, 'acq_EUR_lanapays_auto_cap', '1');
    const r = await propose(100, { headers: null });
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('under_review'); // auto_cap = 1 EUR on the legacy path
    expect(r.body.offer.mandateRef).toBeNull();
  });
});

/** An 'offered' row on the LEGACY path (gate off, no auto cap): what today's UI produces. */
async function legacyOffered(): Promise<string> {
  setSetting(db, GATE_SETTING_KEY, '');
  const r = await propose(100, { headers: null });
  expect(r.body.offer.status).toBe('offered');
  expect(r.body.offer.mandateRef).toBeNull();
  return r.body.offer.offerRef as string;
}

describe('accept', () => {
  it('REFERENCE_MOVED: a rate change between the offer and the acceptance lapses a MANDATE offer', async () => {
    const ref = (await propose(100)).body.offer.offerRef;
    setSplit(db, 9, { EUR: 0.25 });
    const r = await acceptOffer(ref);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REFERENCE_MOVED');
    expect(row(ref).status).toBe('expired');
    expect(row(ref).decision_reason).toMatch(/0\.256 to 0\.25/);
    // …and the cap is free again.
    expect((await propose(1000)).body.offer.status).toBe('offered');
  });

  it('PHASE A: a LEGACY offer still accepts after a rate change (today\'s UI cannot handle the 409 yet)', async () => {
    const ref = await legacyOffered();
    setSplit(db, 9, { EUR: 0.25 });
    const r = await post(`/api/acquisitions/${ref}/accept`, { hexId: seller.pub });
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('accepted');
    expect(row(ref).reference_rate).toBe(0.256); // the price it was offered at, unchanged
  });

  it('with an unchanged reference the acceptance stands, at the price offered', async () => {
    const o = (await propose(100)).body.offer;
    const r = await acceptOffer(o.offerRef);
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('accepted');
    expect(r.body.offer.purchasePrice).toBe(o.purchasePrice);
  });

  it('accepting a mandate-bound offer must be signed by the financer; a legacy one need not be', async () => {
    const mandate = (await propose(100)).body.offer.offerRef;
    const unsigned = await post(`/api/acquisitions/${mandate}/accept`, { hexId: seller.pub });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.code).toBe('SIGNATURE_REQUIRED');
    expect(row(mandate).status).toBe('offered');
    const wrongKey = await acceptOffer(mandate, makeKey());
    expect(wrongKey.status).toBe(404); // another hex: no such offer for them
    expect((await acceptOffer(mandate)).status).toBe(200);

    const legacy = await legacyOffered();
    expect((await post(`/api/acquisitions/${legacy}/accept`, { hexId: seller.pub })).status).toBe(200);
  });
});

describe('withdraw', () => {
  it('a mandate-bound offer withdraws only when signed; the cap is free after', async () => {
    const ref = (await propose(1000)).body.offer.offerRef;
    const unsigned = await post(`/api/acquisitions/${ref}/withdraw`, { hexId: seller.pub });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.code).toBe('SIGNATURE_REQUIRED');
    expect(row(ref).status).toBe('offered');
    // A stranger with a valid signature of their own is not the owner: 409 as before.
    const stranger = makeKey();
    expect((await signedPost(`/api/acquisitions/${ref}/withdraw`, { hexId: stranger.pub }, stranger)).status).toBe(409);
    expect((await signedPost(`/api/acquisitions/${ref}/withdraw`, { hexId: seller.pub })).status).toBe(200);
    expect(row(ref).status).toBe('withdrawn');
    expect((await propose(1000)).body.offer.status).toBe('offered');
  });

  it('a legacy offer withdraws unsigned, as today', async () => {
    const ref = await legacyOffered();
    expect((await post(`/api/acquisitions/${ref}/withdraw`, { hexId: seller.pub })).status).toBe(200);
    expect(row(ref).status).toBe('withdrawn');
  });
});

describe("GET /mandate — the financer's own view", () => {
  const path = () => `/api/acquisitions/mandate`;
  const query = (key: TestKey) => `?hexId=${key.pub}&wallet=${W1}&currency=EUR&lanaAmount=100`;

  it('is refused unsigned, and served when signed over the pathname (no query) with an empty body', async () => {
    expect((await get(path() + query(seller))).status).toBe(401);
    const r = await get(path() + query(seller), signedHeaders(seller, 'GET', path(), nowSec()));
    expect(r.status).toBe(200);
    expect(r.body.nonBinding).toBe(true);
    expect(r.body.mandates[0]).toMatchObject({ mandateRef: `8:1:${seller.pub}`, state: 'open', remainingLana: 1000, discountPercent: 22 });
    expect(r.body.mandates[0].indicativeFor).toEqual({ lanaAmount: 100, currency: 'EUR', fiat: 19.97 });
  });

  it('cannot be read with another hex\'s key', async () => {
    const other = makeKey();
    const r = await get(path() + query(seller), signedHeaders(other, 'GET', path(), nowSec()));
    expect(r.status).toBe(401);
    expect(r.body.detail).toBe('PUBKEY_MISMATCH');
  });
});

describe('transfer', () => {
  const accepted = async (lana: number) => {
    const o = (await propose(lana)).body.offer;
    const a = await acceptOffer(o.offerRef);
    expect(a.status).toBe(200);
    return o;
  };

  it('a counteroffer transfer forces emptyWallet=false and moves exactly the agreed amount', async () => {
    const o = await accepted(1500);
    expect(o.isCounteroffer).toBe(true);
    const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: true });
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(false);
    expect(world.sent[0].emptyWallet).toBe(false);
    expect(world.sent[0].amount).toBe(1000);
    expect(row(o.offerRef).status).toBe('settled');
  });

  it('an accepted-as-is offer may empty a wallet holding no more than dust above it', async () => {
    const o = await accepted(1000);
    // Electrum reports 2dp LANA; half a cent of LANA above the amount is
    // the rounding step, not a holding beyond the mandate.
    world.balances[W1] = 1000.005;
    const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: true });
    expect(r.status).toBe(200);
    expect(world.sent[0].emptyWallet).toBe(true);
  });

  it('…but not one holding more than the mandate covers', async () => {
    const o = await accepted(600);
    world.balances[W1] = 1000;
    const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMPTY_WALLET_EXCEEDS_MANDATE');
    expect(world.sent).toHaveLength(0);
    // Without emptyWallet the agreed amount still moves.
    const ok = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: false });
    expect(ok.status).toBe(200);
    expect(world.sent[0].amount).toBe(600);
  });

  it('an unreadable balance is not permission to empty', async () => {
    const o = await accepted(600);
    world.balancesThrow = true;
    const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: true });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('BALANCE_UNVERIFIABLE');
    expect(world.sent).toHaveLength(0);
  });

  /**
   * FAIL CLOSED on every answer electrum can give short of throwing. Each of
   * these used to read as "balance 0" and let the emptying transfer through
   * — a wallet holding 10× the mandate would have been emptied into it.
   */
  describe('an electrum answer that does not verifiably state THIS wallet\'s balance is 503, not 0', () => {
    const shapes: Array<[string, (addresses: string[]) => any[]]> = [
      ['an entry carrying .error', a => a.map(w => ({ wallet_id: w, balance: 0, status: 'error', error: 'No response' }))],
      ['no entry at all', () => []],
      ['an entry for a different wallet', () => [{ wallet_id: W_OTHER, balance: 600, status: 'active' }]],
      ['a non-numeric balance', a => a.map(w => ({ wallet_id: w, balance: 'n/a', status: 'active' }))],
    ];
    for (const [name, shape] of shapes) {
      it(name, async () => {
        const o = await accepted(600);
        world.balanceShape = shape;
        const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: true });
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('BALANCE_UNVERIFIABLE');
        expect(world.sent).toHaveLength(0);
        expect(row(o.offerRef).status).toBe('accepted');
      });
    }

    it('…while the agreed amount, without emptying, still moves', async () => {
      const o = await accepted(600);
      world.balanceShape = () => [];
      const r = await post(`/api/acquisitions/${o.offerRef}/transfer`, { hexId: seller.pub, privateKey: 'k', emptyWallet: false });
      expect(r.status).toBe(200);
      expect(world.sent[0].amount).toBe(600);
    });
  });
});

/**
 * AN ACCEPTED OFFER WHOSE TRANSFER NEVER COMES MUST NOT HOLD THE MANDATE
 * FOREVER — the sweeper frees it after 24 h, an admin sooner; a transferred
 * one is a sale and is never touched by either.
 */
describe('accepted but never transferred', () => {
  const acceptedRef = async (lana: number) => {
    const o = (await propose(lana)).body.offer;
    expect((await acceptOffer(o.offerRef)).status).toBe(200);
    return o.offerRef as string;
  };
  const backdate = (ref: string, hours: number) =>
    db.prepare(`UPDATE acquisition_offers SET accepted_at = datetime('now', ?) WHERE offer_ref = ?`).run(`-${hours} hours`, ref);

  it('the sweeper lapses it after 24 h and the remaining is free again', async () => {
    const ref = await acceptedRef(1000);
    expect((await propose(1)).body.offer.mandateCode).toBe('FULLY_ACQUIRED');
    backdate(ref, ACCEPTED_TRANSFER_WINDOW_HOURS + 1);
    expect(expireStaleOffers(db)).toBe(1);
    expect(row(ref)).toMatchObject({ status: 'expired', decision_reason: TRANSFER_NOT_COMPLETED });
    expect((await propose(1000)).body.offer.status).toBe('offered');
  });

  it('an admin voids it with a reason and the remaining is free again', async () => {
    const ref = await acceptedRef(1000);
    expect((await post(`/api/acquisitions/admin/${ref}/void`, { reason: 'seller lost the key' })).status).toBe(403);
    expect((await post(`/api/acquisitions/admin/${ref}/void`, { reason: '' }, { 'x-admin-hex-id': ADMIN })).status).toBe(400);
    const r = await post(`/api/acquisitions/admin/${ref}/void`, { reason: 'seller lost the key' }, { 'x-admin-hex-id': ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('withdrawn');
    expect(row(ref)).toMatchObject({ status: 'withdrawn', decided_by: ADMIN, decision_reason: 'seller lost the key' });
    expect((await propose(1000)).body.offer.status).toBe('offered');
    // The transfer door is shut behind it.
    const t = await post(`/api/acquisitions/${ref}/transfer`, { hexId: seller.pub, privateKey: 'k' });
    expect(t.status).toBe(409);
    expect(world.sent).toHaveLength(0);
  });

  it('a TRANSFERRED offer is never lapsed by the sweeper nor voided by an admin', async () => {
    const ref = await acceptedRef(600);
    const t = await post(`/api/acquisitions/${ref}/transfer`, { hexId: seller.pub, privateKey: 'k' });
    expect(t.status).toBe(200);
    expect(row(ref).transaction_id).not.toBeNull();
    // Even with the status forced back to 'accepted' and the clock far in the
    // past, transaction_id alone protects it.
    db.prepare("UPDATE acquisition_offers SET status = 'accepted' WHERE offer_ref = ?").run(ref);
    backdate(ref, 1000);
    expect(expireStaleOffers(db)).toBe(0);
    expect(row(ref).status).toBe('accepted');
    const v = await post(`/api/acquisitions/admin/${ref}/void`, { reason: 'try' }, { 'x-admin-hex-id': ADMIN });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe('ALREADY_SETTLED');
    expect(row(ref).status).toBe('accepted');
    // Voiding something that was never accepted is refused too.
    const offered = (await propose(100)).body.offer.offerRef;
    expect((await post(`/api/acquisitions/admin/${offered}/void`, { reason: 'try' }, { 'x-admin-hex-id': ADMIN })).body.code).toBe('NOT_VOIDABLE');
  });
});

describe('admin decide on a mandate-bound offer', () => {
  it('prices at the round discount and refuses more than the mandate has left', async () => {
    // Put a mandate-bound offer into review by hand (the UNMEASURABLE branch
    // is the only automatic road there, and it needs a zero reference).
    db.prepare(`INSERT INTO acquisition_offers (offer_ref, user_hex_id, sender_wallet_id, wallet_class, lana_amount_lanoshis, lana_amount_display,
      currency, status, mandate_ref, round, mandate_code) VALUES ('OFF-R-1', ?, ?, 'lanapays', ?, 900, 'EUR', 'under_review', ?, 1, 'UNMEASURABLE')`)
      .run(seller.pub, W1, 900 * LANA, `8:1:${seller.pub}`);
    const ok = await post('/api/acquisitions/admin/OFF-R-1/decide', { action: 'accept' }, { 'x-admin-hex-id': ADMIN });
    expect(ok.status).toBe(200);
    expect(row('OFF-R-1').discount_percent).toBe(22);
    expect(row('OFF-R-1').purchase_price_fiat).toBe(179.71); // 900 × 0.256 × 0.78

    db.prepare(`INSERT INTO acquisition_offers (offer_ref, user_hex_id, sender_wallet_id, wallet_class, lana_amount_lanoshis, lana_amount_display,
      currency, status, mandate_ref, round, mandate_code) VALUES ('OFF-R-2', ?, ?, 'lanapays', ?, 200, 'EUR', 'under_review', ?, 1, 'UNMEASURABLE')`)
      .run(seller.pub, W1, 200 * LANA, `8:1:${seller.pub}`);
    const over = await post('/api/acquisitions/admin/OFF-R-2/decide', { action: 'accept' }, { 'x-admin-hex-id': ADMIN });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('MANDATE_EXHAUSTED');
    expect(over.body.remainingLana).toBe(100);
  });
});

describe('/api/treasury', () => {
  it('the public rounds view carries dates and totals but no discount, hex or name', async () => {
    const r = await get('/api/treasury/rounds?split=8');
    expect(r.status).toBe(200);
    expect(r.body.rounds[0]).toMatchObject({ round: 1, state: 'open', mandateCount: 1, expectedLana: 1000, remainingLana: 1000 });
    expect(JSON.stringify(r.body)).not.toContain(seller.pub);
    expect(JSON.stringify(r.body)).not.toMatch(/discount/i);
    expect(r.body.rounds[1].state).toBe('no_mandates');
  });

  it('round-terms and ingest need the Bearer key; ingest is the same door as the relay pull', async () => {
    expect((await get('/api/treasury/round-terms?split=8')).status).toBe(401);
    const terms = await get('/api/treasury/round-terms?split=8', { authorization: `Bearer ${API_KEY}` });
    expect(terms.body.rounds[0].discountPercent).toBe(22);
    expect(terms.body.rounds[1]).toEqual({ round: 2, opensAt: null, discountPercent: null });

    const stranger = makeKey();
    const forged = mandateEvent(stranger, { split: 8, round: 2, hex: seller.pub, wallets: [{ address: W1, currency: 'EUR', lana: '5', fundSettingId: '1' }] });
    const r = await post('/api/treasury/mandates/ingest', { event: forged }, { authorization: `Bearer ${API_KEY}` });
    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM acquisition_mandates WHERE round = 2').get()).toEqual({ c: 0 });
  });

  it('the admin worklist shows expected / proposed / accepted / remaining per mandate and the degraded flags', async () => {
    world.balances[W1] = 1234.5;
    await propose(600);
    const r = await get('/api/treasury/admin/mandates?split=8', { 'x-admin-hex-id': ADMIN });
    expect(r.status).toBe(200);
    const m = r.body.mandates[0];
    expect(m).toMatchObject({ round: 1, financerHex: seller.pub, expectedLana: 1000, proposedLana: 600, acceptedLana: 0, remainingLana: 400, state: 'open' });
    expect(m.wallets[0].onchainLana).toBe(1234.5);
    expect(m.offers).toHaveLength(1);
    expect(r.body.degraded).toMatchObject({ noEvents: false, noTerms: false, splitUnknown: false, staleSync: true });
    expect(r.body.totals.remainingLana).toBe(400);
    expect((await get('/api/treasury/admin/mandates?split=8')).status).toBe(403);
  });

  it('PUT /admin/rounds validates and warns', async () => {
    const bad = await fetch(base + '/api/treasury/admin/rounds', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-hex-id': ADMIN },
      body: JSON.stringify({ split: 8, rounds: [{ round: 1, opensAt: '2026-09-21T00:00:00Z', discountPercent: 22 }, { round: 2, opensAt: '2026-09-14T00:00:00Z', discountPercent: 25 }] }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(base + '/api/treasury/admin/rounds', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-hex-id': ADMIN },
      body: JSON.stringify({ split: 8, rounds: [{ round: 1, opensAt: '2026-09-14T22:00:00Z', discountPercent: 21 }, { round: 2, opensAt: null, discountPercent: 25 }] }) });
    const body: any = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    expect(body.rounds.find((x: any) => x.round === 1).discount_percent).toBe(21);
  });
});
