/**
 * The tables behind acquisition by financing round (BEF-P08 §2 mandate,
 * FIFO by round — owner's policy of 4 Sep 2026).
 *
 * Kept in its own file, and exported as plain SQL, for one reason: the tests
 * that prove the cap cannot be double-consumed run against an in-memory
 * SQLite, and they must run against THIS DDL — not a hand-copied twin that
 * drifts the first time a column is added. db/index.ts executes the same
 * strings on the real database.
 *
 * Everything here is additive. Nothing in buyback_transactions, its statuses,
 * or the public /api/brain and /api/external shapes is touched.
 */

import type Database from 'better-sqlite3';

export const ROUND_MANDATE_SCHEMA_SQL = `
  -- One date and one discount per (split, round). lana.discount is the
  -- AUTHORITY for both (plan: "Datumi fail-closed"): a missing row, or a row
  -- with no date, means the round is closed. The event's own opens_at tag is
  -- an echo of this table, never the other way round.
  CREATE TABLE IF NOT EXISTS acquisition_rounds (
    split INTEGER NOT NULL,
    round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),
    opens_at TEXT,
    discount_percent REAL,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (split, round)
  );

  -- Mirror of the signed KIND 30960 events (one live row per d tag). Rows get
  -- here ONLY through ingestMandateEvent — author pinned, id recomputed,
  -- signature verified — so a row's existence is itself the evidence that
  -- LanaPays.us announced this mandate. Newest event_created_at per d wins;
  -- a 'closed' tombstone overwrites and empties the wallets.
  CREATE TABLE IF NOT EXISTS acquisition_mandates (
    d_tag TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    event_created_at INTEGER NOT NULL,
    split INTEGER NOT NULL,
    round INTEGER NOT NULL,
    financer_hex TEXT NOT NULL,
    wallets_json TEXT NOT NULL DEFAULT '[]',
    lana_received_lanoshis INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('announced', 'closed')),
    raw_event TEXT NOT NULL,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_acq_mandates_hex_split ON acquisition_mandates(financer_hex, split);

  -- An admin opening one mandate before its round date. The reason is
  -- mandatory because this is a discretionary treasury decision (P08 §4) and
  -- must be readable later as one.
  CREATE TABLE IF NOT EXISTS acquisition_mandate_releases (
    d_tag TEXT PRIMARY KEY,
    released_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    released_at TEXT DEFAULT (datetime('now'))
  );

  -- A counterparty whose proposals the treasury will not answer by machine.
  -- Restriction takes no rights away and grants none: it only withholds the
  -- automatic YES, so every proposal that would have been priced and offered
  -- on the spot waits in the review queue for a person instead. The reason is
  -- mandatory, and a lifted restriction is kept (lifted_at set, row not
  -- deleted) so the history reads back.
  CREATE TABLE IF NOT EXISTS acquisition_restrictions (
    hex_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    restricted_by TEXT NOT NULL,
    restricted_at TEXT NOT NULL DEFAULT (datetime('now')),
    lifted_at TEXT,
    lifted_by TEXT
  );
`;

/**
 * Columns added to acquisition_offers. Nullable on purpose: every offer made
 * before rounds existed has none of them and must keep working.
 *
 *   mandate_ref            the d tag of the KIND 30960 this offer drew on
 *                          (P08 §12: "Treasury Mandate or reason for purchase")
 *   round                  the financing round, for the payout screens
 *   proposed_lana_lanoshis what the seller ASKED for when we countered with
 *                          the remaining mandate; null when we accepted as is
 *   reference_basis        'current_split' on every binding offer; recorded so
 *                          an audit can see no offer was ever priced off a
 *                          projected reference
 */
export const ROUND_MANDATE_OFFER_COLUMNS = [
  'ALTER TABLE acquisition_offers ADD COLUMN mandate_ref TEXT',
  'ALTER TABLE acquisition_offers ADD COLUMN round INTEGER',
  'ALTER TABLE acquisition_offers ADD COLUMN proposed_lana_lanoshis INTEGER',
  'ALTER TABLE acquisition_offers ADD COLUMN reference_basis TEXT',
];

/**
 * WHICH STATUS `decision_reason` WAS WRITTEN TO DESCRIBE.
 *
 * `decision_reason` is written at some transitions and not at others, and the
 * ones that do not write it leave whatever the last writer left. That is how a
 * proposal withdrawn by its own seller kept saying "This proposal is under
 * treasury review." under a badge reading "Closed": the sentence was true when
 * it was written, at submission, and nothing rewrote it on the way out.
 *
 * Status alone cannot tell the two apart — a `withdrawn` row may carry an
 * admin's real void reason or a stale submission verdict, and both are TEXT in
 * the same column. So the writers say what they wrote it about, and the seller
 * is shown the sentence only while that answer still matches the row's status.
 *
 * Nullable, and null on every row written before this existed: the projection
 * treats an unmarked row as unproven and falls back to the statuses where
 * every writer has always written at the transition.
 */
export const OFFER_DECISION_REASON_STATUS_COLUMN =
  'ALTER TABLE acquisition_offers ADD COLUMN decision_reason_status TEXT';

/** kind_38888 v3 carries the Split's end; we keep it beside split_started_at. */
export const KIND_38888_SPLIT_ENDS_AT_COLUMN = 'ALTER TABLE kind_38888 ADD COLUMN split_ends_at INTEGER';

/**
 * Run one `ALTER TABLE … ADD COLUMN` so that a column already present is not
 * an error — and NOTHING else is swallowed. A locked, read-only or half-built
 * database must stop the boot here, not produce a server whose offers
 * endpoint fails on every insert because a column silently never arrived.
 * Returns true when the column was added, false when it was already there.
 */
export function addColumnIfMissing(db: Database.Database, alterSql: string): boolean {
  try {
    db.exec(alterSql);
    return true;
  } catch (err: any) {
    if (/duplicate column/i.test(String(err?.message || ''))) return false;
    throw err;
  }
}

/**
 * The gate: '' (or missing) = rounds are off and every LanaPays.Us proposal
 * takes the path it takes today; a split number = from that split on, a
 * LanaPays.Us proposal is judged against the round mandates.
 */
/** ISO timestamp of the last relay sync that returned at least one verified mandate. */
export const LAST_SYNC_SETTING_KEY = 'acq_mandates_last_sync_at';

// ─── one-off data repairs, run at boot ────────────────────────────────────

/**
 * THE SENTENCE THAT LIVED IN THE DATABASE.
 *
 * `decision_reason` is a STORED column, so renaming the review state in the
 * code on 10 Sept 2026 left every row written before it still handing the old
 * words to the person who wrote the proposal — "This proposal is under
 * treasury review." under a badge saying financial review, which is the exact
 * wording the owner asked to be gone (we are not a ministry and not a treasury
 * department to the counterparty). The rename was pinned by copy.test.ts for
 * the code and nothing at all did the rows.
 *
 * It belongs here rather than in a command somebody runs on a server once: a
 * repair that only exists in a shell history has not happened to staging, has
 * not happened to a restored backup, and cannot be checked.
 *
 * EXACTLY IDEMPOTENT. The second condition is what makes it so — SQLite's LIKE
 * is case-insensitive while REPLACE is not, so matching on LIKE alone would
 * "update" a differently-cased row to itself on every single boot and report
 * the same count for ever. Rows in another casing are deliberately left alone:
 * no such row is known, and a blind lower-casing would rewrite sentences a
 * person typed.
 */
export const REVIEW_PHRASE_WAS = 'under treasury review';
export const REVIEW_PHRASE_IS = 'under financial review';

export function rewriteStoredReviewPhrase(db: Database.Database): number {
  return db.prepare(`
    UPDATE acquisition_offers
       SET decision_reason = REPLACE(decision_reason, ?, ?)
     WHERE decision_reason LIKE ?
       AND decision_reason <> REPLACE(decision_reason, ?, ?)
  `).run(
    REVIEW_PHRASE_WAS, REVIEW_PHRASE_IS,
    `%${REVIEW_PHRASE_WAS}%`,
    REVIEW_PHRASE_WAS, REVIEW_PHRASE_IS,
  ).changes;
}

/**
 * WHO IS BEING REFUSED, AS OPPOSED TO WHO HAS NOT GOT ROUND TO IT.
 *
 * An accepted offer with failed transfer rows against it looks, on every
 * screen we have, exactly like an accepted offer nobody has opened yet. That
 * is how OFF-2026-056 sat for a day while the treasury's own code refused it
 * on every press. One line at boot, printed only when there is something to
 * print, is the cheapest place to say it out loud.
 */
export function stuckTransfers(db: Database.Database): Array<{ offerRef: string; attempts: number; lastError: string | null }> {
  try {
    return db.prepare(`
      SELECT o.offer_ref AS offerRef, COUNT(b.id) AS attempts,
             (SELECT error_message FROM buyback_transactions x
               WHERE x.offer_ref = o.offer_ref AND x.status = 'failed'
               ORDER BY x.id DESC LIMIT 1) AS lastError
        FROM acquisition_offers o
        JOIN buyback_transactions b
          ON b.offer_ref = o.offer_ref AND b.status = 'failed'
       WHERE o.status = 'accepted' AND o.transaction_id IS NULL
       GROUP BY o.offer_ref
       ORDER BY attempts DESC
    `).all() as any;
  } catch {
    // A column this query names may not exist on an older database. A boot
    // must not fail over a diagnostic.
    return [];
  }
}
