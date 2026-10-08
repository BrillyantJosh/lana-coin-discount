/**
 * A LANA wallet key (WIF) → identity, in the browser only.
 *
 * THE PRIVATE KEY NEVER LEAVES THE CALLER. It is decoded here, used once to sign
 * a short-lived sign-in event, and wiped; the server only ever receives a public
 * key and a signature.
 *
 * The reading rules are lana-paper-wallet's (src/lib/wif.ts, pinned there by
 * tools/verify-wif.mjs), rebuilt on @noble so they need no WebCrypto and run the
 * same in the tests:
 *   - exactly 37 bytes (uncompressed) or 38 bytes with the flag byte 0x01;
 *   - the checksum is settled BEFORE the version byte, so a typo in a Lana key
 *     is called a typo, and a real key from another chain is called that;
 *   - version 0xB0 (LanaCoin core, starts T… or 6…) or 0x41 (100Million2Everyone,
 *     starts A… or 3…); Bitcoin's 0x80 is another network;
 *   - the key must lie in [1, n-1].
 * The compression flag decides the address: T and A give one address, 6 and 3
 * another. The identity (the x-only public key) is the same for all four.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's src/lib/wif.ts (origin/main
 * a46f618), unchanged. Only payoutKey.ts reads a key with it — the financer's
 * Lana.Discount wallet, to sign the LANA of their purchases; the sign-in
 * helpers below come along with the file and nothing here calls them (this
 * site's own sign-in is src/lib/crypto.ts).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const LANA_WIF_VERSIONS = [0xb0, 0x41];
const LANA_ADDRESS_VERSION = 0x30;
/** Order of the secp256k1 group, big-endian — a private key must lie in [1, n-1]. */
const SECP256K1_N = hexToBytesConst('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** What a scan or a PDF paste drags along: every JS whitespace (NBSP and BOM
 * included) and the zero-width joiners. */
const STRIPPABLE = /[\s\u200b\u200c\u200d]/g;
/** A leading URI scheme such as "lanacoin:" — base58 has no ":". */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?/;

function hexToBytesConst(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function normalizeKeyInput(raw: string): string {
  if (!raw) return '';
  return raw.replace(STRIPPABLE, '').replace(URI_SCHEME, '');
}

/** Base58 without throwing: a mistyped character is an answer, not a crash. */
export function tryBase58Decode(input: string): Uint8Array | null {
  if (!input) return null;
  let num = 0n;
  for (const ch of input) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    num = num * 58n + BigInt(digit);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = num === 0n ? new Uint8Array(0) : hexToBytes(hex);
  let zeros = 0;
  for (const ch of input) {
    if (ch !== '1') break;
    zeros++;
  }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  body.fill(0);
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + (bytesToHex(bytes) || '0'));
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

const sha256d = (data: Uint8Array): Uint8Array => sha256(sha256(data));

const checksumMatches = (bytes: Uint8Array): boolean => {
  const body = bytes.subarray(0, bytes.length - 4);
  const expected = sha256d(body);
  for (let i = 0; i < 4; i++) if (bytes[bytes.length - 4 + i] !== expected[i]) return false;
  return true;
};

/** LanaCoin P2PKH address: Base58Check(0x30 ‖ ripemd160(sha256(pubkey))). */
export function lanaAddress(publicKey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = LANA_ADDRESS_VERSION;
  payload.set(ripemd160(sha256(publicKey)), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(sha256d(payload).subarray(0, 4), 21);
  return base58Encode(full);
}

/**
 * What the person typed or scanned, before any attempt to read it as a key —
 * so that an address or a Nostr key is named for what it is, instead of being
 * called a broken WIF.
 */
export type KeyInputKind = 'empty' | 'address' | 'npub' | 'nsec' | 'hex' | 'candidate';

export function classifyKeyInput(raw: string): KeyInputKind {
  const text = normalizeKeyInput(raw);
  if (!text) return 'empty';
  const lower = text.toLowerCase();
  if (lower.startsWith('npub1')) return 'npub';
  if (lower.startsWith('nsec1')) return 'nsec';
  if (/^[0-9a-fA-F]{64}$/.test(text)) return 'hex';
  // What is decoded here is only looked at, and wiped before the answer whatever it is: for a WIF it holds the private
  // bytes (8. 10. 2026 — a sign-in field now reads what is typed on every change, src/lib/keyUsername.ts).
  const bytes = tryBase58Decode(text);
  const address = bytes != null && bytes.length === 25 && bytes[0] === LANA_ADDRESS_VERSION && checksumMatches(bytes);
  bytes?.fill(0);
  return address ? 'address' : 'candidate';
}

/** 1 <= key <= n-1, compared byte by byte so the key never becomes a string. */
function inKeyRange(key: Uint8Array): boolean {
  if (key.every((b) => b === 0)) return false;
  for (let i = 0; i < 32; i++) {
    if (key[i] < SECP256K1_N[i]) return true;
    if (key[i] > SECP256K1_N[i]) return false;
  }
  return false; // equal to n
}

export type WifError = 'notAKey' | 'wrongNetwork' | 'checksum';

export type DecodedWif =
  | {
      ok: true;
      /** 32 bytes. Wipe with wipe() as soon as it has signed. */
      privateKey: Uint8Array;
      compressed: boolean;
      /** The LANA address this key form controls. */
      address: string;
      /** x-only Schnorr public key, lowercase hex — the person's identity. */
      hex: string;
      /** The 33-byte compressed public key, hex. Its x is `hex`; the server
       * derives both address forms from it. Public, like the address. */
      publicKey: string;
    }
  | { ok: false; reason: WifError };

export function decodeWif(input: string): DecodedWif {
  const bytes = tryBase58Decode(normalizeKeyInput(input));
  if (!bytes) return { ok: false, reason: 'notAKey' };
  // Every refusal wipes what was decoded first: a key with one typo, or a real key of another network, still holds its
  // private bytes in it.
  const refuse = (reason: WifError): DecodedWif => {
    bytes.fill(0);
    return { ok: false, reason };
  };

  let compressed: boolean;
  if (bytes.length === 37) {
    compressed = false;
  } else if (bytes.length === 38) {
    // The byte between the key and the checksum is the compression flag; any
    // other value means this is not a WIF, whatever else happens to line up.
    if (bytes[33] !== 0x01) return refuse('notAKey');
    compressed = true;
  } else {
    return refuse('notAKey');
  }

  if (!checksumMatches(bytes)) return refuse('checksum');
  if (!LANA_WIF_VERSIONS.includes(bytes[0])) return refuse('wrongNetwork');

  const privateKey = bytes.slice(1, 33);
  bytes.fill(0);
  if (!inKeyRange(privateKey)) {
    privateKey.fill(0);
    return { ok: false, reason: 'notAKey' };
  }

  const publicKey = secp256k1.getPublicKey(privateKey, compressed);
  return {
    ok: true,
    privateKey,
    compressed,
    address: lanaAddress(publicKey),
    hex: bytesToHex(schnorr.getPublicKey(privateKey)),
    publicKey: bytesToHex(secp256k1.getPublicKey(privateKey, true)),
  };
}

/** Overwrite key material in place. JavaScript strings cannot be wiped; bytes can. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Any Nostr event, signed with Schnorr (NIP-01). */
export function signEvent(privateKey: Uint8Array, kind: number, tags: string[][], content: string, createdAt: number): SignedEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey));
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, createdAt, kind, tags, content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privateKey));
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

/**
 * The sign-in event (kind 27235): bound to the endpoint, to a challenge the
 * server issued, and to a moment — so a captured one opens nothing else.
 * `createdAt` comes from the server's clock, so a phone set to the wrong time
 * can still sign in. It also carries the public key and the address of the
 * wallet, so the server can ask the Registrar about exactly that wallet.
 */
export function signLoginEvent(
  privateKey: Uint8Array,
  url: string,
  challenge: string,
  createdAt: number,
  wallet: { publicKey: string; address: string },
): SignedEvent {
  const tags = [
    ['u', url],
    ['method', 'POST'],
    ['challenge', challenge],
    ['key', wallet.publicKey],
    ['address', wallet.address],
  ];
  return signEvent(privateKey, 27235, tags, '', createdAt);
}

/** The person's own request to the Registrar to register their wallet —
 * the event LanaTrace.us accepts in its X-Admin-Auth header. */
export function signRegistrarRequest(privateKey: Uint8Array, createdAt: number): SignedEvent {
  return signEvent(privateKey, 27235, [['action', 'fn:register-virgin-wallets']], '', createdAt);
}
