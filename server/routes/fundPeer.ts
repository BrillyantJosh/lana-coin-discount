/**
 * /api/peer/fund — WHAT DIRECT.FUND MAY READ HERE, AS A MACHINE (11 Nov 2026).
 *
 *   POST /purchase-sends   { tx_refs: string[1..500] }   (the brain's transaction ids)
 *     200 { checked_at,
 *           purchases: { [tx_ref]: { settlement: { settled_by, owner_hex, batch_ref, created_at } | null,
 *                                    legs: [{ id, order_type, to_hex, to_wallet, lana_amount, fiat_value, currency,
 *                                             exchange_rate, status, tx_hash, send_txid, completed_at }] } },
 *           sends: { [txid]: { sender, owner_hex, wallet_id, paying_lanoshis, fee_lanoshis, state, block_height,
 *                              confirmed_at, created_at, chain_txid } } }
 *       The LANA side of the purchases Direct.Fund's accounting lists: who settles each, every leg the brain posted
 *       and what became of it, and the sends that carried them. What each field means, and how a mined copy of a send
 *       reads, is in lib/financer/purchaseSends.ts. Every purchase asked about is answered.
 *     400 BAD_TX_REFS: the body is not { tx_refs: [...] } of 1 to 500 purchase ids. Nothing is read.
 *     A POST although it only reads: 500 ids are ~20 kb, more than a request line carries through a proxy.
 *
 * Authorization: Bearer <FUND_PEER_KEY> — the key this server already presents to Direct.Fund (lib/fundPeer.ts);
 * Direct.Fund holds the same value as PEER_API_KEY. Compared timing-safe. 503 PEER_KEY_UNSET while FUND_PEER_KEY is
 * not configured here (nobody is let in), 401 PEER_KEY_REFUSED for no key or another one.
 *
 * A machine's read, not a person's: no signed admin (requireAdmin), no NIP-98. Read-only: nothing on this router
 * writes. The /api rate limiter lets the right key past on these paths only (lib/apiRateLimit.ts). Mounted before the
 * SPA catch-all in server/index.ts — after it, express would answer index.html with 200.
 */
import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getDbHandle } from '../db/index.js';
import { fundPeerAuth } from '../lib/fundPeer.js';
import { parsePurchaseSendsRequest, readPurchaseSends } from '../lib/financer/purchaseSends.js';

export interface FundPeerRouterDeps {
  db?: () => Database.Database;
  now?: () => number;
}

export function createFundPeerRouter(deps: FundPeerRouterDeps = {}): Router {
  const router = Router();
  const dbOf = deps.db ?? getDbHandle;

  router.post('/purchase-sends', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const auth = fundPeerAuth(req.headers['authorization']);
    if (auth !== 'ok') {
      console.warn(`[fund-peer] REJECT ${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]} reason=${auth}`);
      return auth === 'unset'
        ? res.status(503).json({ error: 'FUND_PEER_KEY is not configured on lana.discount; nothing can be read with a peer key.', code: 'PEER_KEY_UNSET' })
        : res.status(401).json({ error: 'Missing or wrong peer key. Use: Authorization: Bearer <FUND_PEER_KEY>', code: 'PEER_KEY_REFUSED' });
    }
    const asked = parsePurchaseSendsRequest(req.body);
    if (asked.ok === false) return res.status(400).json({ error: asked.error, code: 'BAD_TX_REFS' });
    try {
      return res.json(readPurchaseSends(dbOf(), asked.refs, deps.now ? deps.now() : Date.now()));
    } catch (err: any) {
      console.error(`[fund-peer] purchase-sends failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'The purchases could not be read right now.', code: 'READ_FAILED' });
    }
  });

  return router;
}
