/**
 * SIGNED REQUESTS — the browser half of server/lib/requestSignature.ts.
 *
 * A proposal under a financing-round mandate spends a FINANCER's cap, so the
 * request must be signed by the hex it acts for. The key is the one the
 * session already holds: AuthContext derives `nostrPrivateKey` (32-byte hex)
 * from the WIF at /login and keeps it in memory and in localStorage for the
 * life of the session. Nothing new is asked of the user, and the key never
 * leaves the browser — only a Schnorr signature over this request does.
 *
 * The scheme, reproduced here byte for byte (the server file is the contract;
 * src/lib/signedRequest.test.ts cross-checks this module against its verifier):
 *
 *   payload   = `${METHOD}:${PATH}:${timestamp}:${sha256hex(canonicalBody)}`
 *   METHOD    upper-case;  PATH pathname only (no origin, no query)
 *   timestamp Unix seconds — exactly the x-auth-timestamp string sent
 *   body      JSON.stringify with every object's keys sorted recursively
 *             (arrays keep order); '' for a request without a body (GET)
 *   signature Schnorr (BIP-340) over sha256(payload), 128 hex chars
 *
 *   headers   x-auth-pubkey, x-auth-timestamp, x-auth-signature
 *
 * A signature is honoured once (10-minute replay memory on the server) and
 * within ±300 s of the server clock, so every request signs afresh.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const AUTH_PUBKEY_HEADER = 'x-auth-pubkey';
export const AUTH_TIMESTAMP_HEADER = 'x-auth-timestamp';
export const AUTH_SIGNATURE_HEADER = 'x-auth-signature';

/** Sort object keys recursively; arrays keep their order; scalars pass through. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** The exact string whose sha256 goes into the payload. No body → ''. */
export function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  return JSON.stringify(canonicalize(body));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export function signaturePayload(method: string, path: string, timestamp: number | string, body?: unknown): string {
  const bodyHash = bytesToHex(sha256(utf8(canonicalBody(body))));
  return `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`;
}

/** The pathname of a URL or path string — what the server signs over. */
export function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  // An absolute URL loses its origin; a relative one is already a pathname.
  return path.replace(/^[a-z]+:\/\/[^/]+/i, '');
}

export interface SigningKey {
  /** 32-byte private key, hex (session.nostrPrivateKey). */
  privateKeyHex: string;
  /** The hex the request acts for (session.nostrHexId). Must match the key. */
  pubkeyHex: string;
}

/**
 * The three headers for one request. Throws when the key does not derive to
 * the pubkey it claims — a signature for the wrong hex would only earn a
 * PUBKEY_MISMATCH from the server, so it is refused here, before the send.
 */
export function signRequestHeaders(
  key: SigningKey,
  method: string,
  path: string,
  body?: unknown,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const priv = hexToBytes(key.privateKeyHex);
  const derived = bytesToHex(schnorr.getPublicKey(priv));
  const claimed = String(key.pubkeyHex || '').trim().toLowerCase();
  if (derived !== claimed) {
    throw new Error('The session key does not belong to this account. Please sign in again.');
  }
  const digest = sha256(utf8(signaturePayload(method, path, timestamp, body)));
  const sig = bytesToHex(schnorr.sign(digest, priv));
  return {
    [AUTH_PUBKEY_HEADER]: claimed,
    [AUTH_TIMESTAMP_HEADER]: String(timestamp),
    [AUTH_SIGNATURE_HEADER]: sig,
  };
}

/**
 * fetch() with the signature headers added. The JSON body sent is the very
 * object that was signed (key order on the wire does not matter — the server
 * canonicalises before hashing). GET sends no body and signs ''.
 */
// async on purpose: signRequestHeaders() throws synchronously when the session's
// key does not derive to its claimed pubkey. Inside an effect that only has a
// .catch on the returned promise, a synchronous throw escapes and takes the page
// down; as an async function every failure becomes a rejection the caller handles.
export async function signedFetch(
  url: string,
  key: SigningKey,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && init.body !== undefined;
  const headers: Record<string, string> = {
    ...(init.headers || {}),
    ...signRequestHeaders(key, method, pathnameOf(url), hasBody ? init.body : undefined),
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return fetch(url, { method, headers, body: hasBody ? JSON.stringify(init.body) : undefined });
}
