/**
 * Which pending LANA orders the manual "Send LANA" button may broadcast.
 *
 * Until 2 Oct 2026 POST /api/admin/send-batch-lana sent EVERY pending order of
 * the transaction refs it was handed — no check that the money behind them
 * had arrived. The auto-sender has always required it (server/index.ts): an
 * order goes out only when the brain authorised it, or when its batch is at
 * 'lana_bought' (the operator confirmed the FIAT). Two senders spending the
 * same wallet under two different rules is one rule too many, so the button
 * now asks the same question with the same SQL.
 *
 * All or nothing: if ANY requested pending order is not authorised the caller
 * sends none of them, so a purchase is never broadcast in part (its legs share
 * one hash at the brain — see autoSendSelection.ts).
 *
 * And, from 8 Oct 2026, only the TREASURY's own purchases (TREASURY_LEG_JOIN):
 * a purchase its financer confirmed is theirs to pay from their own wallet, and
 * one nobody confirmed is nobody's yet. Such legs are counted in `notTreasury`
 * and, like an unauthorised one, stop the whole request.
 */
import type Database from 'better-sqlite3';
import { TREASURY_AUTHORISED } from './autoSendSelection.js';

export interface ManualSendSelection<T = any> {
  /** Every pending order of the requested refs, oldest first. */
  pending: T[];
  /** How many of `pending` the auto-sender would NOT send yet. Send only when 0. */
  unauthorised: number;
  /** How many of `pending` belong to a purchase the treasury does not settle. Send only when 0. */
  notTreasury: number;
}

export function selectManualSendOrders(db: Database.Database, transactionRefs: readonly unknown[]): ManualSendSelection {
  if (transactionRefs.length === 0) return { pending: [], unauthorised: 0, notTreasury: 0 };
  const placeholders = transactionRefs.map(() => '?').join(',');
  // Same rule as the auto-sender: brain_authorized = 1 OR the batch is 'lana_bought',
  // and the purchase is the treasury's. Both joins are on UNIQUE keys
  // (incoming_batches.batch_ref, purchase_settlement.transaction_ref), so
  // neither ever doubles a row. LEFT JOIN on purchase_settlement so a leg that
  // is not the treasury's is SEEN and refused, not silently left out of a
  // request that would then go out in part.
  const rows = db.prepare(`
    SELECT blo.*,
      CASE WHEN ${TREASURY_AUTHORISED} THEN 1 ELSE 0 END AS send_authorised,
      CASE WHEN ps.transaction_ref IS NULL THEN 1 ELSE 0 END AS not_treasury
    FROM brain_lana_orders blo
    LEFT JOIN incoming_batches ib ON blo.batch_ref = ib.batch_ref
    LEFT JOIN purchase_settlement ps ON ps.transaction_ref = blo.transaction_ref AND ps.settled_by = 'treasury'
    WHERE blo.transaction_ref IN (${placeholders})
      AND blo.status = 'pending'
    ORDER BY blo.created_at
  `).all(...transactionRefs) as any[];

  let unauthorised = 0;
  let notTreasury = 0;
  const pending = rows.map(({ send_authorised, not_treasury, ...order }) => {
    if (send_authorised !== 1) unauthorised++;
    if (not_treasury === 1) notTreasury++;
    return order;
  });
  return { pending, unauthorised, notTreasury };
}
