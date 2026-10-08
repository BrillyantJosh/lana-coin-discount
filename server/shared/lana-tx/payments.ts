/**
 * From "what each purchase gets" to the outputs of one payout transaction.
 *
 * Brilly (6. 10. 2026): "2) a system for multiple outputs; 3) of course track
 * that at most as much LANA is paid as was promised to someone, never more."
 * The admin pays several purchases at once. Each purchase gets an ALLOCATION
 * (its wallet and its lanoshis); the transaction gets OUTPUTS. This file is the
 * one rule between the two, used by the browser that builds the transaction and
 * by the server that checks it, so the two can never read the same transaction
 * differently:
 *
 *   ONE OUTPUT PER WALLET. Allocations to the same wallet (two purchases of one
 *   buyer) are added into ONE output, equal to their sum, standing where that
 *   wallet's first allocation stands. Every other wallet keeps the order of the
 *   allocations. The change back to the payout wallet comes last (shape.ts).
 *
 * So given the allocations, the outputs are fixed: the server recomputes them
 * with paymentsOf() and shape.ts checkShape() refuses any transaction whose
 * outputs differ by one lanoshi, one place or one output more.
 *
 * WHAT AN ALLOCATION MAY BE:
 *   - its wallet is a LANA address, in its one canonical spelling (address.ts);
 *   - its lanoshis are a positive bigint and a whole number of LANOSHI_STEP
 *     (1,000 lanoshis = 0.00001 LANA). The purchase book counts what a purchase
 *     received to 5 decimals and rounds a chain amount DOWN to this step
 *     (server/lib/purchaseBook.ts), so anything finer would be paid and never
 *     counted. The step is the caller's (`step`, default LANOSHI_STEP):
 *     lana.discount pays the brain's legs, which are whole LANOSHIS and nothing
 *     coarser (1,004,492,188 or 3,446,289,063 lanoshis, 8. 10. 2026), so it
 *     passes LEG_LANOSHI_STEP, 1 lanoshi. Rounding a leg to 1,000 would pay
 *     every buyer up to 999 lanoshis less than the brain recorded as sent;
 *   - each OUTPUT is at least DUST_LANOSHIS (0.005 LANA), the fleet's smallest
 *     payment (fee.ts). The node itself would take less; a smaller remainder
 *     owed waits until it can go out with more, or is settled another way;
 *   - at most MAX_PAY_OUTPUTS wallets in one transaction: 98 payments and the
 *     change is the largest payout proven on the chain (lana.discount
 *     auto-send b4422dda…, 3,559 bytes; the node takes up to 500,000).
 *
 * Pure: no key, no clock, no connection. Money is integer lanoshis as bigint.
 */
import { addressToHash160 } from './address.ts';
import { DUST_LANOSHIS } from './fee.ts';
import type { Payment } from './shape.ts';

/** 0.00001 LANA: the purchase book's step. Every allocation is a whole number of it. */
export const LANOSHI_STEP = 1_000n;
/**
 * lana.discount's step: one lanoshi. A leg of a purchase (brain_lana_orders) is what the brain computed, in whole
 * lanoshis; the financer's payout pays it exactly, and lana-sent reports exactly that amount as sent. The browser that
 * signs and the server that checks pass this same constant, so the two can never read one payout differently.
 */
export const LEG_LANOSHI_STEP = 1n;
/** The most wallets one payout pays (see the top of this file). */
export const MAX_PAY_OUTPUTS = 98;

/** What one purchase gets from this payout. */
export interface Allocation {
  /** The buyer's wallet of that purchase. */
  address: string;
  lanoshis: bigint;
}

export type AllocationProblemCode = 'EMPTY' | 'BAD_ADDRESS' | 'NOT_POSITIVE' | 'NOT_STEP' | 'BELOW_DUST' | 'TOO_MANY_OUTPUTS';

export interface AllocationProblem {
  code: AllocationProblemCode;
  /** The allocation it is about (for BELOW_DUST, the first allocation of that wallet); -1 for the list as a whole. */
  index: number;
  detail: string;
}

export type PaymentsResult =
  | {
      ok: true;
      /** The payment outputs, in order: one per wallet. */
      pay: Payment[];
      /** All of them together. */
      paying: bigint;
    }
  | { ok: false; problems: AllocationProblem[] };

/**
 * The payment outputs for `allocations`, by the one-output-per-wallet rule above. Every allocation must be a whole
 * number of `step` lanoshis (KM's purchase book: LANOSHI_STEP; lana.discount's legs: LEG_LANOSHI_STEP).
 */
export function paymentsOf(allocations: readonly Allocation[], step: bigint = LANOSHI_STEP): PaymentsResult {
  // A step of 0 or less is no rule at all (and 0 would divide by zero): a caller's mistake, never a payout's.
  if (typeof step !== 'bigint' || step < 1n) throw new Error('step must be a positive bigint');
  const problems: AllocationProblem[] = [];
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { ok: false, problems: [{ code: 'EMPTY', index: -1, detail: 'nothing to pay' }] };
  }
  const byWallet = new Map<string, { first: number; lanoshis: bigint }>();
  allocations.forEach((a, i) => {
    const address = a?.address;
    if (addressToHash160(address) === null) return void problems.push({ code: 'BAD_ADDRESS', index: i, detail: `${String(address)} is not a LANA address` });
    const v = a.lanoshis;
    if (typeof v !== 'bigint' || v <= 0n) return void problems.push({ code: 'NOT_POSITIVE', index: i, detail: `${String(v)} is not a positive number of lanoshis` });
    if (v % step !== 0n) return void problems.push({ code: 'NOT_STEP', index: i, detail: `${v} lanoshis is not a whole number of ${step}` });
    const seen = byWallet.get(address);
    if (seen) seen.lanoshis += v;
    else byWallet.set(address, { first: i, lanoshis: v });
  });
  for (const [address, w] of byWallet) {
    if (w.lanoshis < DUST_LANOSHIS) {
      problems.push({ code: 'BELOW_DUST', index: w.first, detail: `${address} would get ${w.lanoshis} lanoshis, under ${DUST_LANOSHIS}` });
    }
  }
  if (byWallet.size > MAX_PAY_OUTPUTS) {
    problems.push({ code: 'TOO_MANY_OUTPUTS', index: -1, detail: `${byWallet.size} wallets, at most ${MAX_PAY_OUTPUTS} in one payout` });
  }
  if (problems.length) return { ok: false, problems };
  // A Map keeps insertion order: each wallet stands where its first allocation stands.
  const pay = [...byWallet].map(([address, w]) => ({ address, lanoshis: w.lanoshis }));
  return { ok: true, pay, paying: pay.reduce((s, p) => s + p.lanoshis, 0n) };
}
