/**
 * LANA addresses on the server: from a public key, and read from what a page sent.
 *
 * A sign-in event is signed with an x-only key; the address a person actually
 * holds depends on the key form they typed (compressed T…/A… or uncompressed
 * 6…/3…). The browser sends its 33-byte compressed public key and the address
 * of its key form inside the SIGNED event; this checks that both belong to the
 * signature's key, so nobody can sign in "as" a wallet they do not control.
 *
 * A NEW WALLET'S ADDRESS IS CHECKED HERE TOO (6. 10. 2026, /ko-kreacija/kupi).
 * The Registrar checks only that an address starts with "L" and is 26–35
 * letters and digits (new-lana-register register-virgin-wallets.ts): a
 * mistyped address passes there, is "empty" because nobody holds its key, and
 * would be registered for good to a wallet nobody can ever spend from. So the
 * address a person asks to register is read in full before anything is asked:
 * Base58, 25 bytes, version 0x30, and the 4-byte checksum matching.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's server/lib/lanaAddress.ts
 * (origin/main a46f618), unchanged; chainPayment.ts reads a wallet through it
 * before any Electrum server is asked about it.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** LanaCoin's address version byte: every LANA address starts with "L". */
export const LANA_ADDRESS_VERSION = 0x30;
/** A Base58Check of 25 bytes is at most 35 characters; anything longer is not looked at. */
const MAX_ADDRESS_LENGTH = 35;

/** Base58 to bytes, each leading "1" a zero byte; null for any character outside the alphabet. */
function base58Decode(text: string): Uint8Array | null {
  let num = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    num = num * 58n + BigInt(digit);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const hex = num === 0n ? '' : num.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

/**
 * The LANA address exactly as given, when it is one: a string of Base58 that
 * decodes to 25 bytes — version 0x30, a 20-byte key hash, and the first 4
 * bytes of sha256(sha256(the 21 before)). Null for anything else: another
 * network's version, a typo the checksum catches, spaces, a key, a URI.
 */
export function readLanaAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 26 || value.length > MAX_ADDRESS_LENGTH) return null;
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== LANA_ADDRESS_VERSION) return null;
  const check = sha256(sha256(bytes.subarray(0, 21)));
  for (let i = 0; i < 4; i++) if (bytes[21 + i] !== check[i]) return null;
  return value;
}

/**
 * The 20-byte key hash of a LANA address (hex, lower case) — what a P2PKH output
 * paying it carries (76 a9 14 <hash> 88 ac) — or null when the address does not
 * read in full (readLanaAddress). The Electrum servers do not check an
 * address's checksum (an address with one letter changed is answered with
 * another wallet's partial history, 6. 10. 2026), so a payout is read only for
 * an address that passed here first (server/lib/chainPayment.ts).
 */
export function lanaAddressHash160(value: unknown): string | null {
  const address = readLanaAddress(value);
  if (!address) return null;
  const bytes = base58Decode(address);
  return bytes ? Buffer.from(bytes.subarray(1, 21)).toString('hex') : null;
}

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

/** Base58Check(0x30 ‖ ripemd160(sha256(pubkey))). */
export function lanaAddressOf(publicKey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = LANA_ADDRESS_VERSION;
  payload.set(ripemd160(sha256(publicKey)), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(sha256(sha256(payload)).subarray(0, 4), 21);
  return base58Encode(full);
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
