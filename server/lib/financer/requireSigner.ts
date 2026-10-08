/**
 * WHO IS ASKING, on the financer's own routes: the key that signed the request.
 *
 * Not requireAdmin — a financer is not an administrator, and nothing here may
 * depend on the admin roster. The NIP-98 token (lib/nip98Auth.ts: method, exact
 * path and query, exact body, about a minute, single use) proves the signer's
 * hex, and that hex IS the identity: every route answers only about the
 * signer's own batches, purchases and wallet, as Direct.Fund knows them. No
 * body or query field ever names whose data to act on.
 */
import type { Request, Response } from 'express';
import { verifyRequestNip98, nip98Refusal } from '../nip98Auth.js';

/** The signer's lower-case hex, or null after answering 403 itself. */
export function requireSigner(req: Request, res: Response): string | null {
  const r = verifyRequestNip98(req);
  if (r.ok === false) {
    console.warn(`[financer-auth] REJECT ${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]} reason=${r.reason}`);
    res.status(403).json(nip98Refusal(r.reason));
    return null;
  }
  return r.hex.toLowerCase();
}
