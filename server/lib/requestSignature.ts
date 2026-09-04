/**
 * REQUEST SIGNATURE — THE CONTRACT FOR THE UI.
 *
 * A proposal under a round mandate consumes a FINANCER's cap — a quota that
 * belongs to one hex, not to whoever knows the hex. Until now `/offers` took
 * `hexId` from the request body and believed it. With per-budget caps that
 * would let a third party spend someone else's mandate, so on the mandate
 * path the request itself must be signed by the hex it claims to be — and
 * so must accepting, withdrawing and reading that hex's mandate.
 *
 * The scheme (v2 — binds the BODY and refuses REPLAYS; the v1 scheme signed
 * only method+path+timestamp, so a captured signature could be re-sent with
 * a different amount or wallet, and re-sent again inside the clock window):
 *
 *   payload        = `${METHOD}:${PATH}:${timestamp}:${sha256hex(canonicalBody)}`
 *   METHOD         = the HTTP method, upper-case                      "POST"
 *   PATH           = the request pathname ONLY — no origin, no query  "/api/acquisitions/mandate"
 *   timestamp      = Unix seconds, exactly the x-auth-timestamp string sent
 *   canonicalBody  = JSON.stringify(body) with every object's keys sorted,
 *                    recursively (arrays keep their order); for a request
 *                    without a body (GET) it is the empty string ''
 *   signature      = Schnorr (BIP-340) over sha256(payload), hex, 128 chars
 *
 *   headers        x-auth-pubkey      the hex, 64 lowercase hex chars; must
 *                                     equal the hexId the request acts for
 *                  x-auth-timestamp   as above; accepted within ±300 s
 *                  x-auth-signature   as above
 *
 *   replay         (pubkey, timestamp, signature) is remembered for 10
 *                  minutes — longer than the ±5-minute window — so a valid
 *                  request can be honoured exactly once. A second copy is
 *                  refused with REPLAYED (route answers 401 SIGNATURE_REPLAYED).
 *
 * Client sketch (nostr-tools / @noble):
 *   const body = { hexId, senderAddress, lanaAmount, currency };
 *   const ts = Math.floor(Date.now() / 1000);
 *   const bodyHash = sha256hex(canonicalBody(body));         // '' → sha256 of ''
 *   const payload = `POST:/api/acquisitions/offers:${ts}:${bodyHash}`;
 *   const sig = schnorr.sign(sha256(payload), privkey);
 *   fetch(url, { headers: { 'x-auth-pubkey': hex, 'x-auth-timestamp': String(ts), 'x-auth-signature': hex(sig) } })
 * The JSON the client SENDS may have keys in any order — only the signed
 * canonical form is sorted, and the server canonicalises the parsed body the
 * same way before hashing.
 *
 * Worked example (reproduced byte-for-byte by requestSignature.test.ts, so a
 * UI author can check their implementation against these four strings):
 *
 *   timestamp      1757000000
 *   body (as sent) { hexId: "aaaa…aa" (64 × 'a'), senderAddress: "LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB",
 *                    lanaAmount: 600, currency: "EUR" }
 *   canonicalBody  {"currency":"EUR","hexId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lanaAmount":600,"senderAddress":"LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB"}
 *   sha256hex(canonicalBody)
 *                  103b4ba1a0425ecf34fcd9528dd551e5b6eaa505392c2b482a08587aff293802
 *   payload        POST:/api/acquisitions/offers:1757000000:103b4ba1a0425ecf34fcd9528dd551e5b6eaa505392c2b482a08587aff293802
 *   sha256hex(payload) — the 32 bytes Schnorr signs
 *                  dec7a821a809846237d083f8375bbb1fe6843cfeb782da49dccbbcad52e5c353
 *   For a GET the canonical body is '' and its sha256hex is
 *                  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 *   (The signature itself is not listed: BIP-340 signing is randomised, so
 *   two correct clients produce different 128-hex signatures for this input;
 *   both verify.)
 *
 * Errors (all JSON: { error, code, detail? }):
 *   401 SIGNATURE_REQUIRED   the signature is absent or does not verify;
 *                            `detail` says why:
 *                              MISSING          one or more x-auth-* headers absent
 *                              PUBKEY_MISMATCH  x-auth-pubkey ≠ the hexId the request acts for
 *                              STALE            |server now − timestamp| > 300 s
 *                              INVALID          malformed header, or the Schnorr
 *                                               signature does not verify over
 *                                               METHOD:PATH:timestamp:sha256hex(canonicalBody)
 *                                               (a changed body lands here)
 *   401 SIGNATURE_REPLAYED   a valid signature that was already honoured
 *                            inside the last 10 minutes; sign a fresh one
 *   403 WALLET_NOT_OWNED     signature fine, but senderAddress is not on the
 *                            signed KIND 30889 wallet list of that hex
 *   503 WALLET_OWNERSHIP_UNVERIFIABLE
 *                            the signed wallet list could not be fetched
 *                            from the relays (or none exists); retry later —
 *                            ownership fails CLOSED, never open
 *
 * Where required (every route that calls the check, and when):
 *   POST /api/acquisitions/offers          on the MANDATE path only — the
 *                                          round gate is active for the
 *                                          current split and the hex has a
 *                                          KIND 30960 mandate for this wallet.
 *                                          Legacy proposals are unsigned as
 *                                          before. Body is signed. Then the
 *                                          403/503 wallet-ownership checks.
 *   POST /api/acquisitions/:ref/accept     when the offer has mandate_ref.
 *                                          Body ({ hexId }) is signed.
 *   POST /api/acquisitions/:ref/withdraw   when the offer has mandate_ref and
 *                                          hexId matches its owner. Body signed.
 *   GET /api/acquisitions/mandate          always. No body: canonical body
 *                                          is '' and PATH carries no query
 *                                          string (hexId/wallet stay in the
 *                                          query, unsigned; the pubkey header
 *                                          must equal hexId).
 *
 * Pure: the clock and the replay cache are parameters, so the tests can stand
 * at any moment and start from an empty memory.
 */
import crypto from 'crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

/** How far the client's clock may drift from ours, in seconds. */
export const SIGNATURE_WINDOW_SECONDS = 300;
/** How long a seen (pubkey, timestamp, signature) is refused, in seconds. Must exceed the window on both sides. */
export const REPLAY_TTL_SECONDS = 600;

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

/** The exact string whose sha256 goes into the payload. GET/no body → ''. */
export function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  return JSON.stringify(canonicalize(body));
}

export function signaturePayload(method: string, path: string, timestamp: number | string, body?: unknown): string {
  const bodyHash = crypto.createHash('sha256').update(canonicalBody(body)).digest('hex');
  return `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`;
}

export function signaturePayloadHash(method: string, path: string, timestamp: number | string, body?: unknown): Buffer {
  return crypto.createHash('sha256').update(signaturePayload(method, path, timestamp, body)).digest();
}

// ─── replay cache ─────────────────────────────────────────────────────────

export interface ReplayCache {
  /** True when this exact signature was already honoured inside the TTL; otherwise records it and returns false. */
  seenBefore(key: string, now: number): boolean;
  size(): number;
}

/**
 * In-memory, per-process. Enough because the window is minutes and a restart
 * cannot bring a signature back inside it once the TTL has passed the
 * window: a replay across a restart would still have to beat ±300 s.
 */
export function createReplayCache(ttlSeconds = REPLAY_TTL_SECONDS): ReplayCache {
  const expiresAt = new Map<string, number>();
  return {
    seenBefore(key, now) {
      // Prune on every call: the map only ever holds the last ten minutes of
      // signed requests, so this stays a handful of entries.
      for (const [k, exp] of expiresAt) if (exp <= now) expiresAt.delete(k);
      const exp = expiresAt.get(key);
      if (exp !== undefined && exp > now) return true;
      expiresAt.set(key, now + ttlSeconds);
      return false;
    },
    size: () => expiresAt.size,
  };
}

/** The process-wide cache the routes use when none is injected. */
export const defaultReplayCache: ReplayCache = createReplayCache();

// ─── verification ─────────────────────────────────────────────────────────

export interface SignatureVerdict {
  ok: boolean;
  code?: 'MISSING' | 'PUBKEY_MISMATCH' | 'STALE' | 'INVALID' | 'REPLAYED';
}

export function verifyRequestSignature(input: {
  /** The hex the request claims to act for (from the body or query). */
  expectedPubkey: string;
  pubkeyHeader: string | undefined;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  /** Pathname only, no query string. */
  path: string;
  /** The parsed JSON body; undefined for GET. Canonicalised here, so key order on the wire does not matter. */
  body?: unknown;
  /** Unix seconds. */
  now: number;
  /** Defaults to the process-wide cache; tests inject a fresh one. */
  replayCache?: ReplayCache;
}): SignatureVerdict {
  const pubkey = String(input.pubkeyHeader || '').trim().toLowerCase();
  const ts = String(input.timestampHeader || '').trim();
  const sig = String(input.signatureHeader || '').trim().toLowerCase();
  if (!pubkey || !ts || !sig) return { ok: false, code: 'MISSING' };
  if (!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) return { ok: false, code: 'INVALID' };
  if (pubkey !== String(input.expectedPubkey || '').trim().toLowerCase()) {
    return { ok: false, code: 'PUBKEY_MISMATCH' };
  }
  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) return { ok: false, code: 'INVALID' };
  if (Math.abs(input.now - tsNum) > SIGNATURE_WINDOW_SECONDS) return { ok: false, code: 'STALE' };

  let valid = false;
  try {
    const digest = signaturePayloadHash(input.method, input.path, ts, input.body);
    valid = schnorr.verify(Buffer.from(sig, 'hex'), digest, Buffer.from(pubkey, 'hex'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'INVALID' };

  // Only a signature that verified is remembered: a failed attempt must not
  // be able to "burn" a signature the real client is about to send.
  const cache = input.replayCache || defaultReplayCache;
  if (cache.seenBefore(`${pubkey}:${ts}:${sig}`, input.now)) return { ok: false, code: 'REPLAYED' };
  return { ok: true };
}
