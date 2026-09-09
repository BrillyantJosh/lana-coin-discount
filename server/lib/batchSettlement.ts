import type Database from 'better-sqlite3';

/**
 * A batch that has just been advanced to 'lana_sent', for the log.
 */
export interface SettledBatch {
  batchRef: string;
  /** The status it advanced FROM — 'received' or 'lana_bought'. */
  from: string;
  /** How many LANA orders are linked to it. */
  orders: number;
  /** One of the broadcasts that carried its LANA, kept for the audit trail. */
  txHash: string;
}

interface BatchRow {
  batch_ref: string;
  status: string;
}

interface OrderStats {
  total: number;
  pending: number;
  sent: number;
  first_sent_at: string | null;
  tx_hash: string | null;
}

/**
 * Close every batch whose LANA has demonstrably left the wallet.
 *
 * A batch used to need two more clicks after the operator confirmed the money
 * in the bank: "Mark LANA Bought" and then "Mark LANA Sent". Neither decides
 * anything. The click that releases money is "Confirm Received" — it tells the
 * brain the FIAT landed, the brain authorises the LANA orders, and the
 * auto-sender broadcasts them. The two clicks that follow are bookkeeping
 * catching up with money that has already moved.
 *
 * Between 5 and 9 September 2026 nobody made them, so eight batches carrying
 * EUR 2,225.81 and GBP 126.00 sat in the RECEIVED tab looking like unpaid work
 * while all 216 of their LANA orders had long since been broadcast. The owner
 * read that list as "the system says this is not paid yet". It said no such
 * thing; it only said nobody had ticked it off.
 *
 * So the ticking is done from the evidence instead. A batch advances only when
 * its own LANA orders say so:
 *   - it must HAVE linked orders (no orders is not proof of anything, and this
 *     function never guesses);
 *   - none of them may still be pending;
 *   - at least one must actually have been sent, so a batch whose every leg was
 *     cancelled is never dressed up as settled.
 *
 * 'incoming' is deliberately NOT eligible. Only a human can see the bank
 * statement, so confirming that the FIAT arrived stays the operator's call.
 * This function closes the two steps after it, never the one before.
 */
export function settleBatchesWithSentLana(db: Database.Database): SettledBatch[] {
  const candidates = db.prepare(
    "SELECT batch_ref, status FROM incoming_batches WHERE status IN ('received', 'lana_bought')"
  ).all() as BatchRow[];
  if (candidates.length === 0) return [];

  // One pass over the orders of one batch: how many there are, how many are
  // still owed, how many went out, when the first one went out (that is the
  // latest moment by which we must have held the coins — it backfills a
  // lana_bought_at that was never clicked) and a hash to keep.
  const statsFor = db.prepare(`
    SELECT
      COUNT(*)                                                        AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)             AS pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)                AS sent,
      MIN(CASE WHEN status = 'sent' THEN completed_at END)            AS first_sent_at,
      MAX(CASE WHEN status = 'sent' AND tx_hash IS NOT NULL AND tx_hash != ''
               THEN tx_hash END)                                      AS tx_hash
    FROM brain_lana_orders
    WHERE batch_ref = ?
  `);

  // The status guard in the WHERE clause is what makes this safe to run beside
  // the operator's own buttons: whoever gets there first wins, and the loser
  // changes nothing.
  const close = db.prepare(`
    UPDATE incoming_batches
       SET status = 'lana_sent',
           lana_sent_at = datetime('now'),
           lana_bought_at = COALESCE(lana_bought_at, ?),
           lana_tx_hash = COALESCE(NULLIF(lana_tx_hash, ''), ?),
           updated_at = datetime('now')
     WHERE batch_ref = ? AND status IN ('received', 'lana_bought')
  `);

  const settled: SettledBatch[] = [];
  const run = db.transaction(() => {
    for (const batch of candidates) {
      const s = statsFor.get(batch.batch_ref) as OrderStats;
      if (!s || s.total === 0) continue;      // nothing linked — not evidence
      if (s.pending > 0) continue;            // still owed
      if (s.sent === 0) continue;             // linked, but nothing ever left

      const changed = close.run(
        s.first_sent_at ?? null,
        s.tx_hash ?? '',
        batch.batch_ref,
      ).changes;
      if (changed > 0) {
        settled.push({ batchRef: batch.batch_ref, from: batch.status, orders: s.total, txHash: s.tx_hash ?? '' });
      }
    }
  });
  run();

  return settled;
}
