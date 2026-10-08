/**
 * LANA addresses from a public key, on the server.
 *
 * A sign-in event is signed with an x-only key; the address a person actually
 * holds depends on the key form they typed (compressed T…/A… or uncompressed
 * 6…/3…). The browser sends its 33-byte compressed public key and the address
 * of its key form inside the SIGNED event; this checks that both belong to the
 * signature's key, so nobody can sign in "as" a wallet they do not control.
 *
 * Ported from krog-menjave/server/lib/lanaAddress.ts.
 *
 * isLanaAddress goes the other way: whether a text someone wrote is a LANA
 * address at all (a dealer's payout wallet, KIND 30972 v1.4.0).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Base58 → bytes, each leading "1" a leading zero byte; null on a character outside the alphabet. */
function base58Decode(text: string): Uint8Array | null {
  let num = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    num = num * 58n + BigInt(digit);
  }
  let hex = num === 0n ? '' : num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + hex.length / 2);
  out.set(Buffer.from(hex, 'hex'), zeros);
  return out;
}

/** Base58Check(0x30 ‖ ripemd160(sha256(pubkey))). */
export function lanaAddressOf(publicKey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = 0x30;
  payload.set(ripemd160(sha256(publicKey)), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(sha256(sha256(payload)).subarray(0, 4), 21);
  return base58Encode(full);
}

/**
 * A LANA address exactly as written: 34 Base58 characters starting with L
 * that decode to 25 bytes — the version byte 0x30, a 20-byte key hash, and a
 * checksum (the first 4 bytes of double SHA-256 of the 21 before it) that
 * holds. No spaces, no other version byte. The rule of isLanaAddress in
 * lana-nostr-kinds-bef/src/lib/correctionSafety.ts (KIND 30972 payout_wallet
 * and receive_wallet, KIND 87070's wallet), the inverse of lanaAddressOf above.
 */
export function isLanaAddress(address: unknown): boolean {
  if (typeof address !== 'string' || !/^L[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x30) return false;
  const check = sha256(sha256(raw.subarray(0, 21)));
  for (let i = 0; i < 4; i++) if (check[i] !== raw[21 + i]) return false;
  return true;
}

export interface KeyAddresses {
  compressed: string;
  uncompressed: string;
}

/**
 * Both addresses of a 33-byte compressed public key, provided its x coordinate
 * is the signer's x-only key. Null when the key is malformed or not the signer's.
 */
export function addressesForSigner(compressedKeyHex: unknown, signerHex: string): KeyAddresses | null {
  if (typeof compressedKeyHex !== 'string' || !/^0[23][0-9a-f]{64}$/.test(compressedKeyHex)) return null;
  if (compressedKeyHex.slice(2) !== signerHex) return null;
  try {
    const point = secp256k1.Point.fromHex(compressedKeyHex);
    return {
      compressed: lanaAddressOf(point.toBytes(true)),
      uncompressed: lanaAddressOf(point.toBytes(false)),
    };
  } catch {
    return null;
  }
}
