/**
 * What each input's signature signs: the legacy SIGHASH_ALL digest.
 *
 * For input i, the node takes a copy of the transaction, empties EVERY input's
 * scriptSig, puts the script being spent (the prevout's P2PKH scriptPubKey) into
 * input i only, serialises the copy with nTime as always, appends the hash type
 * as 4 little-endian bytes and hashes it twice with sha256. So one signature
 * commits to every input's outpoint and sequence, every output, the version,
 * nTime and the locktime. Change any of them and every signature breaks.
 *
 * WHY THIS IS SPELLED OUT. Two builders in the fleet got it wrong, and neither
 * may be copied (spec Q11, Q12):
 *   - lana-pays-us server/routes/functions.ts put ONLY the input being signed
 *     into the preimage while the count still said n. For one input that is the
 *     same bytes, so single-input payments worked; with two or more, the node
 *     hashes something else and refuses every signature. sighash.test.ts proves
 *     that shape fails on mainnet multi-input transactions while this one passes;
 *   - buylana src/lib/transaction.ts computes the preimage right but signs with
 *     a hand-written nonce. Signing lives only in signature.ts.
 * lana-cards src/lib/txBuilder.ts:350-381 is the shape this follows.
 *
 * WHAT IT DOES NOT COVER. A legacy sighash does not commit to the VALUE of the
 * coins being spent. A signer told "this input is worth 10 LANA" when it is worth
 * 1,000 signs a transaction whose difference goes to the fee, and the signature
 * is valid. So whoever signs must read every prevout value from the raw previous
 * transaction it fetched itself and re-hashed to its txid (shape.ts
 * prevoutFromRawTx; spec §5.5 rule 5), never from a number someone sent.
 *
 * Only SIGHASH_ALL, and only P2PKH scriptCodes, are accepted: those are the only
 * ones KM ever signs. A P2PKH script has no OP_CODESEPARATOR, so the legacy
 * scriptCode rules reduce to "the scriptPubKey as it is".
 */
import { concatBytes, sha256d } from './bytes.ts';
import { p2pkhHash160 } from './address.ts';
import { encodeTx, SIGHASH_ALL, type LanaTx } from './codec.ts';

export { SIGHASH_ALL } from './codec.ts';

/** The exact bytes that are hashed for input `inputIndex`. Exported so tests can show them. */
export function sighashPreimage(tx: LanaTx, inputIndex: number, scriptCodeHex: string, hashType: number = SIGHASH_ALL): Uint8Array {
  if (hashType !== SIGHASH_ALL) throw new Error('only SIGHASH_ALL is supported');
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`input index ${inputIndex} is out of range`);
  }
  if (p2pkhHash160(scriptCodeHex) === null) throw new Error('the script being spent must be a P2PKH script');
  const copy: LanaTx = {
    ...tx,
    inputs: tx.inputs.map((input, i) => ({ ...input, scriptSigHex: i === inputIndex ? scriptCodeHex : '' })),
  };
  const type = new Uint8Array(4);
  new DataView(type.buffer).setUint32(0, hashType, true);
  return concatBytes(encodeTx(copy), type);
}

/** The 32-byte digest input `inputIndex` signs (what signature.ts signLanaSighash takes). */
export function sighash(tx: LanaTx, inputIndex: number, scriptCodeHex: string, hashType: number = SIGHASH_ALL): Uint8Array {
  return sha256d(sighashPreimage(tx, inputIndex, scriptCodeHex, hashType));
}

/** One digest per input; `prevScriptsHex[i]` is the scriptPubKey input i spends. */
export function sighashes(tx: LanaTx, prevScriptsHex: readonly string[]): Uint8Array[] {
  if (prevScriptsHex.length !== tx.inputs.length) throw new Error('one prevout script per input is required');
  return tx.inputs.map((_, i) => sighash(tx, i, prevScriptsHex[i]));
}
