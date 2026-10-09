// @vitest-environment node
/**
 * THE SEND MACHINE (lib/financer/sends.ts), one rule at a time, against a chain
 * this test scripts: what each broadcast answer leaves behind, when a leg may go
 * back to 'pending' and when it may not, what a released leg demands of its next
 * send, and that a leg is moved into a send only exactly as it was checked.
 *
 * The transactions are real: signed with the shared library the browser signs
 * with (shared/lana-tx planPayout / signPayoutTx, the brain's leg amounts at a
 * step of one lanoshi), checked by the server with checkPayoutTx. Only the
 * network (PayoutChain) and the two-server proof (PaymentReader) are stand-ins,
 * so every outcome — accepted, known, refused finally or not, no answer, a
 * thrown socket — can be asked for exactly. The end-to-end run over fake
 * Electrum servers, Direct.Fund and the brain is routes/financerSends.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('../roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { createMandateTestDb } from '../roundMandateTestKit';
import {
  createSends, judgeMustSpend, nextMustSpend, sendsHealth, unmetMustSpend, mergedAllocations, isCopyOf, ownerMismatchPurchases, proofWalletOf, financerCurrencies,
  noteUnownedMismatch, forgetUnownedMismatches,
  REFUSALS_TO_RELEASE, REBROADCAST_FOR_S, MAX_ORDER_IDS, OWNER_MISMATCH_LISTED, MIN_SPENDER_DEPTH, type PrepareAnswer, type SendableAnswer, type Sends, type SendsDeps,
} from './sends';
import type { BroadcastOutcome, ListedOutput, PayoutChain } from './payoutChain';
import type { PaymentRead, PaymentReader } from './chainPayment';
import type { FinancerWalletCheck } from './registrarWallet';
import { parseFinancer } from './dfClient';
import { tryAcquireSendLock, releaseSendLock } from '../sendLock';
import { LANA, parentPaying, throwawayAddress, throwawayWallet, type ThrowawayWallet } from '../../shared/lana-tx/fixtures/wallets';
import { verifiedCoins, type ListedCoin } from '../../shared/lana-tx/select';
import { planPayout, signPayoutTx } from '../../shared/lana-tx/payout';
import { LEG_LANOSHI_STEP, LANOSHI_STEP } from '../../shared/lana-tx/payments';
import { outpointKey, txidOfRaw, decodeTx, encodeTxHex, SEQUENCE_FINAL } from '../../shared/lana-tx/codec';
import { p2pkScriptHex, scriptOfAddress } from '../../shared/lana-tx/address';

// Signing with two libraries' checks, many times over.
vi.setConfig({ testTimeout: 60_000 });

const OWNER = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
/** Real leg amounts of brain_lana_orders (8 Oct 2026), in lanoshis — not whole thousands. */
const AMOUNT = { investor: 10_338_867_187, merchant: 1_004_492_188, cashback: 3_446_289_063, caretaker: 40_800_000 };

// ─── a chain this test scripts ────────────────────────────────────────────

function scriptedChain() {
  const coins = new Map<string, ListedOutput>();
  /** Whose each coin is (fund); a coin set directly has none and is listed for every wallet. */
  const owners = new Map<string, string>();
  const raws = new Map<string, string>();
  /** Held in every wallet's history. */
  const history = new Map<string, number>();
  /** Held in one wallet's history only. */
  const histories = new Map<string, Map<string, number>>();
  const walletHistory = (address: string) => {
    if (!histories.has(address)) histories.set(address, new Map());
    return histories.get(address) as Map<string, number>;
  };
  const answers: Array<BroadcastOutcome | 'throw'> = [];
  const broadcasts: string[] = [];
  const state = { unconfirmed: 0n, onBroadcast: null as null | ((raw: string) => void), down: false };
  const chain: PayoutChain = {
    async state(address) {
      if (state.down) return null;
      const unspent = [...coins].filter(([k]) => (owners.get(k) ?? address) === address).map(([, c]) => c);
      return {
        server: 'scripted',
        balance: { confirmed: unspent.reduce((s, c) => s + c.value, 0n), unconfirmed: state.unconfirmed },
        unspent,
        history: new Map([...history, ...(histories.get(address) ?? [])]),
      };
    },
    async rawTxs(ids) {
      return new Map(ids.filter(id => raws.has(id)).map(id => [id, raws.get(id) as string]));
    },
    async broadcast(raw) {
      broadcasts.push(raw);
      state.onBroadcast?.(raw);
      const next = answers.shift() ?? { kind: 'accepted', server: 'scripted:1' };
      if (next === 'throw') throw new Error('socket hang up');
      return next;
    },
  };
  /** Confirmed coins of `address`, each its own made-up parent (in the wallet's history at the coin's height). */
  const fund = (address: string, values: bigint[], nTime: number): string[] => values.map(v => {
    const p = parentPaying(address, [v], nTime);
    raws.set(p.txid, p.raw);
    coins.set(outpointKey(p.txid, 0), { txid: p.txid, vout: 0, value: v, height: 1_067_000 });
    owners.set(outpointKey(p.txid, 0), address);
    walletHistory(address).set(p.txid, 1_067_000);
    return outpointKey(p.txid, 0);
  });
  /**
   * A transaction of `wallet` on the chain: in its history at `height` (0: the mempool), its bytes there to be read,
   * and — in a block — the coins it spends gone from the confirmed ones. Its id.
   */
  const onChain = (raw: string, wallet: string, height: number): string => {
    const txid = txidOfRaw(raw);
    raws.set(txid, raw);
    walletHistory(wallet).set(txid, height);
    if (height > 0) for (const i of decodeTx(raw).inputs) coins.delete(outpointKey(i.prevTxid, i.vout));
    return txid;
  };
  return { chain, coins, raws, history, walletHistory, answers, broadcasts, state, fund, onChain };
}

/**
 * The same payment under another push of the same signature (OP_PUSHDATA1 — which a 2013-era node relays, from before
 * the minimal-push rule): no key needed, another txid, the very same coins, outputs, nTime and locktime.
 */
function malleated(raw: string): string {
  const tx = decodeTx(raw);
  return encodeTxHex({ ...tx, inputs: tx.inputs.map((i, n) => (n === 0 ? { ...i, scriptSigHex: `4c${i.scriptSigHex}` } : i)) });
}

/** Another transaction spending these coins (not signed: nothing here checks a signature), paying `to`. */
function spending(outpoints: string[], to = throwawayAddress(), nTime = 1_791_300_000): string {
  return encodeTxHex({
    version: 1,
    nTime,
    inputs: outpoints.map(o => ({ prevTxid: o.slice(0, 64), vout: Number(o.slice(65)), scriptSigHex: '', sequence: SEQUENCE_FINAL })),
    outputs: [{ value: LANA, scriptPubKeyHex: scriptOfAddress(to) }],
    locktime: 0,
  });
}

/**
 * A coinstake of the LANA desktop wallet spending these coins (not signed: nothing here checks a signature): an empty
 * first output, then the staker's PUBLIC KEY (<public key> OP_CHECKSIG) — no P2PKH output at all.
 */
function coinstake(outpoints: string[], staker: ThrowawayWallet, nTime = 1_791_300_000): string {
  return encodeTxHex({
    version: 1,
    nTime,
    inputs: outpoints.map(o => ({ prevTxid: o.slice(0, 64), vout: Number(o.slice(65)), scriptSigHex: '', sequence: SEQUENCE_FINAL })),
    outputs: [{ value: 0n, scriptPubKeyHex: '' }, { value: 301n * LANA, scriptPubKeyHex: p2pkScriptHex(staker.publicKey) }],
    locktime: 0,
  });
}

/** In a block by the two-server proof — deep enough to be proof of a spender (MIN_SPENDER_DEPTH), unless told otherwise. */
const inBlock = (height: number, confirmations = MIN_SPENDER_DEPTH): PaymentRead => ({ state: 'confirmed', lanoshis: 1n, height, confirmations, nTime: 1, blockTime: 1 });

function scriptedProof() {
  const reads = new Map<string, PaymentRead>();
  const asked: string[] = [];
  /** Each question with the wallet it was asked for. */
  const askedWith: Array<[string, string]> = [];
  const payments: PaymentReader = {
    async read(txid, wallet) {
      asked.push(txid);
      askedWith.push([txid, wallet]);
      return reads.get(txid) ?? { state: 'unknown' };
    },
  };
  return { payments, reads, asked, askedWith };
}

// ─── the world of one test ────────────────────────────────────────────────

let db: Database.Database;
let net: ReturnType<typeof scriptedChain>;
let proof: ReturnType<typeof scriptedProof>;
let clock: number;
let key: ThrowawayWallet;
let registrar: (wallet: string, owner: string) => FinancerWalletCheck;
let dfWallet: string | null;
/** Direct.Fund's wallets per currency; null: a Direct.Fund before them (the field absent). */
let dfWallets: Record<string, { walletId: string; setAt: string | null }> | null;
let sends: Sends;
const logs: string[] = [];
const wallets = { investor: '', merchant: '', cashback: '', caretaker: '' };
let seq = 0;

const nowSec = () => Math.floor(clock / 1000);
const make = (over: Partial<SendsDeps> = {}): Sends => createSends({
  db,
  chain: net.chain,
  payments: proof.payments,
  // Direct.Fund before wallets per currency (no `wallets`): its one wallet for every currency — or, set, per currency.
  financer: async hex => parseFinancer({ hexId: hex, isInvestor: true, lanaDiscountWallet: dfWallet, lanaDiscountWalletSetAt: null, ...(dfWallets ? { wallets: dfWallets } : {}) }, hex),
  checkWallet: async (w, o) => registrar(w, o),
  now: () => clock,
  log: line => void logs.push(line),
  ...over,
});

beforeEach(() => {
  db = createMandateTestDb();
  net = scriptedChain();
  proof = scriptedProof();
  clock = Date.now();
  key = throwawayWallet(true);
  dfWallet = key.address;
  dfWallets = null;
  registrar = () => ({ ok: true, walletType: 'Lana.Discount', frozen: false });
  for (const k of Object.keys(wallets) as Array<keyof typeof wallets>) wallets[k] = throwawayAddress();
  logs.length = 0;
  sends = make();
});

const own = (ref: string, owner = OWNER, settledBy: 'financer' | 'treasury' = 'financer') =>
  db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by) VALUES (?, ?, ?, 'B1', ?)").run(ref, owner, settledBy, owner);
const leg = (ref: string, type: keyof typeof wallets, o: { id?: string; lanoshis?: number; status?: string; auth?: 0 | 1; wallet?: string; currency?: string } = {}) => {
  const id = o.id ?? `${ref}-${type}`;
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized, batch_ref, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, 'B1', ?)`)
    .run(id, ref, type === 'investor' ? 'investor_lana' : `${type}_commission`, o.wallet ?? wallets[type], type === 'investor' ? OWNER : 'c3'.repeat(32),
      o.lanoshis ?? AMOUNT[type], o.currency ?? 'EUR', o.status ?? 'pending', o.auth ?? 1, `2026-10-08 10:00:${String(++seq).padStart(2, '0')}`);
  return id;
};
/** A purchase of the financer's with its four legs (in EUR unless said), confirmed and authorised; the leg ids. */
const purchase = (ref = 'T1', owner = OWNER, currency = 'EUR'): string[] => {
  own(ref, owner);
  return (['investor', 'merchant', 'cashback', 'caretaker'] as const).map(t => leg(ref, t, { currency }));
};
const legRow = (id: string) => db.prepare('SELECT * FROM brain_lana_orders WHERE id = ?').get(id) as any;
const sendRow = (txid: string) => db.prepare('SELECT * FROM lana_sends WHERE txid = ?').get(txid) as any;
const outbox = () => db.prepare('SELECT kind, dedupe_key, body_json FROM brain_callback_outbox ORDER BY id').all() as any[];

/** Sign what a prepare answered, as the browser does — or from exactly `only` of the wallet's coins; with `signer`'s key. */
async function sign(prepared: PrepareAnswer, only?: string[], signer: ThrowawayWallet = key): Promise<string> {
  const listed: ListedCoin[] = only
    ? only.map(k => {
      const c = net.coins.get(k) as ListedOutput;
      return { txid: c.txid, vout: c.vout, value: c.value, height: c.height, rawTx: net.raws.get(c.txid) as string };
    })
    : prepared.coins.map(c => ({ txid: c.txid, vout: c.vout, value: BigInt(c.value), height: c.height, rawTx: c.rawTx }));
  const coins = verifiedCoins(listed, prepared.wallet);
  if (coins.ok === false) throw new Error(coins.problems.join('; '));
  const plan = planPayout({ from: prepared.wallet, coins: coins.coins, allocations: prepared.allocations.map(a => ({ address: a.wallet, lanoshis: BigInt(a.lanoshis) })), nowSec: prepared.nowSec, step: LEG_LANOSHI_STEP });
  if (plan.ok === false) throw new Error(`${plan.code}: ${plan.detail}`);
  const signed = await signPayoutTx({ from: prepared.wallet, pay: plan.pay, coins: plan.coins, nowSec: prepared.nowSec, privateKey: signer.privateKey, compressed: signer.compressed });
  if (signed.ok === false) throw new Error(`${signed.code}: ${signed.detail}`);
  return signed.rawTx;
}

/** What GET /sendable answers (one currency's, or the only one's), or the refusal thrown. */
async function sendableNow(currency?: string): Promise<SendableAnswer> {
  const r = await sends.sendable(OWNER, currency);
  if (r.ok === false) throw new Error(`${r.code}: ${r.error}`);
  return r.body;
}

async function prepared(ids: string[], s = sends): Promise<PrepareAnswer> {
  const r = await s.prepare(OWNER, ids);
  if (r.ok === false) throw new Error(`${r.code}: ${r.error}`);
  return r.body;
}

/** Fund the wallet, prepare, sign, announce: the send as announce answered it. */
async function announced(ids: string[], fund: bigint[] = [300n * LANA, 50n * LANA]) {
  if (fund.length) net.fund(key.address, fund, nowSec() - 86_400);
  const p = await prepared(ids);
  const rawTx = await sign(p);
  const r = await sends.announce(OWNER, { orderIds: ids, rawTx });
  if (r.ok === false) throw new Error(`${r.code}: ${r.error}`);
  return { ...r, rawTx, txid: txidOfRaw(rawTx), prepared: p };
}

const minutes = (n: number) => { clock += n * 60_000; };

// ─── announce: what each answer of the network leaves ─────────────────────

describe('announce — recorded first, then broadcast, and what the answer leaves', () => {
  it('the send and its legs are written BEFORE the bytes go out; accepted → mempool, legs sending', async () => {
    const ids = purchase();
    let atBroadcast: { send: any; legs: string[] } | null = null;
    net.state.onBroadcast = raw => {
      atBroadcast = { send: sendRow(txidOfRaw(raw)), legs: ids.map(id => legRow(id).status) };
    };
    const r = await announced(ids);
    expect(atBroadcast!.send).toMatchObject({ state: 'announced', broadcasts: 0, sender: 'financer', owner_hex: OWNER, wallet_id: key.address });
    expect(atBroadcast!.legs).toEqual(['sending', 'sending', 'sending', 'sending']);
    expect(r.already).toBe(false);
    expect(r.send).toMatchObject({ state: 'mempool', broadcasts: 1, sender: 'financer', orderIds: ids, transactionRefs: ['T1'] });
    const row = sendRow(r.txid);
    expect(JSON.parse(row.order_ids_json)).toEqual(ids);
    expect(JSON.parse(row.inputs_json)).toEqual(decodeTx(r.rawTx).inputs.map(i => outpointKey(i.prevTxid, i.vout)));
    expect(row.raw_tx).toBe(r.rawTx);
    expect(row.paying_lanoshis).toBe(Object.values(AMOUNT).reduce((s, v) => s + v, 0));
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: r.txid, tx_hash: null });
    expect(net.broadcasts).toEqual([r.rawTx]);
    expect(outbox()).toEqual([]); // the brain hears of it only once it is in a block
  });

  it('known (refused in words, but a server holds it) → mempool', async () => {
    net.answers.push({ kind: 'known', server: 's:2', detail: "{u'code': -22}" });
    const r = await announced(purchase());
    expect(sendRow(r.txid).state).toBe('mempool');
  });

  it('refused FINALLY at its first broadcast → released at once: legs pending, and they must spend one of its coins next time', async () => {
    const ids = purchase();
    net.answers.push({ kind: 'refused', detail: "{u'message': u'TX rejected', u'code': -22}", final: true });
    const r = await announced(ids);
    const inputs = JSON.parse(sendRow(r.txid).inputs_json);
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'refused', broadcasts: 1 });
    expect(r.send.state).toBe('released');
    for (const id of ids) {
      expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
      expect(JSON.parse(legRow(id).must_spend_json)).toEqual(inputs);
    }
  });

  for (const [what, answer] of [
    ['refused while a server was silent (not final)', { kind: 'refused', detail: 'TX rejected', final: false }],
    ['no answer at all (unknown)', { kind: 'unknown', detail: 'no answer' }],
    ['a thrown socket', 'throw'],
  ] as Array<[string, BroadcastOutcome | 'throw']>) {
    it(`${what} → kept as announced, in doubt: legs stay sending, nothing released`, async () => {
      const ids = purchase();
      net.answers.push(answer);
      const r = await announced(ids);
      expect(sendRow(r.txid)).toMatchObject({ state: 'announced', broadcasts: 1, release_reason: null });
      for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: r.txid, must_spend_json: null });
    });
  }

  it('the same bytes again answer with the send as it stands — nothing done twice, nothing broadcast again', async () => {
    const ids = purchase();
    net.answers.push({ kind: 'unknown', detail: 'timeout' });
    const r = await announced(ids);
    const again = await sends.announce(OWNER, { orderIds: [...ids].reverse(), rawTx: r.rawTx });
    expect(again).toMatchObject({ ok: true, already: true, send: { txid: r.txid, state: 'announced' } });
    expect(net.broadcasts).toHaveLength(1);
    // Another financer, or the same bytes for other legs: a conflict, never a second send.
    expect(await sends.announce(OTHER, { orderIds: ids, rawTx: r.rawTx })).toMatchObject({ ok: false, status: 409, code: 'CONFLICT' });
    expect(await sends.announce(OWNER, { orderIds: ids.slice(1), rawTx: r.rawTx })).toMatchObject({ ok: false, status: 409, code: 'CONFLICT' });
  });

  it('while a send of the wallet is on its way, no second one is prepared', async () => {
    const ids = purchase();
    await announced(ids);
    const later = purchase('T2');
    expect(await sends.prepare(OWNER, later)).toMatchObject({ ok: false, status: 409, code: 'SEND_IN_FLIGHT' });
  });
});

// ─── exactly one row per leg, in one transaction ──────────────────────────

describe('a leg moves into a send only exactly as it was checked', () => {
  for (const [what, change] of [
    ['cancelled', (id: string) => db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE id = ?").run(id)],
    ['redirected to another wallet', (id: string) => db.prepare('UPDATE brain_lana_orders SET to_wallet = ? WHERE id = ?').run(throwawayAddress(), id)],
    ['given another amount', (id: string) => db.prepare('UPDATE brain_lana_orders SET lana_amount = lana_amount + 1 WHERE id = ?').run(id)],
  ] as Array<[string, (id: string) => void]>) {
    it(`a leg ${what} while the announce waits on the Registrar: LEGS_CHANGED, nothing stored, nothing broadcast`, async () => {
      const ids = purchase();
      net.fund(key.address, [300n * LANA], nowSec() - 86_400);
      const rawTx = await sign(await prepared(ids));
      // The announce reads the legs, then asks the Registrar (and the chain) — the leg changes in that gap.
      let asked = 0;
      registrar = () => {
        if (++asked === 1) change(ids[2]);
        return { ok: true, walletType: 'Lana.Discount', frozen: false };
      };
      const r = await sends.announce(OWNER, { orderIds: ids, rawTx });
      expect(r).toMatchObject({ ok: false, status: 409, code: 'LEGS_CHANGED', orderIds: [ids[2]] });
      expect(db.prepare('SELECT COUNT(*) c FROM lana_sends').get()).toEqual({ c: 0 });
      // Rolled back whole: the legs before the changed one are pending again, in no send.
      for (const id of [ids[0], ids[1], ids[3]]) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
      expect(net.broadcasts).toEqual([]);
    });
  }

  it('a leg redirected between prepare and announce: the outputs no longer match the legs (LEGS_CHANGED)', async () => {
    const ids = purchase();
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    const rawTx = await sign(await prepared(ids));
    db.prepare('UPDATE brain_lana_orders SET to_wallet = ? WHERE id = ?').run(throwawayAddress(), ids[1]);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx })).toMatchObject({ ok: false, status: 409, code: 'LEGS_CHANGED' });
    expect(net.broadcasts).toEqual([]);
  });

  it("legs of another financer, of the treasury, not authorised, or only part of a purchase are refused", async () => {
    const mine = purchase();
    const theirs = purchase('T2', OTHER);
    own('T3', OWNER, 'treasury');
    const treasury = leg('T3', 'merchant');
    own('T4');
    const unauth = leg('T4', 'merchant', { auth: 0 });
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    expect(await sends.prepare(OWNER, theirs)).toMatchObject({ status: 409, code: 'NOT_SENDABLE', orderIds: theirs });
    expect(await sends.prepare(OWNER, [treasury])).toMatchObject({ status: 409, code: 'NOT_SENDABLE' });
    expect(await sends.prepare(OWNER, [unauth])).toMatchObject({ status: 409, code: 'NOT_SENDABLE' });
    expect(await sends.prepare(OWNER, mine.slice(0, 3))).toMatchObject({ status: 409, code: 'PARTIAL_PURCHASE', orderIds: [mine[3]] });
    expect(await sends.prepare(OWNER, [mine[0], mine[0]])).toMatchObject({ status: 400, code: 'BAD_ORDER_IDS' });
    expect(await sends.prepare(OWNER, [])).toMatchObject({ status: 400, code: 'BAD_ORDER_IDS' });
  });
});

// ─── the step: the brain's legs to the lanoshi ───────────────────────────

describe("the brain's legs, to the lanoshi", () => {
  it('real leg amounts (not whole thousands) go out exactly: the outputs ARE the legs', async () => {
    const ids = purchase();
    const r = await announced(ids);
    const outs = decodeTx(r.rawTx).outputs.map(o => o.value);
    expect(outs.slice(0, 4)).toEqual([AMOUNT.investor, AMOUNT.merchant, AMOUNT.cashback, AMOUNT.caretaker].map(BigInt));
    expect(AMOUNT.merchant % Number(LANOSHI_STEP)).not.toBe(0); // Krog Menjave's step would have refused them
  });

  it('two legs to one wallet are one output, their sum, where that wallet first appears', () => {
    const w = throwawayAddress();
    expect(mergedAllocations([
      { id: 'a', to_wallet: w, lana_amount: 1 }, { id: 'b', to_wallet: 'X', lana_amount: 5 }, { id: 'c', to_wallet: w, lana_amount: 2 },
    ])).toEqual([{ wallet: w, lanoshis: '3', orderIds: ['a', 'c'] }, { wallet: 'X', lanoshis: '5', orderIds: ['b'] }]);
  });
});

// ─── the round ────────────────────────────────────────────────────────────

describe('the round', () => {
  it('confirmed by the two-server proof → legs sent with the hash, lana-sent with exactly those legs, the batch closed', async () => {
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B1', ?, 20, 'EUR', 'received', 'financer')").run(OWNER);
    const ids = purchase();
    const r = await announced(ids);
    proof.reads.set(r.txid, { state: 'confirmed', lanoshis: 1n, height: 1_067_600, confirmations: 1, nTime: nowSec(), blockTime: nowSec() });
    const done = await sends.round();
    expect(done.confirmed).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'confirmed', block_height: 1_067_600 });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: r.txid, send_txid: r.txid, must_spend_json: null });
    expect(legRow(ids[0]).completed_at).toBeTruthy();
    expect(outbox()).toEqual([{ kind: 'lana-sent', dedupe_key: `lana-sent:${r.txid}`, body_json: JSON.stringify({ transaction_refs: ['T1'], tx_hash: r.txid, order_ids: ids }) }]);
    expect((db.prepare("SELECT status FROM incoming_batches WHERE batch_ref = 'B1'").get() as any).status).toBe('lana_sent');
    // Asked again: nothing more happens.
    await sends.round();
    expect(outbox()).toHaveLength(1);
  });

  it('not confirmed: the SAME bytes again, only when due — after 2, 4, 8, 16, 30, 30 minutes', async () => {
    const r = await announced(purchase());
    const gaps: number[] = [];
    let last = clock;
    for (let m = 1; m <= 100; m++) {
      minutes(1);
      const before = net.broadcasts.length;
      await sends.round();
      if (net.broadcasts.length > before) {
        gaps.push(Math.round((clock - last) / 60_000));
        last = clock;
      }
    }
    expect(gaps).toEqual([2, 4, 8, 16, 30, 30]);
    expect(new Set(net.broadcasts)).toEqual(new Set([r.rawTx]));
  });

  it(`a final refusal after an unanswered first broadcast releases only after ${REFUSALS_TO_RELEASE} in a row`, async () => {
    const ids = purchase();
    net.answers.push({ kind: 'unknown', detail: 'timeout' });
    const r = await announced(ids);
    const final: BroadcastOutcome = { kind: 'refused', detail: 'TX rejected', final: true };
    for (let i = 1; i < REFUSALS_TO_RELEASE; i++) {
      net.answers.push(final);
      minutes(31);
      await sends.round();
      expect(sendRow(r.txid).state).toBe('announced');
      expect(sendRow(r.txid).last_outcome).toMatch(new RegExp(`^refused-final#${i}:`));
    }
    // One answer in between that is not a final refusal starts the count again.
    net.answers.push({ kind: 'unknown', detail: 'timeout' });
    minutes(31);
    await sends.round();
    for (let i = 1; i <= REFUSALS_TO_RELEASE; i++) {
      net.answers.push(final);
      minutes(31);
      await sends.round();
    }
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'refused' });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
  });

  it('a send no server knows whose coin went in ANOTHER transaction — found in the history, proven in a block, no copy of it → released (input_spent), no new must-spend; the spender unknown or unproven → kept', async () => {
    const ids = purchase();
    const r = await announced(ids);
    const earlier = JSON.stringify(['ee'.repeat(32) + ':0']);
    db.prepare('UPDATE brain_lana_orders SET must_spend_json = ? WHERE id = ?').run(earlier, ids[0]);
    proof.reads.set(r.txid, { state: 'not_found' });
    // Still listed: nothing proven — kept.
    minutes(3);
    await sends.round();
    expect(sendRow(r.txid).state).toBe('mempool');
    // Gone from the confirmed coins, but nothing in the wallet's history spends it: who spent it is not known — kept.
    const coin = JSON.parse(sendRow(r.txid).inputs_json)[0];
    net.coins.delete(coin);
    minutes(3);
    expect((await sends.round()).released).toEqual([]);
    expect(sendRow(r.txid).state).toBe('mempool');
    // The spender in the wallet's history "in a block" — one server's word, no two-server proof: kept.
    const other = net.onChain(spending([coin]), key.address, 1_067_800);
    minutes(3);
    expect((await sends.round()).released).toEqual([]);
    expect(legRow(ids[1]).status).toBe('sending');
    // Proven in a block, and no copy of this send: it can never confirm — released.
    proof.reads.set(other, inBlock(1_067_800));
    minutes(3);
    const res = await sends.round();
    expect(res.released).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'input_spent' });
    expect(sendRow(r.txid).last_outcome).toBe(`spent elsewhere: ${coin} by ${other}`);
    expect(legRow(ids[0])).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: earlier }); // an earlier set stays
    expect(legRow(ids[1])).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: null });
  });

  it("a COPY of a send (the same payment under other signatures) mined instead of it: booked under the copy's id — never released, never paid twice (review of 8 Oct 2026)", async () => {
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B1', ?, 20, 'EUR', 'received', 'financer')").run(OWNER);
    const ids = purchase();
    const r = await announced(ids);
    const copy = malleated(r.rawTx);
    const copyId = txidOfRaw(copy);
    expect(copyId).not.toBe(r.txid);
    expect(isCopyOf(copy, r.rawTx)).toBe(true);
    expect(isCopyOf(spending(JSON.parse(sendRow(r.txid).inputs_json)), r.rawTx)).toBe(false);
    // The copy is in a block: no server knows the send's own id, its coins are gone, the wallet's history holds the copy.
    proof.reads.set(r.txid, { state: 'not_found' });
    net.onChain(copy, key.address, 1_067_700);
    proof.reads.set(copyId, inBlock(1_067_700));
    minutes(3);
    const res = await sends.round();
    expect(res.released).toEqual([]);
    expect(res.confirmed).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'confirmed', block_height: 1_067_700, release_reason: null, last_outcome: `confirmed as copy ${copyId}` });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: copyId, send_txid: r.txid, must_spend_json: null });
    expect(outbox()).toEqual([{ kind: 'lana-sent', dedupe_key: `lana-sent:${copyId}`, body_json: JSON.stringify({ transaction_refs: ['T1'], tx_hash: copyId, order_ids: ids }) }]);
    expect((db.prepare("SELECT status, lana_tx_hash FROM incoming_batches WHERE batch_ref = 'B1'").get() as any)).toEqual({ status: 'lana_sent', lana_tx_hash: copyId });
    expect(sends.view(r.txid)).toMatchObject({ state: 'confirmed', chainTxid: copyId });
    // Nothing of it can go again.
    expect((await sendableNow()).purchases).toEqual([]);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'NOT_SENDABLE' });
  });

  it("a copy waiting in the mempool: the send's own bytes are not sent again beside it (no refusal counts toward a release); booked once the copy is proven in a block", async () => {
    const ids = purchase();
    const r = await announced(ids);
    const copy = malleated(r.rawTx);
    const copyId = net.onChain(copy, key.address, 0);
    proof.reads.set(r.txid, { state: 'not_found' });
    const before = net.broadcasts.length;
    minutes(3);
    const res = await sends.round();
    expect(res.held).toEqual([r.txid]);
    expect(net.broadcasts.length).toBe(before);
    expect(sendRow(r.txid)).toMatchObject({ state: 'mempool', last_outcome: `copy ${copyId} on the chain (mempool): booked under its id once proven` });
    expect(legRow(ids[0]).status).toBe('sending');
    // Mined; not proven yet (one server's word): still waiting. Proven: booked.
    net.onChain(copy, key.address, 1_067_701);
    minutes(3);
    expect((await sends.round()).confirmed).toEqual([]);
    expect(sendRow(r.txid).state).toBe('mempool');
    proof.reads.set(copyId, inBlock(1_067_701));
    minutes(3);
    expect((await sends.round()).confirmed).toEqual([r.txid]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: copyId });
    expect(net.broadcasts.length).toBe(before);
  });

  it('one server silent, every other one said it does not know the send (notFoundByAllReachable): the proof that its coin went elsewhere is looked at — a plain "unknown" never', async () => {
    const ids = purchase();
    const r = await announced(ids);
    const coin = JSON.parse(sendRow(r.txid).inputs_json)[0];
    const other = net.onChain(spending([coin]), key.address, 1_067_800);
    proof.reads.set(other, inBlock(1_067_800));
    proof.reads.set(r.txid, { state: 'unknown' });
    minutes(3);
    expect((await sends.round()).released).toEqual([]);
    expect(legRow(ids[0]).status).toBe('sending');
    proof.reads.set(r.txid, { state: 'unknown', notFoundByAllReachable: true });
    minutes(3);
    expect((await sends.round()).released).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'input_spent' });
    // A copy beside the silence is booked, never released.
    const again = purchase('T2');
    const s = await announced(again, [200n * LANA]);
    const copy = net.onChain(malleated(s.rawTx), key.address, 1_067_900);
    proof.reads.set(s.txid, { state: 'unknown', notFoundByAllReachable: true });
    proof.reads.set(copy, inBlock(1_067_900));
    minutes(3);
    expect((await sends.round()).confirmed).toEqual([s.txid]);
    for (const id of again) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: copy });
  });

  it("a coin of a send staked by the financer's desktop wallet — a coinstake: an empty first output, then their public key, no P2PKH output — is proven like any other spender: the send is released (recheck of 9 Oct 2026)", async () => {
    const ids = purchase();
    const r = await announced(ids);
    proof.reads.set(r.txid, { state: 'not_found' });
    const coin = JSON.parse(sendRow(r.txid).inputs_json)[0];
    const stake = net.onChain(coinstake([coin], key), key.address, 1_067_800);
    // In a block by one server's word only: kept.
    minutes(3);
    expect((await sends.round()).released).toEqual([]);
    expect(legRow(ids[0]).status).toBe('sending');
    // Asked of the two-server proof with the staker's own address (the address of the key it pays), proven: released.
    expect(proof.askedWith).toContainEqual([stake, key.address]);
    proof.reads.set(stake, inBlock(1_067_800));
    minutes(3);
    expect((await sends.round()).released).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'input_spent', last_outcome: `spent elsewhere: ${coin} by ${stake}` });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: null });
  });

  it('proofWalletOf: the first output that pays and reads — a P2PKH output, or a public key (compressed or not) as the address of that key; an empty or unreadable one never', () => {
    const [c, u] = [throwawayWallet(true), throwawayWallet(false)];
    const tx = (outputs: Array<{ value: bigint; scriptPubKeyHex: string }>) =>
      encodeTxHex({ version: 1, nTime: 1, inputs: [{ prevTxid: 'ab'.repeat(32), vout: 0, scriptSigHex: '', sequence: SEQUENCE_FINAL }], outputs, locktime: 0 });
    expect(proofWalletOf(tx([{ value: 0n, scriptPubKeyHex: '' }, { value: LANA, scriptPubKeyHex: p2pkScriptHex(c.publicKey) }]))).toBe(c.address);
    expect(proofWalletOf(tx([{ value: 0n, scriptPubKeyHex: '' }, { value: LANA, scriptPubKeyHex: p2pkScriptHex(u.publicKey) }]))).toBe(u.address);
    expect(proofWalletOf(tx([{ value: LANA, scriptPubKeyHex: scriptOfAddress(u.address) }, { value: LANA, scriptPubKeyHex: p2pkScriptHex(c.publicKey) }]))).toBe(u.address);
    expect(proofWalletOf(tx([{ value: 0n, scriptPubKeyHex: p2pkScriptHex(c.publicKey) }, { value: LANA, scriptPubKeyHex: '6a' }]))).toBeNull();
    expect(proofWalletOf('00')).toBeNull();
  });

  it('a coin gone, but the wallet history holds the send: not released (it may be confirming)', async () => {
    const ids = purchase();
    const r = await announced(ids);
    proof.reads.set(r.txid, { state: 'not_found' });
    net.coins.delete(JSON.parse(sendRow(r.txid).inputs_json)[0]);
    net.history.set(r.txid, 0);
    minutes(3);
    await sends.round();
    expect(sendRow(r.txid).state).toBe('mempool');
    expect(legRow(ids[0]).status).toBe('sending');
  });

  it('a day without confirmation and its coins unspent: kept, flagged for a person, no longer sent again — never released', async () => {
    const ids = purchase();
    const r = await announced(ids);
    clock += (REBROADCAST_FOR_S + 60) * 1000;
    const before = net.broadcasts.length;
    const res = await sends.round();
    expect(res.stuck).toEqual([r.txid]);
    expect(net.broadcasts.length).toBe(before);
    expect(sendRow(r.txid)).toMatchObject({ state: 'mempool' });
    expect(sendRow(r.txid).last_outcome).toMatch(/^STUCK/);
    expect(legRow(ids[0]).status).toBe('sending');
    expect(sendsHealth(db, clock)).toEqual({ inFlight: 1, stuck: 1, stuckTxids: [r.txid], ownerMismatchPurchases: 0, ownerMismatchRefs: [] });
    // Still looked at: should it confirm after all, it is booked.
    proof.reads.set(r.txid, { state: 'confirmed', lanoshis: 1n, height: 9, confirmations: 1, nTime: 1, blockTime: 1 });
    clock += 11 * 60_000;
    expect((await sends.round()).confirmed).toEqual([r.txid]);
  });

  it("a financer's send is sent again only while the Registrar still allows its wallet — held otherwise", async () => {
    const r = await announced(purchase());
    registrar = () => ({ ok: false, reason: 'WALLET_FROZEN', frozen: true, freezeReason: 'frozen_own_person' });
    minutes(3);
    const before = net.broadcasts.length;
    const res = await sends.round();
    expect(res.held).toEqual([r.txid]);
    expect(net.broadcasts.length).toBe(before);
    expect(sendRow(r.txid).last_outcome).toBe('held: WALLET_FROZEN (frozen_own_person)');
    registrar = () => ({ ok: true, walletType: 'Lana.Discount', frozen: false });
    minutes(3);
    expect((await sends.round()).sent).toEqual([r.txid]);
  });

  it('a restart between storing and broadcasting: a new machine sends the stored bytes at its first round', async () => {
    const r = await announced(purchase());
    db.prepare("UPDATE lana_sends SET state = 'announced', broadcasts = 0, next_broadcast_at = NULL WHERE txid = ?").run(r.txid);
    const restarted = make();
    const res = await restarted.round();
    expect(res.sent).toEqual([r.txid]);
    expect(net.broadcasts).toEqual([r.rawTx, r.rawTx]);
    expect(sendRow(r.txid).state).toBe('mempool');
  });

  it('the treasury\'s sends wait while the send lock is held (the auto-sender, the button); the financers\' do not', async () => {
    const r = await announced(purchase());
    db.prepare("INSERT INTO lana_sends (txid, sender, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis, state, created_at, updated_at) VALUES (?, 'treasury', 'LX', ?, '[]', '[]', 1, 1, 'announced', ?, ?)")
      .run('cd'.repeat(32), r.rawTx, '2026-10-08 10:00:00', '2026-10-08 10:00:00');
    expect(tryAcquireSendLock('auto-send')).toBe(true);
    try {
      minutes(3);
      proof.asked.length = 0;
      const res = await sends.round();
      expect(res.treasurySkipped).toBe(true);
      expect(proof.asked).toEqual([r.txid]);
    } finally {
      releaseSendLock('auto-send');
    }
  });
});

// ─── must spend: two sends of one leg can never both confirm ──────────────

describe('a leg released from a refused send goes out again only in a send that conflicts with it', () => {
  it('the next send must spend a coin of the refused one: a send that does not is refused (MUST_SPEND_UNMET)', async () => {
    const ids = purchase();
    const [big, small] = net.fund(key.address, [300n * LANA, 200n * LANA], nowSec() - 86_400);
    // The first send spends the smaller coin (a browser may sign any plan the check accepts).
    const first = await sign(await prepared(ids), [small]);
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    expect((await sends.announce(OWNER, { orderIds: ids, rawTx: first })).ok).toBe(true);
    expect(JSON.parse(legRow(ids[0]).must_spend_json)).toEqual([small]);

    // A send from the other coin alone could confirm beside it: refused.
    const p = await prepared(ids);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: await sign(p, [big]) })).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_UNMET', mustSpend: [[small]] });
    // The prepare offers the coins so that the plan the browser makes spends the required one: the larger coin,
    // which the plan would take first, is left out of this send.
    expect(p.mustSpend).toEqual([[small]]);
    expect(p.coins.map(c => outpointKey(c.txid, c.vout))).not.toContain(big);
    const again = await sign(p);
    expect(decodeTx(again).inputs.map(i => outpointKey(i.prevTxid, i.vout))).toContain(small);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: again })).toMatchObject({ ok: true, send: { state: 'mempool' } });
  });

  it('refused with a coin the legs did not have to spend: an announce over the other coin is refused', async () => {
    const ids = purchase();
    const [big, small] = net.fund(key.address, [300n * LANA, 200n * LANA], nowSec() - 86_400);
    const p = await prepared(ids);
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    await sends.announce(OWNER, { orderIds: ids, rawTx: await sign(p, [big]) });
    expect(JSON.parse(legRow(ids[0]).must_spend_json)).toEqual([big]);
    // Signed from the small coin only — it does not conflict with the refused send.
    const off = await sign(p, [small]);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: off })).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_UNMET', mustSpend: [[big]] });
    expect(legRow(ids[0]).status).toBe('pending');
  });

  it('released again: only the coins shared with the earlier set stay required (every later send conflicts with EVERY earlier one)', () => {
    expect(nextMustSpend(null, ['a:0', 'b:0'])).toEqual(['a:0', 'b:0']);
    expect(nextMustSpend(JSON.stringify(['a:0', 'b:0']), ['b:0', 'c:0'])).toEqual(['b:0']);
    expect(nextMustSpend(JSON.stringify(['a:0']), ['c:0'])).toEqual(['c:0']); // the earlier set had lapsed
    expect(unmetMustSpend([['a:0', 'b:0'], ['c:0']], ['b:0'])).toEqual([['c:0']]);
  });

  it('a required coin spent elsewhere lapses the requirement only when WHO spent it is known — proven in a block, no copy of the refused send; a refused send on the chain after all, itself or a copy, blocks the legs; judged in its own wallet', () => {
    own('T1');
    const id = leg('T1', 'merchant');
    const [aa, bb, ff] = ['aa'.repeat(32) + ':0', 'bb'.repeat(32) + ':1', 'ff'.repeat(32)];
    db.prepare("UPDATE brain_lana_orders SET must_spend_json = ? WHERE id = ?").run(JSON.stringify([aa, bb]), id);
    db.prepare(`INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis, state, release_reason, created_at, updated_at)
                VALUES (?, 'financer', ?, 'LX', '00', ?, ?, 1, 1, 'released', 'refused', ?, ?)`)
      .run(ff, OWNER, JSON.stringify([id]), JSON.stringify([aa, bb]), '2026-10-08 10:00:00', '2026-10-08 10:00:00');
    const coin = (txid: string, vout: number) => ({ txid, vout, value: LANA, height: 5 });
    const legs = [{ id, must_spend_json: legRow(id).must_spend_json }];
    const since = '2026-10-01 00:00:00';
    const both = { unspent: [coin('aa'.repeat(32), 0), coin('bb'.repeat(32), 1)], history: new Map<string, number>() };
    const oneGone = { unspent: [coin('bb'.repeat(32), 1)], history: new Map<string, number>() };
    const none = { binding: [], blockedOrderIds: [], live: [], foreign: [] };
    expect(judgeMustSpend(db, legs, both, since)).toEqual({ ...none, binding: [[aa, bb]] });
    // Gone, and nobody known to have spent it: it still binds — never lapsed without proof.
    expect(judgeMustSpend(db, legs, oneGone, since)).toEqual({ ...none, binding: [[aa, bb]] });
    // Spent by a transaction proven in a block that is no copy: every send it guarded is dead — lapsed.
    expect(judgeMustSpend(db, legs, oneGone, since, { spentByOther: new Set([aa]) })).toEqual(none);
    // Spent by a COPY of the refused send: that send is in a block under another id — the legs wait (also once it is
    // older than the week its own id is watched for).
    const copies = new Map([[ff, 'ab'.repeat(32)]]);
    expect(judgeMustSpend(db, legs, oneGone, since, { copies })).toEqual({ ...none, blockedOrderIds: [id], live: [ff] });
    expect(judgeMustSpend(db, legs, oneGone, '2026-10-09 00:00:00', { copies })).toEqual({ ...none, blockedOrderIds: [id], live: [ff] });
    // Its own id in the wallet's history.
    expect(judgeMustSpend(db, legs, { ...oneGone, history: new Map([[ff, 0]]) }, since)).toEqual({ ...none, blockedOrderIds: [id], live: [ff] });
    // Sent from ANOTHER wallet now: the set's own wallet (LX) decides — binding there, it is foreign; its history there
    // shows it live; the other wallet's history never could.
    const fromLY = { wallet: 'LY', states: new Map([['LX', both]]) };
    expect(judgeMustSpend(db, legs, { unspent: [], history: new Map() }, since, fromLY)).toEqual({ ...none, foreign: [{ wallet: 'LX', set: [aa, bb] }] });
    expect(judgeMustSpend(db, legs, { unspent: [], history: new Map([[ff, 3]]) }, since, fromLY)).toEqual({ ...none, foreign: [{ wallet: 'LX', set: [aa, bb] }] });
    expect(judgeMustSpend(db, legs, { unspent: [], history: new Map() }, since, { wallet: 'LY', states: new Map([['LX', { ...both, history: new Map([[ff, 3]]) }]]) }))
      .toEqual({ ...none, blockedOrderIds: [id], live: [ff] });
    expect(judgeMustSpend(db, legs, { unspent: [], history: new Map() }, since, { wallet: 'LY', states: new Map([['LX', oneGone]]), spentByOther: new Set([aa]) })).toEqual(none);
    // Sent from LX itself: binding as ever.
    expect(judgeMustSpend(db, legs, both, since, { wallet: 'LX' })).toEqual({ ...none, binding: [[aa, bb]] });
  });

  it("a refused send whose COPY is mined: the requirement has not lapsed — the legs wait, never sent again — and the round books them under the copy's id", async () => {
    const ids = purchase();
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const r = await announced(ids);
    expect(sendRow(r.txid).state).toBe('released');
    // A node nobody asked held it, and a relay's copy of it got into a block: its coins are spent — by the copy.
    const copy = net.onChain(malleated(r.rawTx), key.address, 1_067_900);
    net.fund(key.address, [500n * LANA], nowSec() - 86_400);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ ok: false, status: 409, code: 'RELEASED_SEND_LIVE', txids: [r.txid] });
    proof.reads.set(copy, inBlock(1_067_900));
    clock += 11 * 60_000;
    const res = await sends.round();
    expect(res.lateConfirmed).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'confirmed', last_outcome: `confirmed as copy ${copy}, after it was released` });
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: copy, send_txid: r.txid });
    expect(outbox().map(o => [o.dedupe_key, JSON.parse(o.body_json).tx_hash])).toEqual([[`lana-sent:${copy}`, copy]]);
    expect(sends.view(r.txid)?.chainTxid).toBe(copy);
  });

  it('the financer switched wallets after a refused send: its legs wait (MUST_SPEND_OTHER_WALLET) while the OLD wallet still holds the coins; that wallet\'s history shows the refused send live; spent there by another transaction proven in a block, the requirement lapses', async () => {
    const ids = purchase();
    const w1 = key;
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const first = await announced(ids, [300n * LANA]);
    const set = JSON.parse(sendRow(first.txid).inputs_json);
    expect(JSON.parse(legRow(ids[0]).must_spend_json)).toEqual(set);
    // Direct.Fund now names another Lana.Discount wallet of theirs, with coins of its own.
    key = throwawayWallet(true);
    dfWallet = key.address;
    const [fresh] = net.fund(key.address, [400n * LANA], nowSec() - 86_400);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_OTHER_WALLET', wallet: w1.address, mustSpend: [set] });
    // Signed from the new wallet anyway: refused the same way, nothing stored, nothing sent.
    const fromNew = await sign({ ...first.prepared, wallet: key.address }, [fresh]);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: fromNew })).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_OTHER_WALLET', wallet: w1.address, mustSpend: [set] });
    expect(net.broadcasts).toHaveLength(1);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    // The refused send in the OLD wallet's history after all (the new wallet's never holds it): live — they wait for it.
    net.walletHistory(w1.address).set(first.txid, 0);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'RELEASED_SEND_LIVE', txids: [first.txid] });
    net.walletHistory(w1.address).delete(first.txid);
    // Its coin spent in the old wallet by another transaction — in its history, not yet proven: still waiting.
    const other = net.onChain(spending(set), w1.address, 1_067_950);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'MUST_SPEND_OTHER_WALLET' });
    // Proven in a block: nothing of the refused send can confirm — the legs go from the new wallet.
    proof.reads.set(other, inBlock(1_067_950));
    const p = await prepared(ids);
    expect(p).toMatchObject({ wallet: key.address, mustSpend: [] });
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: await sign(p) })).toMatchObject({ ok: true, send: { state: 'mempool', wallet: key.address } });
  });

  it("a required coin staked by the financer's desktop wallet — a coinstake proven in a block — lapses the requirement, and the lapse is KEPT: never proven again (recheck of 9 Oct 2026)", async () => {
    const ids = purchase();
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const first = await announced(ids, [300n * LANA]);
    const [coin] = JSON.parse(sendRow(first.txid).inputs_json);
    for (const id of ids) expect(JSON.parse(legRow(id).must_spend_json)).toEqual([coin]);
    // Their desktop wallet stakes that very coin; fresh coins come in.
    const stake = net.onChain(coinstake([coin], key), key.address, 1_067_900);
    net.fund(key.address, [400n * LANA], nowSec() - 86_400);
    // In a block by one server's word only: it still binds — and no plan spends a coin that is gone.
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_UNMET', mustSpend: [[coin]] });
    // Proven (asked with the staker's own address): lapsed, and the legs' sets cleared.
    proof.reads.set(stake, inBlock(1_067_900));
    const p = await prepared(ids);
    expect(proof.askedWith).toContainEqual([stake, key.address]);
    expect(p.mustSpend).toEqual([]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: null });
    expect(logs.some(l => l.includes('must-spend lapsed for 4 leg(s)'))).toBe(true);
    // The spender no longer found (past the history looked through, or no second machine answering): nothing binds again.
    proof.reads.delete(stake);
    net.walletHistory(key.address).delete(stake);
    expect((await prepared(ids)).mustSpend).toEqual([]);
    expect(await sends.announce(OWNER, { orderIds: ids, rawTx: await sign(p) })).toMatchObject({ ok: true, send: { state: 'mempool' } });
  });

  it('a coinstake proven only 1 block deep is no proof yet (M1, recheck of 9 Oct 2026): the set still binds and nothing is cleared; its block orphaned, the coin is back and still required; at MIN_SPENDER_DEPTH it lapses', async () => {
    const ids = purchase();
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const first = await announced(ids, [300n * LANA]);
    const [coin] = JSON.parse(sendRow(first.txid).inputs_json);
    const listed = net.coins.get(coin) as ListedOutput;
    const stake = net.onChain(coinstake([coin], key), key.address, 1_067_900);
    net.fund(key.address, [400n * LANA], nowSec() - 86_400);
    // Proven over both servers, but 1 confirmation deep: it still binds, nothing is cleared, nothing kept.
    proof.reads.set(stake, inBlock(1_067_900, 1));
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_UNMET', mustSpend: [[coin]] });
    expect(proof.asked).toContain(stake);
    for (const id of ids) expect(JSON.parse(legRow(id).must_spend_json)).toEqual([coin]);
    expect(logs.some(l => l.includes('must-spend lapsed'))).toBe(false);
    // Its block orphaned: the coinstake is gone from the history, the coin unspent again — and still required.
    net.walletHistory(key.address).delete(stake);
    proof.reads.delete(stake);
    net.coins.set(coin, listed);
    const p = await prepared(ids);
    expect(p.mustSpend).toEqual([[coin]]);
    for (const id of ids) expect(JSON.parse(legRow(id).must_spend_json)).toEqual([coin]);
    // Staked again, and now MIN_SPENDER_DEPTH deep: lapsed, the sets cleared.
    expect(net.onChain(coinstake([coin], key), key.address, 1_067_900)).toBe(stake);
    proof.reads.set(stake, inBlock(1_067_900, MIN_SPENDER_DEPTH));
    expect((await prepared(ids)).mustSpend).toEqual([]);
    for (const id of ids) expect(legRow(id).must_spend_json).toBeNull();
  });

  it('a send whose coin went in a coinstake proven less than MIN_SPENDER_DEPTH deep is not released — its legs stay sending; at that depth it is (M1)', async () => {
    const ids = purchase();
    const r = await announced(ids);
    proof.reads.set(r.txid, { state: 'not_found' });
    const coin = JSON.parse(sendRow(r.txid).inputs_json)[0];
    const stake = net.onChain(coinstake([coin], key), key.address, 1_067_800);
    proof.reads.set(stake, inBlock(1_067_800, MIN_SPENDER_DEPTH - 1));
    minutes(3);
    expect((await sends.round()).released).toEqual([]);
    expect(proof.asked).toContain(stake);
    expect(sendRow(r.txid).state).not.toBe('released');
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: r.txid });
    proof.reads.set(stake, inBlock(1_067_800, MIN_SPENDER_DEPTH));
    minutes(3);
    expect((await sends.round()).released).toEqual([r.txid]);
    expect(sendRow(r.txid)).toMatchObject({ state: 'released', release_reason: 'input_spent' });
  });

  it('a lapse is kept only for a leg as it was judged: one whose set changed meanwhile, or that is no longer pending, keeps what it has', async () => {
    const ids = purchase();
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const first = await announced(ids, [300n * LANA]);
    const [coin] = JSON.parse(sendRow(first.txid).inputs_json);
    const stake = net.onChain(coinstake([coin], key), key.address, 1_067_900);
    proof.reads.set(stake, inBlock(1_067_900));
    // The legs as a caller read them (the auto-sender's selection); before they are judged, one leg's set changes and
    // another is cancelled.
    const read = ids.map(id => legRow(id));
    const changed = JSON.stringify(['cd'.repeat(32) + ':3']);
    db.prepare('UPDATE brain_lana_orders SET must_spend_json = ? WHERE id = ?').run(changed, ids[0]);
    db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE id = ?").run(ids[1]);
    expect((await sends.treasuryCoinRules(key.address, read, new Set())).ok).toBe(true);
    expect(legRow(ids[0]).must_spend_json).toBe(changed);
    expect(legRow(ids[1]).must_spend_json).toBe(JSON.stringify([coin]));
    for (const id of ids.slice(2)) expect(legRow(id).must_spend_json).toBeNull();
  });

  it('a refused send that confirms after all is booked: its legs sent — also those already in a newer (now dead) send', async () => {
    const ids = purchase();
    const [big, small] = net.fund(key.address, [300n * LANA, 200n * LANA], nowSec() - 86_400);
    const p = await prepared(ids);
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    const first = await sign(p, [small]);
    await sends.announce(OWNER, { orderIds: ids, rawTx: first });
    // A newer send of the same legs, spending the required coin.
    const second = await announced(ids, []);
    expect(second.send.state).toBe('mempool');
    void big;
    // The refused one turns up in a block after all.
    proof.reads.set(txidOfRaw(first), { state: 'confirmed', lanoshis: 1n, height: 77, confirmations: 1, nTime: 1, blockTime: 1 });
    clock += 11 * 60_000;
    const res = await sends.round();
    expect(res.lateConfirmed).toEqual([txidOfRaw(first)]);
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: txidOfRaw(first) });
    expect(sendRow(txidOfRaw(first)).state).toBe('confirmed');
    expect(JSON.parse(outbox()[0].body_json).order_ids).toEqual(ids);
  });
});

// ─── the treasury's sends ────────────────────────────────────────────────

describe("the treasury's sends, recorded before they are broadcast", () => {
  const treasury = throwawayWallet(false);
  async function treasuryTx(orders: Array<{ to_wallet: string; lana_amount: number }>, coinValues = [400n * LANA], from: ThrowawayWallet = treasury) {
    const listed = coinValues.map(v => {
      const parent = parentPaying(from.address, [v], nowSec() - 3600);
      net.raws.set(parent.txid, parent.raw);
      net.coins.set(outpointKey(parent.txid, 0), { txid: parent.txid, vout: 0, value: v, height: 5 });
      return { txid: parent.txid, vout: 0, value: v, height: 5, rawTx: parent.raw };
    });
    const coins = verifiedCoins(listed, from.address);
    if (coins.ok === false) throw new Error('coins');
    const plan = planPayout({ from: from.address, coins: coins.coins, allocations: orders.map(o => ({ address: o.to_wallet, lanoshis: BigInt(o.lana_amount) })), nowSec: nowSec(), step: LEG_LANOSHI_STEP });
    if (plan.ok === false) throw new Error(plan.code);
    const signed = await signPayoutTx({ from: from.address, pay: plan.pay, coins: plan.coins, nowSec: nowSec(), privateKey: from.privateKey, compressed: from.compressed });
    if (signed.ok === false) throw new Error(signed.code);
    return signed.rawTx;
  }
  const treasuryLegs = () => {
    own('T9', '', 'treasury');
    return ['merchant', 'cashback'].map(t => legRow(leg('T9', t as 'merchant' | 'cashback')));
  };

  it('legs sending with the txid and the bytes stored, before any broadcast; finished by the round like any send', async () => {
    const orders = treasuryLegs();
    const raw = await treasuryTx(orders);
    const r = await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1234 });
    expect(r).toEqual({ ok: true, txid: txidOfRaw(raw) });
    expect(net.broadcasts).toEqual([]);
    expect(sendRow(txidOfRaw(raw))).toMatchObject({ sender: 'treasury', owner_hex: null, wallet_id: treasury.address, state: 'announced', fee_lanoshis: 1234, broadcasts: 0 });
    for (const o of orders) expect(legRow(o.id)).toMatchObject({ status: 'sending', send_txid: txidOfRaw(raw) });
    expect((await sends.broadcastRecorded(txidOfRaw(raw)))?.kind).toBe('accepted');
    proof.reads.set(txidOfRaw(raw), { state: 'confirmed', lanoshis: 1n, height: 3, confirmations: 1, nTime: 1, blockTime: 1 });
    await sends.round();
    for (const o of orders) expect(legRow(o.id)).toMatchObject({ status: 'sent', tx_hash: txidOfRaw(raw) });
    expect(JSON.parse(outbox()[0].body_json)).toEqual({ transaction_refs: ['T9'], tx_hash: txidOfRaw(raw), order_ids: orders.map(o => o.id) });
  });

  it('a leg cancelled (or redirected, or no longer the treasury\'s) while the transaction was built: nothing recorded', async () => {
    const orders = treasuryLegs();
    const raw = await treasuryTx(orders);
    db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE id = ?").run(orders[1].id);
    expect(await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1 })).toMatchObject({ ok: false, code: 'LEGS_CHANGED', orderIds: [orders[1].id] });
    expect(legRow(orders[0].id)).toMatchObject({ status: 'pending', send_txid: null });
    expect(db.prepare('SELECT COUNT(*) c FROM lana_sends').get()).toEqual({ c: 0 });
    db.prepare("UPDATE brain_lana_orders SET status = 'pending' WHERE id = ?").run(orders[1].id);
    db.prepare("UPDATE purchase_settlement SET settled_by = 'financer' WHERE transaction_ref = 'T9'").run();
    expect(await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1 })).toMatchObject({ ok: false, code: 'LEGS_CHANGED' });
  });

  it("a coin of a treasury send on its way is never spent again, and is left out of the next selection", async () => {
    const orders = treasuryLegs();
    const raw = await treasuryTx(orders);
    await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1 });
    own('T8', '', 'treasury');
    const more = [legRow(leg('T8', 'merchant'))];
    const rules = await sends.treasuryCoinRules(treasury.address, more);
    expect(rules.ok && [...rules.rules.inFlight]).toEqual(decodeTx(raw).inputs.map(i => outpointKey(i.prevTxid, i.vout)));
    // A second transaction over the same coin (built from a stale list) is refused before it can go.
    const sameCoin = decodeTx(raw).inputs[0];
    const listedAgain = { txid: sameCoin.prevTxid, vout: sameCoin.vout };
    const coins = verifiedCoins([{ ...listedAgain, value: 400n * LANA, height: 5, rawTx: net.raws.get(sameCoin.prevTxid) as string }], treasury.address);
    if (coins.ok === false) throw new Error('coins');
    const plan = planPayout({ from: treasury.address, coins: coins.coins, allocations: [{ address: more[0].to_wallet, lanoshis: BigInt(more[0].lana_amount) }], nowSec: nowSec(), step: LEG_LANOSHI_STEP });
    if (plan.ok === false) throw new Error(plan.code);
    const twice = await signPayoutTx({ from: treasury.address, pay: plan.pay, coins: plan.coins, nowSec: nowSec(), privateKey: treasury.privateKey, compressed: false });
    if (twice.ok === false) throw new Error(twice.code);
    expect(await sends.recordTreasurySend({ rawTx: twice.rawTx, wallet: treasury.address, orders: more, feeLanoshis: 1 })).toMatchObject({ ok: false, code: 'COIN_IN_FLIGHT' });
  });

  it('a treasury leg released from a refused send: the coin it must spend is forced, and a send without it is refused', async () => {
    const orders = treasuryLegs();
    const raw = await treasuryTx(orders, [400n * LANA, 500n * LANA]);
    await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1 });
    net.answers.push({ kind: 'refused', detail: 'TX rejected', final: true });
    await sends.broadcastRecorded(txidOfRaw(raw));
    const required = JSON.parse(legRow(orders[0].id).must_spend_json);
    expect(required).toEqual(decodeTx(raw).inputs.map(i => outpointKey(i.prevTxid, i.vout)));
    const fresh = orders.map(o => legRow(o.id));
    const rules = await sends.treasuryCoinRules(treasury.address, fresh);
    expect(rules.ok && rules.rules.forced).toEqual([required[0]]);
    // Over another coin only: refused, nothing recorded.
    const other = await treasuryTx(fresh, [450n * LANA]);
    expect(await sends.recordTreasurySend({ rawTx: other, wallet: treasury.address, orders: fresh, feeLanoshis: 1 })).toMatchObject({ ok: false, code: 'MUST_SPEND_UNMET' });
    expect(legRow(orders[0].id).status).toBe('pending');
  });

  it('the coin forced for a released treasury leg is never one on the -22 list: another coin of its set — or, none left, its legs wait this cycle, their must_spend as it is (without a list: refused)', async () => {
    const orders = treasuryLegs();
    // Two coins, both needed: the refused send spent them both.
    const raw = await treasuryTx(orders, [30n * LANA, 20n * LANA]);
    const [c, d] = decodeTx(raw).inputs.map(i => outpointKey(i.prevTxid, i.vout));
    expect(net.coins.get(c)?.value).toBe(30n * LANA);
    await sends.recordTreasurySend({ rawTx: raw, wallet: treasury.address, orders, feeLanoshis: 1 });
    net.answers.push({ kind: 'refused', detail: "{u'message': u'TX rejected', u'code': -22}", final: true });
    await sends.broadcastRecorded(txidOfRaw(raw));
    const fresh = orders.map(o => legRow(o.id));
    const must = fresh[0].must_spend_json;
    expect(JSON.parse(must)).toEqual([c, d]);
    const rules = async (avoid?: Set<string>) => {
      const r = await sends.treasuryCoinRules(treasury.address, fresh, avoid);
      if (r.ok === false) throw new Error(r.code);
      return { forced: r.rules.forced, deferred: r.rules.deferredOrderIds, blocked: r.rules.blockedOrderIds };
    };
    expect(await rules()).toEqual({ forced: [c], deferred: [], blocked: [] }); // the largest
    // The largest is the coin a co-tenant already spent in the mempool (the auto-sender blacklisted it): the other one.
    expect(await rules(new Set([c]))).toEqual({ forced: [d], deferred: [], blocked: [] });
    // Every coin of the set blacklisted: nothing forced, its legs wait — the other purchases go with other coins.
    expect(await rules(new Set([c, d]))).toEqual({ forced: [], deferred: orders.map(o => o.id), blocked: [] });
    for (const o of orders) expect(legRow(o.id)).toMatchObject({ status: 'pending', must_spend_json: must });
    // Both gone from the confirmed coins, nobody known to have spent them: it still binds, nothing to force — the
    // auto-sender defers, the manual button (no list) is refused.
    net.coins.delete(c);
    net.coins.delete(d);
    expect(await rules(new Set())).toEqual({ forced: [], deferred: orders.map(o => o.id), blocked: [] });
    expect(await sends.treasuryCoinRules(treasury.address, fresh)).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_UNMET', mustSpend: [[c, d]] });
  });

  it("legs whose refused send went out of the OTHER treasury address: the auto-sender's rules defer them, must_spend as it is, and leave the rest to go; the manual button (no list) is refused; a send of them from this address is never recorded (recheck of 9 Oct 2026)", async () => {
    // One cycle from the compressed address (the uncompressed one listed no coins): refused at its first broadcast.
    const compressed = throwawayWallet(true, treasury.privateKey);
    expect(compressed.address).not.toBe(treasury.address);
    const orders = treasuryLegs();
    const raw = await treasuryTx(orders, [400n * LANA], compressed);
    expect((await sends.recordTreasurySend({ rawTx: raw, wallet: compressed.address, orders, feeLanoshis: 1 })).ok).toBe(true);
    net.answers.push({ kind: 'refused', detail: "{u'message': u'TX rejected', u'code': -22}", final: true });
    await sends.broadcastRecorded(txidOfRaw(raw));
    const old = orders.map(o => legRow(o.id));
    const must = old[0].must_spend_json;
    const set = decodeTx(raw).inputs.map(i => outpointKey(i.prevTxid, i.vout));
    expect(JSON.parse(must)).toEqual(set);
    // The next cycle is from the uncompressed address again, with a fresh purchase beside them.
    own('T8', '', 'treasury');
    const fresh = [legRow(leg('T8', 'merchant'))];
    expect(await sends.treasuryCoinRules(treasury.address, [...old, ...fresh], new Set())).toMatchObject({
      ok: true, rules: { forced: [], blockedOrderIds: [], deferredOrderIds: old.map(o => o.id) },
    });
    for (const o of old) expect(legRow(o.id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: must });
    expect(await sends.treasuryCoinRules(treasury.address, fresh, new Set())).toMatchObject({ ok: true, rules: { forced: [], deferredOrderIds: [] } });
    // The manual button: refused, as ever.
    expect(await sends.treasuryCoinRules(treasury.address, [...old, ...fresh])).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_OTHER_WALLET', wallet: compressed.address, mustSpend: [set] });
    // Built from this address anyway: never recorded, nothing broadcast.
    const before = net.broadcasts.length;
    const other = await treasuryTx(old, [450n * LANA]);
    expect(await sends.recordTreasurySend({ rawTx: other, wallet: treasury.address, orders: old, feeLanoshis: 1 })).toMatchObject({ ok: false, status: 409, code: 'MUST_SPEND_OTHER_WALLET' });
    expect(net.broadcasts.length).toBe(before);
    for (const o of old) expect(legRow(o.id)).toMatchObject({ status: 'pending', send_txid: null, must_spend_json: must });
    // The fresh purchase goes.
    const freshTx = await treasuryTx(fresh, [200n * LANA]);
    expect(await sends.recordTreasurySend({ rawTx: freshTx, wallet: treasury.address, orders: fresh, feeLanoshis: 1 })).toEqual({ ok: true, txid: txidOfRaw(freshTx) });
    // From the compressed address again, a send that spends a coin of the set meets it.
    const again = await sends.treasuryCoinRules(compressed.address, old, new Set());
    expect(again).toMatchObject({ ok: true, rules: { forced: [set[0]], deferredOrderIds: [] } });
  });
});

// ─── what the financer sees ───────────────────────────────────────────────

describe('sendable and prepare', () => {
  it("the signer's legs that may go now, by purchase, with the wallet's balance and what it lacks", async () => {
    purchase('T1');
    purchase('T2', OTHER);
    own('T3');
    leg('T3', 'merchant', { lanoshis: 400_000 }); // alone under 0.005 LANA
    leg('T3', 'cashback', { auth: 0 }); // not authorised yet
    net.fund(key.address, [100n * LANA], nowSec() - 86_400);
    const s = await sendableNow();
    expect(s.purchases.map(p => [p.transactionRef, p.legs.length, p.belowDustAlone])).toEqual([['T1', 4, false], ['T3', 1, true]]);
    expect(s.legCount).toBe(5);
    expect(s.wallet).toBe(key.address);
    expect(s.balance).toEqual({ confirmed: (100n * LANA).toString(), unconfirmed: '0' });
    const total = Object.values(AMOUNT).reduce((a, b) => a + b, 0) + 400_000;
    expect(s.totalLanoshis).toBe(String(total));
    expect(BigInt(s.shortfallLanoshis)).toBeGreaterThan(BigInt(total) - 100n * LANA);
    expect(s.limits).toEqual({ maxWallets: 98, maxLegs: 400, maxInputs: 20, dustLanoshis: '500000', stepLanoshis: '1' });
    expect(s.limits.maxLegs).toBe(MAX_ORDER_IDS);
    dfWallet = null;
    expect((await sendableNow()).walletProblem).toBe('NO_WALLET');
  });

  it('the legs one send may name: the limit the page is told is the one prepare holds to', async () => {
    own('T1');
    const many = Array.from({ length: MAX_ORDER_IDS + 1 }, (_, i) => leg('T1', 'caretaker', { id: `T1-c${i}`, lanoshis: 600_000 }));
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    const s = await sendableNow();
    expect(s.legCount).toBe(MAX_ORDER_IDS + 1);
    expect(s.limits.maxLegs).toBe(MAX_ORDER_IDS);
    expect(await sends.prepare(OWNER, many)).toMatchObject({ status: 400, code: 'BAD_ORDER_IDS' });
    const p = await sends.prepare(OWNER, many.slice(0, s.limits.maxLegs));
    expect(p).toMatchObject({ ok: false, code: 'PARTIAL_PURCHASE' }); // read whole — not refused for its count
    if (p.ok === false) expect(p.orderIds).toEqual([many[MAX_ORDER_IDS]]);
  });

  it("a purchase whose investor leg now pays ANOTHER financer (moved by the brain after the confirm) is not the signer's to send: left out of sendable, refused at prepare and announce (OWNER_MISMATCH); a cancelled investor leg does not count", async () => {
    const mine = purchase('T1');
    const moved = purchase('T2');
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    const rawTx = await sign(await prepared(mine));
    // The brain's redirect: the investor_lana leg now names another financer and their wallet.
    db.prepare('UPDATE brain_lana_orders SET to_hex = ?, to_wallet = ? WHERE id = ?').run(OTHER, throwawayAddress(), moved[0]);
    expect((await sendableNow()).purchases.map(p => p.transactionRef)).toEqual(['T1']);
    expect(await sends.prepare(OWNER, moved)).toMatchObject({ ok: false, status: 409, code: 'OWNER_MISMATCH', orderIds: moved });
    expect(await sends.prepare(OWNER, [...mine, ...moved])).toMatchObject({ ok: false, status: 409, code: 'OWNER_MISMATCH', orderIds: moved });
    expect(await sends.announce(OWNER, { orderIds: moved, rawTx })).toMatchObject({ ok: false, status: 409, code: 'OWNER_MISMATCH' });
    expect(net.broadcasts).toEqual([]);
    for (const id of moved) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    // The same hex in capitals is the signer's own.
    db.prepare('UPDATE brain_lana_orders SET to_hex = ? WHERE id = ?').run(OWNER.toUpperCase(), moved[0]);
    expect((await sendableNow()).purchases.map(p => p.transactionRef)).toEqual(['T1', 'T2']);
    // A cancelled investor leg naming another: not the purchase's live leg — the rest of it stays the signer's.
    db.prepare("UPDATE brain_lana_orders SET to_hex = ?, status = 'cancelled' WHERE id = ?").run(OTHER, moved[0]);
    expect((await sendableNow()).purchases.map(p => [p.transactionRef, p.legs.length])).toEqual([['T1', 4], ['T2', 3]]);
  });

  it('a financer-owned purchase whose live investor leg now pays another financer, with a leg still pending, is counted and named for heartbeat-status — nobody else can send it (recheck of 9 Oct 2026)', () => {
    const toOther = (id: string, status = 'pending') => db.prepare('UPDATE brain_lana_orders SET to_hex = ?, status = ? WHERE id = ?').run(OTHER, status, id);
    purchase('T1'); // the owner's own
    const moved = purchase('T2');
    toOther(moved[0]);
    // The owner's hex in capitals: their own.
    const caps = purchase('T3');
    db.prepare('UPDATE brain_lana_orders SET to_hex = ? WHERE id = ?').run(OWNER.toUpperCase(), caps[0]);
    // A cancelled investor leg naming another: not the live one.
    toOther(purchase('T4')[0], 'cancelled');
    // Moved, but nothing of it pending any more: nothing left to send.
    const done = purchase('T5');
    toOther(done[0], 'sent');
    db.prepare("UPDATE brain_lana_orders SET status = 'sent' WHERE transaction_ref = 'T5'").run();
    // The treasury's purchase: not a financer's.
    own('T6', OWNER, 'treasury');
    toOther(leg('T6', 'investor'));
    // Moved with only its investor leg pending (the rest on its way): still nobody's to send.
    const half = purchase('T7');
    toOther(half[0]);
    db.prepare("UPDATE brain_lana_orders SET status = 'sending' WHERE transaction_ref = 'T7' AND id != ?").run(half[0]);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 2, refs: ['T2', 'T7'] });
    expect(sendsHealth(db, clock)).toMatchObject({ inFlight: 0, stuck: 0, ownerMismatchPurchases: 2, ownerMismatchRefs: ['T2', 'T7'] });
    // Every one counted, at most OWNER_MISMATCH_LISTED named.
    for (let i = 0; i < OWNER_MISMATCH_LISTED; i++) toOther(purchase(`M${String(i).padStart(3, '0')}`)[0]);
    const many = ownerMismatchPurchases(db);
    expect(many.count).toBe(OWNER_MISMATCH_LISTED + 2);
    expect(many.refs).toHaveLength(OWNER_MISMATCH_LISTED);
    expect(sendsHealth(db, clock).ownerMismatchRefs).toEqual(many.refs);
  });

  it("a purchase nobody owns, of a financer's confirmed batch, whose investor leg names another investor (noted by GET /api/financer/batches) is counted and named too — as it is now (recheck of 9 Oct 2026, M2)", () => {
    forgetUnownedMismatches();
    const toOther = (id: string) => db.prepare('UPDATE brain_lana_orders SET to_hex = ? WHERE id = ?').run(OTHER, id);
    // Owned by nobody: U1's investor leg names another, its merchant leg pending — no route to anybody.
    toOther(leg('U1', 'investor'));
    leg('U1', 'merchant');
    // U2 names the batch's own financer; U3's leg naming another is cancelled.
    leg('U2', 'investor');
    leg('U2', 'merchant');
    toOther(leg('U3', 'investor', { status: 'cancelled' }));
    leg('U3', 'merchant');
    // Which batch a purchase nobody owns is in, only Direct.Fund says: not noted, not known.
    expect(ownerMismatchPurchases(db)).toEqual({ count: 0, refs: [] });
    noteUnownedMismatch(OWNER, ['U1', 'U2', 'U3']);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 1, refs: ['U1'] });
    // After the owned ones.
    toOther(purchase('T2')[0]);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 2, refs: ['T2', 'U1'] });
    expect(sendsHealth(db, clock)).toMatchObject({ ownerMismatchPurchases: 2, ownerMismatchRefs: ['T2', 'U1'] });
    // The other financer confirms U1 (it pays them): theirs, not stuck — and the note is forgotten.
    own('U1', OTHER);
    expect(ownerMismatchPurchases(db)).toEqual({ count: 1, refs: ['T2'] });
    db.prepare("DELETE FROM purchase_settlement WHERE transaction_ref = 'U1'").run();
    expect(ownerMismatchPurchases(db)).toEqual({ count: 1, refs: ['T2'] });
  });

  it('prepare: the wallet must be allowed by the Registrar, settled, and not the recipient of a leg', async () => {
    const ids = purchase();
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    registrar = () => ({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 503, code: 'WALLET_REFUSED', reason: 'REGISTRAR_UNKNOWN' });
    registrar = () => ({ ok: false, reason: 'WRONG_WALLET_TYPE', walletType: 'Wallet' });
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'WALLET_REFUSED', reason: 'WRONG_WALLET_TYPE' });
    registrar = () => ({ ok: true, walletType: 'Lana.Discount', frozen: false });
    net.state.unconfirmed = -5n;
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'WALLET_UNCONFIRMED' });
    net.state.unconfirmed = 0n;
    net.state.down = true;
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 503, code: 'CHAIN_UNKNOWN' });
    net.state.down = false;
    dfWallet = null;
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'NO_WALLET' });
    dfWallet = key.address;
    db.prepare('UPDATE brain_lana_orders SET to_wallet = ? WHERE id = ?').run(key.address, ids[0]);
    expect(await sends.prepare(OWNER, ids)).toMatchObject({ status: 409, code: 'PAYS_OWN_WALLET', orderIds: [ids[0]] });
  });

  it('prepare answers what the browser signs from: coins with their parents, the legs merged per wallet, the server clock', async () => {
    const ids = purchase();
    net.fund(key.address, [300n * LANA, 50n * LANA], nowSec() - 86_400);
    const p = await prepared(ids);
    expect(p.wallet).toBe(key.address);
    expect(p.nowSec).toBe(nowSec());
    expect(p.coins.map(c => c.value)).toEqual([(300n * LANA).toString(), (50n * LANA).toString()]);
    expect(p.coins.every(c => txidOfRaw(c.rawTx) === c.txid)).toBe(true);
    expect(p.allocations).toEqual([
      { wallet: wallets.investor, lanoshis: String(AMOUNT.investor), orderIds: [ids[0]] },
      { wallet: wallets.merchant, lanoshis: String(AMOUNT.merchant), orderIds: [ids[1]] },
      { wallet: wallets.cashback, lanoshis: String(AMOUNT.cashback), orderIds: [ids[2]] },
      { wallet: wallets.caretaker, lanoshis: String(AMOUNT.caretaker), orderIds: [ids[3]] },
    ]);
    expect(p.mustSpend).toEqual([]);
    // It reserves nothing.
    for (const id of ids) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
  });
});

// ─── one wallet per currency ──────────────────────────────────────────────

describe('one Lana.Discount wallet per currency (owner, 9 Oct 2026): a purchase\'s LANA go from the wallet of its currency', () => {
  /** The financer's GBP wallet; `key` is their EUR one. */
  let gbp: ThrowawayWallet;
  beforeEach(() => {
    gbp = throwawayWallet(true);
    dfWallets = { EUR: { walletId: key.address, setAt: '2026-10-08 10:00:00' }, GBP: { walletId: gbp.address, setAt: '2026-10-09 08:00:00' } };
  });
  const sends0 = () => (db.prepare('SELECT COUNT(*) c FROM lana_sends').get() as { c: number }).c;

  it('sendable: one currency\'s purchases against that currency\'s wallet — its balance, what it lacks, its sends on their way', async () => {
    purchase('T1');
    purchase('T2', OWNER, 'GBP');
    net.fund(key.address, [200n * LANA], nowSec() - 86_400);
    net.fund(gbp.address, [7n * LANA], nowSec() - 86_400);
    const eur = await sendableNow('EUR');
    expect(eur).toMatchObject({ currency: 'EUR', wallet: key.address, walletProblem: null, legCount: 4, balance: { confirmed: (200n * LANA).toString(), unconfirmed: '0' } });
    expect(eur.purchases.map(p => p.transactionRef)).toEqual(['T1']);
    const total = BigInt(Object.values(AMOUNT).reduce((a, b) => a + b, 0));
    expect(BigInt(eur.shortfallLanoshis)).toBe(0n);
    const gb = await sendableNow('gbp');
    expect(gb).toMatchObject({ currency: 'GBP', wallet: gbp.address, walletProblem: null, legCount: 4, balance: { confirmed: (7n * LANA).toString(), unconfirmed: '0' } });
    expect(gb.purchases.map(p => p.transactionRef)).toEqual(['T2']);
    // What the GBP wallet lacks for the GBP purchase — never covered by the EUR wallet's balance.
    expect(BigInt(gb.shortfallLanoshis)).toBeGreaterThan(total - 7n * LANA);
    // A currency with no wallet chosen: its purchases (none here) and NO_WALLET.
    expect(await sendableNow('USD')).toMatchObject({ currency: 'USD', wallet: null, walletProblem: 'NO_WALLET', purchases: [], balance: null });
  });

  it('sendable without a currency: the one their purchases are in — in two, CURRENCY_REQUIRED with both; none to send, the first of their currencies; a code that is none, BAD_CURRENCY', async () => {
    const eurIds = purchase('T1');
    const gbpIds = purchase('T2', OWNER, 'GBP');
    expect(await sends.sendable(OWNER)).toMatchObject({ ok: false, status: 400, code: 'CURRENCY_REQUIRED', currencies: ['EUR', 'GBP'] });
    for (const bad of ['EURO', 'E1R', 7, ['EUR']]) expect(await sends.sendable(OWNER, bad), JSON.stringify(bad)).toMatchObject({ ok: false, status: 400, code: 'BAD_CURRENCY' });
    // The EUR purchase on its way (sending) still counts: it is no single currency yet.
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    const r = await sends.announce(OWNER, { orderIds: eurIds, rawTx: await sign(await prepared(eurIds)) });
    expect(r.ok).toBe(true);
    expect(await sends.sendable(OWNER)).toMatchObject({ ok: false, code: 'CURRENCY_REQUIRED', currencies: ['EUR', 'GBP'] });
    // Only GBP left anywhere: the page from before wallets per currency gets it.
    db.prepare("UPDATE brain_lana_orders SET status = 'sent' WHERE transaction_ref = 'T1'").run();
    db.prepare("UPDATE lana_sends SET state = 'confirmed'").run();
    expect(await sendableNow()).toMatchObject({ currency: 'GBP', wallet: gbp.address, legCount: 4 });
    // Nothing to send or on its way: the first of the financer's currencies (EUR), its wallet and balance.
    db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE id IN (" + gbpIds.map(() => '?').join(',') + ')').run(...gbpIds);
    expect(await sendableNow()).toMatchObject({ currency: 'EUR', wallet: key.address, purchases: [], walletProblem: null });
    // No wallet anywhere, Direct.Fund per currency: none — never the old single wallet.
    dfWallets = {};
    expect(await sendableNow()).toMatchObject({ currency: null, wallet: null, walletProblem: 'NO_WALLET', purchases: [] });
    // A Direct.Fund before wallets per currency: its one wallet.
    dfWallets = null;
    expect(await sendableNow()).toMatchObject({ currency: null, wallet: key.address, walletProblem: null });
  });

  it('a send carries ONE currency, from the wallet of that currency: MIXED_CURRENCY, NO_WALLET {currency} and CURRENCY_UNKNOWN refused at prepare and at announce — nothing written, nothing sent', async () => {
    const eurIds = purchase('T1');
    const gbpIds = purchase('T2', OWNER, 'GBP');
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    net.fund(gbp.address, [300n * LANA], nowSec() - 86_400);
    const eurTx = await sign(await prepared(eurIds));
    expect(await sends.prepare(OWNER, [...eurIds, ...gbpIds])).toMatchObject({ ok: false, status: 409, code: 'MIXED_CURRENCY', currencies: ['EUR', 'GBP'] });
    expect(await sends.announce(OWNER, { orderIds: [...eurIds, ...gbpIds], rawTx: eurTx })).toMatchObject({ ok: false, status: 409, code: 'MIXED_CURRENCY', currencies: ['EUR', 'GBP'] });
    // No GBP wallet chosen: the GBP purchase is sent from none — not from the EUR one.
    dfWallets = { EUR: dfWallets.EUR };
    expect(await sends.prepare(OWNER, gbpIds)).toMatchObject({ ok: false, status: 409, code: 'NO_WALLET', currency: 'GBP' });
    expect(await sends.announce(OWNER, { orderIds: gbpIds, rawTx: eurTx })).toMatchObject({ ok: false, status: 409, code: 'NO_WALLET', currency: 'GBP' });
    // A purchase whose legs do not carry one and the same currency: no wallet sends it, and no currency's list has it.
    const odd = purchase('T3');
    db.prepare("UPDATE brain_lana_orders SET currency = 'GBP' WHERE id = ?").run(odd[1]);
    expect(await sends.prepare(OWNER, odd)).toMatchObject({ ok: false, status: 409, code: 'CURRENCY_UNKNOWN', orderIds: odd, transactionRefs: ['T3'] });
    expect(await sends.prepare(OWNER, [...eurIds, ...odd])).toMatchObject({ ok: false, code: 'CURRENCY_UNKNOWN', orderIds: odd });
    expect(await sends.announce(OWNER, { orderIds: odd, rawTx: eurTx })).toMatchObject({ ok: false, code: 'CURRENCY_UNKNOWN' });
    db.prepare("UPDATE brain_lana_orders SET currency = '' WHERE id = ?").run(odd[1]);
    expect(await sends.prepare(OWNER, odd)).toMatchObject({ ok: false, code: 'CURRENCY_UNKNOWN' });
    expect((await sendableNow('EUR')).purchases.map(p => p.transactionRef)).toEqual(['T1']);
    expect((await sendableNow('GBP')).purchases.map(p => p.transactionRef)).toEqual(['T2']);
    expect(net.broadcasts).toEqual([]);
    expect(sends0()).toBe(0);
    for (const id of [...eurIds, ...gbpIds, ...odd]) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });
    // The legs carry their currency in any case: a lower-case one is the same currency.
    db.prepare("UPDATE brain_lana_orders SET currency = ' eur ' WHERE id = ?").run(eurIds[2]);
    expect((await prepared(eurIds)).currency).toBe('EUR');
  });

  it('a GBP purchase is never announced from the EUR wallet — signed with the EUR key it is refused, nothing sent — and goes from the GBP wallet, beside an EUR send from the EUR one', async () => {
    const eurIds = purchase('T1');
    const gbpIds = purchase('T2', OWNER, 'GBP');
    net.fund(key.address, [300n * LANA], nowSec() - 86_400);
    net.fund(gbp.address, [300n * LANA], nowSec() - 86_400);
    const pe = await prepared(eurIds);
    const pg = await prepared(gbpIds);
    expect([pe.currency, pe.wallet, pg.currency, pg.wallet]).toEqual(['EUR', key.address, 'GBP', gbp.address]);
    // The GBP legs paid from the EUR wallet's coins, signed with the EUR key: a well-formed send, from the wrong wallet.
    const fromEur = await sign({ ...pe, allocations: pg.allocations });
    expect(decodeTx(fromEur).outputs.slice(0, 4).map(o => o.value)).toEqual(pg.allocations.map(a => BigInt(a.lanoshis)));
    expect(await sends.announce(OWNER, { orderIds: gbpIds, rawTx: fromEur })).toMatchObject({ ok: false, status: 409, code: 'COIN_UNAVAILABLE' });
    expect(net.broadcasts).toEqual([]);
    expect(sends0()).toBe(0);
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'pending', send_txid: null });

    // From the GBP wallet, with its own key: sent. The EUR purchase goes from the EUR wallet at the same time.
    const g = await sends.announce(OWNER, { orderIds: gbpIds, rawTx: await sign(pg, undefined, gbp) });
    const e = await sends.announce(OWNER, { orderIds: eurIds, rawTx: await sign(pe) });
    if (g.ok === false || e.ok === false) throw new Error('not sent');
    expect([g.send.wallet, e.send.wallet]).toEqual([gbp.address, key.address]);
    expect(sendRow(g.send.txid)).toMatchObject({ wallet_id: gbp.address, state: 'mempool' });
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'sending', send_txid: g.send.txid });
    // Each currency sees the send of its own wallet on its way.
    expect((await sendableNow('GBP')).inFlight.map(x => x.txid)).toEqual([g.send.txid]);
    expect((await sendableNow('EUR')).inFlight.map(x => x.txid)).toEqual([e.send.txid]);
    // The round finishes each from its own recorded wallet.
    proof.reads.set(g.send.txid, inBlock(1_067_710));
    proof.reads.set(e.send.txid, inBlock(1_067_711));
    expect((await sends.round()).confirmed.sort()).toEqual([g.send.txid, e.send.txid].sort());
    for (const id of gbpIds) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: g.send.txid });
    for (const id of eurIds) expect(legRow(id)).toMatchObject({ status: 'sent', tx_hash: e.send.txid });
  });

  it('a purchase whose currency is not known is in no currency\'s list — not even the answer of no currency at all', async () => {
    const odd = purchase('T3');
    db.prepare("UPDATE brain_lana_orders SET currency = 'GBP' WHERE id = ?").run(odd[1]);
    dfWallets = {};
    expect(await sendableNow()).toMatchObject({ currency: null, wallet: null, purchases: [], legCount: 0 });
    // A Direct.Fund before wallets per currency: its one wallet is read, and still nothing of no known currency is listed.
    dfWallets = null;
    expect(await sendableNow()).toMatchObject({ currency: null, wallet: key.address, purchases: [], legCount: 0 });
    expect(financerCurrencies(db, OWNER)).toEqual({ currencies: [], unknownRefs: ['T3'] });
  });

  it('one wallet chosen for two currencies (allowed): each purchase goes from it, one send of the wallet at a time', async () => {
    dfWallets = { EUR: dfWallets.EUR, GBP: { walletId: key.address, setAt: null } };
    const eurIds = purchase('T1');
    const gbpIds = purchase('T2', OWNER, 'GBP');
    net.fund(key.address, [300n * LANA, 200n * LANA], nowSec() - 86_400);
    const pg = await prepared(gbpIds);
    expect([pg.currency, pg.wallet]).toEqual(['GBP', key.address]);
    const g = await sends.announce(OWNER, { orderIds: gbpIds, rawTx: await sign(pg) });
    if (g.ok === false) throw new Error(g.code);
    expect(await sends.prepare(OWNER, eurIds)).toMatchObject({ ok: false, code: 'SEND_IN_FLIGHT', txid: g.send.txid });
    expect((await sendableNow('EUR')).inFlight.map(x => x.txid)).toEqual([g.send.txid]);
  });

  it('the financer\'s currencies: those of their purchases with a leg to send or on its way (approved or not), and the purchases whose currency is not known', () => {
    purchase('T1');
    purchase('T2', OWNER, 'GBP');
    own('T3');
    leg('T3', 'merchant', { auth: 0, currency: 'usd' }); // not approved yet: still theirs to send
    own('T4');
    leg('T4', 'merchant', { status: 'sent', currency: 'CHF' }); // all sent: nothing to send
    own('T5');
    leg('T5', 'merchant', { currency: 'EUR' });
    leg('T5', 'cashback', { currency: 'GBP' }); // two currencies: not known
    purchase('T6', OTHER, 'SEK'); // another financer's
    expect(financerCurrencies(db, OWNER)).toEqual({ currencies: ['EUR', 'GBP', 'USD'], unknownRefs: ['T5'] });
    db.prepare("UPDATE brain_lana_orders SET status = 'sending' WHERE transaction_ref = 'T2'").run();
    db.prepare("UPDATE brain_lana_orders SET status = 'cancelled' WHERE transaction_ref = 'T3'").run();
    expect(financerCurrencies(db, OWNER)).toEqual({ currencies: ['EUR', 'GBP'], unknownRefs: ['T5'] });
  });
});
