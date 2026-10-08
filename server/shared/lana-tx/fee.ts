/**
 * The network fee, and where the change goes.
 *
 * THE FORMULA is lana.discount's, unchanged (spec Q15; lana-coin-discount
 * server/lib/transaction.ts estimateFeeLanoshis): 180 bytes an input, 34 an
 * output, 10 of envelope, at 100 lanoshis a byte with half again on top:
 *
 *     fee(n, m) = (180·n + 34·m + 10) · 150 lanoshis
 *
 * It is proven live: fee.test.ts reads what a lana.discount auto-send, a manual
 * batch and a 20-input consolidation really paid on mainnet, and it is exactly
 * this; it also matches LD's own function over a grid. lana-cards uses ·100 in
 * the browser and the network took that too, but KM pays the fee lana.discount's
 * live transactions pay, not the smallest one that has not failed yet.
 *
 * THE LIMITS, also LD's: at most 20 inputs per transaction (MAX_INPUTS; more
 * means a consolidation first, spec §5.9, until the live rehearsal T61 proves
 * larger ones), and 500,000 lanoshis (0.005 LANA) as dust.
 *
 * THE CHANGE RULE (spec §5.5 rule 7), one rule for the builder and the checker
 * so they can never disagree (lana.discount's bug of 10 Sept 2026 was two
 * estimates of the same fee disagreeing, and three more of that family followed,
 * MEM:ops_discount_transfer_shape_from_wallet.md):
 *   - if what is left after the payments and the fee for a transaction WITH a
 *     change output is at least dust, it goes back as change and the fee is
 *     exactly fee(n, m + 1);
 *   - otherwise there is no change output: the payments go out exact and the
 *     remainder, under dust plus one output's fee, joins the fee;
 *   - otherwise the coins are not enough.
 * One lanoshi more in never turns a payment into a refusal, and nothing is lost:
 * paid + change + fee is exactly what came in (fee.test.ts walks the boundaries
 * one lanoshi at a time).
 */
import type { LanaTx } from './codec.ts';

export const BYTES_PER_INPUT = 180n;
export const BYTES_PER_OUTPUT = 34n;
export const BYTES_FIXED = 10n;
/** 100 lanoshis a byte, with half again on top. */
export const LANOSHIS_PER_BYTE = 150n;
export const MAX_INPUTS = 20;
export const DUST_LANOSHIS = 500_000n;

function count(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${what} must be a positive integer`);
  return BigInt(n);
}

/** The fee for a transaction of `inputs` inputs and `outputs` outputs, in lanoshis. */
export function feeFor(inputs: number, outputs: number): bigint {
  return (BYTES_PER_INPUT * count(inputs, 'inputs') + BYTES_PER_OUTPUT * count(outputs, 'outputs') + BYTES_FIXED) * LANOSHIS_PER_BYTE;
}

/**
 * The most a transaction of up to `maxInputs` inputs and `payOutputs` payments
 * can pay under the change rule: the fee with a change output, plus a remainder
 * just under dust. An intent's `maxFee` (spec §5.5: "1051700" for one payment
 * and 20 inputs) is this number.
 */
export function feeCeiling(maxInputs: number, payOutputs: number): bigint {
  return feeFor(maxInputs, payOutputs + 1) + DUST_LANOSHIS;
}

export type Settlement =
  | {
      ok: true;
      /** 0n when there is no change output. */
      change: bigint;
      fee: bigint;
      /** payOutputs, plus one when there is change. */
      outputs: number;
    }
  | { ok: false; code: 'INSUFFICIENT'; shortBy: bigint };

/**
 * Split `totalIn` lanoshis from `inputs` coins into `paying` (the sum of
 * `payOutputs` payments), the fee and the change, by the change rule above.
 * `payOutputs` may be 0: a consolidation or a move of everything, where the one
 * output is the "change" and must itself be at least dust.
 */
export function settle(totalIn: bigint, paying: bigint, inputs: number, payOutputs: number): Settlement {
  if (typeof totalIn !== 'bigint' || totalIn < 0n) throw new Error('totalIn must be a non-negative bigint');
  if (typeof paying !== 'bigint' || paying < 0n) throw new Error('paying must be a non-negative bigint');
  if (!Number.isSafeInteger(payOutputs) || payOutputs < 0) throw new Error('payOutputs must be a non-negative integer');
  if ((payOutputs === 0) !== (paying === 0n)) throw new Error('paying must be 0 exactly when there are no payments');

  const feeWithChange = feeFor(inputs, payOutputs + 1);
  const rest = totalIn - paying - feeWithChange;
  if (rest >= DUST_LANOSHIS) return { ok: true, change: rest, fee: feeWithChange, outputs: payOutputs + 1 };
  if (payOutputs === 0) return { ok: false, code: 'INSUFFICIENT', shortBy: DUST_LANOSHIS - rest };

  const feeWithout = feeFor(inputs, payOutputs);
  if (totalIn - paying >= feeWithout) return { ok: true, change: 0n, fee: totalIn - paying, outputs: payOutputs };
  return { ok: false, code: 'INSUFFICIENT', shortBy: paying + feeWithout - totalIn };
}

/**
 * What a transaction actually pays the network: the prevout values it spends
 * minus its outputs. `prevoutValues[i]` must come from the re-hashed previous
 * transaction of input i (sighash.ts explains why). Negative means the
 * transaction spends more than it has, which the node refuses.
 */
export function actualFee(tx: LanaTx, prevoutValues: readonly bigint[]): bigint {
  if (prevoutValues.length !== tx.inputs.length) throw new Error('one prevout value per input is required');
  let fee = 0n;
  for (const v of prevoutValues) {
    if (typeof v !== 'bigint' || v < 0n) throw new Error('prevout values must be non-negative bigints');
    fee += v;
  }
  for (const o of tx.outputs) fee -= o.value;
  return fee;
}
