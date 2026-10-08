/**
 * Bytes, hex and the two hashes a LANA transaction is made of.
 *
 * WHY THIS FILE IS SO SMALL. lana-tx runs in three places: the browser (a client
 * signing a sale to KM), km-financer and km-signer. So nothing in it may lean on
 * Node: no Buffer, no node:crypto. The hashes come from @noble/hashes (audited,
 * synchronous, the same family as the @noble/secp256k1 that signs), which the
 * Krog Menjave site already uses for addresses (krog-menjave server/lib/lanaAddress.ts).
 *
 * Hex in and out of this library is lowercase. Hex coming in may be either case,
 * but anything that is not an even number of hex digits is refused: a stray space
 * or an odd digit silently dropped would change which bytes get signed.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const HEX_RE = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new Error('not an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A reversed copy: txids are hashed in one byte order and printed in the other. */
export function reversed(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** sha256(sha256(x)): txids, sighashes and address checksums. */
export function sha256d(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

/** ripemd160(sha256(x)): the 20 bytes a P2PKH address and script are made of. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(nobleSha256(data));
}
