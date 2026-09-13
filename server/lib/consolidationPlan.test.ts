// @vitest-environment node
/**
 * The consolidation planner must never offer a batch that cannot succeed, never
 * offer one that removes nothing, and never quietly drop a UTXO.
 *
 * Ported case for case from MejmoSeFajn's scripts/testConsolidationPlan.ts, the
 * suite the copied module was written against. Two cases are new, and they are
 * the reason this copy is safe to keep: the fee and the input limit are pinned
 * to the ones the transfer path in transaction.ts uses, so the planner can
 * never promise a batch the signer would price differently.
 */
import { describe, it, expect } from 'vitest';
import {
  buildConsolidationPlan,
  consolidationFee,
  requiredFor,
  largestAffordableSize,
  MAX_INPUTS,
  MIN_INPUTS,
  MIN_NET,
  type PlanUtxo,
} from './consolidationPlan';
import { estimateFeeLanoshis, MAX_TRANSACTION_INPUTS } from './transaction';

let id = 0;
const utxo = (value: number, height = 100): PlanUtxo => ({
  tx_hash: `tx${++id}`.padStart(64, '0'),
  tx_pos: 0,
  value,
  height,
});
const many = (count: number, value: number, height = 100) => Array.from({ length: count }, () => utxo(value, height));
const key = (u: PlanUtxo) => `${u.tx_hash}:${u.tx_pos}`;

/** Invariants that must hold for EVERY plan, whatever the wallet looks like. */
function expectInvariants(input: PlanUtxo[], plan: ReturnType<typeof buildConsolidationPlan>) {
  for (const b of plan.batches) {
    expect(b.net).toBeGreaterThanOrEqual(MIN_NET);
    expect(b.utxos.length).toBeGreaterThanOrEqual(MIN_INPUTS);
    expect(b.utxos.length).toBeLessThanOrEqual(MAX_INPUTS);
    expect(b.fee).toBe(consolidationFee(b.utxos.length));
    const sum = b.utxos.reduce((s, u) => s + u.value, 0);
    expect(sum).toBe(b.totalValue);
    expect(b.net).toBe(sum - b.fee);
  }
  const placed = [...plan.batches.flatMap(b => b.utxos), ...plan.leftovers].map(key);
  expect(new Set(placed).size).toBe(placed.length);
  expect(placed.length).toBe(input.length);
  const inputKeys = new Set(input.map(key));
  expect(placed.every(k => inputKeys.has(k))).toBe(true);
}

describe('one fee, one limit — the planner and the signer agree', () => {
  it('consolidationFee(n) is exactly what transaction.ts charges for n inputs and one output', () => {
    for (let n = 1; n <= MAX_INPUTS; n++) expect(consolidationFee(n)).toBe(estimateFeeLanoshis(n, 1));
  });
  it('the input limit is the transfer limit', () => {
    expect(MAX_INPUTS).toBe(MAX_TRANSACTION_INPUTS);
  });
});

describe('consolidation plan (from MejmoSeFajn)', () => {
  it('the reported wallet: 1 funder of 458,663 + 20 dust of 20', () => {
    const input = [utxo(458663), ...many(20, 20)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].utxos).toHaveLength(16);
    expect(plan.batches[0].fee).toBe(438600);
    expect(plan.batches[0].net).toBe(20363);
    expect(plan.totalRemoved).toBe(15);
    expect(plan.leftovers).toHaveLength(5);
    // The old code produced 20 + 1 and refused both.
    expect(459043 - consolidationFee(20)).toBeLessThan(MIN_NET);
  });

  it('viability is not monotone: five UTXOs of 28,750', () => {
    const input = many(5, 28750);
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(57500).toBeLessThan(requiredFor(2));
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].utxos).toHaveLength(5);
    expect(largestAffordableSize([...input].sort((a, b) => b.value - a.value))).toBe(5);
  });

  it('a single UTXO: nothing to do, and nothing to burn', () => {
    const input = [utxo(1000000)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(0);
    expect(plan.leftovers).toHaveLength(1);
  });

  it('a wallet that can never consolidate: 25 dust of 20', () => {
    const input = many(25, 20);
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(0);
    expect(plan.leftovers).toHaveLength(25);
    expect(plan.depositToUnstick).toBeGreaterThan(0);
    expect(plan.depositToUnstick + 20).toBeGreaterThanOrEqual(requiredFor(2));
  });

  it('plenty of value: 2 funders of 5,000,000 + 38 dust', () => {
    const input = [...many(2, 5000000), ...many(38, 20)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches.length).toBeGreaterThanOrEqual(2);
    expect(plan.batches.every(b => b.utxos.length === MAX_INPUTS)).toBe(true);
    expect(plan.totalRemoved).toBe(plan.batches.length * 19);
    expect(input.length - plan.totalRemoved).toBeLessThanOrEqual(MAX_INPUTS);
  });

  it('barely funded: one of 40,000 + 20 dust', () => {
    const input = [utxo(40000), ...many(20, 20)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(0);
    expect(plan.leftovers).toHaveLength(21);
  });

  it('trivial: 1,000,000 and 15', () => {
    const input = [utxo(1000000), utxo(15)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].net).toBe(1000015 - consolidationFee(2));
  });

  it('20 healthy UTXOs of 1,000,000 make one full batch', () => {
    const input = many(20, 1000000);
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].utxos).toHaveLength(20);
  });

  it('unconfirmed outputs are never spent, and still shown', () => {
    const input = [utxo(1000000, 0), utxo(500000), utxo(20)];
    const plan = buildConsolidationPlan(input);
    expectInvariants(input, plan);
    expect(plan.batches.flatMap(b => b.utxos).every(u => (u.height ?? 1) > 0)).toBe(true);
    expect(plan.leftovers.some(u => u.height === 0)).toBe(true);
  });

  it('empty wallet', () => {
    const plan = buildConsolidationPlan([]);
    expect(plan.batches).toHaveLength(0);
    expect(plan.leftovers).toHaveLength(0);
    expect(plan.depositToUnstick).toBe(0);
  });

  it('400 random wallets all satisfy every invariant', () => {
    let seed = 987654321;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const n = 1 + Math.floor(rnd() * 45);
      const input = Array.from({ length: n }, () =>
        utxo(rnd() < 0.6 ? Math.floor(rnd() * 500) + 1 : Math.floor(rnd() * 3_000_000) + 1));
      expectInvariants(input, buildConsolidationPlan(input));
    }
  });
});
