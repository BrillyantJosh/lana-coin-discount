// @vitest-environment node
/**
 * THE WHOLE SPACE, NOT THE POINTS IN IT.
 *
 * Three transfer incidents in two days, each fixed with a test written on the
 * numbers of the incident, and each fix moving a boundary into somebody else's
 * way:
 *
 *   10 Sept  a wallet holding EXACTLY the agreed amount could not pay the fee
 *   11 Sept  a counteroffer decided the shape from the mandate, not the wallet
 *   11 Sept  a surplus of 0.00125 LANA — too much to sweep, too little to pay
 *            for a change output
 *
 * Every one of them is the same question: IS THERE A WALLET FOR WHICH NEITHER
 * SHAPE WORKS? That cannot be answered by adding another example. So this file
 * asks it of the space — every combination of agreed amount, surplus, piece
 * count, browser flag and balance precision that could matter — and asserts
 * the four things that have to be true of all of them at once.
 *
 * The boundaries are deliberately hugged at ±1 lanoshi, because every bug
 * above was a boundary that two layers drew in different places.
 */
import { describe, it, expect } from 'vitest';
import { decideTransferShape, EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS, BALANCE_ROUNDING_LANOSHIS } from './transferShape';
import { planTransfer, planFailed, estimateFeeLanoshis, MAX_TRANSACTION_INPUTS, type UTXO } from './transaction';
import { BACKING_TOLERANCE_LANOSHIS } from './acquisitionBacking';

const LANA = 100_000_000;

/** Agreed amounts: a round one, and the two that actually stranded people. */
const AGREED = [1000 * LANA, 323_703_000_000, 326_179_687_500];

/**
 * Surplus over the agreed amount, hugging every boundary either layer draws:
 * the dust allowance (100,800), the rounding step (500,000), the backing
 * tolerance (500,000 under), and the sweep and ordinary fees at several piece
 * counts — because THE FEE IS NOT A CONSTANT and that is what keeps biting.
 */
const SURPLUS: number[] = [];
for (const b of [
  -BACKING_TOLERANCE_LANOSHIS - 1, -BACKING_TOLERANCE_LANOSHIS, 0,
  EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS, BALANCE_ROUNDING_LANOSHIS,
  125_000,                                   // OFF-2026-062, measured
  ...[1, 2, 3, 6, 19, 20].flatMap(n => [estimateFeeLanoshis(n, 1), estimateFeeLanoshis(n, 2)]),
  10 * LANA,
]) SURPLUS.push(b - 1, b, b + 1);

const PIECES = [1, 2, 3, 4, 6, 9, 12, 17, 19, 20, 21];
const ASKED = [false, true];
const EXACT = [true, false];

const pieces = (count: number, total: number): UTXO[] => {
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => ({
    tx_hash: String(i + 11).repeat(64).slice(0, 64),
    tx_pos: 0,
    value: each + (i === count - 1 ? total - each * count : 0),
    height: 1_000_000 + i,
  }));
};

interface Case {
  agreed: number; surplus: number; count: number; asked: boolean; exact: boolean;
  balance: number;
}
const CASES: Case[] = [];
for (const agreed of AGREED)
  for (const surplus of SURPLUS)
    for (const count of PIECES)
      for (const asked of ASKED)
        for (const exact of EXACT) {
          const balance = agreed + surplus;
          if (balance <= 0) continue;
          CASES.push({ agreed, surplus, count, asked, exact, balance });
        }

/** What the two layers together do with one wallet. */
function run(c: Case) {
  const slack = c.exact ? 0 : BALANCE_ROUNDING_LANOSHIS;
  const shape = decideTransferShape({
    balanceLanoshis: c.balance, agreedLanoshis: c.agreed, askedToEmpty: c.asked, roundingSlack: slack,
  });
  if (shape.kind === 'refuse') return { shape, plan: null };
  const plan = planTransfer({
    utxos: pieces(c.count, c.balance),
    amountLanoshis: c.agreed,
    emptyWallet: shape.emptyWallet,
    sweepCeilingLanoshis: shape.sweepCeilingLanoshis,
  });
  return { shape, plan };
}

const name = (c: Case) =>
  `agreed ${c.agreed}, surplus ${c.surplus}, ${c.count} piece(s), asked=${c.asked}, exact=${c.exact}`;

describe(`the transfer decision over its whole space (${CASES.length} wallets)`, () => {
  it('is asking a real question — the space covers both shapes and both outcomes', () => {
    // A guard on the guard: a grid that only ever produces one answer proves
    // nothing, however many rows it has.
    const results = CASES.map(run);
    const swept = results.filter(r => r.plan && !planFailed(r.plan) && r.plan.emptyWallet).length;
    const ordinary = results.filter(r => r.plan && !planFailed(r.plan) && !r.plan.emptyWallet).length;
    const refused = results.filter(r => !r.plan || planFailed(r.plan)).length;
    expect(swept).toBeGreaterThan(50);
    expect(ordinary).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(10);
  });

  /**
   * I1 — THE TREASURY NEVER RECEIVES MORE THAN IT AGREED TO BUY.
   * The one invariant that costs real money if it breaks: everything above the
   * agreed amount would be LANA taken and not paid for.
   */
  it('never delivers more than the agreed amount', () => {
    const over = CASES.filter(c => {
      const { plan } = run(c);
      return plan && !planFailed(plan) && plan.amountLanoshis > c.agreed;
    });
    expect(over.map(name), 'these wallets hand the treasury more than it bought').toEqual([]);
  });

  /**
   * I2 — NO DEAD ENDS. The invariant every incident above broke. If the wallet
   * holds what was agreed and can be carried in one transaction, SOME plan has
   * to exist; which shape it is, is our business and not the seller's.
   */
  it('never refuses a wallet that holds the agreed amount and fits in one transaction', () => {
    const stranded = CASES.filter(c => {
      if (c.balance < c.agreed) return false;
      if (c.count > MAX_TRANSACTION_INPUTS) return false;
      const { shape, plan } = run(c);
      if (shape.kind === 'refuse') return true;
      return !plan || planFailed(plan);
    });
    expect(
      stranded.map(name),
      'these wallets hold what was agreed and are refused anyway — a dead end with nothing the seller can do',
    ).toEqual([]);
  });

  /**
   * I3 — NOTHING VANISHES. Whatever leaves the wallet beyond what arrives has
   * to be a fee somebody could have charged for this transaction, not an
   * arbitrary remainder.
   */
  it('never burns more than a plausible fee', () => {
    const burnt = CASES.filter(c => {
      const { plan } = run(c);
      if (!plan || planFailed(plan)) return false;
      const left = c.balance - plan.amountLanoshis;          // fee + change
      const change = left - plan.feeLanoshis;
      return change < 0 || plan.feeLanoshis > estimateFeeLanoshis(c.count, 2) + BALANCE_ROUNDING_LANOSHIS;
    });
    expect(burnt.map(name), 'these plans lose LANA to neither the treasury nor the seller').toEqual([]);
  });

  /**
   * I4 — A REFUSAL IS ONLY EVER ABOUT EVIDENCE. Since 11 Sept the browser's
   * derived flag cannot refuse anybody; the only 'refuse' the shape layer may
   * return is the unreadable balance, and that one needs a null balance.
   */
  it('the shape layer refuses only when the balance could not be read', () => {
    const wrong = CASES.filter(c => run(c).shape.kind === 'refuse');
    expect(wrong.map(name), 'a readable balance must never produce a refusal at this layer').toEqual([]);
    // …and with no balance at all, the flag decides whether we fail closed.
    const blind = (asked: boolean) => decideTransferShape({
      balanceLanoshis: null, agreedLanoshis: 1000 * LANA, askedToEmpty: asked, roundingSlack: BALANCE_ROUNDING_LANOSHIS,
    });
    expect(blind(true).kind).toBe('refuse');
    expect(blind(false).kind).toBe('proceed');
  });

  /**
   * I5 — THE BROWSER IS NEVER THE DECIDING VOTE. Its number is rounded to
   * 0.01 LANA and the rules turn on a thousandth of that, so if the flag could
   * change the outcome it would change it wrongly.
   */
  it('gives the same answer whatever the browser says', () => {
    const differing = CASES.filter(c => c.asked).filter(c => {
      const withFlag = run(c);
      const without = run({ ...c, asked: false });
      const shapeSame = withFlag.shape.kind === without.shape.kind
        && (withFlag.shape.kind !== 'proceed' || without.shape.kind !== 'proceed'
          || withFlag.shape.emptyWallet === without.shape.emptyWallet);
      const planSame = JSON.stringify(withFlag.plan) === JSON.stringify(without.plan);
      return !shapeSame || !planSame;
    });
    expect(differing.map(name), 'the browser flag changed the outcome for these wallets').toEqual([]);
  });

  /**
   * I6 — MORE LANA IN THE WALLET CAN NEVER MAKE THINGS WORSE.
   *
   * This is the one that generalises all the others, including the bands
   * nobody has thought of yet. Every incident in this file's history was the
   * same shape: a wallet that WOULD have worked with a lanoshi less, or a
   * lanoshi more, and did not. That is a non-monotonicity, and it can be
   * searched for without knowing where it is.
   *
   * Walked one lanoshi at a time across the window where every boundary in
   * this system lives — between a sweep's fee and an ordinary transfer's,
   * which is where the two shapes hand over.
   */
  it('is monotonic: adding a lanoshi never turns a sale into a refusal', () => {
    const agreed = 323_703_000_000;
    const breaks: string[] = [];
    for (const count of [1, 2, 6, 13, 20]) {
      const from = Math.max(0, estimateFeeLanoshis(count, 1) - 60);
      const to = estimateFeeLanoshis(count, 2) + 60;
      let sawOk = false;
      for (let surplus = from; surplus <= to; surplus++) {
        const { plan } = run({ agreed, surplus, count, asked: false, exact: true, balance: agreed + surplus });
        const ok = !!plan && !planFailed(plan);
        if (ok) sawOk = true;
        else if (sawOk) { breaks.push(`${count} piece(s): worked below, refused at surplus ${surplus}`); break; }
      }
    }
    expect(breaks, 'a wallet with MORE in it was refused where a poorer one succeeded').toEqual([]);
  });

  /**
   * I7 — AND WHAT ARRIVES STAYS INSIDE ITS WINDOW, all the way across that
   * handover: never a lanoshi above the agreed amount, never further below it
   * than one fee for that wallet.
   */
  it('delivers within one fee of the agreed amount across the whole handover', () => {
    const agreed = 323_703_000_000;
    const bad: string[] = [];
    for (const count of [1, 2, 6, 13, 20]) {
      const most = estimateFeeLanoshis(count, 1);
      // Step of ONE across the handover window, where every boundary in this
      // system lives; a coarse walk below it, where the sweep simply applies
      // and the grid above already covers what arrives.
      const window: number[] = [];
      for (let v = 0; v < most - 60; v += 977) window.push(v);
      for (let v = Math.max(0, most - 60); v <= estimateFeeLanoshis(count, 2) + 60; v++) window.push(v);
      for (const surplus of window) {
        if (bad.length > 4) break;
        const { plan } = run({ agreed, surplus, count, asked: false, exact: true, balance: agreed + surplus });
        if (!plan || planFailed(plan)) continue;
        const d = plan.amountLanoshis - agreed;
        if (d > 0) bad.push(`${count}p surplus ${surplus}: delivered ${d} OVER`);
        else if (-d > most) bad.push(`${count}p surplus ${surplus}: ${-d} under, more than one fee (${most})`);
      }
    }
    expect(bad, 'delivery strayed outside [agreed - one fee, agreed]').toEqual([]);
  });
});
