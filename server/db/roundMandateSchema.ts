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
