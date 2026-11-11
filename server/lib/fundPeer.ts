/**
 * How this server identifies itself to direct.lana.fund.
 *
 * With a key of its own, never a person's Nostr hex. The fund's order ledger
 * answered anyone on the open internet until 10.9.2026, which is why nothing
 * here carried a credential; it is guarded now, and the guard admits a keyed
 * machine as well as a human administrator.
 *
 * Unset means the call goes out bare and is refused — and that is safe here.
 * The only caller is an admin page that already falls back to its cached copy
 * on any failure. NOTHING on the selling path touches Direct.Fund, so a missing
 * key cannot narrow the one door that has to stay open.
 */
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export const fundPeerKey = (): string => String(process.env.FUND_PEER_KEY || '').trim();

export function fundPeerHeaders(): Record<string, string> {
  const key = fundPeerKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * And the other way round, from 11 Nov 2026: how direct.lana.fund identifies
 * itself HERE. The same secret, one secret for both directions — it is
 * FUND_PEER_KEY on this side and PEER_API_KEY on Direct.Fund's
 * (server/lib/peerAuth.ts there). It opens only the routes listed below, all
 * read-only machine reads (routes/fundPeer.ts): nothing that writes, nothing
 * that moves LANA. A leaked key costs visibility, never funds.
 */
export const FUND_PEER_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/peer/fund/purchase-sends' },
];

/** 'unset': FUND_PEER_KEY is not configured here (the route answers 503); 'refused': no key, or not that one (401). */
export type FundPeerAuth = 'ok' | 'unset' | 'refused';

/**
 * Compared as SHA-256 digests: always 32 bytes each, so timingSafeEqual never
 * throws on a length mismatch and the comparison does not even tell the key's
 * length.
 */
function sameSecret(given: string, want: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(want, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Does this Authorization header carry FUND_PEER_KEY? Fails closed: with the key unset, nobody is admitted. */
export function fundPeerAuth(authorization: unknown): FundPeerAuth {
  const want = fundPeerKey();
  if (!want) return 'unset';
  const header = typeof authorization === 'string' ? authorization : '';
  if (!header.startsWith('Bearer ')) return 'refused';
  const given = header.slice(7).trim();
  return given !== '' && sameSecret(given, want) ? 'ok' : 'refused';
}

/**
 * Direct.Fund with the right key, on a route listed above. For the /api rate
 * limiter (lib/apiRateLimit.ts), which lets it past as it lets the brain past:
 * all of Direct.Fund arrives from one container IP, and an accounting export
 * that asks about many purchases, 500 at a time, must not be refused halfway
 * (Direct.Fund lets this server past its own limiter the same way —
 * isPeerRequest there). The exact key AND a listed route, so no wrong key and
 * no other path leaves the limit. Anything that throws answers false: the
 * request keeps the limit.
 */
export function isFundPeerRequest(req: Pick<Request, 'headers' | 'method' | 'url'> & { originalUrl?: string }): boolean {
  try {
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const method = String(req.method || '').toUpperCase();
    if (!FUND_PEER_ROUTES.some(r => r.method === method && r.path === path)) return false;
    return fundPeerAuth(req.headers['authorization']) === 'ok';
  } catch {
    return false;
  }
}
