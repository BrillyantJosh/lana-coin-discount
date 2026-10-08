// @vitest-environment node
/**
 * select.ts: which coins pay a payout, and that every coin is what its own
 * previous transaction says it is.
 *
 * The choosing rule is the archived km-signer's (selectCoins, deliver branch),
 * here with as many payment outputs as the payout pays wallets. Its tests came
 * along and still hold; the new ones walk the change rule one lanoshi at a time
 * and check the choice on thousands of random wallets against the rule itself.
 * Made-up coins and throwaway addresses only (fixtures/wallets.ts).
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { p2pkScriptHex, scriptOfAddress } from './address.ts';
import { decodeTx, encodeTxHex } from './codec.ts';
import { DUST_LANOSHIS, feeFor, MAX_INPUTS, settle } from './fee.ts';
import { INPUT_FEE_LANOSHIS, selectPayoutCoins, verifiedCoins, type Coin, type ListedCoin } from './select.ts';
import { buildUnsignedTx, checkShape, prevoutFromRawTx } from './shape.ts';
import { LANA, listedCoins, parentPaying, parentWithOutputs, throwawayAddress, throwawayWallet } from './fixtures/wallets.ts';

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};

/** A coin of `v` lanoshis, numbered so two coins never share a txid. */
const coin = (v: bigint, n: number): Coin => ({ txid: n.toString(16).padStart(64, '0'), vout: 0, value: v });
const coinsOf = (n: number, value: bigint, from: number): Coin[] => Array.from({ length: n }, (_, i) => coin(value, from + i));

describe('selectPayoutCoins(): the km-signer rule, for a payout of several wallets', () => {
  it('one input costs 27,000 lanoshis, so a coin worth no more is never spent', () => {
    assert.equal(INPUT_FEE_LANOSHIS, 27_000n);
    assert.equal(feeFor(2, 1) - feeFor(1, 1), INPUT_FEE_LANOSHIS);
  });

  it('the largest coins first, stopping as soon as the change rule is met', () => {
    const pool = [coin(5n * LANA, 1), coin(60n * LANA, 2), coin(50n * LANA, 3), coin(30n * LANA, 4)];
    for (const outputs of [1, 3, 10]) {
      const r = selectPayoutCoins(pool, 100n * LANA, outputs);
      assert.ok(r.ok, r.ok === true ? '' : r.detail);
      if (!r.ok) continue;
      assert.deepEqual(r.coins.map((c) => c.value / LANA), [60n, 50n]);
      // Change back, the fee for 2 inputs and outputs + change, nothing lost.
      assert.equal(r.fee, feeFor(2, outputs + 1));
      assert.equal(r.totalIn, 110n * LANA);
      assert.equal(r.change, 110n * LANA - 100n * LANA - r.fee);
    }
  });

  it('the fee grows with every wallet paid: 34 bytes an output at 150 lanoshis', () => {
    const pool = [coin(1_000n * LANA, 1)];
    const one = selectPayoutCoins(pool, 10n * LANA, 1);
    const five = selectPayoutCoins(pool, 10n * LANA, 5);
    assert.ok(one.ok && five.ok);
    if (one.ok && five.ok) assert.equal(five.fee - one.fee, 4n * 34n * 150n);
  });

  it('dust sent to the payout wallet cannot jam it: coins worth no more than their own fee are left alone', () => {
    const pool = [...coinsOf(25, INPUT_FEE_LANOSHIS, 1), ...coinsOf(25, 10_400n, 100), coin(200n * LANA, 500)];
    const r = selectPayoutCoins(pool, 100n * LANA, 2);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.coins.map((c) => c.value), [200n * LANA]);
    // A coin one lanoshi above its input fee is worth spending, and is spent when needed.
    // 10 LANA alone leave one lanoshi less than the fee of one input; the small coin adds that lanoshi.
    const edge = selectPayoutCoins([...coinsOf(30, INPUT_FEE_LANOSHIS, 1), coin(INPUT_FEE_LANOSHIS + 1n, 99), coin(10n * LANA, 98)], 10n * LANA - feeFor(1, 1) + 1n, 1);
    assert.ok(edge.ok, edge.ok === true ? '' : edge.detail);
    if (edge.ok) assert.deepEqual(edge.coins.map((c) => c.value), [10n * LANA, INPUT_FEE_LANOSHIS + 1n]);
  });

  it(`more than ${MAX_INPUTS} coins needed → TOO_MANY_INPUTS, "consolidate first"; not enough → INSUFFICIENT`, () => {
    const tiny = coinsOf(30, 5n * LANA, 1);
    const many = selectPayoutCoins(tiny, 100n * LANA, 3);
    assert.equal(many.ok, false);
    if (!many.ok) {
      assert.equal(many.code, 'TOO_MANY_INPUTS');
      if (many.code === 'TOO_MANY_INPUTS') assert.equal(many.needed, 21);
      assert.match(many.detail, /consolidate/);
    }
    // Twenty is still fine.
    const twenty = selectPayoutCoins(tiny, 95n * LANA, 3);
    assert.ok(twenty.ok);
    if (twenty.ok) assert.equal(twenty.coins.length, 20);
    const short = selectPayoutCoins(tiny.slice(0, 3), 100n * LANA, 1);
    assert.equal(short.ok, false);
    if (!short.ok && short.code === 'INSUFFICIENT') assert.equal(short.shortBy, 100n * LANA + feeFor(3, 1) - 15n * LANA);
    else assert.fail('expected INSUFFICIENT');
  });

  it('an empty wallet, or one holding only dust, is short by the payout and the smallest fee', () => {
    for (const pool of [[], coinsOf(10, 10_400n, 1)]) {
      const r = selectPayoutCoins(pool, 7n * LANA, 4);
      assert.equal(r.ok, false);
      if (!r.ok && r.code === 'INSUFFICIENT') assert.equal(r.shortBy, 7n * LANA + feeFor(1, 4));
      else assert.fail('expected INSUFFICIENT');
    }
  });

  it('one lanoshi decides, both ways, and nothing is lost on either side', () => {
    const paying = 3n * LANA;
    for (const outputs of [1, 2, 7]) {
      // Exactly the payments and the fee without change: paid, no change output.
      const exact = paying + feeFor(1, outputs);
      const r = selectPayoutCoins([coin(exact, 1)], paying, outputs);
      assert.ok(r.ok);
      if (r.ok) assert.deepEqual([r.change, r.fee], [0n, feeFor(1, outputs)]);
      const less = selectPayoutCoins([coin(exact - 1n, 1)], paying, outputs);
      assert.equal(less.ok, false);
      if (!less.ok && less.code === 'INSUFFICIENT') assert.equal(less.shortBy, 1n);
      // Change comes back from exactly dust on.
      const withChange = paying + feeFor(1, outputs + 1) + DUST_LANOSHIS;
      const c = selectPayoutCoins([coin(withChange, 1)], paying, outputs);
      assert.ok(c.ok);
      if (c.ok) assert.deepEqual([c.change, c.fee], [DUST_LANOSHIS, feeFor(1, outputs + 1)]);
      const under = selectPayoutCoins([coin(withChange - 1n, 1)], paying, outputs);
      assert.ok(under.ok);
      if (under.ok) assert.deepEqual([under.change, under.fee], [0n, withChange - 1n - paying]);
    }
  });

  it('the same coins give the same choice, in whatever order the server lists them', () => {
    const pool = [...coinsOf(6, 40n * LANA, 1), ...coinsOf(6, 40n * LANA, 50).map((c) => ({ ...c, vout: 3 })), coin(10n * LANA, 90)];
    const first = selectPayoutCoins(pool, 150n * LANA, 2);
    assert.ok(first.ok);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const again = selectPayoutCoins(shuffled, 150n * LANA, 2);
      assert.deepEqual(again, first);
    }
  });

  it('refuses arguments that are not a payout', () => {
    assert.throws(() => selectPayoutCoins([coin(LANA, 1)], 0n, 1));
    assert.throws(() => selectPayoutCoins([coin(LANA, 1)], LANA, 0));
    assert.throws(() => selectPayoutCoins([coin(LANA, 1)], 1 as unknown as bigint, 1));
    assert.throws(() => selectPayoutCoins([{ ...coin(LANA, 1), value: 5 as unknown as bigint }], LANA, 1));
    assert.throws(() => selectPayoutCoins([coin(LANA, 1)], LANA, 1, 0));
  });

  it('on 3,000 random wallets: as few coins as the rule allows, and what it chooses builds and checks', () => {
    let seed = 11;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % k;
    };
    const from = throwawayAddress();
    const payees = Array.from({ length: 6 }, throwawayAddress);
    let paid = 0;
    for (let i = 0; i < 3000; i++) {
      const pool = Array.from({ length: rnd(30) }, (_, k) => coin(BigInt(1 + rnd(50)) * BigInt(10 ** rnd(9)), i * 100 + k));
      const pay = Array.from({ length: 1 + rnd(payees.length) }, (_, k) => ({ address: payees[k], lanoshis: DUST_LANOSHIS + BigInt(rnd(2_000_000_000)) }));
      const paying = pay.reduce((s, p) => s + p.lanoshis, 0n);
      const r = selectPayoutCoins(pool, paying, pay.length);
      const worth = pool.filter((c) => c.value > INPUT_FEE_LANOSHIS).sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
      // The largest-first prefix that first meets the rule, computed the slow way.
      let k = 0;
      while (k < worth.length && !settle(worth.slice(0, k + 1).reduce((s, c) => s + c.value, 0n), paying, k + 1, pay.length).ok) k++;
      if (k === worth.length) {
        assert.equal(r.ok === true ? 'ok' : r.code, 'INSUFFICIENT');
        continue;
      }
      if (k + 1 > MAX_INPUTS) {
        assert.equal(r.ok === true ? 'ok' : r.code, 'TOO_MANY_INPUTS');
        continue;
      }
      assert.ok(r.ok, r.ok === true ? '' : r.detail);
      if (!r.ok) continue;
      assert.equal(r.coins.length, k + 1);
      assert.equal(paying + r.fee + r.change, r.totalIn);
      // Built from these coins, the transaction is exactly what the checker wants.
      const withScripts = r.coins.map((c) => ({ ...c, scriptPubKeyHex: scriptOfAddress(from), txNTime: 1 }));
      const built = buildUnsignedTx({ from, pay, change: from, coins: withScripts, nTime: 1_800_000_000, maxFee: feeFor(MAX_INPUTS, pay.length + 1) + DUST_LANOSHIS });
      assert.ok(built.ok, built.ok === true ? '' : JSON.stringify(built.problems));
      if (built.ok) {
        assert.deepEqual([built.fee, built.change], [r.fee, r.change]);
        const again = checkShape(decodeTx(encodeTxHex(built.tx)), withScripts, { from, pay, change: from, maxFee: feeFor(MAX_INPUTS, pay.length + 1) + DUST_LANOSHIS, nowSec: 1_800_000_000, signed: false });
        assert.ok(again.ok);
      }
      paid++;
    }
    assert.ok(paid > 500, `only ${paid} of 3000 could pay`);
  });
});

describe('verifiedCoins(): a coin is believed only from its own previous transaction', () => {
  const NOW = 1_800_000_000;

  it('confirmed coins of the wallet, re-hashed to their txids, with their value, script and nTime', () => {
    const wallet = throwawayAddress();
    const listed = listedCoins(wallet, [5n * LANA, 7n * LANA, 123_456n], NOW - 600);
    const r = verifiedCoins(listed, wallet);
    assert.ok(r.ok, r.ok === true ? '' : r.problems.join('; '));
    if (!r.ok) return;
    assert.equal(r.balance, 12n * LANA + 123_456n);
    assert.deepEqual(r.coins.map((c) => [c.txid, c.vout, c.value, c.txNTime]), listed.map((c) => [c.txid, 0, c.value, NOW - 600]));
  });

  it('a coin in the middle of a parent with several outputs, and a parent sent in capitals', () => {
    const wallet = throwawayAddress();
    const p = parentPaying(wallet, [LANA, 2n * LANA, 3n * LANA], NOW);
    const r = verifiedCoins([{ txid: p.txid, vout: 1, value: 2n * LANA, height: 5, rawTx: p.raw.toUpperCase() }], wallet);
    assert.ok(r.ok, r.ok === true ? '' : r.problems.join('; '));
  });

  it('real mainnet coins: the inputs of the 20-input consolidation, as their wallet’s coins', () => {
    const c = mainnet.cases.find((x) => x.name === 'ld-consolidation')!;
    const tx = decodeTx(mainnet.transactions[c.txid]);
    const listed: ListedCoin[] = tx.inputs.map((i) => {
      const raw = mainnet.transactions[i.prevTxid];
      return { txid: i.prevTxid, vout: i.vout, value: prevoutFromRawTx(raw, i.prevTxid, i.vout).value, height: 1, rawTx: raw };
    });
    const r = verifiedCoins(listed, c.from);
    assert.ok(r.ok, r.ok === true ? '' : r.problems.join('; '));
    if (r.ok) assert.equal(r.coins.length, 20);
  });

  it('a coin paid to the wallet’s own public key (a staking reward) is left out and counted apart — never a reason to refuse the others', () => {
    for (const compressed of [true, false]) {
      const w = throwawayWallet(compressed);
      const good = listedCoins(w.address, [5n * LANA], NOW)[0];
      const reward = parentWithOutputs([{ value: 7n * LANA, scriptPubKeyHex: p2pkScriptHex(w.publicKey) }], NOW);
      const r = verifiedCoins([{ txid: reward.txid, vout: 0, value: 7n * LANA, height: 9, rawTx: reward.raw }, good], w.address);
      assert.ok(r.ok, r.ok === true ? '' : r.problems.join('; '));
      if (!r.ok) return;
      assert.deepEqual([r.coins.map((c) => c.txid), r.balance], [[good.txid], 5n * LANA]);
      assert.deepEqual(r.skipped, [{ txid: reward.txid, vout: 0, value: 7n * LANA }]);
      // Its value is still read from its own transaction: listed as more, all are refused.
      assert.equal(verifiedCoins([{ txid: reward.txid, vout: 0, value: 70n * LANA, height: 9, rawTx: reward.raw }, good], w.address).ok, false);
      // Another key's, or the same key in its other form (another wallet): a server that lies — refused, all of them.
      const theirs = parentWithOutputs([{ value: LANA, scriptPubKeyHex: p2pkScriptHex(throwawayWallet().publicKey) }], NOW);
      const otherForm = parentWithOutputs([{ value: LANA, scriptPubKeyHex: p2pkScriptHex(throwawayWallet(!compressed, w.privateKey).publicKey) }], NOW);
      for (const p of [theirs, otherForm]) {
        const refused = verifiedCoins([good, { txid: p.txid, vout: 0, value: LANA, height: 9, rawTx: p.raw }], w.address);
        assert.equal(refused.ok, false);
        if (!refused.ok) assert.match(refused.problems.join('; '), /not locked to/);
      }
    }
  });

  it('refuses them all when one coin is wrong, and says which and why', () => {
    const wallet = throwawayAddress();
    const other = throwawayAddress();
    const good = listedCoins(wallet, [5n * LANA], NOW)[0];
    const cases: [string, ListedCoin[], RegExp][] = [
      ['a value the transaction does not hold', [{ ...good, value: 50n * LANA }], /listed as 5000000000 lanoshis, its transaction says 500000000/],
      ['a coin of another wallet', [listedCoins(other, [5n * LANA], NOW)[0]], /not locked to/],
      ['bytes that do not hash to the txid', [{ ...good, rawTx: listedCoins(wallet, [5n * LANA], NOW)[0].rawTx }], /hashes to/],
      ['an output the transaction does not have', [{ ...good, vout: 1 }], /has no output 1/],
      ['an unconfirmed coin', [{ ...good, height: 0 }], /not confirmed yet/],
      ['a mempool coin (height −1)', [{ ...good, height: -1 }], /not confirmed yet/],
      ['the same coin twice', [good, good], /listed twice/],
      ['a value that is not a bigint', [{ ...good, value: 500000000 as unknown as bigint }], /no valid value/],
      ['a txid that is not 64 lowercase hex', [{ ...good, txid: good.txid.toUpperCase() }], /not a coin/],
      ['no raw transaction at all', [{ ...good, rawTx: undefined as unknown as string }], /not hex/],
    ];
    for (const [name, listed, why] of cases) {
      const r = verifiedCoins([listedCoins(wallet, [LANA], NOW)[0], ...listed], wallet);
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.match(r.problems.join('; '), why, name);
    }
    const notAnAddress = verifiedCoins([good], wallet.slice(0, -1) + (wallet.endsWith('a') ? 'b' : 'a'));
    assert.equal(notAnAddress.ok, false);
  });
});
