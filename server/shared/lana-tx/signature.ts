/**
 * Sign a LanaCoin transaction input's sighash.
 *
 * WHY THIS FILE EXISTS. The signer this app used before (a hand-written ECDSA
 * copied from the fleet's shared Deno signer) chose the nonce as
 * k = (sighash + privateKey) mod n. The sighash is public — anyone can rebuild
 * it from the transaction on the chain — so every signature it produced lets
 * anyone compute the signer's private key with one line of algebra:
 *     s·(z + d) = z + r·d   ⇒   d = z·(1 − s) / (s − r)   (mod n, for s or n − s)
 * The nonce must never be derivable by anyone who does not already hold the key.
 *
 * Now: @noble/secp256k1 (audited) with RFC 6979 deterministic nonces hedged with
 * fresh randomness (`extraEntropy: true`), low-S, and every signature verified
 * twice — by noble and by the independent `elliptic` library — before it is
 * allowed into a transaction. A signature that fails either check is never
 * broadcast. Same module as lana-cards/src/lib/lanaSignature.ts.
 */
import * as secp from '@noble/secp256k1';
import elliptic from 'elliptic';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ec = new elliptic.ec('secp256k1');

function toHex(a: Uint8Array): string {
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

/** Strict DER for (r, s), as Bitcoin-family nodes require. */
export function encodeDER(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    const bytes = Array.from(fromHex(v.toString(16).padStart(64, '0')));
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
    if (bytes[0] >= 0x80) bytes.unshift(0);
    return bytes;
  };
  const rb = int(r);
  const sb = int(s);
  const body = [0x02, rb.length, ...rb, 0x02, sb.length, ...sb];
  return new Uint8Array([0x30, body.length, ...body]);
}

/**
 * DER signature (without the sighash-type byte) of a 32-byte sighash.
 * `publicKey` is the key the input will carry (compressed or uncompressed);
 * the signature is checked against exactly that key before it is returned.
 */
export async function signLanaSighash(privateKeyHex: string, sighash: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
  if (sighash.length !== 32) throw new Error('sighash must be 32 bytes');
  const secret = fromHex(privateKeyHex);
  if (secret.length !== 32) throw new Error('private key must be 32 bytes');

  const compact = await secp.signAsync(sighash, secret, { prehash: false, lowS: true, extraEntropy: true });
  const r = BigInt('0x' + toHex(compact.slice(0, 32)));
  const s = BigInt('0x' + toHex(compact.slice(32, 64)));
  if (r <= 0n || r >= N || s <= 0n || s > N / 2n) throw new Error('signer produced an out-of-range signature');

  // Two independent verifications before anything is broadcast.
  if (!secp.verify(compact, sighash, publicKey, { prehash: false, lowS: true })) {
    throw new Error('signature failed verification (noble) — nothing was sent');
  }
  const der = encodeDER(r, s);
  if (!ec.keyFromPublic(toHex(publicKey), 'hex').verify(toHex(sighash), Array.from(der))) {
    throw new Error('signature failed verification (elliptic) — nothing was sent');
  }
  return der;
}
