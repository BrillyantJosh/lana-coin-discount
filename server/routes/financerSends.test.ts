// @vitest-environment node
/**
 * A FINANCER SENDS THEIR PURCHASES' LANA — END TO END, AND NOTHING EVER TWICE.
 *
 * Everything real that can be: the routers (/api/financer and the brain's and
 * admin's /api), the NIP-98 signatures, the production DDL, the brain outbox,
 * the send machine and its round, the treasury's auto-sender, and the browser's
 * own signing code (src/lib/financer/payoutView.ts + payoutKey.ts, with a WIF
 * typed as the financer would). Stand-ins, each a real server in this process:
 * two Electrum servers over one LANA chain in memory (fakeChain.ts — they answer
 * as electrum1/2.lanacoin.com do), Direct.Fund, and the brain (which, given
 * fiat-received, authorises the purchase back through POST
 * /api/brain/authorize-send as it does on its 10th beat). The Registrar is a
 * stand-in fetch. Every key is a throwaway one; nothing leaves this machine.
 *
 * The whole way: Direct.Fund batch paid → POST /api/financer/batches/confirm →
 * fiat-received reaches the brain → the brain authorises → GET /sendable →
 * prepare → signed IN THE TEST with the browser's code → POST /sends → mempool →
 * a block → the round → legs 'sent', lana-sent with exactly their order ids, the
 * batch settled. And the edges: a broadcast that timed out (the second prepare
 * refused, the same bytes again), a redirect between prepare and announce, a
 * cancel while sending, a caretaker leg released late, another financer, a
 * restart while announced — and the treasury's auto-send, whose silent
 * broadcast used to pay the same people twice.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 120_000 });

const fake = vi.hoisted(() => ({ servers: [] as Array<{ host: string; port: number }> }));
vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../lib/roundMandateTestKit');
  return { ...dbModuleStub(createMandateTestDb()), getElectrumServersFromDb: () => fake.servers };
});

import { getDbHandle } from '../db/index.js';
import apiRouter from './api';
import { createFinancerRouter } from './financer';
import { keepRawBody } from '../lib/nip98Auth';
import { newSigner, nip98Header, type TestSigner } from '../lib/nip98TestKit';
import { createSends, setDefaultSends, MIN_SPENDER_DEPTH, type PrepareAnswer, type Sends } from '../lib/financer/sends';
import { createPayoutChain } from '../lib/financer/payoutChain';
import { createPaymentReader, machineOfAddress } from '../lib/financer/chainPayment';
import { fetchFinancer } from '../lib/financer/dfClient';
import { checkFinancerWallet } from '../lib/financer/registrarWallet';
import { runOutbox } from '../lib/financer/brainOutbox';
import { createTreasuryAutoSend } from '../lib/treasuryAutoSend';
import { sendLockHolder } from '../lib/sendLock';
import { addTx, fakeElectrumChain, newChain } from '../lib/financer/fakeChain';
import { LANA, parentPaying, throwawayAddress, throwawayWallet, type ThrowawayWallet } from '../shared/lana-tx/fixtures/wallets';
import { decodeTx, encodeTxHex, SEQUENCE_FINAL, txidOfRaw } from '../shared/lana-tx/codec';
import { p2pkScriptHex, scriptOfAddress } from '../shared/lana-tx/address';
import { coinsOf, planOfPrepared, checkOwnSend, serverNowSec } from '../../src/lib/financer/payoutView';
import { signPayoutWithKey } from '../../src/lib/financer/payoutKey';
import { base58Encode } from '../../src/lib/financer/wif';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58CheckEncode, hexToUint8Array, privateKeyToPublicKey, privateKeyToUncompressedPublicKey, publicKeyToAddress } from '../lib/transaction';

const db: Database.Database = getDbHandle();
const me = newSigner();
const other = newSigner();
const admin = newSigner();
const API_KEY = 'ldk_financer_sends_test';
const CALLBACK_KEY = 'cb-financer-sends';
/** Real leg amounts of brain_lana_orders (8 Oct 2026), in lanoshis — not whole thousands. */
const AMOUNTS = { investor_lana: 10_338_867_187, merchant_commission: 1_004_492_188, customer_cashback: 3_446_289_063, caretaker_commission: 40_800_000 };

/** A LanaCoin WIF (0xB0) of a throwaway wallet, in the form its compression flag says — as the financer types it. */
function wifOf(w: Pick<ThrowawayWallet, 'privateKey' | 'compressed'>): string {
  const payload = new Uint8Array(w.compressed ? 34 : 33);
  payload[0] = 0xb0;
  payload.set(w.privateKey, 1);
  if (w.compressed) payload[33] = 0x01;
  const check = sha256(sha256(payload)).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(check, payload.length);
  return base58Encode(full);
}

// ─── the LANA chain, two Electrum servers over it ──────────────────────────

const chain = newChain(1_068_000);
let height = 1_067_000;
let electrumA: Awaited<ReturnType<typeof fakeElectrumChain>>;
let electrumB: Awaited<ReturnType<typeof fakeElectrumChain>>;
const fund = (address: string, values: bigint[]) => {
  for (const v of values) addTx(chain, parentPaying(address, [v], Math.floor(Date.now() / 1000) - 86_400).raw, { height: ++height });
  chain.tip = height + 3;
};
/** Into a block: the transaction (from the mempool) at the next height. */
const mine = (txid: string) => {
  const raw = chain.raws.get(txid);
  if (!raw) throw new Error(`not in the mempool: ${txid}`);
  addTx(chain, raw, { height: ++height });
  chain.tip = height + 1;
};
const distinctBroadcasts = () => [...new Set(chain.broadcasts ?? [])];

// ─── Direct.Fund ───────────────────────────────────────────────────────────

const df = {
  batches: new Map<string, unknown>(),
  financers: new Map<string, string | null>(),
  /** A financer's wallets per currency (9 Oct 2026); none set: a Direct.Fund before them (the field absent). */
  wallets: new Map<string, Record<string, { walletId: string; setAt: string | null }>>(),
};
const dfServer = http.createServer((req, res) => {
  const url = String(req.url);
  res.setHeader('content-type', 'application/json');
  let m = /^\/api\/admin\/batch-by-ref\/([^/]+)$/.exec(url);
  if (m) {
    const b = df.batches.get(decodeURIComponent(m[1]));
    res.statusCode = b ? 200 : 404;
    res.end(JSON.stringify(b ?? { error: 'BATCH_NOT_FOUND' }));
    return;
  }
  // Route 3: the financer's own Lana Discount batches (the confirm reads only batches on this list).
  m = /^\/api\/admin\/financers\/([0-9a-f]{64})\/lana-discount-batches$/.exec(url);
  if (m) {
    const own = [...df.batches.values()].map(b => b as { batch: any; payments: any[] }).filter(b => b.batch.investorHex === m![1]);
    res.end(JSON.stringify({ batches: own.map(({ batch, payments }) => ({ ...batch, transactionRefs: payments.map(p => p.transactionRef) })) }));
    return;
  }
  m = /^\/api\/admin\/financers\/([0-9a-f]{64})$/.exec(url);
  if (m) {
    const wallet = df.financers.get(m[1]) ?? null;
    const perCurrency = df.wallets.get(m[1]);
    res.end(JSON.stringify({ hexId: m[1], isInvestor: df.financers.has(m[1]), lanaDiscountWallet: wallet, lanaDiscountWalletSetAt: wallet ? '2026-10-08' : null, ...(perCurrency ? { wallets: perCurrency } : {}) }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
const dfBatch = (batchRef: string, refs: string[], investor = me.hex, currency = 'EUR') => df.batches.set(batchRef, {
  batch: { batchRef, investorHex: investor, totalAmount: 10 * refs.length, currency, paymentCount: refs.length, confirmedCount: refs.length, status: 'paid', destinationType: 'lana_discount', fundSettingId: 7, createdAt: '2026-10-08 09:00:00', paidAt: '2026-10-08 10:00:00' },
  payments: refs.map((ref, i) => ({ ppId: i + 1, amount: 10, currency, confirmed: true, transactionRef: ref, investorHex: investor, destinationType: 'lana_discount', orderStatus: 'DirectPaid', live: true, orderType: 'cash' })),
});

// ─── the brain ─────────────────────────────────────────────────────────────

const brainWorld = { calls: [] as Array<{ kind: string; body: any; key: string | undefined }>, authorizes: true };
let base = '';
const brainServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const kind = String(req.url).split('/').pop() as string;
    const body = JSON.parse(raw || '{}');
    brainWorld.calls.push({ kind, body, key: req.headers['x-callback-key'] as string | undefined });
    // DirectPaid now: the brain authorises the purchase's LANA at Lana Discount (its step 5).
    if (kind === 'fiat-received' && brainWorld.authorizes) {
      await fetch(`${base}/api/brain/authorize-send`, { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ transaction_refs: body.transaction_refs }) });
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
});
let brainBase = '';
const deliverToBrain = () => runOutbox(db, { callbackUrl: brainBase, callbackKey: CALLBACK_KEY });

// ─── the Registrar ─────────────────────────────────────────────────────────

const registrar = { owner: (_wallet: string): string | null => me.hex };
const walletFetch = (async (_url: unknown, init: any) => {
  const { wallet_id } = JSON.parse(String(init.body));
  const owner = registrar.owner(wallet_id);
  const body = owner ? { registered: true, frozen: false, wallet_type: 'Lana.Discount', nostr_hex_id: owner } : { registered: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ─── lana.discount ─────────────────────────────────────────────────────────

let skewMs = 0;
const clock = () => Date.now() + skewMs;
let dfBase = '';
const servers = () => fake.servers;
const makeSends = (): Sends => createSends({
  db,
  chain: createPayoutChain({ servers, stateTimeoutMs: 1500, rawTimeoutMs: 1500, broadcastTimeoutMs: 400 }),
  // Both fake servers answer from 127.0.0.1 — one machine by the address a connection reaches (the reader's default
  // never lets one vouch for the other). Here each stands for a machine of its own, told apart by its port.
  payments: createPaymentReader({ servers, timeoutMs: 1500, machineOf: (address, s) => `${machineOfAddress(address)}#${s.port}` }),
  financer: hex => fetchFinancer(hex, { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) }),
  checkWallet: (w, o) => checkFinancerWallet(w, o, { checkBaseUrl: 'http://check.test', fetch: walletFetch }),
  now: clock,
  log: () => undefined,
});
let sends: Sends;
let server: http.Server;

beforeAll(async () => {
  electrumA = await fakeElectrumChain(chain);
  electrumB = await fakeElectrumChain(chain);
  fake.servers = [electrumA.at, electrumB.at];
  await new Promise<void>(r => dfServer.listen(0, '127.0.0.1', r));
  dfBase = `http://127.0.0.1:${(dfServer.address() as AddressInfo).port}`;
  await new Promise<void>(r => brainServer.listen(0, '127.0.0.1', r));
  brainBase = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;
  sends = makeSends();
  // The manual button (routes/api.ts) sends with the process's one machine: this one.
  setDefaultSends(sends);
  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use('/api/financer', createFinancerRouter({
    walletCheckBaseUrl: 'http://check.test',
    df: { baseUrl: dfBase, headers: () => ({ Authorization: 'Bearer peer-test' }) },
    walletFetch,
    sends,
  }));
  app.use('/api', apiRouter);
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setDefaultSends(null);
  for (const s of [server, dfServer, brainServer]) await new Promise<void>(r => s.close(() => r()));
  await electrumA.close();
  await electrumB.close();
});

let wallet: ThrowawayWallet;
beforeEach(() => {
  for (const t of ['brain_lana_orders', 'incoming_batch_payments', 'incoming_batches', 'purchase_settlement', 'brain_callback_outbox', 'lana_sends', 'api_keys', 'admin_users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO api_keys (key_hash, app_name, created_by) VALUES (?, 'lana-brain', 'test')").run(createHash('sha256').update(API_KEY).digest('hex'));
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(admin.hex);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('buyback_wallet_id', 'LTreasury') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  // A fresh Lana.Discount wallet for the financer, chosen on Direct.Fund, registered to them, holding 300 + 50 LANA.
  wallet = throwawayWallet(true);
  df.financers.clear();
  df.financers.set(me.hex, wallet.address);
  df.wallets.clear();
  df.batches.clear();
  registrar.owner = w => (w === wallet.address ? me.hex : null);
  fund(wallet.address, [300n * LANA, 50n * LANA]);
  chain.broadcast = 'accept';
  brainWorld.calls = [];
  brainWorld.authorizes = true;
  skewMs = 0;
});

// ─── helpers ───────────────────────────────────────────────────────────────

const call = async (who: TestSigner, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const url = `/api/financer${path}`;
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: nip98Header(who, { method, url, body: raw }) }, body: raw });
  return { status: r.status, body: await r.json() as any };
};
const brain = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const asAdmin = async (path: string, body: unknown) => {
  const raw = JSON.stringify(body);
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: nip98Header(admin, { method: 'POST', url: path, body: raw }) }, body: raw });
  return { status: r.status, body: await r.json() as any };
};
const legRow = (id: string) => db.prepare('SELECT * FROM brain_lana_orders WHERE id = ?').get(id) as any;
const outbox = (kind: string) => db.prepare('SELECT * FROM brain_callback_outbox WHERE kind = ? ORDER BY id').all(kind) as any[];

/** The brain's legs of one purchase (each to its own throwaway wallet; the investor leg pays the financer's budget wallet). */
async function brainOrders(ref: string, types = Object.keys(AMOUNTS) as Array<keyof typeof AMOUNTS>, currency = 'EUR'): Promise<string[]> {
  const ids: string[] = [];
  for (const type of types) {
    const id = `${ref}-${type}`;
    const r = await brain('POST', '/api/brain/lana-order', {
      order_id: id, tx_ref: ref, order_type: type, to_wallet: throwawayAddress(), to_hex: type === 'investor_lana' ? me.hex : 'c3'.repeat(32),
      lana_amount: AMOUNTS[type], fiat_value: 1, currency, exchange_rate: 0.128,
    });
    expect(r.status).toBe(201);
    ids.push(id);
  }
  // In the order lana.discount sends a purchase's legs: oldest first, then by purchase and id (sends.ts LEG_ORDER) — read
  // back, not assumed: on a busy machine the four posts can straddle a second.
  return (db.prepare('SELECT id FROM brain_lana_orders WHERE transaction_ref = ? ORDER BY created_at, transaction_ref, id').all(ref) as Array<{ id: string }>)
    .map(r => r.id).filter(id => ids.includes(id));
}
const amountOf = (id: string) => AMOUNTS[id.slice(id.indexOf('-') + 1) as keyof typeof AMOUNTS];

/** Paid on Direct.Fund, confirmed here by the financer, fiat-received delivered, authorised by the brain. */
async function confirmedPurchase(ref: string, batchRef: string, currency = 'EUR'): Promise<string[]> {
  const ids = await brainOrders(ref, undefined, currency);
  dfBatch(batchRef, [ref], me.hex, currency);
  const c = await call(me, 'POST', '/batches/confirm', { batchRefs: [batchRef] });
  expect(c.body.results).toEqual([{ batchRef, ok: true, alreadyConfirmed: false, transactionRefs: [ref] }]);
  const delivered = await deliverToBrain();
  expect(delivered).toMatchObject({ done: 1, waiting: 0 });
  for (const id of ids) expect(legRow(id).brain_authorized).toBe(1);
  return ids;
}

/** The financer's browser: the prepare answer read, the send planned at the server's clock, signed with the typed WIF. */
async function browserSigns(prepared: PrepareAnswer, receivedAt: number, wif = wifOf(wallet)): Promise<string> {
  const coins = coinsOf(prepared);
  if (coins.ok !== true) throw new Error('coins do not read');
  const nowSec = serverNowSec(prepared.nowSec, receivedAt, Date.now());
  const page = planOfPrepared(prepared, coins.coins, nowSec);
  if (page.ok !== true) throw new Error(`no plan: ${JSON.stringify(page.problem)}`);
  const signed = await signPayoutWithKey(wif, { from: prepared.wallet, pay: page.plan.pay, coins: page.plan.coins, nowSec });
  if (signed.ok !== true) throw new Error(`not signed: ${JSON.stringify(signed)}`);
  // The page's own second look, against the coins in input order (the plan's).
  expect(checkOwnSend(signed.rawTx, prepared, page.plan.coins, nowSec).ok).toBe(true);
  return signed.rawTx;
}

async function prepareAndSign(ids: string[], who = me): Promise<{ prepared: PrepareAnswer; rawTx: string }> {
  const r = await call(who, 'POST', '/sends/prepare', { orderIds: ids });
  expect(r.status).toBe(200);
  return { prepared: r.body, rawTx: await browserSigns(r.body, Date.now()) };
}

// ─── the whole way ─────────────────────────────────────────────────────────

describe('a financer sends their purchases\' LANA from their own wallet', () => {
  it('the whole way: confirm → fiat-received → authorised → prepare → signed in the browser → sent → in a block → sent, told, settled', async () => {
    const ids = await confirmedPurchase('T1', 'B1');
    expect(brainWorld.calls.map(c => [c.kind, c.body, c.key])).toEqual([['fiat-received', { batch_ref: 'B1', transaction_refs: ['T1'] }, CALLBACK_KEY]]);

    const s = await call(me, 'GET', '/sendable');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ wallet: wallet.address, legCount: 4, balance: { confirmed: (350n * LANA).toString(), unconfirmed: '0' }, shortfallLanoshis: '0' });
    expect(s.body.purchases.map((p: any) => [p.transactionRef, p.batchRef, p.legs.map((l: any) => l.orderId)])).toEqual([['T1', 'B1', ids]]);

    const { prepared, rawTx } = await prepareAndSign(ids);
    expect(prepared.allocations.map(a => a.lanoshis)).toEqual(ids.map(id => String(amountOf(id))));
    const sent = await call(me, 'POST', '/sends', { orderIds: ids, rawTx });
    expect(sent.status).toBe(200);
    const txid = txidOfRaw(rawTx);
    expect(sent.body).toMatchObject({ already: false, send: { txid, state: 'mempool', sender: 'financer', orderIds: ids, transactionRefs: ['T1'] } });
    expect(chain.raws.has(txid)).toBe(true);
    // The outputs are the legs to the lanoshi, then the change back to the financer's wallet.
    const outs = decodeTx(rawTx).outputs.map(o => o.value);
    expect(outs.slice(0, 4)).toEqual(ids.map(id => BigInt(amountOf(id))));
    expect(outs).toHaveLength(5);

    // The brain sees a leg on its way as 'pending' — its own word for "wait".
    for (const id of ids) expect((await brain('GET', `/api/brain/lana-order/${id}`)).body).toMatchObject({ status: 'pending', tx_hash: null });
    expect((await sends.round()).confirmed).toEqual([]);
    expect(legRow(ids[0]).status).toBe('sending');

    mine(txid);
    expect((await sends.round()).confirmed).toEqual([txid]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txid });
    expect((db.prepare("SELECT status, lana_tx_hash FROM incoming_batches WHERE batch_ref = 'B1'").get() as any)).toEqual({ status: 'lana_sent', lana_tx_hash: txid });
    expect(outbox('lana-sent').map(r => JSON.parse(r.body_json))).toEqual([{ transaction_refs: ['T1'], tx_hash: txid, order_ids: ids }]);
    await deliverToBrain();
    expect(brainWorld.calls.at(-1)).toEqual({ kind: 'lana-sent', body: { transaction_refs: ['T1'], tx_hash: txid, order_ids: ids }, key: CALLBACK_KEY });
    for (const id of ids) expect((await brain('GET', `/api/brain/lana-order/${id}`)).body).toMatchObject({ status: 'sent', tx_hash: txid });
    expect((await call(me, 'GET', '/sends')).body.sends.map((x: any) => [x.txid, x.state])).toEqual([[txid, 'confirmed']]);
    expect(distinctBroadcasts().filter(r => txidOfRaw(r) === txid)).toHaveLength(1);
  });

  it('a broadcast that timed out: the send is kept, a second prepare is refused, and only the SAME bytes go again', async () => {
    const ids = await confirmedPurchase('T2', 'B2');
    const { rawTx } = await prepareAndSign(ids);
    const txid = txidOfRaw(rawTx);
    chain.broadcast = 'silent'; // no server answers the broadcast
    const sent = await call(me, 'POST', '/sends', { orderIds: ids, rawTx });
    expect(sent.status).toBe(200);
    expect(sent.body.send).toMatchObject({ txid, state: 'announced', broadcasts: 1 });
    expect(sent.body.send.lastOutcome).toMatch(/^unknown/);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: txid });
    // ...while the network took it after all.
    chain.raws.set(txid, rawTx);

    // The page cannot sign the same legs again: nothing is offered while the send is on its way.
    expect(await call(me, 'POST', '/sends/prepare', { orderIds: ids })).toMatchObject({ status: 409, body: { code: 'NOT_SENDABLE' } });
    expect((await call(me, 'GET', '/sendable')).body.purchases).toEqual([]);
    // A later purchase waits for this one: one send of the wallet at a time.
    const later = await confirmedPurchase('T2b', 'B2b');
    expect(await call(me, 'POST', '/sends/prepare', { orderIds: later })).toMatchObject({ status: 409, body: { code: 'SEND_IN_FLIGHT', txid } });
    // The page repeats its announce with the same bytes: answered as it stands, nothing broadcast again.
    const before = (chain.broadcasts ?? []).length;
    expect(await call(me, 'POST', '/sends', { orderIds: ids, rawTx })).toMatchObject({ status: 200, body: { already: true, send: { txid } } });
    expect((chain.broadcasts ?? []).length).toBe(before);

    // The round sends the SAME bytes again when due — never a new transaction.
    chain.broadcast = 'accept';
    skewMs = 3 * 60_000;
    expect((await sends.round()).sent).toEqual([txid]);
    expect(legRow(ids[0]).status).toBe('sending');
    mine(txid);
    expect((await sends.round()).confirmed).toEqual([txid]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txid });
    // Of every transaction ever broadcast, exactly one pays these legs' wallets.
    const scripts = new Set(ids.map(id => scriptOfAddress(legRow(id).to_wallet)));
    expect(distinctBroadcasts().filter(r => decodeTx(r).outputs.some(o => scripts.has(o.scriptPubKeyHex)))).toEqual([rawTx]);
  });

  it('a leg redirected between prepare and announce: refused (LEGS_CHANGED), nothing sent', async () => {
    const ids = await confirmedPurchase('T3', 'B3');
    const { rawTx } = await prepareAndSign(ids);
    expect((await brain('POST', `/api/brain/lana-order/${ids[1]}/redirect`, { to_wallet: throwawayAddress() })).status).toBe(200);
    const r = await call(me, 'POST', '/sends', { orderIds: ids, rawTx });
    expect(r).toMatchObject({ status: 409, body: { code: 'LEGS_CHANGED' } });
    expect(chain.raws.has(txidOfRaw(rawTx))).toBe(false);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    expect(db.prepare('SELECT COUNT(*) c FROM lana_sends').get()).toEqual({ c: 0 });
  });

  it('a leg on its way cannot be cancelled, redirected or have its wallet fixed (409)', async () => {
    const ids = await confirmedPurchase('T4', 'B4');
    const { rawTx } = await prepareAndSign(ids);
    expect((await call(me, 'POST', '/sends', { orderIds: ids, rawTx })).status).toBe(200);
    expect(await brain('POST', `/api/brain/lana-order/${ids[2]}/cancel`, { reason: 'test' })).toMatchObject({ status: 409, body: { status: 'sending', error: 'too_late' } });
    expect(await brain('POST', `/api/brain/lana-order/${ids[2]}/redirect`, { to_wallet: throwawayAddress() })).toMatchObject({ status: 409, body: { status: 'sending' } });
    expect(await asAdmin('/api/admin/fix-wallet', { table: 'brain_lana_orders', id: ids[2], field: 'to_wallet', new_value: throwawayAddress() }))
      .toMatchObject({ status: 409, body: { code: 'NOT_PENDING', status: 'sending' } });
    expect(legRow(ids[2])).toMatchObject({ status: 'sending', send_txid: txidOfRaw(rawTx) });
  });

  it('a caretaker leg released late is covered by the purchase\'s owner and becomes sendable once authorised', async () => {
    const ids = await confirmedPurchase('T5', 'B5');
    const { rawTx } = await prepareAndSign(ids);
    await call(me, 'POST', '/sends', { orderIds: ids, rawTx });
    mine(txidOfRaw(rawTx));
    await sends.round();
    // The brain releases the caretaker's commission afterwards, then authorises the purchase again.
    const late = 'T5-caretaker-late';
    expect((await brain('POST', '/api/brain/lana-order', { order_id: late, tx_ref: 'T5', order_type: 'caretaker_commission', to_wallet: throwawayAddress(), to_hex: 'c3'.repeat(32), lana_amount: 52_000_000, fiat_value: 1, currency: 'EUR', exchange_rate: 0.128 })).status).toBe(201);
    expect(legRow(late)).toMatchObject({ status: 'pending', brain_authorized: 0 });
    expect((await call(me, 'GET', '/sendable')).body.purchases).toEqual([]);
    expect((await brain('POST', '/api/brain/authorize-send', { transaction_refs: ['T5'] })).body).toMatchObject({ authorized: 1 });
    const s = await call(me, 'GET', '/sendable');
    expect(s.body.purchases.map((p: any) => [p.transactionRef, p.legs.map((l: any) => l.orderId)])).toEqual([['T5', [late]]]);
    const second = await prepareAndSign([late]);
    expect((await call(me, 'POST', '/sends', { orderIds: [late], rawTx: second.rawTx })).body.send.state).toBe('mempool');
    mine(txidOfRaw(second.rawTx));
    expect((await sends.round()).confirmed).toEqual([txidOfRaw(second.rawTx)]);
    expect(legRow(late)).toMatchObject({ status: 'sent', tx_hash: txidOfRaw(second.rawTx) });
    expect(outbox('lana-sent').map(r => JSON.parse(r.body_json).order_ids)).toEqual([ids, [late]]);
  });

  it("the brain moves a confirmed purchase's investor leg to another financer: its answer unchanged, and the purchase is no longer this financer's to send (OWNER_MISMATCH)", async () => {
    const ids = await confirmedPurchase('T3b', 'B3b');
    const investor = ids.find(id => id.endsWith('investor_lana')) as string;
    const before = legRow(investor).to_wallet;
    const to = throwawayAddress();
    const r = await brain('POST', `/api/brain/lana-order/${investor}/redirect`, { to_wallet: to, to_hex: other.hex });
    expect(r).toEqual({ status: 200, body: { ok: true, before, after: to } });
    expect((await call(me, 'GET', '/sendable')).body.purchases).toEqual([]);
    expect(await call(me, 'POST', '/sends/prepare', { orderIds: ids })).toMatchObject({ status: 409, body: { code: 'OWNER_MISMATCH', orderIds: ids } });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
  });

  it('another financer sees nothing of these legs and can neither prepare nor send them', async () => {
    const ids = await confirmedPurchase('T6', 'B6');
    const { rawTx } = await prepareAndSign(ids);
    expect((await call(other, 'GET', '/sendable')).body).toMatchObject({ purchases: [], legCount: 0, walletProblem: 'NO_WALLET' });
    expect(await call(other, 'POST', '/sends/prepare', { orderIds: ids })).toMatchObject({ status: 409, body: { code: 'NOT_SENDABLE' } });
    expect(await call(other, 'POST', '/sends', { orderIds: ids, rawTx })).toMatchObject({ status: 409, body: { code: 'NOT_SENDABLE' } });
    expect((await call(other, 'GET', '/sends')).body).toEqual({ sends: [] });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    const unsigned = await fetch(`${base}/api/financer/sendable`);
    expect(unsigned.status).toBe(403);
  });

  it("a send that never got out, whose coin the financer's desktop wallet then staked — a coinstake mined: an empty first output, then the wallet's public key, no P2PKH output — is released by the round, the coinstake proven over both servers (recheck of 9 Oct 2026)", async () => {
    const ids = await confirmedPurchase('T8', 'B8');
    const { rawTx } = await prepareAndSign(ids);
    const txid = txidOfRaw(rawTx);
    chain.broadcast = 'silent'; // it never reached a node
    expect((await call(me, 'POST', '/sends', { orderIds: ids, rawTx })).body.send).toMatchObject({ txid, state: 'announced' });
    chain.broadcast = 'accept';
    const stake = encodeTxHex({
      version: 1,
      nTime: Math.floor(Date.now() / 1000),
      inputs: decodeTx(rawTx).inputs.slice(0, 1).map(i => ({ prevTxid: i.prevTxid, vout: i.vout, scriptSigHex: '', sequence: SEQUENCE_FINAL })),
      outputs: [{ value: 0n, scriptPubKeyHex: '' }, { value: 301n * LANA, scriptPubKeyHex: p2pkScriptHex(wallet.publicKey) }],
      locktime: 0,
    });
    addTx(chain, stake, 'mempool');
    mine(txidOfRaw(stake));
    // Proven over both servers, but 2 blocks deep: no proof yet — a coinstake orphaned vanishes (M1). Kept.
    expect((await sends.round()).released).toEqual([]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: txid });
    // MIN_SPENDER_DEPTH deep: released.
    chain.tip = height + MIN_SPENDER_DEPTH - 1;
    skewMs += 3 * 60_000;
    const res = await sends.round();
    expect(res.released).toEqual([txid]);
    expect(db.prepare('SELECT state, release_reason, last_outcome FROM lana_sends WHERE txid = ?').get(txid)).toMatchObject({ state: 'released', release_reason: 'input_spent', last_outcome: expect.stringContaining(txidOfRaw(stake)) });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: null });
  });

  it('a restart while a send is announced: the new process sends the stored bytes and finishes it', async () => {
    const ids = await confirmedPurchase('T7', 'B7');
    const { rawTx } = await prepareAndSign(ids);
    const txid = txidOfRaw(rawTx);
    chain.broadcast = 'silent';
    await call(me, 'POST', '/sends', { orderIds: ids, rawTx });
    // The process stopped between storing the send and broadcasting it.
    db.prepare('UPDATE lana_sends SET broadcasts = 0, next_broadcast_at = NULL, last_outcome = NULL WHERE txid = ?').run(txid);
    chain.broadcast = 'accept';
    const restarted = makeSends();
    expect((await restarted.round()).sent).toEqual([txid]);
    expect(chain.raws.has(txid)).toBe(true);
    mine(txid);
    expect((await restarted.round()).confirmed).toEqual([txid]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txid });
  });
});

// ─── one wallet per currency ───────────────────────────────────────────────

describe('one Lana.Discount wallet per currency (owner, 9 Oct 2026): EUR and GBP purchases, each from its own wallet, the whole way', () => {
  it('confirm both → /me lists both wallets → each currency read and sent from its wallet; a GBP send signed from the EUR wallet is refused, nothing broadcast; both in a block → every leg sent, both batches settled', async () => {
    // The financer chose a GBP wallet beside the EUR one on Direct.Fund; both registered to them, both funded.
    const gbpWallet = throwawayWallet(true);
    df.wallets.set(me.hex, { EUR: { walletId: wallet.address, setAt: '2026-10-08 10:00:00' }, GBP: { walletId: gbpWallet.address, setAt: '2026-10-09 08:00:00' } });
    registrar.owner = w => (w === wallet.address || w === gbpWallet.address ? me.hex : null);
    fund(gbpWallet.address, [300n * LANA]);
    const eurIds = await confirmedPurchase('TE1', 'BE1');
    const gbpIds = await confirmedPurchase('TG1', 'BG1', 'GBP');

    const who = await call(me, 'GET', '/me');
    expect(who.body.wallets).toEqual([
      { currency: 'EUR', walletId: wallet.address, walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false } },
      { currency: 'GBP', walletId: gbpWallet.address, walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false } },
    ]);

    // Without a currency there is no one answer; with one, its purchases and its wallet.
    expect(await call(me, 'GET', '/sendable')).toMatchObject({ status: 400, body: { code: 'CURRENCY_REQUIRED', currencies: ['EUR', 'GBP'] } });
    expect(await call(me, 'GET', '/sendable?currency=EURO')).toMatchObject({ status: 400, body: { code: 'BAD_CURRENCY' } });
    const sg = await call(me, 'GET', '/sendable?currency=GBP');
    expect(sg.body).toMatchObject({ currency: 'GBP', wallet: gbpWallet.address, legCount: 4, balance: { confirmed: (300n * LANA).toString(), unconfirmed: '0' } });
    expect(sg.body.purchases.map((p: any) => p.transactionRef)).toEqual(['TG1']);
    const se = await call(me, 'GET', '/sendable?currency=EUR');
    expect(se.body).toMatchObject({ currency: 'EUR', wallet: wallet.address, legCount: 4, balance: { confirmed: (350n * LANA).toString(), unconfirmed: '0' } });

    // One send, one currency.
    expect(await call(me, 'POST', '/sends/prepare', { orderIds: [...eurIds, ...gbpIds] })).toMatchObject({ status: 409, body: { code: 'MIXED_CURRENCY', currencies: ['EUR', 'GBP'] } });

    // The GBP purchase's legs, planned on the EUR wallet's coins and signed in the browser with the EUR key.
    const pe = (await call(me, 'POST', '/sends/prepare', { orderIds: eurIds })).body as PrepareAnswer;
    const pg = (await call(me, 'POST', '/sends/prepare', { orderIds: gbpIds })).body as PrepareAnswer;
    expect([pe.currency, pe.wallet, pg.currency, pg.wallet]).toEqual(['EUR', wallet.address, 'GBP', gbpWallet.address]);
    const fromEur = await browserSigns({ ...pe, allocations: pg.allocations, legs: pg.legs, payingLanoshis: pg.payingLanoshis }, Date.now(), wifOf(wallet));
    const refused = await call(me, 'POST', '/sends', { orderIds: gbpIds, rawTx: fromEur });
    expect(refused).toMatchObject({ status: 409, body: { code: 'COIN_UNAVAILABLE' } });
    expect(chain.raws.has(txidOfRaw(fromEur))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM lana_sends').get()).toEqual({ c: 0 });
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    // The GBP wallet's key does not open the EUR wallet's send either: the browser refuses to sign it.
    await expect(browserSigns(pe, Date.now(), wifOf(gbpWallet))).rejects.toThrow(/not signed/);

    // Each from its own wallet, with its own key — both on their way at once.
    const gbpTx = await browserSigns(pg, Date.now(), wifOf(gbpWallet));
    const eurTx = await browserSigns(pe, Date.now(), wifOf(wallet));
    const g = await call(me, 'POST', '/sends', { orderIds: gbpIds, rawTx: gbpTx });
    const e = await call(me, 'POST', '/sends', { orderIds: eurIds, rawTx: eurTx });
    expect(g.body.send).toMatchObject({ txid: txidOfRaw(gbpTx), state: 'mempool', wallet: gbpWallet.address, transactionRefs: ['TG1'] });
    expect(e.body.send).toMatchObject({ txid: txidOfRaw(eurTx), state: 'mempool', wallet: wallet.address, transactionRefs: ['TE1'] });
    // The GBP send spends only the GBP wallet's coins, and its change goes back there.
    const gbpCoins = new Set(pg.coins.map(c => `${c.txid}:${c.vout}`));
    expect(decodeTx(gbpTx).inputs.every(i => gbpCoins.has(`${i.prevTxid}:${i.vout}`))).toBe(true);
    expect(decodeTx(gbpTx).outputs.at(-1)!.scriptPubKeyHex).toBe(scriptOfAddress(gbpWallet.address));
    expect((await call(me, 'GET', '/sendable?currency=GBP')).body.inFlight.map((x: any) => x.txid)).toEqual([txidOfRaw(gbpTx)]);
    expect((await call(me, 'GET', '/sendable?currency=EUR')).body.inFlight.map((x: any) => x.txid)).toEqual([txidOfRaw(eurTx)]);

    mine(txidOfRaw(gbpTx));
    mine(txidOfRaw(eurTx));
    expect((await sends.round()).confirmed.sort()).toEqual([txidOfRaw(gbpTx), txidOfRaw(eurTx)].sort());
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txidOfRaw(gbpTx) });
    for (const id of eurIds) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txidOfRaw(eurTx) });
    expect(db.prepare("SELECT batch_ref, status, lana_tx_hash FROM incoming_batches WHERE batch_ref IN ('BE1', 'BG1') ORDER BY batch_ref").all()).toEqual([
      { batch_ref: 'BE1', status: 'lana_sent', lana_tx_hash: txidOfRaw(eurTx) },
      { batch_ref: 'BG1', status: 'lana_sent', lana_tx_hash: txidOfRaw(gbpTx) },
    ]);
    expect(outbox('lana-sent').map(r => JSON.parse(r.body_json)).sort((a, b) => a.transaction_refs[0].localeCompare(b.transaction_refs[0]))).toEqual([
      { transaction_refs: ['TE1'], tx_hash: txidOfRaw(eurTx), order_ids: eurIds },
      { transaction_refs: ['TG1'], tx_hash: txidOfRaw(gbpTx), order_ids: gbpIds },
    ]);
    // Of every transaction ever broadcast, exactly one pays the GBP purchase's wallets: the GBP wallet's.
    const scripts = new Set(gbpIds.map(id => scriptOfAddress(legRow(id).to_wallet)));
    expect(distinctBroadcasts().filter(r => decodeTx(r).outputs.some(o => scripts.has(o.scriptPubKeyHex)))).toEqual([gbpTx]);
  });

  it('a GBP purchase with no GBP wallet chosen is listed with NO_WALLET and refused NO_WALLET — never sent from the EUR wallet', async () => {
    df.wallets.set(me.hex, { EUR: { walletId: wallet.address, setAt: null } });
    const gbpIds = await confirmedPurchase('TG2', 'BG2', 'GBP');
    expect((await call(me, 'GET', '/me')).body.wallets).toEqual([
      { currency: 'EUR', walletId: wallet.address, walletCheck: { ok: true, walletType: 'Lana.Discount', frozen: false } },
      { currency: 'GBP', walletId: null, walletCheck: { ok: false, reason: 'NO_WALLET' } },
    ]);
    // A page from before wallets per currency asks without one: the only currency to send is GBP, and it has no wallet.
    expect((await call(me, 'GET', '/sendable')).body).toMatchObject({ currency: 'GBP', wallet: null, walletProblem: 'NO_WALLET', legCount: 4 });
    // Its one wallet says so too — not the EUR wallet, whose key would only be refused.
    expect((await call(me, 'GET', '/me')).body).toMatchObject({ lanaDiscountWallet: null, walletCheck: { ok: false, reason: 'NO_WALLET' } });
    expect(await call(me, 'POST', '/sends/prepare', { orderIds: gbpIds })).toMatchObject({ status: 409, body: { code: 'NO_WALLET', currency: 'GBP' } });
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
  });

  it("a page from before wallets per currency: /me's one wallet is the one its /sendable and prepare send from — GBP, the only currency to send, not EUR, the first chosen", async () => {
    const gbpWallet = throwawayWallet(true);
    df.wallets.set(me.hex, { EUR: { walletId: wallet.address, setAt: '2026-10-08 10:00:00' }, GBP: { walletId: gbpWallet.address, setAt: '2026-10-09 08:00:00' } });
    registrar.owner = w => (w === wallet.address || w === gbpWallet.address ? me.hex : null);
    fund(gbpWallet.address, [300n * LANA]);
    const gbpIds = await confirmedPurchase('TG3', 'BG3', 'GBP');

    // What the old page draws: the card from /me, the balance and the legs from /sendable, the plan from prepare.
    const who = (await call(me, 'GET', '/me')).body;
    expect([who.lanaDiscountWallet, who.walletCheck]).toEqual([gbpWallet.address, { ok: true, walletType: 'Lana.Discount', frozen: false }]);
    expect((await call(me, 'GET', '/sendable')).body).toMatchObject({ currency: 'GBP', wallet: gbpWallet.address, legCount: 4 });
    expect((await call(me, 'POST', '/sends/prepare', { orderIds: gbpIds })).body).toMatchObject({ currency: 'GBP', wallet: gbpWallet.address });

    // The new page lists both, as before.
    expect(who.wallets.map((w: any) => [w.currency, w.walletId])).toEqual([['EUR', wallet.address], ['GBP', gbpWallet.address]]);
  });
});

// ─── the treasury ──────────────────────────────────────────────────────────

describe("the treasury's sends no longer pay twice when a broadcast's answer is lost", () => {
  const TREASURY_PRIV = '3d'.repeat(32);
  const TREASURY_WIF = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(TREASURY_PRIV)]));
  const TREASURY = publicKeyToAddress(privateKeyToUncompressedPublicKey(TREASURY_PRIV));
  const savedWif = process.env.BUYBACK_WIF;
  beforeAll(() => { process.env.BUYBACK_WIF = TREASURY_WIF; });
  afterAll(() => { if (savedWif === undefined) delete process.env.BUYBACK_WIF; else process.env.BUYBACK_WIF = savedWif; });

  /** A purchase the treasury settles: its legs, authorised by the brain. */
  async function treasuryPurchase(ref: string): Promise<string[]> {
    const ids = await brainOrders(ref, ['merchant_commission', 'customer_cashback']);
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES (?, '', 'treasury', 'test')").run(ref);
    await brain('POST', '/api/brain/authorize-send', { transaction_refs: [ref] });
    return ids;
  }

  it('auto-send: a broadcast the network took but never answered — the next cycle builds NOTHING; the round finishes the one transaction', async () => {
    fund(TREASURY, [200n * LANA, 150n * LANA]);
    const ids = await treasuryPurchase('T9');
    const auto = createTreasuryAutoSend({
      db, sends, electrumServers: servers, wif: () => TREASURY_WIF,
      settleFinishedBatches: () => undefined, settleOrphanBoughtBatches: () => undefined, now: clock,
    });
    const before = distinctBroadcasts().length;
    chain.broadcast = 'silent';
    await auto.run();
    const mine1 = distinctBroadcasts().slice(before);
    expect(mine1).toHaveLength(1);
    const txid = txidOfRaw(mine1[0]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: txid });
    chain.raws.set(txid, mine1[0]); // the network had taken it

    // The next cycle, after the cooldown: the coins of the first are blacklisted, other coins are there —
    // and still nothing is built, because no leg of it is pending.
    skewMs = 6 * 60_000;
    chain.broadcast = 'accept';
    await auto.run();
    expect(distinctBroadcasts().slice(before)).toEqual(mine1);
    expect(sendLockHolder()).toBeNull();

    // The round sends the same bytes again and books them once they are in a block.
    await sends.round();
    mine(txid);
    expect((await sends.round()).confirmed).toEqual([txid]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txid });
    expect(outbox('lana-sent').map(r => JSON.parse(r.body_json))).toEqual([{ transaction_refs: ['T9'], tx_hash: txid, order_ids: [...ids].sort() }]);
    expect(distinctBroadcasts().slice(before)).toEqual(mine1);
  });

  it("auto-send while a treasury send is on its way: that send's coins are left out, the next purchase goes with other coins", async () => {
    // A wallet of its own, so no coin of the tests before is in the way.
    const priv = '4e'.repeat(32);
    const address = publicKeyToAddress(privateKeyToUncompressedPublicKey(priv));
    const wif = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(priv)]));
    fund(address, [200n * LANA, 150n * LANA]);
    const auto = createTreasuryAutoSend({
      db, sends, electrumServers: servers, wif: () => wif,
      settleFinishedBatches: () => undefined, settleOrphanBoughtBatches: () => undefined, now: clock,
    });
    const first = await treasuryPurchase('T11');
    await auto.run();
    const x1 = legRow(first[0]).send_txid as string;
    expect(x1).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.raws.has(x1)).toBe(true); // in the mempool; its coin is still listed as unspent

    const second = await treasuryPurchase('T12');
    await auto.run();
    const x2 = legRow(second[0]).send_txid as string;
    expect(x2).toMatch(/^[0-9a-f]{64}$/);
    expect(x2).not.toBe(x1);
    const spends = (txid: string) => decodeTx(chain.raws.get(txid) as string).inputs.map(i => `${i.prevTxid}:${i.vout}`);
    expect(spends(x2).filter(o => spends(x1).includes(o))).toEqual([]);
    for (const id of second) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: x2 });
  });

  it('a co-tenant spent the largest coin in the mempool: the refused purchase waits while that coin is blacklisted — never forced into the next send — and a new purchase goes out with other coins', async () => {
    const priv = '5f'.repeat(32);
    const address = publicKeyToAddress(privateKeyToUncompressedPublicKey(priv));
    const wif = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(priv)]));
    fund(address, [300n * LANA, 120n * LANA, 100n * LANA]);
    const largest = [...chain.raws].find(([, raw]) => decodeTx(raw).outputs.some(o => o.value === 300n * LANA && o.scriptPubKeyHex === scriptOfAddress(address)))![0];
    const c = `${largest}:0`;
    // Another service of the shared wallet spends it; electrum's listunspent keeps listing it until that is mined.
    addTx(chain, encodeTxHex({ version: 1, nTime: Math.floor(Date.now() / 1000), inputs: [{ prevTxid: largest, vout: 0, scriptSigHex: '', sequence: SEQUENCE_FINAL }], outputs: [{ value: 299n * LANA, scriptPubKeyHex: scriptOfAddress(throwawayAddress()) }], locktime: 0 }), 'mempool');
    const auto = createTreasuryAutoSend({
      db, sends, electrumServers: servers, wif: () => wif,
      settleFinishedBatches: () => undefined, settleOrphanBoughtBatches: () => undefined, now: clock,
    });
    const old = await treasuryPurchase('T13');
    await auto.run();
    const t1 = db.prepare("SELECT * FROM lana_sends WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(address) as any;
    expect(JSON.parse(t1.inputs_json)).toEqual([c]); // the largest coin first
    expect(t1).toMatchObject({ state: 'released', release_reason: 'refused' }); // -22 at every server, held by none
    for (const id of old) expect(JSON.parse(legRow(id).must_spend_json)).toEqual([c]);

    // A new purchase; the next cycle after the cooldown — the blacklist still holds the coin.
    const fresh = await treasuryPurchase('T14');
    skewMs += 3 * 60_000;
    await auto.run();
    const x = legRow(fresh[0]).send_txid as string;
    expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare('SELECT state FROM lana_sends WHERE txid = ?').get(x)).toEqual({ state: 'mempool' });
    expect(decodeTx(chain.raws.get(x) as string).inputs.map(i => `${i.prevTxid}:${i.vout}`)).not.toContain(c);
    for (const id of fresh) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: x, must_spend_json: null });
    // The refused purchase waits, its requirement as it was: nothing of it went anywhere.
    for (const id of old) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: JSON.stringify([c]) });
    expect(sendLockHolder()).toBeNull();
  });

  it('a purchase whose refused send went out of the COMPRESSED treasury address waits for that address; the next cycles, from the uncompressed one, still send the fresh purchases (recheck of 9 Oct 2026)', async () => {
    const priv = '6a'.repeat(32);
    const uncompressed = publicKeyToAddress(privateKeyToUncompressedPublicKey(priv));
    const compressed = publicKeyToAddress(privateKeyToPublicKey(priv));
    const wif = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(priv)]));
    // Only the compressed address holds coins: the auto-sender sends from it this cycle.
    fund(compressed, [200n * LANA]);
    const auto = createTreasuryAutoSend({
      db, sends, electrumServers: servers, wif: () => wif,
      settleFinishedBatches: () => undefined, settleOrphanBoughtBatches: () => undefined, now: clock,
    });
    const old = await treasuryPurchase('T15');
    chain.broadcast = 'refuse'; // -22 at every server, and held by none
    await auto.run();
    const t1 = db.prepare('SELECT * FROM lana_sends WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(compressed) as any;
    expect(t1).toMatchObject({ state: 'released', release_reason: 'refused' });
    const must = JSON.stringify(JSON.parse(t1.inputs_json));
    for (const id of old) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: must });

    // Coins come to the uncompressed address, and with them the auto-sender's choice; a new purchase arrives.
    chain.broadcast = 'accept';
    fund(uncompressed, [300n * LANA]);
    const fresh = await treasuryPurchase('T16');
    skewMs += 3 * 60_000;
    await auto.run();
    const x = legRow(fresh[0]).send_txid as string;
    expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare('SELECT wallet_id, state FROM lana_sends WHERE txid = ?').get(x)).toEqual({ wallet_id: uncompressed, state: 'mempool' });
    for (const id of fresh) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: x, must_spend_json: null });
    // The refused purchase waits for its own address, its requirement as it was: nothing of it went anywhere.
    for (const id of old) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: must });
    expect(sendLockHolder()).toBeNull();
  });

  it('the manual button: in doubt it answers 202 with the transaction, and a second click sends nothing', async () => {
    fund(TREASURY, [120n * LANA]);
    const ids = await treasuryPurchase('T10');
    const before = distinctBroadcasts().length;
    chain.broadcast = 'silent';
    const first = await asAdmin('/api/admin/send-batch-lana', { transaction_refs: ['T10'] });
    expect(first.body).toMatchObject({ status: 'in_doubt' });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'in_doubt', orders_count: 2 });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: first.body.tx_hash });
    const second = await asAdmin('/api/admin/send-batch-lana', { transaction_refs: ['T10'] });
    expect(second).toMatchObject({ status: 400, body: { error: 'No pending LANA orders found for these transactions' } });
    expect(distinctBroadcasts().slice(before).map(txidOfRaw)).toEqual([first.body.tx_hash]);
    expect(sendLockHolder()).toBeNull();
  });
});
