/**
 * /api/session — what a signed-in key is HERE (owner, 9 Oct 2026: lana.discount
 * is now only for the companies that finance purchases and for the
 * administrators; nobody else signs in).
 *
 *   GET /role → { role: 'admin' | 'financer' | 'none' }
 *        admin:    this site's own administrators (admin_users, the roster
 *                  requireAdmin reads). Asked first and asked here only, so an
 *                  administrator signs in while Direct.Fund is away.
 *        financer: Direct.Fund says isInvestor && financer, read fresh
 *                  (lib/financer/dfClient.ts DfFinancer.isFinancer).
 *        none:     neither. The page signs the key out and says why
 *                  (src/contexts/AuthContext.tsx).
 *        Direct.Fund not answering about a key that is no administrator is
 *        502 DF_UNAVAILABLE — never 'none' and never 'financer': the page says
 *        it could not check, and keeps no new session.
 *
 * Signed (NIP-98, lib/nip98Auth.ts): the key that signed is the only one asked
 * about, so nobody learns another key's role by naming it. The page signs it
 * with the key being signed in, before it keeps a session.
 *
 * This is what the page decides on. It is not what protects anything: the
 * admin routes check requireAdmin and the financer routes Direct.Fund, each
 * on every call (routes/financer.ts requireFinancer).
 */
import { Router, type Request, type Response } from 'express';
import { isAdminUser } from '../db/index.js';
import { verifyRequestNip98, nip98Refusal } from '../lib/nip98Auth.js';
import { fetchFinancer, type DfClientOptions } from '../lib/financer/dfClient.js';

export type SessionRole = 'admin' | 'financer' | 'none';

export interface SessionRouterDeps {
  /** Direct.Fund peer calls; defaults to DIRECT_FUND_URL with FUND_PEER_KEY. */
  df?: DfClientOptions;
  /** This site's administrators; defaults to admin_users (db/index.ts isAdminUser). */
  isAdmin?: (hex: string) => boolean;
}

export function createSessionRouter(deps: SessionRouterDeps = {}): Router {
  const router = Router();
  const df = deps.df ?? {};
  const isAdmin = deps.isAdmin ?? isAdminUser;

  router.get('/role', async (req: Request, res: Response) => {
    const r = verifyRequestNip98(req);
    if (r.ok === false) {
      console.warn(`[session-auth] REJECT ${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]} reason=${r.reason}`);
      return res.status(403).json(nip98Refusal(r.reason));
    }
    // The verified pubkey, lower-case hex: the identity requireAdmin checks, as it checks it.
    const hex = r.hex;
    const answer = (role: SessionRole) => res.json({ role });
    if (isAdmin(hex)) return answer('admin');
    try {
      const f = await fetchFinancer(hex, df);
      return answer(f.isFinancer ? 'financer' : 'none');
    } catch (err) {
      console.warn(`[session] role of ${hex.slice(0, 12)}… not read from Direct.Fund: ${(err as any)?.message || err}`);
      return res.status(502).json({
        error: 'Direct.Fund could not be asked right now whether this key may sign in. Nothing was changed; try again shortly.',
        code: 'DF_UNAVAILABLE',
      });
    }
  });

  return router;
}
