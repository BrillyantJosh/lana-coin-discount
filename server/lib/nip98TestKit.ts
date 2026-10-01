/**
 * Test-only: build the Authorization header a browser running
 * src/lib/nip98Fetch.ts would send, with a key the test owns. Mirrors
 * nostr-tools finalizeEvent (NIP-01 id, BIP-340 signature) using the same
 * @noble/curves the server verifies with.
 */
import { createHash, randomBytes } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

export interface TestSigner {
  sk: string;
  hex: string;
}

export function newSigner(): TestSigner {
  const sk = randomBytes(32).toString('hex');
  return { sk, hex: Buffer.from(schnorr.getPublicKey(Buffer.from(sk, 'hex'))).toString('hex') };
}

export interface SignOptions {
  method: string;
  /** Absolute URL or bare path + query, exactly as the browser would sign it. */
  url: string;
  /** The exact body string that will be sent. */
  body?: string;
  nowSec?: number;
  /** Override the payload tag (e.g. to sign a different body than is sent). */
  payload?: string | null;
  kind?: number;
  extraTags?: string[][];
}

export function nip98Header(signer: TestSigner, o: SignOptions): string {
  const created_at = o.nowSec ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ['u', o.url],
    ['method', o.method.toUpperCase()],
    ['nonce', randomBytes(16).toString('hex')],
  ];
  const payload = o.payload !== undefined
    ? o.payload
    : (o.body ? createHash('sha256').update(o.body).digest('hex') : null);
  if (payload) tags.push(['payload', payload]);
  if (o.extraTags) tags.push(...o.extraTags);
  const kind = o.kind ?? 27235;
  const content = '';
  const id = createHash('sha256')
    .update(JSON.stringify([0, signer.hex, created_at, kind, tags, content]))
    .digest('hex');
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), Buffer.from(signer.sk, 'hex'))).toString('hex');
  const ev = { id, pubkey: signer.hex, created_at, kind, tags, content, sig };
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
