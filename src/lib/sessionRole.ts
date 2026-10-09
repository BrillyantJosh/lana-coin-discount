/**
 * WHO A KEY IS HERE — asked of the server before a session is kept (owner,
 * 9 Oct 2026: lana.discount is now only for the companies that finance
 * purchases and for the administrators).
 *
 * GET /api/session/role (server/routes/session.ts), signed with the key itself:
 * at sign-in that key is not stored yet, so it is handed to the signer
 * (nip98Fetch.ts nip98Headers' `key`). The answer decides only what the page
 * keeps and where it goes; every route that reads or moves anything checks the
 * signer again on its own.
 */
import { nip98Headers } from './nip98Fetch';

export type SessionRole = 'admin' | 'financer' | 'none';

/**
 * The server's answer, or why there is none (status 0: no answer at all). `reason` is the signature gate's own
 * (SIGNATURE_REQUIRED: STALE, BAD_TIME, HOST_MISMATCH…): a device clock more than a minute off fails every try the
 * same way, and only the reason can tell the person to fix it.
 */
export type RoleAnswer =
  | { ok: true; role: SessionRole }
  | { ok: false; status: number; code: string | null; reason: string | null };

export const SESSION_ROLE_URL = '/api/session/role';

/** Ask, signed with `key` (32-byte hex). Never throws. */
export async function askSessionRole(key: string): Promise<RoleAnswer> {
  try {
    const res = await fetch(SESSION_ROLE_URL, { method: 'GET', headers: await nip98Headers('GET', SESSION_ROLE_URL, undefined, key) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: no role in it.
    }
    const role = body?.role;
    if (res.ok && (role === 'admin' || role === 'financer' || role === 'none')) return { ok: true, role };
    return {
      ok: false,
      status: res.status,
      code: typeof body?.code === 'string' ? body.code : null,
      reason: typeof body?.reason === 'string' ? body.reason : null,
    };
  } catch {
    return { ok: false, status: 0, code: null, reason: null };
  }
}

/** Pages a sign-in may return to (`/login?next=…`): a financer sent here from Direct.Fund goes back to /financer. */
export const AFTER_SIGN_IN = ['/financer'];

/**
 * Where a signed-in key lands: a financer who is not an administrator on their own page; an administrator (and a
 * session kept from before whose role could not be asked yet) where they always did — `next` when it is a page named
 * in AFTER_SIGN_IN, the dashboard otherwise. Only named pages: an address from the link must never decide where a
 * fresh session is taken (an open redirect).
 */
export function landingFor(session: { role?: SessionRole; isAdmin?: boolean } | null | undefined, next: string | null): string {
  if (session?.role === 'financer' && session.isAdmin !== true) return '/financer';
  return next && AFTER_SIGN_IN.includes(next) ? next : '/dashboard';
}
