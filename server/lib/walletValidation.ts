/**
 * LANA wallet address validation — base58check + 21-byte payload.
 *
 * Mirror of lana-brain/server/lib/walletValidation.ts. Kept identical so the
 * two services give the same yes/no for any candidate address. Use this at
 * every ingress that accepts a wallet — especially POST /api/brain/lana-order
 * (so corrupt to_wallet values never reach the buyback-send code path again).
 */

import { createHash } from 'crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s: string): Buffer | null {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  let pad = 0;
  for (const c of s) { if (c === '1') pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), Buffer.from(h, 'hex')]);
}

export function isValidLanaAddress(addr: unknown): addr is string {
  if (typeof addr !== 'string' || addr.length === 0) return false;
  if (!/^L[a-km-zA-HJ-NP-Z1-9]+$/.test(addr)) return false;
  const raw = b58decode(addr);
  if (!raw || raw.length !== 25) return false;
  const payload = raw.subarray(0, 21);
  const expected = raw.subarray(21);
  const h1 = createHash('sha256').update(payload).digest();
  const h2 = createHash('sha256').update(h1).digest();
  return expected.equals(h2.subarray(0, 4));
}
