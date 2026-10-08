/**
 * LANA addresses: base58check with version byte 0x30 ("L…"), and the P2PKH
 * script an address stands for.
 *
 * WHY STRICT. An address is the one thing in a payment a person types or pastes,
 * and the one thing the chain never checks for us: a mistyped address that still
 * decodes would simply pay a different hash, and nobody could ever spend it. So a
 * string is an address only when ALL of these hold, and otherwise it is null:
 *   - every character is in the base58 alphabet (no spaces trimmed for you: the
 *     caller decides what a person meant, this file only says what a string is);
 *   - it decodes to exactly 25 bytes: version, 20-byte hash, 4-byte checksum;
 *   - the checksum is sha256d(version ‖ hash)[0..4];
 *   - the version byte is LANA's 0x30 (a Bitcoin "1…" address has a valid
 *     checksum too, and is refused);
 *   - it is the canonical spelling: encoding the bytes again gives the same
 *     string, so one wallet never has two accepted spellings.
 *
 * Same version byte and the same hash160 as krog-menjave server/lib/lanaAddress.ts
 * and lana-cards server/lib/lanaTx.ts; the tests pin real addresses from the chain.
 *
 * Both key forms are real: the same private key gives one address from its
 * 33-byte compressed public key (WIF T…/A…) and another from its 65-byte
 * uncompressed key (WIF 6…/3…). Which one a wallet is depends on the key form
 * that was hashed (MEM:ops_lana_wif_prefix_0x41.md); this file never guesses.
 */
import { bytesToHex, concatBytes, equalBytes, hash160, hexToBytes, sha256d } from './bytes.ts';

/** Address version byte for LanaCoin P2PKH ("L…"). */
export const LANA_ADDRESS_VERSION = 0x30;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Longer than any 25-byte encoding; bounds the work a hostile string can cause. */
const MAX_BASE58_LENGTH = 64;

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Null when a character is outside the alphabet or the string is implausibly long. */
export function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length > MAX_BASE58_LENGTH) return null;
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return concatBytes(new Uint8Array(zeros), Uint8Array.from(body));
}

export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concatBytes(payload, sha256d(payload).subarray(0, 4)));
}

/** The payload (checksum removed), or null when the string or its checksum is wrong. */
export function base58CheckDecode(s: string): Uint8Array | null {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  if (!equalBytes(sha256d(payload).subarray(0, 4), raw.subarray(raw.length - 4))) return null;
  return Uint8Array.from(payload);
}

/** hash160 (40 lowercase hex) of a LANA address, or null when it is not exactly one. */
export function addressToHash160(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const payload = base58CheckDecode(address);
  if (!payload || payload.length !== 21 || payload[0] !== LANA_ADDRESS_VERSION) return null;
  if (base58CheckEncode(payload) !== address) return null;
  return bytesToHex(payload.subarray(1));
}

export function isLanaAddress(address: unknown): address is string {
  return addressToHash160(address) !== null;
}

export function hash160ToAddress(hash160Hex: string): string {
  const h = hexToBytes(hash160Hex);
  if (h.length !== 20) throw new Error('hash160 must be 20 bytes');
  return base58CheckEncode(concatBytes(Uint8Array.of(LANA_ADDRESS_VERSION), h));
}

/**
 * The address of a public key in the form given: 33 bytes (02/03 prefix) or 65
 * bytes (04 prefix). It does not check the point is on the curve; signing does.
 */
export function addressOfPublicKey(publicKey: Uint8Array): string {
  const okCompressed = publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03);
  const okUncompressed = publicKey.length === 65 && publicKey[0] === 0x04;
  if (!okCompressed && !okUncompressed) throw new Error('public key must be 33 bytes (02/03) or 65 bytes (04)');
  return hash160ToAddress(bytesToHex(hash160(publicKey)));
}

/** OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG, as hex. */
export function p2pkhScriptHex(hash160Hex: string): string {
  if (!/^[0-9a-f]{40}$/.test(hash160Hex)) throw new Error('hash160 must be 40 lowercase hex');
  return `76a914${hash160Hex}88ac`;
}

/** The hash160 a P2PKH script locks to, or null for any other script. */
export function p2pkhHash160(scriptHex: string): string | null {
  const m = /^76a914([0-9a-f]{40})88ac$/.exec(scriptHex);
  return m ? m[1] : null;
}

/**
 * The hash160 of the public key a pay-to-public-key script locks to — <33 bytes 02/03 | 65 bytes 04> OP_CHECKSIG — or
 * null for any other script. The LANA desktop wallet writes its staking reward this way (lanacoin-v2 wallet.cpp:
 * "convert to pay to public key type"), and the Electrum servers list such a coin under the address of that key's
 * hash160: a coin of the wallet a P2PKH signature cannot spend (review of 6. 10. 2026).
 */
export function p2pkHash160(scriptHex: string): string | null {
  const m = /^(?:21((?:02|03)[0-9a-f]{64})|41(04[0-9a-f]{128}))ac$/.exec(scriptHex);
  return m ? bytesToHex(hash160(hexToBytes(m[1] ?? m[2]))) : null;
}

/** <public key> OP_CHECKSIG, as hex: a pay-to-public-key script (tests build such coins). */
export function p2pkScriptHex(publicKey: Uint8Array): string {
  addressOfPublicKey(publicKey);
  return `${publicKey.length === 33 ? '21' : '41'}${bytesToHex(publicKey)}ac`;
}

/** The P2PKH script paying `address`. Throws when it is not a LANA address. */
export function scriptOfAddress(address: string): string {
  const h = addressToHash160(address);
  if (!h) throw new Error('not a LANA address');
  return p2pkhScriptHex(h);
}

/** The LANA address a P2PKH script pays, or null for any other script. */
export function addressOfScript(scriptHex: string): string | null {
  const h = p2pkhHash160(scriptHex);
  return h ? hash160ToAddress(h) : null;
}
