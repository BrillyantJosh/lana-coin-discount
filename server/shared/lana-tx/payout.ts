/**
 * One payout transaction of the dealer's payout wallet: planned, then built and
 * signed, IN THE ADMIN'S BROWSER.
 *
 * Brilly (6. 10. 2026): "At the end the admin enters the private key before
 * paying and the transaction happens." The key is typed or scanned on the page,
 * read there (src/lib/wif.ts decodeWif), handed to signPayoutTx() as bytes and
 * wiped by the caller right after. This file never sends, stores or logs
 * anything: it returns a raw transaction, which the page announces to the
 * server. The server checks it again with checkPayoutTx() below, the same rule
 * the browser checked its own bytes with, and broadcasts it itself.
 *
 * THE STEPS, in the order the page takes them:
 *   1. select.ts verifiedCoins(): the payout wallet's confirmed coins, each
 *      read from its own previous transaction (never a value on trust);
 *   2. planPayout(): the allocations become outputs (payments.ts, one per
 *      wallet), the coins are chosen (select.ts, largest first, at most 20),
 *      and the unsigned transaction is built once, so the fee, the change and
 *      what stays in the wallet shown to the admin are the ones that will be
 *      signed;
 *   3. signPayoutTx(): the key must open EXACTLY the payout wallet, in the form
 *      its own compression flag says (a T…/A… key and a 6…/3… key of the same
 *      secret open two different wallets, MEM:ops_lana_wif_prefix_0x41.md);
 *      every input is signed with signature.ts, the fleet's nonce-safe signer
 *      (pinned byte for byte, signature.pin.test.ts); the finished bytes are
 *      decoded again, checked against the plan and verified by two libraries.
 *      Anything off and no transaction is returned at all;
 *   4. (the server) checkPayoutTx(): the announced bytes against the payout
 *      wallet, the allocations and the coins it read from the chain itself.
 *
 * nTIME is the SERVER's clock, never the browser's: the purchase book refuses a
 * payout dated before the offer was accepted, and a phone's clock can be wrong.
 * It is kept at or after every transaction the payout spends (the chain refuses
 * a transaction older than its coins). Never a block time: blocks are stamped
 * about 18 minutes ahead (MEM:ops_lana_block_time_runs_ahead.md).
 *
 * ONE STRING ON THE WAY. The pinned signer takes the secret as hex, and a
 * JavaScript string cannot be wiped. It is made inside signPayoutTx(), lives
 * only for the signing loop and is never returned, stored or printed; the bytes
 * the caller passed in are the copy the caller wipes.
 */
import * as secp from '@noble/secp256k1';
import { addressOfPublicKey } from './address.ts';
import { bytesToHex } from './bytes.ts';
import { decodeTx, encodeTxHex, p2pkhScriptSigHex, txidOfRaw, type LanaTx } from './codec.ts';
import { feeCeiling, MAX_INPUTS } from './fee.ts';
import { paymentsOf, type Allocation, type AllocationProblem } from './payments.ts';
import { selectPayoutCoins } from './select.ts';
import { sighash } from './sighash.ts';
import { buildUnsignedTx, checkShape, DEFAULT_MAX_AHEAD_SEC, type Payment, type Prevout, type ShapeProblem } from './shape.ts';
import { signLanaSighash } from './signature.ts';
import { verifyTxSignatures, verifyTxSignedBy } from './verify.ts';

/** The nTime of a payout: the server's clock, and never before a coin it spends was made. */
export function payoutNTime(nowSec: number, coins: readonly Pick<Prevout, 'txNTime'>[]): number {
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) throw new Error('nowSec must be a positive integer');
  return coins.reduce((t, c) => (c.txNTime > t ? c.txNTime : t), nowSec);
}

/** The highest fee a payout of `payOutputs` wallets may pay: 20 inputs, change, and a remainder under dust. */
export function payoutMaxFee(payOutputs: number): bigint {
  return feeCeiling(MAX_INPUTS, payOutputs);
}

export interface PlanArgs {
  /** The payout wallet. */
  from: string;
  /** Its confirmed coins, from select.ts verifiedCoins(). */
  coins: readonly Prevout[];
  allocations: readonly Allocation[];
  /** The server's clock, seconds UTC. */
  nowSec: number;
  /** Default MAX_INPUTS (20). */
  maxInputs?: number;
  /** Every allocation a whole number of this many lanoshis (payments.ts). Default LANOSHI_STEP; lana.discount: LEG_LANOSHI_STEP. */
  step?: bigint;
}

export type PayoutPlan =
  | {
      ok: true;
      /** The payment outputs, one per wallet (payments.ts). */
      pay: Payment[];
      /** The coins to spend, in input order. */
      coins: Prevout[];
      /** What the payments add up to. */
      paying: bigint;
      fee: bigint;
      /** Back to the payout wallet; 0n when the remainder under dust joins the fee. */
      change: bigint;
      /** What every coin given held: the wallet's confirmed balance. */
      balance: bigint;
      /** What the wallet holds once this payout confirms: balance − paying − fee. */
      left: bigint;
      nTime: number;
    }
  | { ok: false; code: 'ALLOCATIONS'; detail: string; problems: AllocationProblem[] }
  | { ok: false; code: 'INSUFFICIENT'; detail: string; shortBy: bigint }
  | { ok: false; code: 'TOO_MANY_INPUTS'; detail: string; needed: number }
  | { ok: false; code: 'SHAPE'; detail: string; problems: ShapeProblem[] };

const problemText = (ps: readonly { code: string; detail: string }[]) => ps.map((p) => `${p.code}: ${p.detail}`).join('; ');

/**
 * A coin made further ahead of the server's clock than the checker allows
 * (shape.ts, 10 minutes) cannot be spent yet: the payout would be dated after
 * "now" by more than the server accepts. Said before anything is signed.
 */
function aheadProblem(nTime: number, nowSec: number): ShapeProblem | null {
  const ahead = nTime - nowSec;
  if (ahead <= DEFAULT_MAX_AHEAD_SEC) return null;
  return { code: 'NTIME_AHEAD', detail: `a coin of this payout is dated ${ahead} s after the server's clock; it can be spent in ${ahead - DEFAULT_MAX_AHEAD_SEC} s` };
}

/** What this payout will be, before any key is asked for. */
export function planPayout(args: PlanArgs): PayoutPlan {
  const payments = paymentsOf(args.allocations, args.step);
  if (payments.ok === false) return { ok: false, code: 'ALLOCATIONS', detail: problemText(payments.problems), problems: payments.problems };
  const choice = selectPayoutCoins(args.coins, payments.paying, payments.pay.length, args.maxInputs ?? MAX_INPUTS);
  if (choice.ok === false) return choice;
  const nTime = payoutNTime(args.nowSec, choice.coins);
  const early = aheadProblem(nTime, args.nowSec);
  if (early) return { ok: false, code: 'SHAPE', detail: problemText([early]), problems: [early] };
  const built = buildUnsignedTx({
    from: args.from,
    pay: payments.pay,
    change: args.from,
    coins: choice.coins,
    nTime,
    maxFee: payoutMaxFee(payments.pay.length),
    maxInputs: args.maxInputs,
  });
  if (built.ok === false) return { ok: false, code: 'SHAPE', detail: problemText(built.problems), problems: built.problems };
  const balance = args.coins.reduce((s, c) => s + c.value, 0n);
  return {
    ok: true,
    pay: payments.pay,
    coins: choice.coins,
    paying: payments.paying,
    fee: built.fee,
    change: built.change,
    balance,
    left: balance - payments.paying - built.fee,
    nTime,
  };
}

export interface SignPayoutArgs {
  /** The payout wallet: the key must open exactly this address. */
  from: string;
  /** From planPayout(). */
  pay: readonly Payment[];
  /** From planPayout(), in its order. */
  coins: readonly Prevout[];
  /** The server's clock, seconds UTC. */
  nowSec: number;
  /** The 32-byte secret (src/lib/wif.ts decodeWif). The caller wipes it after this call. */
  privateKey: Uint8Array;
  /** The key's own compression flag (decodeWif), which decides its address. */
  compressed: boolean;
  /** Default MAX_INPUTS (20). */
  maxInputs?: number;
}

export type SignedPayout =
  | {
      ok: true;
      /** Lowercase hex: what the page announces to the server. */
      rawTx: string;
      /** Computed from rawTx, never taken from anyone. */
      txid: string;
      fee: bigint;
      change: bigint;
      nTime: number;
    }
  | { ok: false; code: 'BAD_KEY' | 'KEY_NOT_SOURCE' | 'SHAPE' | 'SIGNATURE_FAILED'; detail: string };

/** Build and sign the payout. Returns a transaction only when it verifies in full. */
export async function signPayoutTx(args: SignPayoutArgs): Promise<SignedPayout> {
  if (!(args.privateKey instanceof Uint8Array) || args.privateKey.length !== 32 || typeof args.compressed !== 'boolean') {
    return { ok: false, code: 'BAD_KEY', detail: 'the key must be 32 bytes with its compression flag' };
  }
  let publicKey: Uint8Array;
  try {
    publicKey = secp.getPublicKey(args.privateKey, args.compressed);
  } catch {
    return { ok: false, code: 'BAD_KEY', detail: 'not a valid secp256k1 key' };
  }
  const opens = addressOfPublicKey(publicKey);
  if (opens !== args.from) return { ok: false, code: 'KEY_NOT_SOURCE', detail: `this key opens ${opens}, not the payout wallet ${String(args.from)}` };

  const nTime = payoutNTime(args.nowSec, args.coins);
  const early = aheadProblem(nTime, args.nowSec);
  if (early) return { ok: false, code: 'SHAPE', detail: problemText([early]) };
  const maxFee = payoutMaxFee(args.pay.length);
  const built = buildUnsignedTx({ from: args.from, pay: args.pay, change: args.from, coins: args.coins, nTime, maxFee, maxInputs: args.maxInputs });
  if (built.ok === false) return { ok: false, code: 'SHAPE', detail: problemText(built.problems) };

  // Every digest from the unsigned transaction (each covers every input and output), then every signature.
  const digests = built.tx.inputs.map((_, i) => sighash(built.tx, i, built.prevScriptsHex[i]));
  const signed: LanaTx = { ...built.tx, inputs: built.tx.inputs.map((x) => ({ ...x })) };
  try {
    const secretHex = bytesToHex(args.privateKey);
    for (let i = 0; i < digests.length; i++) {
      const der = await signLanaSighash(secretHex, digests[i], publicKey);
      signed.inputs[i].scriptSigHex = p2pkhScriptSigHex(der, publicKey);
    }
  } catch (e) {
    return { ok: false, code: 'SIGNATURE_FAILED', detail: `${(e as Error).message}; nothing was signed` };
  }

  // The finished bytes, checked as the server will check them: nothing on trust from the steps above.
  const rawTx = encodeTxHex(signed);
  const txid = txidOfRaw(rawTx);
  const problems = verifyTxSignatures(rawTx, args.coins, bytesToHex(publicKey));
  const checked = checkSignedPayout(rawTx, args.pay, args.coins, args.from, args.nowSec, args.maxInputs);
  if (checked.ok === false) problems.push(checked.detail);
  else if (checked.txid !== txid || checked.fee !== built.fee || checked.change !== built.change) problems.push('the signed transaction is not the one that was built');
  if (problems.length) return { ok: false, code: 'SIGNATURE_FAILED', detail: `the signed transaction did not verify (${problems.join('; ')}); nothing was returned` };
  return { ok: true, rawTx, txid, fee: built.fee, change: built.change, nTime };
}

/** The node takes no transaction larger than this (main.h MAX_STANDARD_TX_SIZE). */
export const MAX_TX_BYTES = 500_000;

export interface PayoutCheckArgs {
  /** The announced transaction, lowercase hex as signPayoutTx returns it. */
  rawTx: string;
  /** What each purchase gets, as announced with it; the outputs follow from them (payments.ts). */
  allocations: readonly Allocation[];
  /**
   * The coin each input spends, in input order, read by the CHECKER from the
   * chain: prevoutFromRawTx(parentRaw, input.prevTxid, input.vout) for every
   * input of decodeTx(rawTx), the parent fetched by the checker itself.
   */
  prevouts: readonly Prevout[];
  /** The payout wallet: every input spends from it, the change goes back to it, its key signs. */
  from: string;
  /** The checker's own clock, seconds UTC. */
  nowSec: number;
  /** Default MAX_INPUTS (20). */
  maxInputs?: number;
  /** Every allocation a whole number of this many lanoshis (payments.ts). Default LANOSHI_STEP; lana.discount: LEG_LANOSHI_STEP. */
  step?: bigint;
}

export type PayoutCheck =
  | {
      ok: true;
      /** Computed from the bytes. */
      txid: string;
      fee: bigint;
      /** Back to the payout wallet; 0n when there is no change output. */
      change: bigint;
      /** The payment outputs the allocations give, in order. */
      pay: Payment[];
      nTime: number;
    }
  | { ok: false; code: 'MALFORMED'; detail: string }
  | { ok: false; code: 'ALLOCATIONS'; detail: string; problems: AllocationProblem[] }
  | { ok: false; code: 'SHAPE'; detail: string; problems: ShapeProblem[] }
  | { ok: false; code: 'SIGNATURE'; detail: string; problems: string[] };

/**
 * Is `rawTx` exactly the payout the allocations describe, from the payout
 * wallet, signed by its key? What the server runs on announce, before it stores
 * or sends anything; the browser ran the same rule on its own bytes.
 *
 *   - lowercase hex, one well-formed transaction, at most MAX_TX_BYTES;
 *   - the outputs are exactly paymentsOf(allocations) in order, then at most
 *     one change back to `from`; no other output (shape.ts);
 *   - every input spends a coin of `from`, at most 20, none twice; the fee is
 *     exactly the change rule and never above payoutMaxFee; nTime not before
 *     any coin it spends, not older than an hour and not more than ten minutes
 *     ahead of `nowSec` (shape.ts);
 *   - every input is signed SIGHASH_ALL by the key of `from`, strict DER, low
 *     S, valid under noble and elliptic (verify.ts).
 * What is owed and what is already in flight is the server's to check: this
 * says only that the bytes are the payout they claim to be.
 */
export function checkPayoutTx(args: PayoutCheckArgs): PayoutCheck {
  if (typeof args.rawTx !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(args.rawTx)) {
    return { ok: false, code: 'MALFORMED', detail: 'the transaction is not lowercase hex' };
  }
  if (args.rawTx.length / 2 > MAX_TX_BYTES) return { ok: false, code: 'MALFORMED', detail: `the transaction is larger than ${MAX_TX_BYTES} bytes` };
  try {
    decodeTx(args.rawTx);
  } catch (e) {
    return { ok: false, code: 'MALFORMED', detail: (e as Error).message };
  }
  const payments = paymentsOf(args.allocations, args.step);
  if (payments.ok === false) return { ok: false, code: 'ALLOCATIONS', detail: problemText(payments.problems), problems: payments.problems };
  const checked = checkSignedPayout(args.rawTx, payments.pay, args.prevouts, args.from, args.nowSec, args.maxInputs);
  if (!checked.ok) return checked;
  const signatures = verifyTxSignedBy(args.rawTx, args.prevouts, args.from);
  if (signatures.length) return { ok: false, code: 'SIGNATURE', detail: signatures.join('; '), problems: signatures };
  return checked;
}

/** The shape half of the check, shared by signPayoutTx (on its own bytes) and checkPayoutTx (on announced ones). */
function checkSignedPayout(
  rawTx: string,
  pay: readonly Payment[],
  prevouts: readonly Prevout[],
  from: string,
  nowSec: number,
  maxInputs: number | undefined,
): Extract<PayoutCheck, { ok: true } | { code: 'SHAPE' }> {
  const tx = decodeTx(rawTx);
  const shape = checkShape(tx, prevouts, { from, pay, change: from, maxFee: payoutMaxFee(pay.length), maxInputs, nowSec, signed: true });
  if (shape.ok === false) return { ok: false, code: 'SHAPE', detail: problemText(shape.problems), problems: shape.problems };
  return { ok: true, txid: shape.txid, fee: shape.fee, change: shape.change, pay: [...pay], nTime: tx.nTime };
}
