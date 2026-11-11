/**
 * /api/peer/fund — WHAT DIRECT.FUND MAY READ HERE, AS A MACHINE (11 Nov 2026).
 *
 *   POST /purchase-sends   { tx_refs: string[1..500] }   (the brain's transaction ids)
 *     200 { checked_at,
 *           purchases: { [tx_ref]: { settlement: { settled_by, owner_hex, batch_ref, created_at } | null,
 *                                    legs: [{ id, order_type, to_hex, to_wallet, lana_amount, fiat_value, currency,
 *                                             exchange_rate, status, tx_hash, send_txid, completed_at }] } },
 *           sends: { [txid]: { sender, owner_hex, wallet_id, key_wallets, paying_lanoshis, fee_lanoshis, state,
 *                              block_height, confirmed_at, created_at, chain_txid } } }
 *       The LANA side of the purchases Direct.Fund's accounting lists: who settles each, every leg the brain posted
 *       and what became of it, and the sends that carried them. What each field means, and how a mined copy of a send
 *       reads, is in lib/financer/purchaseSends.ts. Every purchase asked about is answered. A customer_cashback leg's
 *       to_hex and to_wallet are null: the customer's key and wallet are not given out. key_wallets: wallet_id and the
 *       same key's other address (compressed/uncompressed) — whose wallet a treasury send paid from is asked of the
 *       registrar for each.
 *     400 BAD_TX_REFS: the body is not { tx_refs: [...] } of 1 to 500 purchase ids. Nothing is read.
 *     A POST although it only reads: 500 ids are ~20 kb, more than a request line carries through a proxy.
 *
 * Authorization: Bearer <FUND_READ_KEY> — Direct.Fund's key for these reads and nothing else (lib/fundPeer.ts); it
 * holds the same value as LANA_DISCOUNT_READ_KEY. Never FUND_PEER_KEY: brain and the auditor hold that value too.
 * Compared timing-safe. 503 READ_KEY_UNSET while FUND_READ_KEY is not configured here, 503 READ_KEY_SHARED while it is
 * FUND_PEER_KEY's value (nobody is let in either way), 401 READ_KEY_REFUSED for no key or another one.
 *
 * A machine's read, not a person's: no signed admin (requireAdmin), no NIP-98. Read-only: nothing on this router
 * writes. The /api rate limiter lets the right key past on these paths only (lib/apiRateLimit.ts). Mounted before the
 * SPA catch-all in server/index.ts — after it, express would answer index.html with 200.
 */
import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getDbHandle } from '../db/index.js';
import { fundReadAuth } from '../lib/fundPeer.js';
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
    const auth = fundReadAuth(req.headers['authorization']);
    if (auth !== 'ok') {
      console.warn(`[fund-peer] REJECT ${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]} reason=${auth}`);
      if (auth === 'unset') {
        return res.status(503).json({ error: 'FUND_READ_KEY is not configured on lana.discount; nothing can be read with a read key.', code: 'READ_KEY_UNSET' });
      }
      if (auth === 'shared') {
        return res.status(503).json({ error: 'FUND_READ_KEY on lana.discount is set to the shared peer key; it must be a key of its own. Nothing can be read until it is.', code: 'READ_KEY_SHARED' });
      }
      return res.status(401).json({ error: 'Missing or wrong read key. Use: Authorization: Bearer <FUND_READ_KEY>', code: 'READ_KEY_REFUSED' });
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
