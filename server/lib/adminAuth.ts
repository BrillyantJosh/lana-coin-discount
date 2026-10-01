/**
 * One admin gate for every router. It used to be defined twice — once in
 * routes/api.ts and once in routes/acquisitions.ts — with the same body, and
 * the treasury router would have made a third. Three copies of "who is an
 * admin" is three places for them to drift apart.
 *
 * WHO is asking is PROVED, not claimed (2 Oct 2026). Until then this read the
 * hex from a bare `x-admin-hex-id` header, and a hex is a public key — anyone
 * who had seen an admin's could send it and be that admin, including on the
 * route that broadcasts LANA from the treasury wallet. Now the request must
 * carry a NIP-98 token signed by that key (lib/nip98Auth.ts), and the signer's
 * hex is the only identity there is; the old header is never read again.
 *
 * Deliberately NO KIND 87058 exclusion gate here: lana.discount is the one
 * place a person must always be able to sell, so it does not join that gate.
 */
import type { Request, Response } from 'express';
import { isAdminUser } from '../db/index.js';
import { verifyRequestNip98, nip98Refusal } from './nip98Auth.js';

/** Verifies the signature, then the signer against admin_users; answers 403 itself. */
export function requireAdmin(req: Request, res: Response): string | null {
  const r = verifyRequestNip98(req);
  if (r.ok === false) {
    // The path only: a query may carry an id, and the header is never logged.
    console.warn(`[admin-auth] REJECT ${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]} reason=${r.reason}`);
    res.status(403).json(nip98Refusal(r.reason));
    return null;
  }
  if (!isAdminUser(r.hex)) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  (req as any).adminHex = r.hex;
  return r.hex;
}
