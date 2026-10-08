// @vitest-environment node
/**
 * payout.ts: the path the admin's browser takes — the payout wallet's coins
 * verified, the payout planned, the key checked against the wallet, every input
 * signed by the fleet's signer — and the server's check of what comes out.
 *
 * Brilly (6. 10. 2026): "At the end the admin enters the private key before
 * paying and the transaction happens." These tests sign with throwaway keys
 * only (fixtures/wallets.ts), over made-up coins; nothing is broadcast and
 * nothing opens a connection. The last step of each is what the server does on
 * announce, from the library alone: recompute the outputs from the allocations
 * (payments.ts), read every coin from its parent, check the shape (shape.ts)
 * and the signatures (verify.ts).
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import { scriptOfAddress } from './address.ts';
import { bytesToHex } from './bytes.ts';
import { decodeTx, encodeTxHex, p2pkhScriptSigHex, parseP2pkhScriptSig, txidOfRaw } from './codec.ts';
import { encodeDER } from './signature.ts';
import { DUST_LANOSHIS, feeFor, MAX_INPUTS } from './fee.ts';
import { MAX_PAY_OUTPUTS, type Allocation } from './payments.ts';
import { checkPayoutTx, MAX_TX_BYTES, payoutMaxFee, payoutNTime, planPayout, signPayoutTx } from './payout.ts';
import { verifiedCoins } from './select.ts';
import { DEFAULT_MAX_AHEAD_SEC, prevoutFromRawTx, type Prevout } from './shape.ts';
import { LANA, listedCoins, NOW_SEC, signedPayout, throwawayAddress, throwawayWallet, type ThrowawayWallet } from './fixtures/wallets.ts';
import type { ListedCoin } from './select.ts';

/** The coins an announced transaction spends, read the server's way: each parent by its own txid, re-hashed. */
function prevoutsOf(rawTx: string, listed: readonly ListedCoin[]): Prevout[] {
  const parents = new Map(listed.map((c) => [c.txid, c.rawTx]));
  return decodeTx(rawTx).inputs.map((i) => prevoutFromRawTx(parents.get(i.prevTxid)!, i.prevTxid, i.vout));
}

/**
 * What the server does with an announced payout, from the library alone (the
 * announce route adds the database and the chain): [] when it is accepted,
 * else the shape problems' codes, or the refusal's code.
 */
function serverAccepts(rawTx: string, allocations: readonly Allocation[], listed: readonly ListedCoin[], payoutWallet: string, nowSec: number): string[] {
  const r = checkPayoutTx({ rawTx, allocations, prevouts: prevoutsOf(rawTx, listed), from: payoutWallet, nowSec });
  if (r.ok === true) return [];
  return r.code === 'SHAPE' ? r.problems.map((x) => x.code) : [r.code];
}

const coinsOf = (w: ThrowawayWallet, values: readonly bigint[], nTime = NOW_SEC - 3600) => {
  const listed = listedCoins(w.address, values, nTime);
  const v = verifiedCoins(listed, w.address);
  if (v.ok === false) throw new Error(v.problems.join('; '));
  return { listed, coins: v.coins };
};

describe('the browser path: plan, sign, and what the server checks', () => {
  for (const compressed of [true, false]) {
    it(`five allocations to four buyers, a ${compressed ? 'compressed (T…/A…)' : 'uncompressed (6…/3…)'} key: signed, and the server's check accepts it`, async () => {
      const p = await signedPayout({ compressed });
      const tx = decodeTx(p.signed.rawTx);

      // Two coins, largest first; four outputs, one per buyer in the order they first appear, then the change.
      assert.deepEqual(p.plan.coins.map((c) => c.value), [20n * LANA, 15n * LANA]);
      assert.deepEqual(tx.inputs.map((i) => `${i.prevTxid}:${i.vout}`), p.plan.coins.map((c) => `${c.txid}:${c.vout}`));
      assert.deepEqual(
        tx.outputs.map((o) => [o.scriptPubKeyHex, o.value]),
        [
          [scriptOfAddress(p.payees[0]), 10n * LANA + 12_345_000n],
          [scriptOfAddress(p.payees[1]), 1_250_000_000n],
          [scriptOfAddress(p.payees[2]), 7n * LANA],
          [scriptOfAddress(p.payees[3]), DUST_LANOSHIS],
          [scriptOfAddress(p.wallet.address), p.plan.change],
        ],
      );

      // The numbers the admin saw are the numbers signed; nothing is lost.
      assert.equal(p.plan.paying, 2_962_845_000n);
      assert.equal(p.plan.fee, feeFor(2, 5));
      assert.equal(p.plan.change, 35n * LANA - p.plan.paying - p.plan.fee);
      assert.equal(p.plan.balance, 36n * LANA);
      assert.equal(p.plan.left, 1n * LANA + p.plan.change);
      assert.deepEqual([p.signed.fee, p.signed.change, p.signed.nTime], [p.plan.fee, p.plan.change, NOW_SEC]);
      assert.equal(tx.nTime, NOW_SEC, 'nTime is the server’s clock');

      // The bytes are what they say: lowercase, and the txid is their hash.
      assert.match(p.signed.rawTx, /^[0-9a-f]+$/);
      assert.equal(p.signed.txid, txidOfRaw(p.signed.rawTx));

      // The server, 45 seconds later, believing nothing the browser said but the allocations.
      assert.deepEqual(serverAccepts(p.signed.rawTx, p.allocations, p.listed, p.wallet.address, NOW_SEC + 45), []);
    });
  }

  it('the result carries the transaction and its numbers, and nothing of the key', async () => {
    const p = await signedPayout();
    assert.deepEqual(Object.keys(p.signed).sort(), ['change', 'fee', 'nTime', 'ok', 'rawTx', 'txid']);
    const text = JSON.stringify(p.signed, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.ok(!text.includes(bytesToHex(p.wallet.privateKey)));
    assert.deepEqual(Object.keys(p.plan).sort(), ['balance', 'change', 'coins', 'fee', 'left', 'nTime', 'ok', 'pay', 'paying']);
  });

  it('two signings of the same plan are two different transactions, both valid: a payout is announced once, by its txid', async () => {
    const p = await signedPayout();
    const again = await signPayoutTx({ from: p.wallet.address, pay: p.plan.pay, coins: p.plan.coins, nowSec: NOW_SEC, privateKey: p.wallet.privateKey, compressed: p.wallet.compressed });
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.notEqual(again.txid, p.signed.txid, 'the nonce is hedged with fresh randomness');
    assert.deepEqual(serverAccepts(again.rawTx, p.allocations, p.listed, p.wallet.address, NOW_SEC), []);
    // They spend the same coins: at most one of them can ever confirm.
    assert.deepEqual(decodeTx(again.rawTx).inputs.map((i) => i.prevTxid), decodeTx(p.signed.rawTx).inputs.map((i) => i.prevTxid));
  });

  it('the largest payout proven on the chain: twenty coins, 98 buyers and the change, signed and accepted', async () => {
    const w = throwawayWallet();
    const { listed, coins } = coinsOf(w, Array.from({ length: MAX_INPUTS }, () => 5n * LANA));
    const allocations = Array.from({ length: MAX_PAY_OUTPUTS }, () => ({ address: throwawayAddress(), lanoshis: LANA }));
    const plan = planPayout({ from: w.address, coins, allocations, nowSec: NOW_SEC });
    assert.ok(plan.ok, plan.ok === true ? '' : plan.detail);
    if (!plan.ok) return;
    assert.equal(plan.coins.length, MAX_INPUTS);
    const signed = await signPayoutTx({ from: w.address, pay: plan.pay, coins: plan.coins, nowSec: NOW_SEC, privateKey: w.privateKey, compressed: true });
    assert.ok(signed.ok, signed.ok === true ? '' : signed.detail);
    if (!signed.ok) return;
    assert.equal(decodeTx(signed.rawTx).outputs.length, MAX_PAY_OUTPUTS + 1);
    assert.ok(signed.rawTx.length / 2 < 500_000, 'far below the node’s 500,000 bytes');
    assert.ok(signed.fee <= payoutMaxFee(MAX_PAY_OUTPUTS));
    assert.deepEqual(serverAccepts(signed.rawTx, allocations, listed, w.address, NOW_SEC), []);
  });
});

describe('the key must open exactly the payout wallet', () => {
  it('the same secret in its other form is another wallet: refused before anything is signed, naming the wallet it opens', async () => {
    const p = await signedPayout({ compressed: true });
    const other = throwawayWallet(false, p.wallet.privateKey);
    const r = await signPayoutTx({ from: p.wallet.address, pay: p.plan.pay, coins: p.plan.coins, nowSec: NOW_SEC, privateKey: p.wallet.privateKey, compressed: false });
    assert.deepEqual(r, { ok: false, code: 'KEY_NOT_SOURCE', detail: `this key opens ${other.address}, not the payout wallet ${p.wallet.address}` });
  });

  it('another key is refused, and so is a key that is not one', async () => {
    const p = await signedPayout();
    const base = { from: p.wallet.address, pay: p.plan.pay, coins: p.plan.coins, nowSec: NOW_SEC };
    const other = throwawayWallet();
    assert.equal((await signPayoutTx({ ...base, privateKey: other.privateKey, compressed: true })).ok, false);
    const N = Uint8Array.from(Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex'));
    const bad: [string, Uint8Array, unknown][] = [
      ['31 bytes', p.wallet.privateKey.slice(1), true],
      ['zero', new Uint8Array(32), true],
      ['the group order', N, true],
      ['no compression flag', p.wallet.privateKey, undefined],
    ];
    for (const [name, privateKey, compressed] of bad) {
      const r = await signPayoutTx({ ...base, privateKey, compressed: compressed as boolean });
      assert.equal(r.ok === true ? 'ok' : r.code, 'BAD_KEY', name);
    }
  });
});

describe('nTime: the server’s clock, never before a coin it spends', () => {
  it('a coin dated after the server’s clock moves nTime to it; within ten minutes, the server accepts it', async () => {
    const w = throwawayWallet();
    const { listed, coins } = coinsOf(w, [10n * LANA], NOW_SEC + 300);
    assert.equal(payoutNTime(NOW_SEC, coins), NOW_SEC + 300);
    const allocations = [{ address: throwawayAddress(), lanoshis: 2n * LANA }];
    const plan = planPayout({ from: w.address, coins, allocations, nowSec: NOW_SEC });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.equal(plan.nTime, NOW_SEC + 300);
    const signed = await signPayoutTx({ from: w.address, pay: plan.pay, coins: plan.coins, nowSec: NOW_SEC, privateKey: w.privateKey, compressed: true });
    assert.ok(signed.ok);
    if (signed.ok) assert.deepEqual(serverAccepts(signed.rawTx, allocations, listed, w.address, NOW_SEC), []);
  });

  it(`more than ${DEFAULT_MAX_AHEAD_SEC / 60} minutes ahead: the plan and the signer both say wait, and sign nothing`, async () => {
    const w = throwawayWallet();
    const { coins } = coinsOf(w, [10n * LANA], NOW_SEC + DEFAULT_MAX_AHEAD_SEC + 1);
    const allocations = [{ address: throwawayAddress(), lanoshis: 2n * LANA }];
    const plan = planPayout({ from: w.address, coins, allocations, nowSec: NOW_SEC });
    assert.equal(plan.ok === true ? 'ok' : plan.code, 'SHAPE');
    if (plan.ok === false) assert.match(plan.detail, /^NTIME_AHEAD: .* it can be spent in 1 s$/);
    const pay = [{ address: allocations[0].address, lanoshis: 2n * LANA }];
    const r = await signPayoutTx({ from: w.address, pay, coins, nowSec: NOW_SEC, privateKey: w.privateKey, compressed: true });
    assert.equal(r.ok === true ? 'ok' : r.code, 'SHAPE');
  });

  it('the server refuses a payout dated an hour before its clock, or more than ten minutes after', async () => {
    const p = await signedPayout();
    assert.deepEqual(serverAccepts(p.signed.rawTx, p.allocations, p.listed, p.wallet.address, NOW_SEC + 3601), ['NTIME_TOO_OLD']);
    assert.deepEqual(serverAccepts(p.signed.rawTx, p.allocations, p.listed, p.wallet.address, NOW_SEC - 601), ['NTIME_AHEAD']);
  });
});

describe('what the plan refuses, before the key is asked for', () => {
  const w = throwawayWallet();
  const { coins } = coinsOf(w, [20n * LANA, 15n * LANA, 1n * LANA]);
  const plan = (allocations: Allocation[], c: readonly Prevout[] = coins) => planPayout({ from: w.address, coins: c, allocations, nowSec: NOW_SEC });

  it('allocations that are not a payout', () => {
    const r = plan([{ address: throwawayAddress(), lanoshis: LANA + 1n }]);
    assert.equal(r.ok === true ? 'ok' : r.code, 'ALLOCATIONS');
    if (r.ok === false && r.code === 'ALLOCATIONS') assert.deepEqual(r.problems.map((x) => x.code), ['NOT_STEP']);
  });

  it('more than the wallet holds: INSUFFICIENT, by how much', () => {
    const r = plan([{ address: throwawayAddress(), lanoshis: 36n * LANA }]);
    assert.equal(r.ok === true ? 'ok' : r.code, 'INSUFFICIENT');
    if (r.ok === false && r.code === 'INSUFFICIENT') assert.equal(r.shortBy, feeFor(3, 1));
  });

  it('more than twenty coins needed: consolidate first', () => {
    const many = coinsOf(w, Array.from({ length: 25 }, () => 2n * LANA)).coins;
    const r = plan([{ address: throwawayAddress(), lanoshis: 45n * LANA }], many);
    assert.equal(r.ok === true ? 'ok' : r.code, 'TOO_MANY_INPUTS');
    if (r.ok === false) assert.match(r.detail, /consolidate/);
  });

  it('a payment back to the payout wallet itself', () => {
    const r = plan([{ address: w.address, lanoshis: LANA }]);
    assert.equal(r.ok === true ? 'ok' : r.code, 'SHAPE');
    if (r.ok === false && r.code === 'SHAPE') assert.deepEqual(r.problems.map((x) => x.code), ['PAY_TO_SOURCE']);
  });

  it('the fee cap: twenty inputs, change, and a remainder under dust (1,051,700 lanoshis for one buyer)', () => {
    assert.equal(payoutMaxFee(1), 1_051_700n);
    assert.equal(payoutMaxFee(4), feeFor(MAX_INPUTS, 5) + DUST_LANOSHIS);
  });
});

describe('what the signer refuses when the plan was changed after it was made', () => {
  it('a coin of another wallet, or a payment below dust: SHAPE, nothing signed', async () => {
    const p = await signedPayout();
    const base = { from: p.wallet.address, nowSec: NOW_SEC, privateKey: p.wallet.privateKey, compressed: true };
    const foreign = coinsOf(throwawayWallet(), [20n * LANA]).coins;
    const a = await signPayoutTx({ ...base, pay: p.plan.pay, coins: [foreign[0], p.plan.coins[1]] });
    assert.equal(a.ok === true ? 'ok' : a.code, 'SHAPE');
    if (a.ok === false) assert.match(a.detail, /INPUT_NOT_FROM_SOURCE/);
    const b = await signPayoutTx({ ...base, pay: [{ ...p.plan.pay[0], lanoshis: DUST_LANOSHIS - 1n }], coins: p.plan.coins });
    assert.equal(b.ok === true ? 'ok' : b.code, 'SHAPE');
  });

  it('the server refuses outputs the allocations do not give, one lanoshi or one place off', async () => {
    const p = await signedPayout();
    const [first, second, ...rest] = p.allocations;
    // The same transaction, announced with allocations that would put other outputs in it.
    assert.deepEqual(serverAccepts(p.signed.rawTx, [second, first, ...rest], p.listed, p.wallet.address, NOW_SEC), ['OUTPUT_ADDRESS', 'OUTPUT_VALUE', 'OUTPUT_ADDRESS', 'OUTPUT_VALUE']);
    assert.deepEqual(serverAccepts(p.signed.rawTx, [{ ...first, lanoshis: first.lanoshis + 1_000n }, second, ...rest], p.listed, p.wallet.address, NOW_SEC), ['OUTPUT_VALUE', 'CHANGE_RULE']);
    assert.deepEqual(serverAccepts(p.signed.rawTx, [first, second, ...rest.slice(0, -1)], p.listed, p.wallet.address, NOW_SEC), ['OUTPUT_COUNT', 'CHANGE_RULE']);
    // Announced as another wallet's payout: every input is from the wrong wallet, and the key is not that wallet's.
    const elsewhere = serverAccepts(p.signed.rawTx, p.allocations, p.listed, throwawayAddress(), NOW_SEC);
    assert.ok(elsewhere.includes('INPUT_NOT_FROM_SOURCE') && elsewhere.includes('PUBKEY_NOT_SOURCE') && elsewhere.includes('CHANGE_ADDRESS'), elsewhere.join(', '));
  });
});

describe('checkPayoutTx(): the server’s check of an announced payout', () => {
  it('accepted: the txid from the bytes, the fee, the change and the outputs the allocations give', async () => {
    const p = await signedPayout();
    const r = checkPayoutTx({ rawTx: p.signed.rawTx, allocations: p.allocations, prevouts: prevoutsOf(p.signed.rawTx, p.listed), from: p.wallet.address, nowSec: NOW_SEC });
    assert.deepEqual(r, { ok: true, txid: p.signed.txid, fee: p.plan.fee, change: p.plan.change, pay: p.plan.pay, nTime: NOW_SEC });
  });

  it('bytes that are not one lowercase transaction of at most 500,000 bytes: MALFORMED, before anything else is read', async () => {
    const p = await signedPayout();
    const base = { allocations: p.allocations, prevouts: prevoutsOf(p.signed.rawTx, p.listed), from: p.wallet.address, nowSec: NOW_SEC };
    for (const rawTx of [p.signed.rawTx.toUpperCase(), p.signed.rawTx + '0', p.signed.rawTx + '00', '', 'zz', ` ${p.signed.rawTx}`, 42 as unknown as string, '00'.repeat(MAX_TX_BYTES + 1)]) {
      const r = checkPayoutTx({ ...base, rawTx });
      assert.equal(r.ok === true ? 'ok' : r.code, 'MALFORMED', String(rawTx).slice(0, 20));
    }
  });

  it('allocations that are not a payout: ALLOCATIONS', async () => {
    const p = await signedPayout();
    const r = checkPayoutTx({ rawTx: p.signed.rawTx, allocations: [], prevouts: prevoutsOf(p.signed.rawTx, p.listed), from: p.wallet.address, nowSec: NOW_SEC });
    assert.equal(r.ok === true ? 'ok' : r.code, 'ALLOCATIONS');
  });

  it('the right shape with a signature the network would refuse (its high-S twin): SIGNATURE', async () => {
    const p = await signedPayout();
    const tx = decodeTx(p.signed.rawTx);
    const sig = parseP2pkhScriptSig(tx.inputs[1].scriptSigHex)!;
    const lenR = sig.signatureDer[3];
    const r = BigInt('0x' + bytesToHex(sig.signatureDer.subarray(4, 4 + lenR)));
    const s = BigInt('0x' + bytesToHex(sig.signatureDer.subarray(6 + lenR)));
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const twin = encodeTxHex({ ...tx, inputs: tx.inputs.map((x, i) => (i === 1 ? { ...x, scriptSigHex: p2pkhScriptSigHex(encodeDER(r, N - s), sig.publicKey) } : x)) });
    const out = checkPayoutTx({ rawTx: twin, allocations: p.allocations, prevouts: prevoutsOf(twin, p.listed), from: p.wallet.address, nowSec: NOW_SEC });
    assert.equal(out.ok === true ? 'ok' : out.code, 'SIGNATURE');
    if (out.ok === false) assert.match(out.detail, /input 1: high S/);
  });

  it('coins given in another order than the inputs: refused, never matched up by guessing', async () => {
    const p = await signedPayout();
    const prevouts = prevoutsOf(p.signed.rawTx, p.listed).reverse();
    const r = checkPayoutTx({ rawTx: p.signed.rawTx, allocations: p.allocations, prevouts, from: p.wallet.address, nowSec: NOW_SEC });
    assert.equal(r.ok === true ? 'ok' : r.code, 'SHAPE');
    if (r.ok === false) assert.match(r.detail, /PREVOUT_MISMATCH/);
  });
});
