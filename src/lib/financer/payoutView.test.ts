// @vitest-environment node
/**
 * payoutView.ts: the financer's send as the /financer page plans it from the
 * server's prepare answer — at the brain's exact leg amounts (step 1 lanoshi,
 * never Krog Menjave's 1,000), from coins read out of their own transactions,
 * at the server's clock — and every reason there is no send, as a code.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  announceInDoubt,
  checkOwnSend,
  coinsOf,
  leastShortfall,
  lanoshisText,
  planOfPrepared,
  readLanoshis,
  serverNowSec,
  type PreparedSend,
} from './payoutView.ts';
import { p2pkScriptHex } from '../../../server/shared/lana-tx/address.ts';
import { feeFor, MAX_INPUTS } from '../../../server/shared/lana-tx/fee.ts';
import { MAX_PAY_OUTPUTS } from '../../../server/shared/lana-tx/payments.ts';
import { planPayout, signPayoutTx } from '../../../server/shared/lana-tx/payout.ts';
import { decodeTx } from '../../../server/shared/lana-tx/codec.ts';
import { LANA, listedCoins, NOW_SEC, parentWithOutputs, throwawayAddress, throwawayWallet, type ThrowawayWallet } from '../../../server/shared/lana-tx/fixtures/wallets.ts';

// Signing with two libraries' checks, and 98-wallet plans, while the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 });

/** Real leg amounts of brain_lana_orders (8. 10. 2026), in lanoshis, as JSON carries them. */
const LEG = { a: '1004492188', b: '10338867187', c: '3446289063' } as const;

/** The server's prepare answer for a wallet holding `values` (confirmed coins), paying `allocations`. */
function prepare(wallet: ThrowawayWallet, values: bigint[], allocations: PreparedSend['allocations']): PreparedSend {
  return {
    wallet: wallet.address,
    coins: listedCoins(wallet.address, values, NOW_SEC - 3600).map((c) => ({ ...c, value: c.value.toString() })),
    allocations,
    nowSec: NOW_SEC,
  };
}

function plannedOf(prepared: PreparedSend) {
  const coins = coinsOf(prepared);
  if (!coins.ok) throw new Error('coins');
  return { coins: coins.coins, page: planOfPrepared(prepared, coins.coins, NOW_SEC) };
}

describe('amounts', () => {
  it('lanoshis as LANA, exact, written as this site writes money', () => {
    expect(lanoshisText(100_449_218_800n)).toBe('1,004.492188');
    expect(lanoshisText(1_004_492_188n)).toBe('10.04492188');
    expect(lanoshisText(1n)).toBe('0.00000001');
    expect(lanoshisText(0n)).toBe('0.00');
    expect(lanoshisText(100_000_000n)).toBe('1.00');
    expect(lanoshisText(50_000_000n)).toBe('0.50');
    expect(lanoshisText(-1_034_000n)).toBe('-0.01034');
    expect(lanoshisText(2_100_000_000_000_000n)).toBe('21,000,000.00');
  });

  it('lanoshis from JSON: digits, or a whole number held exactly — never a float, never a guess', () => {
    expect(readLanoshis(LEG.b)).toBe(10_338_867_187n);
    expect(readLanoshis(1_004_492_188)).toBe(1_004_492_188n);
    expect(readLanoshis('0')).toBe(0n);
    for (const bad of [1.5, -1, 2 ** 53, '1e9', '1.5', '-5', ' 5', '', null, undefined, {}, '12345678901234567890']) expect(readLanoshis(bad)).toBeNull();
  });

  it('the server’s clock carried forward by this device’s elapsed time — never this device’s clock itself', () => {
    expect(serverNowSec(NOW_SEC, 1_000_000, 1_000_000)).toBe(NOW_SEC);
    expect(serverNowSec(NOW_SEC, 1_000_000, 1_061_999)).toBe(NOW_SEC + 61);
    expect(serverNowSec(NOW_SEC, 1_000_000, 900_000)).toBe(NOW_SEC); // a clock stepped back: never before what the server said
  });
});

describe('the coins', () => {
  it('each read from its own transaction: one listed with another value refuses them all; one paid to the wallet’s key is left out', () => {
    const wallet = throwawayWallet();
    const good = prepare(wallet, [5n * LANA, 2n * LANA], []);
    const read = coinsOf(good);
    expect(read.ok && read.balance).toBe(7n * LANA);
    const lie = { ...good, coins: good.coins.map((c, i) => (i === 0 ? { ...c, value: (6n * LANA).toString() } : c)) };
    expect(coinsOf(lie)).toEqual({ ok: false });
    const float = { ...good, coins: good.coins.map((c, i) => (i === 0 ? { ...c, value: 5.5 } : c)) };
    expect(coinsOf(float)).toEqual({ ok: false });
    const unconfirmed = { ...good, coins: good.coins.map((c, i) => (i === 0 ? { ...c, height: 0 } : c)) };
    expect(coinsOf(unconfirmed)).toEqual({ ok: false });
    // A staking reward: paid to the wallet's public key, listed under its address.
    const staking = parentWithOutputs([{ value: 3n * LANA, scriptPubKeyHex: p2pkScriptHex(wallet.publicKey) }], NOW_SEC - 3600);
    const withStaking = { ...good, coins: [...good.coins, { txid: staking.txid, vout: 0, value: (3n * LANA).toString(), height: 100, rawTx: staking.raw }] };
    const skipped = coinsOf(withStaking);
    expect(skipped.ok && [skipped.balance, skipped.skipped]).toEqual([7n * LANA, 1]);
  });
});

describe('the send planned', () => {
  it('real legs plan to the lanoshi — one output per wallet, in the server’s order — where Krog Menjave’s step refuses them', () => {
    const wallet = throwawayWallet();
    const [buyer, caretaker, budget] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
    const prepared = prepare(wallet, [100n * LANA, 50n * LANA, 1n * LANA], [
      { wallet: buyer, lanoshis: LEG.a, orderIds: ['o1', 'o4'] },
      { wallet: caretaker, lanoshis: LEG.b, orderIds: ['o2'] },
      { wallet: budget, lanoshis: LEG.c, orderIds: ['o3'] },
    ]);
    const { coins, page } = plannedOf(prepared);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.plan.pay).toEqual([
      { address: buyer, lanoshis: 1_004_492_188n },
      { address: caretaker, lanoshis: 10_338_867_187n },
      { address: budget, lanoshis: 3_446_289_063n },
    ]);
    expect(page.wallets).toBe(3);
    expect(page.inputs).toBe(2);
    expect(page.plan.nTime).toBe(NOW_SEC);
    expect(page.left).toBe(151n * LANA - page.plan.paying - page.plan.fee);
    expect(page.plan.fee).toBe(feeFor(2, 4));
    // The very plan under Krog Menjave's step: refused — the page must pass this site's step.
    const km = planPayout({ from: wallet.address, coins, allocations: page.plan.pay, nowSec: NOW_SEC });
    expect(km.ok).toBe(false);
  });

  it('every reason there is no send, as a code', () => {
    const wallet = throwawayWallet();
    const a = throwawayAddress();
    expect(plannedOf(prepare(wallet, [5n * LANA], [])).page).toEqual({ ok: false, problem: { code: 'NOTHING' } });
    expect(plannedOf(prepare(wallet, [5n * LANA], [{ wallet: a, lanoshis: '1.5', orderIds: ['o1'] }])).page).toEqual({ ok: false, problem: { code: 'UNREADABLE' } });
    expect(plannedOf(prepare(wallet, [5n * LANA], [{ wallet: 'Lnot-an-address', lanoshis: LEG.a, orderIds: ['o1'] }])).page).toEqual({ ok: false, problem: { code: 'UNREADABLE' } });

    // Under 0.005 LANA to one wallet: its legs wait, named.
    const dust = plannedOf(prepare(wallet, [50n * LANA], [
      { wallet: a, lanoshis: LEG.a, orderIds: ['o1'] },
      { wallet: throwawayAddress(), lanoshis: '499999', orderIds: ['o2', 'o3'] },
    ])).page;
    expect(dust).toEqual({ ok: false, problem: { code: 'BELOW_DUST', orderIds: ['o2', 'o3'] } });

    // More wallets than one send carries.
    const many = Array.from({ length: MAX_PAY_OUTPUTS + 1 }, (_, i) => ({ wallet: throwawayAddress(), lanoshis: String(1_000_000 + i), orderIds: [`o${i}`] }));
    expect(plannedOf(prepare(wallet, [500n * LANA], many)).page).toEqual({ ok: false, problem: { code: 'TOO_MANY_WALLETS', max: 98 } });

    // Not enough: exactly how much more, with the one coin there is and no change.
    const short = plannedOf(prepare(wallet, [10n * LANA], [{ wallet: a, lanoshis: LEG.b, orderIds: ['o1'] }])).page;
    expect(short).toEqual({ ok: false, problem: { code: 'INSUFFICIENT', shortBy: 10_338_867_187n + feeFor(1, 1) - 10n * LANA } });

    // Enough, in too many small coins: consolidate first.
    const crumbs = plannedOf(prepare(wallet, Array.from({ length: MAX_INPUTS + 5 }, () => LANA), [{ wallet: a, lanoshis: String(22n * LANA), orderIds: ['o1'] }])).page;
    expect(crumbs).toEqual({ ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: MAX_INPUTS + 3, max: MAX_INPUTS } });
  });

  it('more coins than the server listed, and the listed ones short: merge the wallet (TOO_MANY_INPUTS), never a top-up figure', () => {
    // Review C20: 600 LANA in 60 coins of 10. The server lists the 40 largest (400 LANA) and counts the other 20. A
    // purchase of 450 LANA needs 46 coins, and at most 20 fit in one send: moving 50 LANA more in would not help.
    const wallet = throwawayWallet();
    const listed = prepare(wallet, Array.from({ length: 40 }, () => 10n * LANA), [{ wallet: throwawayAddress(), lanoshis: String(450n * LANA), orderIds: ['o1'] }]);
    const answer = { ...listed, unlisted: { count: 20, value: String(200n * LANA) } };
    expect(plannedOf(answer).page).toEqual({ ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: 41, max: MAX_INPUTS, atLeast: true } });
    // The same coins with nothing unlisted: the wallet truly holds too little, and how much more is said.
    expect(plannedOf(listed).page).toMatchObject({ ok: false, problem: { code: 'INSUFFICIENT' } });
  });

  it('more coins than listed, and even the whole wallet short: INSUFFICIENT from the whole wallet, with the merge — never »merge« alone (review N12)', () => {
    // 41 coins: 40 of 7 LANA (listed) and one of 0.5 (not listed) — 280.5 LANA in all. The purchases: 300 LANA.
    // Merging cannot help: the wallet is about 20 LANA short. The figure counts the whole wallet and the fee of the
    // largest send (the coins are many), and the plan says to move that in AND merge.
    const wallet = throwawayWallet();
    const listed = prepare(wallet, Array.from({ length: 40 }, () => 7n * LANA), [{ wallet: throwawayAddress(), lanoshis: String(300n * LANA), orderIds: ['o1'] }]);
    const whole = 280n * LANA + LANA / 2n;
    const need = 300n * LANA + feeFor(MAX_INPUTS, 1);
    const expected = { ok: false, problem: { code: 'INSUFFICIENT', shortBy: need - whole, merge: true } };
    const unlisted = { count: 1, value: String(LANA / 2n) };
    // From the server's own balance, and from the coins added up when an answer has none.
    expect(plannedOf({ ...listed, unlisted, balance: { confirmed: whole.toString(), unconfirmed: '0' } }).page).toEqual(expected);
    expect(plannedOf({ ...listed, unlisted }).page).toEqual(expected);
    // Exactly enough in the whole wallet for the largest send: merging alone helps (TOO_MANY_INPUTS); a lanoshi less, not.
    expect(plannedOf({ ...listed, unlisted, balance: { confirmed: need.toString() } }).page).toEqual({ ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: 41, max: MAX_INPUTS, atLeast: true } });
    expect(plannedOf({ ...listed, unlisted, balance: { confirmed: (need - 1n).toString() } }).page).toEqual({ ok: false, problem: { code: 'INSUFFICIENT', shortBy: 1n, merge: true } });
  });

  it('staking coins count as coins not offered: the whole wallet covering the send is never told to move more in (review M9)', () => {
    // A wallet that stakes: 3 staking coins of 100 LANA (never offered, `skipped`), 1 regular coin of 50, nothing unlisted.
    // 120 LANA owed. The confirmed balance (350) covers it; the coin offered does not. Moving 70 more in is not the answer.
    const wallet = throwawayWallet();
    const to = throwawayAddress();
    const staking = { skipped: { count: 3, value: String(300n * LANA) }, unlisted: { count: 0, value: '0' }, balance: { confirmed: String(350n * LANA), unconfirmed: '0' } };
    const owe120 = { ...prepare(wallet, [50n * LANA], [{ wallet: to, lanoshis: String(120n * LANA), orderIds: ['o1'] }]), ...staking };
    expect(plannedOf(owe120).page).toEqual({ ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: 2, max: MAX_INPUTS, atLeast: true } });
    // Owing more than the whole wallet holds: what is missing counted from the whole wallet (350), with the merge.
    const owe400 = { ...prepare(wallet, [50n * LANA], [{ wallet: to, lanoshis: String(400n * LANA), orderIds: ['o1'] }]), ...staking };
    expect(plannedOf(owe400).page).toEqual({ ok: false, problem: { code: 'INSUFFICIENT', shortBy: 400n * LANA + feeFor(MAX_INPUTS, 1) - 350n * LANA, merge: true } });
    // No staking coin and nothing unlisted: the plain shortfall of the coins there are.
    const plain = prepare(wallet, [50n * LANA], [{ wallet: to, lanoshis: String(120n * LANA), orderIds: ['o1'] }]);
    expect(plannedOf(plain).page).toEqual({ ok: false, problem: { code: 'INSUFFICIENT', shortBy: 120n * LANA + feeFor(1, 1) - 50n * LANA } });
  });

  it('what stays in the wallet is the WHOLE confirmed balance less the send — coins not offered for this send included (review N13)', () => {
    // A 5,000 LANA coin and a 30 LANA coin, the 30 the coin of an earlier refused send: the server offers only it (and
    // smaller ones), so the 5,000 coin is neither offered nor counted as not listed. It stays in the wallet all the same.
    const wallet = throwawayWallet();
    const offered = prepare(wallet, [30n * LANA], [{ wallet: throwawayAddress(), lanoshis: String(20n * LANA), orderIds: ['o1'] }]);
    const page = plannedOf({ ...offered, balance: { confirmed: String(5_030n * LANA), unconfirmed: '0' } }).page;
    if (page.ok === false) throw new Error(page.problem.code);
    expect(page.left).toBe(5_030n * LANA - 20n * LANA - page.plan.fee);
    expect(page.left).toBeGreaterThan(5_000n * LANA);
    // A balance that says less than the coins offered leave is not believed below them.
    const low = plannedOf({ ...offered, balance: { confirmed: String(1n * LANA) } }).page;
    if (low.ok === false) throw new Error(low.problem.code);
    expect(low.left).toBe(low.plan.left);
  });

  it('what stays in the wallet counts the coins the server did not list, and the staking coins', () => {
    const wallet = throwawayWallet();
    const prepared = prepare(wallet, [100n * LANA, 50n * LANA], [{ wallet: throwawayAddress(), lanoshis: LEG.b, orderIds: ['o1'] }]);
    const alone = plannedOf(prepared).page;
    const withRest = plannedOf({ ...prepared, unlisted: { count: 3, value: String(7n * LANA) }, skipped: { count: 1, value: String(2n * LANA) } }).page;
    if (alone.ok === false || withRest.ok === false) throw new Error('plan');
    expect(alone.left).toBe(150n * LANA - alone.plan.paying - alone.plan.fee);
    expect(withRest.left).toBe(alone.left + 9n * LANA);
    expect(withRest.plan).toEqual(alone.plan);
  });

  it('a coin dated after the server’s clock waits: AHEAD', () => {
    const wallet = throwawayWallet();
    const prepared = { ...prepare(wallet, [], [{ wallet: throwawayAddress(), lanoshis: LEG.a, orderIds: ['o1'] }]) };
    prepared.coins = listedCoins(wallet.address, [50n * LANA], NOW_SEC + 3600).map((c) => ({ ...c, value: c.value.toString() }));
    expect(plannedOf(prepared).page).toEqual({ ok: false, problem: { code: 'AHEAD' } });
  });
});

describe('the page’s own check of what it signed', () => {
  it('the signed bytes pass the server’s rule against the allocations; one lanoshi off in the answer and they do not', async () => {
    for (const compressed of [true, false]) {
      const wallet = throwawayWallet(compressed);
      const prepared = prepare(wallet, [100n * LANA, 50n * LANA], [
        { wallet: throwawayAddress(), lanoshis: LEG.b, orderIds: ['o1'] },
        { wallet: throwawayAddress(), lanoshis: LEG.c, orderIds: ['o2'] },
      ]);
      const { coins, page } = plannedOf(prepared);
      if (page.ok === false) throw new Error(page.problem.code);
      const signed = await signPayoutTx({ from: wallet.address, pay: page.plan.pay, coins: page.plan.coins, nowSec: NOW_SEC, privateKey: wallet.privateKey, compressed });
      if (signed.ok === false) throw new Error(signed.detail);
      expect(decodeTx(signed.rawTx).outputs.slice(0, 2).map((o) => o.value)).toEqual([10_338_867_187n, 3_446_289_063n]);
      const own = checkOwnSend(signed.rawTx, prepared, coins, NOW_SEC);
      expect(own.ok && own.txid).toBe(signed.txid);
      const off = { ...prepared, allocations: prepared.allocations.map((a, i) => (i === 0 ? { ...a, lanoshis: '10338867186' } : a)) };
      const refused = checkOwnSend(signed.rawTx, off, coins, NOW_SEC);
      expect(refused.ok).toBe(false);
      expect(checkOwnSend(signed.rawTx, { ...prepared, allocations: [{ ...prepared.allocations[0], lanoshis: 'x' }] }, coins, NOW_SEC).ok).toBe(false);
    }
  });
});

describe('what the page tells before any coin is chosen, and after an announce', () => {
  it('the least that is missing: the legs and the smallest send’s fee, less the confirmed balance', () => {
    expect(leastShortfall(10n * LANA, 5n * LANA, 1)).toBe(5n * LANA + feeFor(1, 1));
    expect(leastShortfall(10n * LANA, 11n * LANA, 3)).toBe(0n);
    expect(leastShortfall(0n, 0n, 1)).toBe(0n);
    expect(leastShortfall(10n * LANA, 0n, 0)).toBe(0n);
  });

  it('an announce in doubt is repeated with the same bytes; a refusal is the server’s word', () => {
    for (const status of [null, undefined, 0, 408, 425, 429, 500, 502, 503, 504]) expect(announceInDoubt(status)).toBe(true);
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422]) expect(announceInDoubt(status)).toBe(false);
  });
});
