// @vitest-environment node
/**
 * What lana.discount changed in Krog Menjave's lana-tx, and why it holds.
 *
 * Krog Menjave pays purchases counted to 5 decimals, so its payments.ts refuses
 * any allocation that is not a whole number of 1,000 lanoshis (LANOSHI_STEP).
 * lana.discount pays the brain's LEGS, and a leg is whatever the brain computed,
 * to the lanoshi: 1,004,492,188 — 10,338,867,187 — 3,446,289,063 (real legs, 8. 10.
 * 2026). With Krog Menjave's step every financer send would be refused, or — had
 * the amounts been rounded to fit — every buyer would be paid up to 999 lanoshis
 * less than the brain records as sent. So the step became a parameter: Krog
 * Menjave's default stays, and lana.discount passes LEG_LANOSHI_STEP (1) in the
 * browser that signs AND on the server that checks.
 *
 * What is proven: the real legs are refused under the default and taken under
 * step 1, through paymentsOf, planPayout, signPayoutTx and checkPayoutTx; the
 * smaller step does not loosen anything else — one lanoshi short is still a
 * different transaction, 98 wallets is still the most; the fee is still this
 * repository's own live function.
 *
 * EVERYTHING ELSE THAT DIFFERS from krog-menjave origin/main a46f618, so a later
 * copy knows what to keep:
 *   - the step: payments.ts paymentsOf(allocations, step), PlanArgs.step and
 *     PayoutCheckArgs.step in payout.ts, LEG_LANOSHI_STEP;
 *   - `x.ok === false` where Krog Menjave writes `!x.ok`, at the few places a
 *     result is read after it (shape.ts, select.ts, fixtures/wallets.ts and
 *     some tests). This repository compiles server/ with strictNullChecks off
 *     (tsconfig.server.json) and src/ with strict off, and there TypeScript
 *     narrows a { ok: true } | { ok: false } result only on an explicit
 *     comparison, never on `!`. The same bytes run the same way; only the type
 *     checker reads them differently;
 *   - every copied test: vitest instead of node:test, its node environment and
 *     a long time limit (signature.pin.test.ts undoes those lines of
 *     signature.test.ts before its hash); browser.test.ts also bundles
 *     src/lib/financer.
 * signature.ts is byte for byte the fleet's (signature.pin.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { decodeTx } from './codec.ts';
import { feeFor, MAX_INPUTS, DUST_LANOSHIS } from './fee.ts';
import { LANOSHI_STEP, LEG_LANOSHI_STEP, MAX_PAY_OUTPUTS, paymentsOf, type Allocation } from './payments.ts';
import { checkPayoutTx, planPayout, signPayoutTx } from './payout.ts';
import { verifiedCoins } from './select.ts';
import { scriptOfAddress } from './address.ts';
import { LANA, listedCoins, NOW_SEC, throwawayAddress, throwawayWallet } from './fixtures/wallets.ts';
import { estimateFeeLanoshis, MAX_TRANSACTION_INPUTS } from '../../lib/transaction.ts';

// Signing and verifying with two libraries, many times over, while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });

/** Real leg amounts of brain_lana_orders (8. 10. 2026), in lanoshis: none a whole number of 1,000. */
const REAL_LEGS = [1_004_492_188n, 10_338_867_187n, 3_446_289_063n] as const;

const codes = (r: ReturnType<typeof paymentsOf>) => (r.ok === true ? [] : r.problems.map((p) => p.code));

/** A financer's wallet with three confirmed coins, the legs of two purchases to three wallets (two legs to one). */
async function financerSend(compressed = true) {
  const wallet = throwawayWallet(compressed);
  const coins = verifiedCoins(listedCoins(wallet.address, [100n * LANA, 50n * LANA, 2n * LANA], NOW_SEC - 3600), wallet.address);
  if (coins.ok === false) throw new Error(coins.problems.join('; '));
  const [buyer, caretaker, budget] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
  const allocations: Allocation[] = [
    { address: buyer, lanoshis: REAL_LEGS[0] },
    { address: caretaker, lanoshis: REAL_LEGS[1] },
    { address: budget, lanoshis: REAL_LEGS[2] },
    { address: buyer, lanoshis: 40_800_000n }, // 0.408 LANA, the smallest leg of 8. 10. 2026 — merged into the buyer's output
  ];
  return { wallet, coins: coins.coins, allocations, buyer, caretaker, budget };
}

describe('the step is a parameter: Krog Menjave keeps 1,000, lana.discount passes 1', () => {
  it('the constants: Krog Menjave’s step unchanged, lana.discount’s is one lanoshi, at most 98 wallets', () => {
    expect(LANOSHI_STEP).toBe(1_000n);
    expect(LEG_LANOSHI_STEP).toBe(1n);
    expect(MAX_PAY_OUTPUTS).toBe(98);
  });

  it('real brain legs: refused under Krog Menjave’s default, taken to the lanoshi under step 1', () => {
    const a = throwawayAddress();
    for (const lanoshis of REAL_LEGS) {
      expect(lanoshis % LANOSHI_STEP).not.toBe(0n);
      expect(codes(paymentsOf([{ address: a, lanoshis }]))).toEqual(['NOT_STEP']);
      expect(codes(paymentsOf([{ address: a, lanoshis }], LANOSHI_STEP))).toEqual(['NOT_STEP']);
      const taken = paymentsOf([{ address: a, lanoshis }], LEG_LANOSHI_STEP);
      expect(taken.ok && taken.pay).toEqual([{ address: a, lanoshis }]);
    }
    const [b, c] = [throwawayAddress(), throwawayAddress()];
    const all = paymentsOf(
      [
        { address: a, lanoshis: REAL_LEGS[0] },
        { address: b, lanoshis: REAL_LEGS[1] },
        { address: a, lanoshis: REAL_LEGS[2] },
        { address: c, lanoshis: 1n + DUST_LANOSHIS },
      ],
      LEG_LANOSHI_STEP,
    );
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    // Still one output per wallet, where it first stands, equal to its sum.
    expect(all.pay).toEqual([
      { address: a, lanoshis: REAL_LEGS[0] + REAL_LEGS[2] },
      { address: b, lanoshis: REAL_LEGS[1] },
      { address: c, lanoshis: 500_001n },
    ]);
    expect(all.paying).toBe(REAL_LEGS[0] + REAL_LEGS[1] + REAL_LEGS[2] + 500_001n);
  });

  it('step 1 loosens nothing else: dust per wallet, 98 wallets, positive amounts, real addresses', () => {
    const a = throwawayAddress();
    expect(codes(paymentsOf([{ address: a, lanoshis: DUST_LANOSHIS - 1n }], LEG_LANOSHI_STEP))).toEqual(['BELOW_DUST']);
    expect(codes(paymentsOf([{ address: a, lanoshis: 0n }], LEG_LANOSHI_STEP))).toEqual(['NOT_POSITIVE']);
    expect(codes(paymentsOf([{ address: a.slice(0, -1) + (a.endsWith('z') ? 'y' : 'z'), lanoshis: REAL_LEGS[0] }], LEG_LANOSHI_STEP))).toEqual(['BAD_ADDRESS']);
    const wallets = Array.from({ length: MAX_PAY_OUTPUTS + 1 }, throwawayAddress);
    const odd = (i: number) => REAL_LEGS[i % 3] + BigInt(i);
    expect(paymentsOf(wallets.slice(0, MAX_PAY_OUTPUTS).map((address, i) => ({ address, lanoshis: odd(i) })), LEG_LANOSHI_STEP).ok).toBe(true);
    expect(codes(paymentsOf(wallets.map((address, i) => ({ address, lanoshis: odd(i) })), LEG_LANOSHI_STEP))).toEqual(['TOO_MANY_OUTPUTS']);
  });

  it('a step that is no step is a caller’s mistake, said at once', () => {
    const one = [{ address: throwawayAddress(), lanoshis: LANA }];
    expect(() => paymentsOf(one, 0n)).toThrow(/positive bigint/);
    expect(() => paymentsOf(one, -1n)).toThrow(/positive bigint/);
    expect(() => paymentsOf(one, 1 as unknown as bigint)).toThrow(/positive bigint/);
  });
});

describe('the financer’s send, signed in the browser and checked by the server, at the brain’s exact amounts', () => {
  it('planned and signed under step 1; the server’s check under step 1 takes it; the outputs are the legs to the lanoshi', async () => {
    for (const compressed of [true, false]) {
      const fx = await financerSend(compressed);
      // Krog Menjave's default refuses to plan it at all.
      const refused = planPayout({ from: fx.wallet.address, coins: fx.coins, allocations: fx.allocations, nowSec: NOW_SEC });
      expect(refused.ok).toBe(false);
      if (refused.ok === false) expect(refused.code === 'ALLOCATIONS' && refused.problems.map((p) => p.code)).toEqual(['NOT_STEP', 'NOT_STEP', 'NOT_STEP']);

      const plan = planPayout({ from: fx.wallet.address, coins: fx.coins, allocations: fx.allocations, nowSec: NOW_SEC, step: LEG_LANOSHI_STEP });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const signed = await signPayoutTx({ from: fx.wallet.address, pay: plan.pay, coins: plan.coins, nowSec: NOW_SEC, privateKey: fx.wallet.privateKey, compressed });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;

      const checked = checkPayoutTx({ rawTx: signed.rawTx, allocations: fx.allocations, prevouts: plan.coins, from: fx.wallet.address, nowSec: NOW_SEC, step: LEG_LANOSHI_STEP });
      expect(checked.ok && checked.txid).toBe(signed.txid);
      // The server must pass the same step: under the default it would refuse every financer send.
      const serverDefault = checkPayoutTx({ rawTx: signed.rawTx, allocations: fx.allocations, prevouts: plan.coins, from: fx.wallet.address, nowSec: NOW_SEC });
      expect(serverDefault.ok).toBe(false);
      if (serverDefault.ok === false) expect(serverDefault.code).toBe('ALLOCATIONS');

      const outputs = decodeTx(signed.rawTx).outputs.map((o) => [o.scriptPubKeyHex, o.value]);
      expect(outputs.slice(0, 3)).toEqual([
        [scriptOfAddress(fx.buyer), REAL_LEGS[0] + 40_800_000n],
        [scriptOfAddress(fx.caretaker), REAL_LEGS[1]],
        [scriptOfAddress(fx.budget), REAL_LEGS[2]],
      ]);
      expect(outputs[3]).toEqual([scriptOfAddress(fx.wallet.address), plan.change]);
      expect(outputs).toHaveLength(4);
    }
  });

  it('one lanoshi less to one wallet is another transaction: the server refuses it, under step 1 as before', async () => {
    const fx = await financerSend();
    const short = fx.allocations.map((a, i) => (i === 1 ? { ...a, lanoshis: a.lanoshis - 1n } : a));
    const plan = planPayout({ from: fx.wallet.address, coins: fx.coins, allocations: short, nowSec: NOW_SEC, step: LEG_LANOSHI_STEP });
    if (plan.ok === false) throw new Error(plan.detail);
    const signed = await signPayoutTx({ from: fx.wallet.address, pay: plan.pay, coins: plan.coins, nowSec: NOW_SEC, privateKey: fx.wallet.privateKey, compressed: true });
    if (signed.ok === false) throw new Error(signed.detail);
    const checked = checkPayoutTx({ rawTx: signed.rawTx, allocations: fx.allocations, prevouts: plan.coins, from: fx.wallet.address, nowSec: NOW_SEC, step: LEG_LANOSHI_STEP });
    expect(checked.ok).toBe(false);
    if (checked.ok === false) expect(checked.code).toBe('SHAPE');
  });
});

describe('the fee is this repository’s own, live', () => {
  it('feeFor is server/lib/transaction.ts estimateFeeLanoshis — the function the treasury’s sends use today — over 1–20 inputs × 1–99 outputs', () => {
    // fee.test.ts holds a pinned copy of it from Krog Menjave's side; here it is the very function.
    for (let n = 1; n <= MAX_INPUTS; n++) {
      for (let m = 1; m <= MAX_PAY_OUTPUTS + 1; m++) {
        if (feeFor(n, m) !== BigInt(estimateFeeLanoshis(n, m))) expect.fail(`differs at ${n} in, ${m} out`);
      }
    }
    expect(MAX_INPUTS).toBe(MAX_TRANSACTION_INPUTS);
  });
});
