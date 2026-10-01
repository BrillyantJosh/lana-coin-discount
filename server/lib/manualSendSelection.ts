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
 */
import type Database from 'better-sqlite3';

export interface ManualSendSelection<T = any> {
  /** Every pending order of the requested refs, oldest first. */
  pending: T[];
  /** How many of `pending` the auto-sender would NOT send yet. Send only when 0. */
  unauthorised: number;
}

export function selectManualSendOrders(db: Database.Database, transactionRefs: readonly unknown[]): ManualSendSelection {
  if (transactionRefs.length === 0) return { pending: [], unauthorised: 0 };
  const placeholders = transactionRefs.map(() => '?').join(',');
  // Same rule as the auto-sender: brain_authorized = 1 OR the batch is 'lana_bought'.
  // incoming_batches.batch_ref is UNIQUE, so the join never doubles a row.
  const rows = db.prepare(`
    SELECT blo.*,
      CASE WHEN blo.brain_authorized = 1 OR ib.status = 'lana_bought' THEN 1 ELSE 0 END AS send_authorised
    FROM brain_lana_orders blo
    LEFT JOIN incoming_batches ib ON blo.batch_ref = ib.batch_ref
    WHERE blo.transaction_ref IN (${placeholders})
      AND blo.status = 'pending'
    ORDER BY blo.created_at
  `).all(...transactionRefs) as any[];

  let unauthorised = 0;
  const pending = rows.map(({ send_authorised, ...order }) => {
    if (send_authorised !== 1) unauthorised++;
    return order;
  });
  return { pending, unauthorised };
}
