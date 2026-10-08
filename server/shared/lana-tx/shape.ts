/**
 * The shape of a KM transaction: build it, and check that one is exactly that.
 *
 * WHAT A KM TRANSACTION IS (spec §5.5 rule 7, §5.1):
 *   - version 1, locktime 0, every input final (sequence 0xffffffff);
 *   - every input spends a P2PKH coin of ONE wallet, `from`. Signed inputs are
 *     signed SIGHASH_ALL by the key of that wallet, in the key form its address
 *     was made from (a compressed key cannot spend an uncompressed address);
 *   - at most `maxInputs` inputs (20, fee.ts), no outpoint twice, every anchor
 *     outpoint spent (a re-sign must conflict with every earlier live attempt,
 *     spec §5.5 rule 8);
 *   - the outputs are exactly the payments, in order, each to its address with
 *     its exact amount, then at most one change output back to `from`, the same
 *     wallet: change never goes anywhere else, so a holding's wallet stays right;
 *   - change and fee are exactly what fee.ts settle() says for these coins and
 *     payments: no smaller fee, no change burnt into the fee, never above `maxFee`;
 *   - nTime is sane: not earlier than any transaction it spends (the chain
 *     refuses that), not older than `maxAgeSec` and not further ahead than
 *     `maxAheadSec` of the checker's clock (tx nTime is real UTC; block
 *     timestamps run ~18 min ahead, spec Q14, so never compare with a block).
 *
 * WHY ONE FILE BUILDS AND CHECKS. The builder runs the checker on what it built
 * and refuses to hand out anything the checker refuses. The signer checks its
 * own transaction again after signing, the financer checks what the signer
 * returned, and a client's sale to KM is checked at announce with the same
 * function (spec §4.4). One rule, so no two layers can drift apart.
 *
 * Prevouts are never taken on trust. prevoutFromRawTx() reads a coin's value,
 * script and nTime from the raw previous transaction and refuses it unless those
 * bytes hash to the txid being spent (sighash.ts explains why the value matters).
 *
 * Nothing here signs, holds a key or opens a connection. A failed check returns
 * every problem found, each with a code, so the caller can log why it refused.
 */
import { addressToHash160, p2pkhScriptHex } from './address.ts';
import { bytesToHex, hash160 } from './bytes.ts';
import {
  decodeTx,
  outpointKey,
  parseP2pkhScriptSig,
  SEQUENCE_FINAL,
  SIGHASH_ALL,
  txidOf,
  txidOfRaw,
  type LanaTx,
} from './codec.ts';
import { actualFee, DUST_LANOSHIS, feeFor, MAX_INPUTS, settle } from './fee.ts';

export interface Outpoint {
  txid: string;
  vout: number;
}

/** A coin being spent, as read from its own previous transaction. */
export interface Prevout extends Outpoint {
  value: bigint;
  scriptPubKeyHex: string;
  /** nTime of the transaction that created the coin. */
  txNTime: number;
}

export interface Payment {
  address: string;
  lanoshis: bigint;
}

export interface ShapeRules {
  /** The one wallet every input spends from. */
  from: string;
  /** The payments, in output order. Empty for a consolidation. */
  pay: readonly Payment[];
  /** Where change goes; must be `from`. */
  change: string;
  maxFee: bigint;
  /** Default MAX_INPUTS (20). */
  maxInputs?: number;
  /** Outpoints that must be among the inputs. */
  anchors?: readonly Outpoint[];
  /** The checker's own clock, seconds UTC. */
  nowSec: number;
  /** Default DEFAULT_MAX_AGE_SEC. */
  maxAgeSec?: number;
  /** Default DEFAULT_MAX_AHEAD_SEC. */
  maxAheadSec?: number;
  /** true: every input carries a P2PKH signature by `from`'s key. false: every scriptSig is empty. */
  signed: boolean;
}

export const TX_VERSION = 1;
export const TX_LOCKTIME = 0;
/** An hour: an older transaction is re-approved and rebuilt, not sent. */
export const DEFAULT_MAX_AGE_SEC = 3600;
/** Ten minutes of clock difference between whoever built it and whoever checks it. */
export const DEFAULT_MAX_AHEAD_SEC = 600;

export type ShapeProblemCode =
  | 'MALFORMED'
  | 'BAD_RULES'
  | 'BAD_ADDRESS'
  | 'CHANGE_NOT_SOURCE'
  | 'PAY_TO_SOURCE'
  | 'PAY_BELOW_DUST'
  | 'VERSION'
  | 'LOCKTIME'
  | 'SEQUENCE'
  | 'TOO_MANY_INPUTS'
  | 'DUPLICATE_INPUT'
  | 'PREVOUT_MISMATCH'
  | 'INPUT_NOT_FROM_SOURCE'
  | 'NOT_UNSIGNED'
  | 'SCRIPTSIG'
  | 'HASHTYPE'
  | 'PUBKEY_NOT_SOURCE'
  | 'ANCHOR_MISSING'
  | 'OUTPUT_COUNT'
  | 'OUTPUT_ADDRESS'
  | 'OUTPUT_VALUE'
  | 'CHANGE_ADDRESS'
  | 'INSUFFICIENT'
  | 'FEE_BELOW_RULE'
  | 'CHANGE_RULE'
  | 'FEE_ABOVE_MAX'
  | 'NTIME_BEFORE_PREVOUT'
  | 'NTIME_TOO_OLD'
  | 'NTIME_AHEAD';

export interface ShapeProblem {
  code: ShapeProblemCode;
  detail: string;
}

export type ShapeResult =
  | { ok: true; txid: string; fee: bigint; change: bigint }
  | { ok: false; problems: ShapeProblem[] };

/**
 * The coin `txid:vout`, read from the raw transaction that created it. Throws
 * unless `prevRaw` hashes to `txid` and has that output: a server that answers
 * with other bytes is caught here instead of believed.
 */
export function prevoutFromRawTx(prevRaw: string | Uint8Array, txid: string, vout: number): Prevout {
  const got = txidOfRaw(prevRaw);
  if (got !== txid) throw new Error(`previous transaction hashes to ${got}, not ${txid}`);
  const prev = decodeTx(prevRaw);
  const out = prev.outputs[vout];
  if (!Number.isInteger(vout) || vout < 0 || !out) throw new Error(`${txid} has no output ${vout}`);
  return { txid, vout, value: out.value, scriptPubKeyHex: out.scriptPubKeyHex, txNTime: prev.nTime };
}

/** Check `tx` against the rules. `prevouts[i]` is the coin input i spends. */
export function checkShape(tx: LanaTx, prevouts: readonly Prevout[], rules: ShapeRules): ShapeResult {
  const problems: ShapeProblem[] = [];
  const bad = (code: ShapeProblemCode, detail: string) => problems.push({ code, detail });

  // An object that does not encode is not a transaction (no inputs, no outputs, a field out of range).
  let txid: string;
  try {
    txid = txidOf(tx);
  } catch (e) {
    return { ok: false, problems: [{ code: 'MALFORMED', detail: (e as Error).message }] };
  }

  // The rules themselves: nothing below means anything without valid addresses.
  const fromHash = addressToHash160(rules.from);
  if (!fromHash) bad('BAD_ADDRESS', `from ${String(rules.from)}`);
  if (!addressToHash160(rules.change)) bad('BAD_ADDRESS', `change ${String(rules.change)}`);
  else if (rules.change !== rules.from) bad('CHANGE_NOT_SOURCE', `change ${rules.change} is not ${rules.from}`);
  const payScripts: string[] = [];
  rules.pay.forEach((p, i) => {
    const h = addressToHash160(p.address);
    if (!h) bad('BAD_ADDRESS', `payment ${i} ${String(p.address)}`);
    else {
      payScripts.push(p2pkhScriptHex(h));
      if (h === fromHash) bad('PAY_TO_SOURCE', `payment ${i} goes back to ${rules.from}`);
    }
    if (typeof p.lanoshis !== 'bigint' || p.lanoshis < DUST_LANOSHIS) bad('PAY_BELOW_DUST', `payment ${i} is ${String(p.lanoshis)}`);
  });
  const maxInputs = rules.maxInputs ?? MAX_INPUTS;
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1) bad('BAD_RULES', `maxInputs ${maxInputs}`);
  if (typeof rules.maxFee !== 'bigint' || rules.maxFee < 0n) bad('BAD_RULES', `maxFee ${String(rules.maxFee)}`);
  if (!Number.isSafeInteger(rules.nowSec) || rules.nowSec <= 0) bad('BAD_RULES', `nowSec ${rules.nowSec}`);
  for (const [what, v] of [['maxAgeSec', rules.maxAgeSec], ['maxAheadSec', rules.maxAheadSec]] as const) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) bad('BAD_RULES', `${what} ${v}`);
  }
  if (prevouts.length !== tx.inputs.length) bad('BAD_RULES', `${prevouts.length} prevouts for ${tx.inputs.length} inputs`);
  prevouts.forEach((p, i) => {
    if (typeof p.value !== 'bigint' || p.value < 0n || !Number.isSafeInteger(p.txNTime)) bad('BAD_RULES', `prevout ${i} has no valid value or nTime`);
  });
  if (problems.length) return { ok: false, problems };
  const fromScript = p2pkhScriptHex(fromHash as string);

  // Envelope.
  if (tx.version !== TX_VERSION) bad('VERSION', `version ${tx.version}`);
  if (tx.locktime !== TX_LOCKTIME) bad('LOCKTIME', `locktime ${tx.locktime}`);

  // Inputs: one wallet, each coin once, signed (or not) as asked.
  if (tx.inputs.length > maxInputs) bad('TOO_MANY_INPUTS', `${tx.inputs.length} inputs, at most ${maxInputs}`);
  const seen = new Set<string>();
  tx.inputs.forEach((input, i) => {
    const key = outpointKey(input.prevTxid, input.vout);
    if (seen.has(key)) bad('DUPLICATE_INPUT', `${key} is spent twice`);
    seen.add(key);
    if (input.sequence !== SEQUENCE_FINAL) bad('SEQUENCE', `input ${i} sequence ${input.sequence}`);
    const prev = prevouts[i];
    if (prev.txid !== input.prevTxid || prev.vout !== input.vout) {
      bad('PREVOUT_MISMATCH', `input ${i} spends ${key}, prevout given for ${outpointKey(prev.txid, prev.vout)}`);
    }
    if (prev.scriptPubKeyHex !== fromScript) bad('INPUT_NOT_FROM_SOURCE', `input ${i} spends a coin not locked to ${rules.from}`);
    if (!rules.signed) {
      if (input.scriptSigHex !== '') bad('NOT_UNSIGNED', `input ${i} carries a scriptSig`);
      return;
    }
    const sig = parseP2pkhScriptSig(input.scriptSigHex);
    if (!sig) {
      bad('SCRIPTSIG', `input ${i} is not <strict DER signature> <public key>`);
      return;
    }
    if (sig.hashType !== SIGHASH_ALL) bad('HASHTYPE', `input ${i} hash type ${sig.hashType}`);
    if (bytesToHex(hash160(sig.publicKey)) !== fromHash) bad('PUBKEY_NOT_SOURCE', `input ${i} key is not the key of ${rules.from}`);
  });
  for (const a of rules.anchors ?? []) {
    if (!seen.has(outpointKey(a.txid, a.vout))) bad('ANCHOR_MISSING', `${outpointKey(a.txid, a.vout)} is not spent`);
  }

  // Outputs: the payments in order, then at most one change back to `from`.
  const nPay = rules.pay.length;
  const hasChange = tx.outputs.length === nPay + 1;
  if (tx.outputs.length !== nPay && !hasChange) bad('OUTPUT_COUNT', `${tx.outputs.length} outputs for ${nPay} payments`);
  for (let i = 0; i < Math.min(nPay, tx.outputs.length); i++) {
    if (tx.outputs[i].scriptPubKeyHex !== payScripts[i]) bad('OUTPUT_ADDRESS', `output ${i} does not pay ${rules.pay[i].address}`);
    if (tx.outputs[i].value !== rules.pay[i].lanoshis) {
      bad('OUTPUT_VALUE', `output ${i} pays ${tx.outputs[i].value}, expected ${rules.pay[i].lanoshis}`);
    }
  }
  const changeValue = hasChange ? tx.outputs[nPay].value : 0n;
  if (hasChange && tx.outputs[nPay].scriptPubKeyHex !== fromScript) bad('CHANGE_ADDRESS', `output ${nPay} is not back to ${rules.from}`);

  // Fee: exactly the change rule, never above maxFee.
  const totalIn = prevouts.reduce((s, p) => s + p.value, 0n);
  const paying = rules.pay.reduce((s, p) => s + p.lanoshis, 0n);
  const fee = actualFee(tx, prevouts.map((p) => p.value));
  const rule = settle(totalIn, paying, tx.inputs.length, nPay);
  if (fee < feeFor(tx.inputs.length, tx.outputs.length)) {
    bad('FEE_BELOW_RULE', `fee ${fee} is below ${feeFor(tx.inputs.length, tx.outputs.length)} for ${tx.inputs.length} in, ${tx.outputs.length} out`);
  } else if (rule.ok === false) {
    bad('INSUFFICIENT', `the coins are ${rule.shortBy} lanoshis short`);
  } else if (rule.change !== changeValue || rule.fee !== fee) {
    bad('CHANGE_RULE', `change ${changeValue} and fee ${fee}; the rule gives change ${rule.change} and fee ${rule.fee}`);
  }
  if (fee > rules.maxFee) bad('FEE_ABOVE_MAX', `fee ${fee} is above ${rules.maxFee}`);

  // nTime.
  prevouts.forEach((p, i) => {
    if (tx.nTime < p.txNTime) bad('NTIME_BEFORE_PREVOUT', `nTime ${tx.nTime} is before input ${i}'s transaction (${p.txNTime})`);
  });
  if (tx.nTime < rules.nowSec - (rules.maxAgeSec ?? DEFAULT_MAX_AGE_SEC)) bad('NTIME_TOO_OLD', `nTime ${tx.nTime}, now ${rules.nowSec}`);
  if (tx.nTime > rules.nowSec + (rules.maxAheadSec ?? DEFAULT_MAX_AHEAD_SEC)) bad('NTIME_AHEAD', `nTime ${tx.nTime}, now ${rules.nowSec}`);

  if (problems.length) return { ok: false, problems };
  return { ok: true, txid, fee, change: changeValue };
}

export interface BuildArgs {
  from: string;
  pay: readonly Payment[];
  change: string;
  /** The coins to spend, in input order (selection is the caller's). */
  coins: readonly Prevout[];
  /** The builder's clock, seconds UTC; becomes the transaction's nTime. */
  nTime: number;
  maxFee: bigint;
  maxInputs?: number;
  anchors?: readonly Outpoint[];
}

export type BuildResult =
  | { ok: true; tx: LanaTx; fee: bigint; change: bigint; prevScriptsHex: string[] }
  | { ok: false; problems: ShapeProblem[] };

/**
 * The unsigned transaction spending `coins` to `pay`, with change by the rule.
 * It is checked with checkShape before it is returned, so the builder can never
 * produce what the checker refuses. Signing (signature.ts) and putting the
 * scriptSigs in (codec.ts p2pkhScriptSigHex) are the caller's next steps.
 */
export function buildUnsignedTx(args: BuildArgs): BuildResult {
  const fromHash = addressToHash160(args.from);
  if (!fromHash) return { ok: false, problems: [{ code: 'BAD_ADDRESS', detail: `from ${String(args.from)}` }] };
  if (args.coins.length === 0) return { ok: false, problems: [{ code: 'INSUFFICIENT', detail: 'no coins' }] };
  for (const [i, c] of args.coins.entries()) {
    if (typeof c.value !== 'bigint' || c.value < 0n) return { ok: false, problems: [{ code: 'BAD_RULES', detail: `coin ${i} has no valid value` }] };
  }
  const payScripts: string[] = [];
  for (const [i, p] of args.pay.entries()) {
    const h = addressToHash160(p.address);
    if (!h) return { ok: false, problems: [{ code: 'BAD_ADDRESS', detail: `payment ${i} ${String(p.address)}` }] };
    if (typeof p.lanoshis !== 'bigint' || p.lanoshis < DUST_LANOSHIS) {
      return { ok: false, problems: [{ code: 'PAY_BELOW_DUST', detail: `payment ${i} is ${String(p.lanoshis)}` }] };
    }
    payScripts.push(p2pkhScriptHex(h));
  }

  const totalIn = args.coins.reduce((s, c) => s + c.value, 0n);
  const paying = args.pay.reduce((s, p) => s + p.lanoshis, 0n);
  const rule = settle(totalIn, paying, args.coins.length, args.pay.length);
  if (rule.ok === false) return { ok: false, problems: [{ code: 'INSUFFICIENT', detail: `the coins are ${rule.shortBy} lanoshis short` }] };

  const tx: LanaTx = {
    version: TX_VERSION,
    nTime: args.nTime,
    inputs: args.coins.map((c) => ({ prevTxid: c.txid, vout: c.vout, scriptSigHex: '', sequence: SEQUENCE_FINAL })),
    outputs: args.pay.map((p, i) => ({ value: p.lanoshis, scriptPubKeyHex: payScripts[i] })),
    locktime: TX_LOCKTIME,
  };
  if (rule.change > 0n) tx.outputs.push({ value: rule.change, scriptPubKeyHex: p2pkhScriptHex(fromHash) });

  const checked = checkShape(tx, args.coins, {
    from: args.from,
    pay: args.pay,
    change: args.change,
    maxFee: args.maxFee,
    maxInputs: args.maxInputs,
    anchors: args.anchors,
    nowSec: args.nTime,
    signed: false,
  });
  if (checked.ok === false) return checked;
  return { ok: true, tx, fee: checked.fee, change: checked.change, prevScriptsHex: args.coins.map((c) => c.scriptPubKeyHex) };
}
