/**
 * WHO IS ASKING — proved per request, not claimed.
 *
 * Until 2 Oct 2026 the admin API of this server believed a bare header
 * (`x-admin-hex-id` / `x-admin-hex`, or `?admin_hex=`) holding a Nostr PUBLIC
 * key. A public key is public: it is on every event on the relays and on the
 * project's own web pages. So anybody who had seen an admin's hex could send it
 * and be that admin. Naming yourself was authentication.
 *
 * The caller now SIGNS each request: a NIP-98 event (kind 27235) signed with
 * the key whose hex it claims, that binds
 *   - the HTTP method                    (`method` tag)
 *   - the path AND query string          (`u` tag — absolute URL or bare path;
 *                                         an absolute one must name THIS host)
 *   - the exact body bytes, when there is a body  (`payload` = sha256 hex)
 * is at most MAX_SKEW_SEC old or early, and is SINGLE USE: a header captured in
 * flight cannot be replayed, not even inside its minute.
 *
 * The signature only establishes the hex. Whether that hex may do the thing —
 * the admin roster, root-only routes, the KIND 87058 exclusion gate — is still
 * decided by the caller of this module, exactly as before.
 *
 * ⚠ Two identical requests in the same second would be the SAME event (the id is
 * sha256 over [0, pubkey, created_at, kind, tags, content]; the signature is not
 * in it) and single use would refuse the second. That is why the browser helper
 * (src/lib/nip98Fetch.ts) puts a random `nonce` tag in every token. NIP-98
 * allows extra tags and they are inside the signature, so nobody can strip one.
 *
 * This file is vendored BYTE-IDENTICAL into lana-brain, lana-direct-fund and
 * lana-coin-discount. Fix it in one place and copy it.
 */
import { createHash } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

export const AUTH_KIND = 27235;
/** How long a token is good for, either way of "now". A captured header dies with it. */
export const MAX_SKEW_SEC = 60;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type Nip98Reason =
  | 'MISSING' | 'MALFORMED' | 'BAD_BASE64' | 'BAD_EVENT' | 'BAD_KIND' | 'BAD_PUBKEY'
  | 'BAD_SIG' | 'BAD_ID' | 'BAD_TIME' | 'STALE' | 'BAD_TAGS' | 'METHOD_MISMATCH'
  | 'PATH_MISMATCH' | 'HOST_MISMATCH' | 'PAYLOAD_MISSING' | 'PAYLOAD_MISMATCH' | 'REPLAYED';

export type Nip98Result =
  | { ok: true; hex: string; id: string }
  | { ok: false; reason: Nip98Reason };

export interface Nip98Request {
  /** The Authorization header as received. */
  authorization: string | undefined;
  method: string;
  /** The request target as received: path + query (Express `req.originalUrl`). */
  target: string;
  /** The Host header as received. An absolute `u` tag must name this host. */
  host?: string;
  /** The exact body bytes (see keepRawBody). Absent or empty = no body. */
  rawBody?: Uint8Array;
}

export interface Nip98Options {
  nowSec?: number;
  /** Returns false when this id was already spent. Defaults to the module store. */
  consume?: (id: string, expiresAt: number, nowSec: number) => boolean;
}

/** Spent token ids → when they stop mattering. In memory: a token lives two minutes at most. */
const spent = new Map<string, number>();

export function consumeOnce(id: string, expiresAt: number, nowSec: number): boolean {
  for (const [k, exp] of spent) if (exp < nowSec) spent.delete(k);
  if (spent.has(id)) return false;
  spent.set(id, expiresAt);
  return true;
}

/** Test seam only. */
export function forgetSpentTokens(): void {
  spent.clear();
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Path + query, normalised the same way for what was signed and what arrived. */
function normalizeTarget(target: string): string | null {
  try {
    const u = new URL(target, 'http://placeholder.invalid');
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

function tagValue(tags: string[][], name: string): string | undefined {
  const t = tags.find((x) => x[0] === name);
  return t ? t[1] : undefined;
}

/**
 * Does this request carry a valid, fresh, unspent NIP-98 token for exactly this
 * method, target, host and body? Returns the signer's hex. Pure apart from the
 * single-use store, which runs LAST so a bad token never spends a good id.
 */
export function verifyNip98(r: Nip98Request, opts: Nip98Options = {}): Nip98Result {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const consume = opts.consume ?? consumeOnce;
  const fail = (reason: Nip98Reason): Nip98Result => ({ ok: false, reason });

  if (!r.authorization) return fail('MISSING');
  const m = /^Nostr\s+([A-Za-z0-9+/=_-]+)\s*$/.exec(String(r.authorization).trim());
  if (!m) return fail('MALFORMED');

  let ev: any;
  try {
    ev = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return fail('BAD_BASE64');
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return fail('BAD_EVENT');

  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  if (kind !== AUTH_KIND) return fail('BAD_KIND');
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return fail('BAD_PUBKEY');
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) return fail('BAD_SIG');
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return fail('BAD_ID');
  if (typeof created_at !== 'number' || !Number.isInteger(created_at)) return fail('BAD_TIME');
  if (Math.abs(nowSec - created_at) > MAX_SKEW_SEC) return fail('STALE');
  if (typeof content !== 'string') return fail('BAD_EVENT');
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) {
    return fail('BAD_TAGS');
  }

  // Bound to this verb: a captured GET is not a licence to POST.
  if (String(tagValue(tags, 'method') || '').toUpperCase() !== String(r.method).toUpperCase()) {
    return fail('METHOD_MISMATCH');
  }

  // Bound to this path and query: one transaction's cancel is not another's.
  const u = tagValue(tags, 'u') || '';
  let signedTarget: string | null = null;
  if (u.startsWith('/') && !u.startsWith('//')) {
    signedTarget = normalizeTarget(u);
  } else {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return fail('PATH_MISMATCH');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('PATH_MISMATCH');
    // Bound to this server: a token signed for one Lana service is not good at another.
    if (r.host && url.host.toLowerCase() !== String(r.host).toLowerCase()) return fail('HOST_MISMATCH');
    signedTarget = url.pathname + url.search;
  }
  if (!signedTarget || signedTarget !== normalizeTarget(r.target)) return fail('PATH_MISMATCH');

  // Bound to this body: the same reallocate URL with a different investor is a
  // different request.
  const payload = tagValue(tags, 'payload');
  const body = r.rawBody && r.rawBody.length > 0 ? r.rawBody : null;
  if (body) {
    if (!payload) return fail('PAYLOAD_MISSING');
    if (payload.toLowerCase() !== sha256Hex(body)) return fail('PAYLOAD_MISMATCH');
  } else if (payload && payload.toLowerCase() !== EMPTY_SHA256) {
    return fail('PAYLOAD_MISMATCH');
  }

  // Recompute the id from the fields themselves, then check the signature over
  // it. Never trust ev.id, and never hand the object to a library verifier that
  // may cache a "verified" mark on it.
  const expectedId = sha256Hex(JSON.stringify([0, pubkey, created_at, kind, tags, content]));
  if (expectedId !== id) return fail('BAD_ID');
  try {
    if (!schnorr.verify(Buffer.from(sig, 'hex'), Buffer.from(id, 'hex'), Buffer.from(pubkey, 'hex'))) {
      return fail('BAD_SIG');
    }
  } catch {
    return fail('BAD_SIG');
  }

  if (!consume(id, created_at + 2 * MAX_SKEW_SEC, nowSec)) return fail('REPLAYED');
  return { ok: true, hex: pubkey, id };
}

/**
 * express.json({ verify: keepRawBody }) — keeps the exact bytes the client sent,
 * so the `payload` tag is checked against what arrived, not a re-serialisation.
 */
export function keepRawBody(req: any, _res: unknown, buf: Buffer): void {
  req.rawBody = buf;
}

/** The fields of an Express request this module reads. */
export interface Nip98HttpRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
}

export function verifyRequestNip98(req: Nip98HttpRequest, opts: Nip98Options = {}): Nip98Result {
  const auth = req.headers['authorization'];
  const host = req.headers['host'];
  return verifyNip98(
    {
      authorization: Array.isArray(auth) ? auth[0] : auth,
      method: req.method,
      target: String(req.originalUrl || req.url || ''),
      host: Array.isArray(host) ? host[0] : host,
      rawBody: (req as any).rawBody,
    },
    opts,
  );
}

/** What the browser is told when the signature is missing or wrong. 403, like any refusal. */
export function nip98Refusal(reason: string) {
  return {
    error: 'This request must be signed with your Nostr key. Sign out, sign in again, and retry.',
    code: 'SIGNATURE_REQUIRED',
    reason,
  };
}
