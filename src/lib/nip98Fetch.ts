/**
 * Proving, per request, that this browser holds the key it claims.
 *
 * The server no longer believes a header that merely NAMES a Nostr public key
 * (x-admin-hex-id / x-admin-hex / x-merchant-hex) — a public key is public, so
 * naming one proves nothing. Every privileged call now carries a NIP-98 token
 * instead (server/lib/nip98Auth.ts): a kind-27235 event signed with the session
 * key, bound to this method, this exact URL (path + query) and this exact body,
 * good for about a minute, and spendable once.
 *
 * ⚠ THE NONCE IS NOT DECORATION. Two identical GETs in the same second would
 * otherwise be the same event id, and the server, which spends each id once,
 * would refuse the second as a replay — two components mounting together, a
 * double click or React StrictMode all do exactly that.
 *
 * The key is read from the stored session rather than passed in, so a small
 * component deep in a page can sign without having the session drilled into it.
 *
 * Vendored into lana-brain, lana-direct-fund and lana-coin-discount; the only
 * difference between the copies is SESSION_KEY.
 */
import { finalizeEvent } from 'nostr-tools/pure';

const SESSION_KEY = 'lana_discount_session';

function storedPrivateKey(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { nostrPrivateKey?: string; expiresAt?: number };
    if (typeof s?.expiresAt === 'number' && s.expiresAt <= Date.now()) return null;
    const sk = String(s?.nostrPrivateKey || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(sk) ? sk : null;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The URL the token names. On a real host the absolute URL, so the token is good
 * only at this host. On localhost (dev) a Vite proxy may rewrite Host, so the
 * bare path + query is signed instead (the server accepts either form).
 */
function signedUrl(url: string): string {
  const abs = new URL(url, window.location.href);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  return local ? abs.pathname + abs.search : abs.href;
}

/** Can this session sign at all? A session without its key will only ever be refused. */
export function canSignRequests(): boolean {
  return storedPrivateKey() !== null;
}

/**
 * The Authorization header proving this session signed this method + URL + body.
 * Returns {} when there is no key, so the request goes out unsigned and the
 * server refuses it with a reason, rather than this throwing inside a click handler.
 */
export async function nip98Headers(method: string, url: string, body?: string): Promise<Record<string, string>> {
  const sk = storedPrivateKey();
  if (!sk) return {};
  const tags: string[][] = [
    ['u', signedUrl(url)],
    ['method', method.toUpperCase()],
    ['nonce', randomNonce()],
  ];
  if (body) tags.push(['payload', await sha256Hex(body)]);
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    hexToBytes(sk),
  );
  return { Authorization: 'Nostr ' + toBase64(JSON.stringify(ev)) };
}

/**
 * fetch() with the signature attached. Same arguments, same return. The body,
 * if any, must be the string that is sent (JSON.stringify once, pass it here):
 * the signature covers those exact bytes.
 */
export async function signedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  if (init.body != null && typeof init.body !== 'string') {
    throw new Error('signedFetch: body must be a string (JSON.stringify it first)');
  }
  const auth = await nip98Headers(method, url, (init.body as string | undefined) ?? undefined);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(auth)) headers.set(k, v);
  return fetch(url, { ...init, method, headers });
}

/** What to tell a person whose request came back refused by the signature gate. */
export function explainSignatureFailure(reason?: string): string {
  switch (reason) {
    case 'MISSING':
    case 'MALFORMED':
    case 'BAD_BASE64':
    case 'BAD_EVENT':
      return 'Your session is missing its signing key. Sign out and sign in again with your private key — refreshing will not help.';
    case 'STALE':
    case 'BAD_TIME':
      return 'Your device clock is more than a minute off, so the signature was rejected. Fix the date and time on this device, then try again.';
    case 'REPLAYED':
      return 'That request was already used. Try it once more.';
    default:
      return 'Could not verify your signature. Sign out and sign in again, then try once more.';
  }
}
