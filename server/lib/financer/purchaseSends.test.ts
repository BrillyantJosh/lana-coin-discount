// @vitest-environment node
/**
 * THE LANA SIDE OF A PURCHASE, AS DIRECT.FUND'S ACCOUNTING READS IT (lib/financer/purchaseSends.ts).
 *
 * Against the production DDL (roundMandateTestKit → db/financerSchema.ts), with the rows written exactly as the
 * send machine writes them (sends.ts: announce, recordTreasurySend, finish, release — the copy's last_outcome built
 * from its own COPY_OUTCOME). What is pinned: who settles each purchase, every leg as stored, the sends the legs name
 * and nothing else, a mined copy reported under the send it copies, the old legs that have only a hash, every
 * purchase asked about answered, and none of the signed bytes, coins or must-spend outpoints ever in the answer. The
 * same read over the real machine's own bookings is the last block of sends.test.ts; the route is
 * routes/fundPeer.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { createMandateTestDb } from '../roundMandateTestKit';
import { COPY_OUTCOME } from './sends';
import { parsePurchaseSendsRequest, readPurchaseSends, MAX_TX_REFS } from './purchaseSends';

const FIN = 'f1'.repeat(32);
const OTHER_FIN = 'e2'.repeat(32);
const CUSTOMER = 'c3'.repeat(32);
const NOW = Date.parse('2026-11-11T09:30:00Z');
/** What no answer may ever carry: the signed bytes, the coins, a leg's must-spend outpoints, the legs a send carried. */
const RAW = '0100000001' + 'de'.repeat(120);
const COIN = `${'ab'.repeat(32)}:1`;
const MUST = `${'cd'.repeat(32)}:0`;
const tx = (c: string) => c.repeat(64);

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createMandateTestDb();
  seq = 0;
});

const own = (ref: string, settledBy: 'financer' | 'treasury', owner: string, batch: string | null, confirmedBy = owner, at = '2026-10-20 08:00:00') =>
  db.prepare('INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ref, owner, settledBy, batch, confirmedBy, at);

interface LegSpec { type?: string; lanoshis?: number; status?: string; txHash?: string | null; sendTxid?: string | null; mustSpend?: string | null; completedAt?: string | null }
const leg = (id: string, ref: string, o: LegSpec = {}) => {
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate,
                status, tx_hash, send_txid, must_spend_json, completed_at, brain_authorized, batch_ref, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 5.25, 'EUR', 0.128, ?, ?, ?, ?, ?, 1, 'B1', ?)`)
    .run(id, ref, o.type ?? 'merchant_commission', `L${id}Wallet`, o.type === 'investor_lana' ? FIN : CUSTOMER, o.lanoshis ?? 1_004_492_188,
      o.status ?? 'pending', o.txHash ?? null, o.sendTxid ?? null, o.mustSpend ?? null, o.completedAt ?? null,
      `2026-10-20 08:00:${String(++seq).padStart(2, '0')}`);
  return id;
};

interface SendSpec { sender?: 'financer' | 'treasury'; owner?: string | null; wallet?: string; orderIds?: string[]; paying?: number; fee?: number;
  state?: string; lastOutcome?: string | null; releaseReason?: string | null; height?: number | null; confirmedAt?: string | null }
const send = (txid: string, o: SendSpec = {}) => {
  const sender = o.sender ?? 'financer';
  db.prepare(`INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis,
                state, broadcasts, last_outcome, release_reason, block_height, confirmed_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?, '2026-10-20 09:00:00', '2026-10-20 09:10:00')`)
    .run(txid, sender, o.owner === undefined ? (sender === 'financer' ? FIN : null) : o.owner, o.wallet ?? 'LFinancerWallet', RAW,
      JSON.stringify(o.orderIds ?? []), JSON.stringify([COIN]), o.paying ?? 4_018_000_000, o.fee ?? 1_000_000,
      o.state ?? 'confirmed', o.lastOutcome ?? null, o.releaseReason ?? null,
      o.height === undefined ? ((o.state ?? 'confirmed') === 'confirmed' ? 1_067_600 : null) : o.height,
      o.confirmedAt === undefined ? ((o.state ?? 'confirmed') === 'confirmed' ? '2026-10-20 09:10:00' : null) : o.confirmedAt);
};

const LEG_KEYS = ['completed_at', 'currency', 'exchange_rate', 'fiat_value', 'id', 'lana_amount', 'order_type', 'send_txid', 'status', 'to_hex', 'to_wallet', 'tx_hash'];
const SEND_KEYS = ['block_height', 'chain_txid', 'confirmed_at', 'created_at', 'fee_lanoshis', 'owner_hex', 'paying_lanoshis', 'sender', 'state', 'wallet_id'];

/** Asserts nothing private is in the answer, by name or by value. */
function expectNothingPrivate(answer: unknown) {
  const json = JSON.stringify(answer);
  for (const word of ['raw_tx', 'inputs_json', 'order_ids_json', 'must_spend', 'last_outcome', 'release_reason', 'broadcasts', 'brain_authorized', 'confirmed_by']) {
    expect(json).not.toContain(word);
  }
  for (const value of [RAW.slice(0, 40), COIN, MUST]) expect(json).not.toContain(value);
}

// ─── the request ──────────────────────────────────────────────────────────

describe('parsePurchaseSendsRequest — { tx_refs: string[1..500] }', () => {
  it('takes 1 to 500 purchase ids, each once, in the order asked', () => {
    const uuid = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
    expect(parsePurchaseSendsRequest({ tx_refs: [uuid, 'T1', uuid] })).toEqual({ ok: true, refs: [uuid, 'T1'] });
    expect(parsePurchaseSendsRequest({ tx_refs: ['x'.repeat(64)] })).toMatchObject({ ok: true });
    const full = Array.from({ length: MAX_TX_REFS }, (_, i) => `ref-${i}`);
    expect(parsePurchaseSendsRequest({ tx_refs: full })).toEqual({ ok: true, refs: full });
  });

  it('refuses anything else, and says what', () => {
    for (const body of [undefined, null, 'T1', ['T1'], {}, { tx_refs: 'T1' }, { tx_refs: [] }, { tx_refs: Array(MAX_TX_REFS + 1).fill('T1') }]) {
      expect(parsePurchaseSendsRequest(body), JSON.stringify(body)).toEqual({ ok: false, error: 'tx_refs must be an array of 1 to 500 purchase ids' });
    }
    for (const bad of [7, null, {}, '', ' T1', 'T 1', 'T1\n', 'x'.repeat(65), 'čšž']) {
      const r = parsePurchaseSendsRequest({ tx_refs: ['T0', bad] });
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, error: 'tx_refs[1] is not a purchase id (1 to 64 printable characters, no spaces)' });
    }
  });
});

// ─── the read ─────────────────────────────────────────────────────────────

describe('readPurchaseSends', () => {
  it("a financer's purchase, its four legs paid in one confirmed send: the settlement, every leg as stored, the send once", () => {
    const S = tx('a');
    own('T1', 'financer', FIN, 'B-FIN-1');
    const ids = [
      leg('o-inv', 'T1', { type: 'investor_lana', lanoshis: 10_338_867_187 }),
      leg('o-mer', 'T1', { type: 'merchant_commission', lanoshis: 1_004_492_188 }),
      leg('o-cb', 'T1', { type: 'customer_cashback', lanoshis: 3_446_289_063 }),
      leg('o-ct', 'T1', { type: 'caretaker_commission', lanoshis: 40_800_000 }),
    ];
    for (const id of ids) db.prepare("UPDATE brain_lana_orders SET status = 'sent', tx_hash = ?, send_txid = ?, completed_at = '2026-10-20 09:10:00' WHERE id = ?").run(S, S, id);
    send(S, { orderIds: ids, paying: 14_830_448_438, fee: 1_120_000 });

    const a = readPurchaseSends(db, ['T1'], NOW);
    expect(a.checked_at).toBe('2026-11-11T09:30:00.000Z');
    expect(Object.keys(a.purchases)).toEqual(['T1']);
    expect(a.purchases.T1.settlement).toEqual({ settled_by: 'financer', owner_hex: FIN, batch_ref: 'B-FIN-1', created_at: '2026-10-20 08:00:00' });
    expect(a.purchases.T1.legs.map(l => l.id)).toEqual(ids);
    expect(a.purchases.T1.legs[0]).toEqual({
      id: 'o-inv', order_type: 'investor_lana', to_hex: FIN, to_wallet: 'Lo-invWallet', lana_amount: 10_338_867_187, fiat_value: 5.25,
      currency: 'EUR', exchange_rate: 0.128, status: 'sent', tx_hash: S, send_txid: S, completed_at: '2026-10-20 09:10:00',
    });
    for (const l of a.purchases.T1.legs) expect(Object.keys(l).sort()).toEqual(LEG_KEYS);
    expect(a.sends).toEqual({
      [S]: {
        sender: 'financer', owner_hex: FIN, wallet_id: 'LFinancerWallet', paying_lanoshis: 14_830_448_438, fee_lanoshis: 1_120_000,
        state: 'confirmed', block_height: 1_067_600, confirmed_at: '2026-10-20 09:10:00', created_at: '2026-10-20 09:00:00', chain_txid: S,
      },
    });
    expect(Object.keys(a.sends[S]).sort()).toEqual(SEND_KEYS);
    expectNothingPrivate(a);
  });

  it("the treasury's purchase: settled by the treasury, its send the treasury's (no owner)", () => {
    const S = tx('b');
    own('T2', 'treasury', FIN, 'B-TRE-1', 'a0'.repeat(32));
    leg('t-mer', 'T2', { status: 'sent', txHash: S, sendTxid: S, completedAt: '2026-10-21 10:00:00' });
    send(S, { sender: 'treasury', wallet: 'LTreasuryWallet', orderIds: ['t-mer'], paying: 1_004_492_188, fee: 1_000_000 });
    const a = readPurchaseSends(db, ['T2'], NOW);
    expect(a.purchases.T2.settlement).toEqual({ settled_by: 'treasury', owner_hex: FIN, batch_ref: 'B-TRE-1', created_at: '2026-10-20 08:00:00' });
    expect(a.sends[S]).toMatchObject({ sender: 'treasury', owner_hex: null, wallet_id: 'LTreasuryWallet', state: 'confirmed', chain_txid: S });
  });

  it("a send booked under a mined COPY's id: the legs' tx_hash is the copy's, the send is reported once, under its own id, chain_txid the copy's", () => {
    const S = tx('c');
    const COPY = tx('9');
    own('T3', 'financer', FIN, 'B-FIN-2');
    const ids = [leg('c-inv', 'T3', { type: 'investor_lana' }), leg('c-mer', 'T3')];
    // As sends.ts finish() leaves them: legs 'sent' with the copy's hash, send_txid still the recorded send's.
    for (const id of ids) db.prepare("UPDATE brain_lana_orders SET status = 'sent', tx_hash = ?, send_txid = ?, completed_at = '2026-10-22 11:00:00' WHERE id = ?").run(COPY, S, id);
    send(S, { orderIds: ids, lastOutcome: `${COPY_OUTCOME}${COPY}`, height: 1_067_700 });

    const a = readPurchaseSends(db, ['T3'], NOW);
    expect(a.purchases.T3.legs.map(l => [l.tx_hash, l.send_txid])).toEqual([[COPY, S], [COPY, S]]);
    expect(Object.keys(a.sends)).toEqual([S]);
    expect(a.sends[S]).toMatchObject({ state: 'confirmed', block_height: 1_067_700, chain_txid: COPY });

    // Confirmed as a copy after it had been released ("…, after it was released"): the same.
    db.prepare('UPDATE lana_sends SET last_outcome = ? WHERE txid = ?').run(`${COPY_OUTCOME}${COPY}, after it was released`, S);
    expect(readPurchaseSends(db, ['T3'], NOW).sends[S].chain_txid).toBe(COPY);
  });

  it('on its way: legs sending, the send not confirmed — no chain_txid, even with a copy of it waiting in a mempool', () => {
    const S = tx('d');
    own('T4', 'financer', FIN, 'B-FIN-3');
    leg('w-mer', 'T4', { status: 'sending', sendTxid: S });
    send(S, { state: 'mempool', lastOutcome: `copy ${tx('8')} on the chain (mempool): booked under its id once proven` });
    const a = readPurchaseSends(db, ['T4'], NOW);
    expect(a.purchases.T4.legs[0]).toMatchObject({ status: 'sending', tx_hash: null, send_txid: S, completed_at: null });
    expect(a.sends[S]).toMatchObject({ state: 'mempool', block_height: null, confirmed_at: null, chain_txid: null });
    send(tx('e'), { state: 'announced' });
    db.prepare('UPDATE brain_lana_orders SET send_txid = ? WHERE id = ?').run(tx('e'), 'w-mer');
    expect(readPurchaseSends(db, ['T4'], NOW).sends).toEqual({ [tx('e')]: expect.objectContaining({ state: 'announced', chain_txid: null }) });
  });

  it('a leg the old auto-send paid (a hash, no recorded send) and a leg released from a refused send (no send named): reported as stored, no send for either', () => {
    const OLD = tx('f');
    const REFUSED = tx('1');
    own('T5', 'treasury', '', null, 'migration');
    leg('old-mer', 'T5', { status: 'sent', txHash: OLD, completedAt: '2026-09-30 12:00:00' });
    leg('old-cb', 'T5', { status: 'pending', mustSpend: JSON.stringify([MUST]) });
    send(REFUSED, { sender: 'treasury', state: 'released', releaseReason: 'refused', orderIds: ['old-cb'] });
    const a = readPurchaseSends(db, ['T5'], NOW);
    expect(a.purchases.T5.settlement).toEqual({ settled_by: 'treasury', owner_hex: '', batch_ref: null, created_at: '2026-10-20 08:00:00' });
    expect(a.purchases.T5.legs.map(l => [l.id, l.status, l.tx_hash, l.send_txid])).toEqual([['old-mer', 'sent', OLD, null], ['old-cb', 'pending', null, null]]);
    expect(a.sends).toEqual({});
    expectNothingPrivate(a);
  });

  it('every purchase asked about is answered: one nobody confirmed (legs, no settlement), one never heard of (nothing) — and only those asked', () => {
    leg('u-mer', 'T6');
    own('T7', 'financer', OTHER_FIN, 'B-X');
    leg('x-mer', 'T7', { status: 'sent', txHash: tx('2'), sendTxid: tx('2') });
    send(tx('2'), { owner: OTHER_FIN });
    const a = readPurchaseSends(db, ['T6', 'never-seen'], NOW);
    expect(Object.keys(a.purchases)).toEqual(['T6', 'never-seen']);
    expect(a.purchases.T6).toEqual({ settlement: null, legs: [expect.objectContaining({ id: 'u-mer', status: 'pending', send_txid: null })] });
    expect(a.purchases['never-seen']).toEqual({ settlement: null, legs: [] });
    expect(a.sends).toEqual({});
  });

  it("a send that carries legs of other purchases too: its whole amount and fee, and only the asked purchase's legs", () => {
    const S = tx('3');
    own('T8', 'financer', FIN, 'B-FIN-4');
    own('T9', 'financer', FIN, 'B-FIN-4');
    leg('a-mer', 'T8', { status: 'sent', txHash: S, sendTxid: S });
    leg('b-mer', 'T9', { status: 'sent', txHash: S, sendTxid: S });
    send(S, { orderIds: ['a-mer', 'b-mer'], paying: 2_008_984_376, fee: 1_060_000 });
    const a = readPurchaseSends(db, ['T8'], NOW);
    expect(a.purchases.T8.legs.map(l => l.id)).toEqual(['a-mer']);
    expect(a.sends[S]).toMatchObject({ paying_lanoshis: 2_008_984_376, fee_lanoshis: 1_060_000 });
    expect(JSON.stringify(a)).not.toContain('b-mer');
  });

  it('500 purchases whose legs name 1,000 sends: every one read (the lists go to SQLite in parts)', () => {
    const refs: string[] = [];
    for (let i = 0; i < MAX_TX_REFS; i++) {
      const ref = `P${i}`;
      refs.push(ref);
      own(ref, 'financer', FIN, 'B-BIG');
      const a = i.toString(16).padStart(64, '0');
      const b = (i + 1000).toString(16).padStart(64, '0');
      leg(`${ref}-1`, ref, { status: 'sent', txHash: a, sendTxid: a });
      leg(`${ref}-2`, ref, { status: 'sent', txHash: b, sendTxid: b });
      send(a);
      send(b);
    }
    const a = readPurchaseSends(db, refs, NOW);
    expect(Object.keys(a.purchases)).toHaveLength(500);
    expect(Object.values(a.purchases).every(p => p.settlement !== null && p.legs.length === 2)).toBe(true);
    expect(Object.keys(a.sends)).toHaveLength(1000);
  });

  it('a purchase id like "__proto__" is a key like any other, and survives JSON', () => {
    own('__proto__', 'financer', FIN, 'B-P');
    leg('p-mer', '__proto__');
    const a = JSON.parse(JSON.stringify(readPurchaseSends(db, ['__proto__', 'constructor'], NOW)));
    expect(Object.keys(a.purchases)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(a.purchases, '__proto__')?.value).toMatchObject({ settlement: { settled_by: 'financer' }, legs: [{ id: 'p-mer' }] });
    expect(a.purchases.constructor).toEqual({ settlement: null, legs: [] });
  });

  it('writes nothing', () => {
    own('T1', 'financer', FIN, 'B1');
    leg('o-1', 'T1', { status: 'sent', txHash: tx('a'), sendTxid: tx('a') });
    send(tx('a'));
    const snapshot = () => ['purchase_settlement', 'brain_lana_orders', 'lana_sends', 'brain_callback_outbox'].map(t => db.prepare(`SELECT * FROM ${t}`).all());
    const before = JSON.stringify(snapshot());
    readPurchaseSends(db, ['T1', 'T2'], NOW);
    expect(JSON.stringify(snapshot())).toBe(before);
  });
});
