/**
 * Is a finished transaction signed by a wallet's key?
 *
 * Ported from the archived km-signer (krog-menjave-signer src/verify.ts, 2 Oct
 * 2026), only its import paths changed. In Krog Menjave it runs twice for every
 * payout: in the admin's browser right after signing (payout.ts: nothing is sent
 * that does not verify), and on the server when the browser announces the
 * transaction (the server believes nothing the browser says about it).
 *
 * Checked from the bytes alone: the transaction is decoded and re-encoded, the
 * sighash of every input is recomputed from the decoded bytes (every input in
 * the preimage, sighash.ts), and each signature must be SIGHASH_ALL, strict DER,
 * low S, made by the wallet's public key, and valid under noble AND elliptic.
 * Two libraries, as the fleet's signature.ts does it: a bug in one does not pass
 * alone.
 *
 * `raw` is lowercase hex, as encodeTxHex writes it: the same transaction in
 * capitals is "does not re-encode to the same bytes". Lowercase it first if it
 * came from somewhere else.
 */
import * as secp from '@noble/secp256k1';
import elliptic from 'elliptic';
import { addressOfPublicKey } from './address.ts';
import { bytesToHex, hexToBytes } from './bytes.ts';
import { decodeTx, encodeTx, isStrictDer, parseP2pkhScriptSig, SIGHASH_ALL, type LanaTx } from './codec.ts';
import { sighash } from './sighash.ts';
import type { Prevout } from './shape.ts';

const ec = new elliptic.ec('secp256k1');
/** The curve order, from the signing library itself (verify.test.ts holds it against the published constant). */
const N = secp.Point.CURVE().n;

/** r ‖ s (64 bytes) of a strict DER signature, or null. */
function derToCompact(der: Uint8Array): Uint8Array | null {
  if (!isStrictDer(der)) return null;
  const lenR = der[3];
  const r = BigInt('0x' + bytesToHex(der.subarray(4, 4 + lenR)));
  const s = BigInt('0x' + bytesToHex(der.subarray(6 + lenR)));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  return hexToBytes(r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0'));
}

/**
 * Every input of `raw` carries a SIGHASH_ALL, strict-DER, low-S signature by
 * `publicKeyHex`, valid under noble AND elliptic over the sighash recomputed
 * from these very bytes. Returns the problems found (empty = all good).
 * `prevouts[i]` gives input i's previous output script (what the sighash signs).
 */
export function verifyTxSignatures(raw: string, prevouts: readonly Pick<Prevout, 'scriptPubKeyHex'>[], publicKeyHex: string): string[] {
  const problems: string[] = [];
  let tx: LanaTx;
  try {
    tx = decodeTx(raw);
  } catch (e) {
    return [`does not decode: ${(e as Error).message}`];
  }
  if (bytesToHex(encodeTx(tx)) !== raw) problems.push('does not re-encode to the same bytes');
  if (prevouts.length !== tx.inputs.length) return [...problems, 'one prevout per input is required'];
  tx.inputs.forEach((input, i) => {
    const sig = parseP2pkhScriptSig(input.scriptSigHex);
    if (!sig) return void problems.push(`input ${i}: not <strict DER> <public key>`);
    if (sig.hashType !== SIGHASH_ALL) problems.push(`input ${i}: hash type ${sig.hashType}`);
    if (bytesToHex(sig.publicKey) !== publicKeyHex) problems.push(`input ${i}: not the wallet's public key`);
    const compact = derToCompact(sig.signatureDer);
    if (!compact) return void problems.push(`input ${i}: signature out of range`);
    if (BigInt('0x' + bytesToHex(compact.subarray(32))) > N / 2n) problems.push(`input ${i}: high S`);
    const digest = sighash(tx, i, prevouts[i].scriptPubKeyHex);
    if (!secp.verify(compact, digest, sig.publicKey, { prehash: false, lowS: true })) problems.push(`input ${i}: noble refuses the signature`);
    if (!ec.keyFromPublic(publicKeyHex, 'hex').verify(bytesToHex(digest), Array.from(sig.signatureDer))) {
      problems.push(`input ${i}: elliptic refuses the signature`);
    }
  });
  return problems;
}

/**
 * The same, for a WALLET rather than a public key: what the server knows of
 * the payout wallet is its address. The key is the one the first input reveals,
 * and it must be the key of `address` in the form the address was made from
 * (a compressed key cannot sign for the uncompressed key's address, and the
 * other way round); every input must then be signed by that same key.
 */
export function verifyTxSignedBy(raw: string, prevouts: readonly Pick<Prevout, 'scriptPubKeyHex'>[], address: string): string[] {
  let tx: LanaTx;
  try {
    tx = decodeTx(raw);
  } catch (e) {
    return [`does not decode: ${(e as Error).message}`];
  }
  const first = parseP2pkhScriptSig(tx.inputs[0].scriptSigHex);
  if (!first) return ['input 0: not <strict DER> <public key>'];
  if (addressOfPublicKey(first.publicKey) !== address) return [`input 0: the key is not the key of ${String(address)}`];
  return verifyTxSignatures(raw, prevouts, bytesToHex(first.publicKey));
}
