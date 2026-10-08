/**
 * The tables behind a financer settling their own purchases (owner, 8 Oct 2026:
 * "Mi smo zgolj infrastruktura").
 *
 * Until now every LANA leg the brain sent us went out of ONE wallet, the
 * treasury's: a financer wired the "Lana Discount" share of their purchases to
 * our bank account, an operator pressed "Confirm Received", and the auto-sender
 * paid every leg from BUYBACK_WIF. From now on a financer pays those legs from a
 * Lana.Discount wallet of their own, signed in their own browser, and the
 * treasury sends only what really arrived on its own account.
 *
 * Who sends a purchase's legs is decided PER PURCHASE, at confirmation, and
 * written down here — never at leg insert, so POST /api/brain/lana-order keeps
 * answering exactly as before. A leg whose purchase has no row is sent by
 * nobody. Legs that arrive later (a caretaker leg released after the fact, the
 * brain re-POSTing an order) are covered by the existing row through a JOIN on
 * transaction_ref.
 *
 * Kept in its own file, as plain SQL, for the reason roundMandateSchema.ts
 * gives: the tests run against THIS DDL, not a hand-copied twin.
 * Everything is additive and every new column is NULLABLE — a NOT NULL column
 * on brain_lana_orders would make the brain's POST fail, and the brain books a
 * refused POST as a failed leg and closes the purchase (7–8 Oct 2026).
 */
import type Database from 'better-sqlite3';
import { addColumnIfMissing } from './roundMandateSchema.js';

export const FINANCER_SCHEMA_SQL = `
  -- Who settles a purchase. Written once, at confirmation: the financer's own
  -- confirmation on /financer ('financer'), the operator's "money arrived on
  -- the treasury account" ('treasury'), or the one-off migration of purchases
  -- the treasury already owed or sent ('treasury', confirmed_by 'migration'). Never
  -- rewritten — a second confirmation by somebody else is refused (409).
  CREATE TABLE IF NOT EXISTS purchase_settlement (
    transaction_ref TEXT PRIMARY KEY,
    owner_hex TEXT NOT NULL,
    settled_by TEXT NOT NULL CHECK (settled_by IN ('treasury', 'financer')),
    batch_ref TEXT,
    confirmed_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_purchase_settlement_owner ON purchase_settlement(owner_hex, settled_by);
  CREATE INDEX IF NOT EXISTS idx_purchase_settlement_batch ON purchase_settlement(batch_ref);

  -- Every LANA send LD records, the financer's (signed in their browser) and
  -- the treasury's (auto-send, manual send) alike: the exact bytes, so an
  -- unconfirmed send is broadcast again AS IT IS and never rebuilt with other
  -- coins — which is how a timed-out broadcast could pay the same wallets twice.
  CREATE TABLE IF NOT EXISTS lana_sends (
    txid TEXT PRIMARY KEY,
    sender TEXT NOT NULL CHECK (sender IN ('treasury', 'financer')),
    owner_hex TEXT,
    wallet_id TEXT NOT NULL,
    raw_tx TEXT NOT NULL,
    order_ids_json TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    paying_lanoshis INTEGER NOT NULL,
    fee_lanoshis INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('announced', 'mempool', 'confirmed', 'released')),
    broadcasts INTEGER NOT NULL DEFAULT 0,
    next_broadcast_at TEXT,
    last_outcome TEXT,
    release_reason TEXT,
    block_height INTEGER,
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_lana_sends_state ON lana_sends(state);
  CREATE INDEX IF NOT EXISTS idx_lana_sends_wallet ON lana_sends(wallet_id, state);

  -- The two calls we owe the brain, kept until it has them. They used to be
  -- fire-and-forget: one lost fiat-received and the purchase never got its
  -- LANA authorised; see lib/financer/brainOutbox.ts.
  CREATE TABLE IF NOT EXISTS brain_callback_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('fiat-received', 'lana-sent')),
    dedupe_key TEXT NOT NULL UNIQUE,
    body_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_brain_callback_outbox_due ON brain_callback_outbox(done_at, next_at);
`;

/**
 * When the brain last answered a row 2xx. A fiat-received it took is kept
 * alive while its purchases wait for approval, and the 7 days a FAILING row is
 * retried run from here, not from the day it was queued: one brain restart on
 * day 8 must not end a row the brain was taking all along. Nullable; added
 * here as well for a database that created the table before the column.
 */
export const OUTBOX_ACCEPTED_AT_COLUMN = 'ALTER TABLE brain_callback_outbox ADD COLUMN accepted_at TEXT';

/**
 * A leg's signed send: the txid it is in while it is 'sending', and — after a
 * send was released (refused, or its input spent elsewhere) — the outpoints the
 * NEXT send of the same leg must spend at least one of, so two sends of one leg
 * can never both confirm. Both nullable, see the header.
 */
export const LEG_SEND_COLUMNS = [
  'ALTER TABLE brain_lana_orders ADD COLUMN send_txid TEXT',
  'ALTER TABLE brain_lana_orders ADD COLUMN must_spend_json TEXT',
];

/** Every treasury query now joins legs to purchase_settlement on this column. */
export const LEG_TRANSACTION_REF_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_brain_lana_orders_transaction_ref ON brain_lana_orders(transaction_ref)';

/** 'treasury' | 'financer' on the batch as well, for the admin page; NULL on every batch before this. */
export const BATCH_SETTLED_BY_COLUMN = 'ALTER TABLE incoming_batches ADD COLUMN settled_by TEXT';

/**
 * The migration of legs the treasury already owed runs ONCE, and this records
 * that it did (app_settings, value = when and how many). Re-running it on every
 * boot would be wrong, not just wasteful: a leg the brain authorised after the
 * deploy, for a purchase nobody has confirmed, would be handed to the treasury
 * by whichever restart happened to come next.
 */
export const TREASURY_MIGRATION_SETTING_KEY = 'financer_treasury_migration';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

export interface TreasuryBackfill {
  /** Purchases given a 'treasury' row that still have pending legs. */
  purchases: number;
  /** Their pending legs, all of them (a purchase is sent whole). */
  legs: number;
  /** Those purchases — only these: the ones below run to thousands. */
  refs: string[];
  /**
   * Purchases given a 'treasury' row with nothing pending: the treasury sent
   * their LANA before this shipped. Owned now so that a leg of one arriving
   * late (a caretaker leg the brain releases, a re-POST) is still the
   * treasury's to send — brain README 8(c), "the same owner must still pay it".
   */
  settled: number;
}

/** Most purchase refs the boot log names; the rest are counted. */
const LOGGED_REFS = 100;

/**
 * Every purchase the treasury already owned on the day this shipped gets a
 * 'treasury' owner, so the auto-sender keeps sending it exactly as it would
 * have. A purchase is the treasury's when
 *   - a PENDING leg of it is authorised by the brain, or sits in a batch the
 *     operator already marked received / LANA bought (money arrived); or
 *   - any leg of it already left (sending / sent / confirmed): the treasury
 *     paid it, and a late leg must go the same way — before this, such a leg
 *     had no owner and nothing could ever send it (review C5/C10); or
 *   - a leg of it is linked to an old-flow batch (no settled_by yet) the
 *     operator marked received, LANA bought or LANA sent.
 * The owner is the financer of its batch, else the investor_lana leg's
 * recipient, else ''. Everything else waits for a confirmation.
 *
 * One set-based read (production holds ~12,500 sent legs) and one insert per
 * purchase found, inside the caller's transaction. NOT EXISTS / INSERT OR
 * IGNORE: an existing row is never rewritten.
 */
export function backfillTreasurySettlements(db: Database.Database): TreasuryBackfill {
  const rows = db.prepare(`
    SELECT r.ref, r.pending,
           COALESCE(
             (SELECT ib.investor_hex FROM brain_lana_orders b JOIN incoming_batches ib ON ib.batch_ref = b.batch_ref
               WHERE b.transaction_ref = r.ref AND ib.investor_hex != '' ORDER BY b.created_at, b.id LIMIT 1),
             (SELECT b.to_hex FROM brain_lana_orders b
               WHERE b.transaction_ref = r.ref AND b.order_type = 'investor_lana' AND b.to_hex != '' ORDER BY b.created_at, b.id LIMIT 1),
             '') AS owner,
           (SELECT b.batch_ref FROM brain_lana_orders b
             WHERE b.transaction_ref = r.ref AND b.batch_ref IS NOT NULL AND b.batch_ref != '' ORDER BY b.created_at, b.id LIMIT 1) AS batch_ref
    FROM (
      SELECT blo.transaction_ref AS ref,
             SUM(CASE WHEN blo.status = 'pending' THEN 1 ELSE 0 END) AS pending,
             MIN(blo.created_at) AS first_at
      FROM brain_lana_orders blo
      LEFT JOIN incoming_batches ib ON ib.batch_ref = blo.batch_ref
      WHERE blo.transaction_ref IS NOT NULL AND blo.transaction_ref != ''
      GROUP BY blo.transaction_ref
      HAVING SUM(CASE WHEN blo.status = 'pending' AND (blo.brain_authorized = 1 OR ib.status IN ('received', 'lana_bought')) THEN 1 ELSE 0 END) > 0
          OR SUM(CASE WHEN blo.status IN ('sending', 'sent', 'confirmed') THEN 1 ELSE 0 END) > 0
          OR SUM(CASE WHEN ib.id IS NOT NULL AND ib.settled_by IS NULL AND ib.status IN ('received', 'lana_bought', 'lana_sent') THEN 1 ELSE 0 END) > 0
    ) r
    WHERE NOT EXISTS (SELECT 1 FROM purchase_settlement ps WHERE ps.transaction_ref = r.ref)
    ORDER BY r.first_at, r.ref
  `).all() as Array<{ ref: string; pending: number; owner: string; batch_ref: string | null }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by)
    VALUES (?, ?, 'treasury', ?, 'migration')
  `);
  const out: TreasuryBackfill = { purchases: 0, legs: 0, refs: [], settled: 0 };
  for (const r of rows) {
    if (insert.run(r.ref, r.owner, r.batch_ref).changes !== 1) continue;
    if (r.pending > 0) {
      out.purchases++;
      out.legs += r.pending;
      out.refs.push(r.ref);
    } else {
      out.settled++;
    }
  }
  return out;
}

export interface FinancerMigration {
  /** Set only on the one boot that ran the treasury backfill. */
  treasuryBackfill: TreasuryBackfill | null;
}

/**
 * Idempotent. Called from db/index.ts (where brain_lana_orders may not exist
 * yet on a fresh database — routes/api.ts creates it) AND from routes/api.ts
 * right after it creates that table, so whichever runs with both tables present
 * finishes the job. Only "duplicate column" is tolerated (addColumnIfMissing);
 * any other failure stops the boot on purpose.
 */
export function migrateFinancerSchema(db: Database.Database): FinancerMigration {
  db.exec(FINANCER_SCHEMA_SQL);
  addColumnIfMissing(db, OUTBOX_ACCEPTED_AT_COLUMN);
  const hasLegs = tableExists(db, 'brain_lana_orders');
  const hasBatches = tableExists(db, 'incoming_batches');
  if (hasLegs) {
    for (const sql of LEG_SEND_COLUMNS) addColumnIfMissing(db, sql);
    db.exec(LEG_TRANSACTION_REF_INDEX_SQL);
  }
  if (hasBatches) addColumnIfMissing(db, BATCH_SETTLED_BY_COLUMN);

  // The backfill reads columns routes/api.ts adds to brain_lana_orders; on the
  // boot where db/index.ts gets here first they may not be there yet.
  const canBackfill = hasLegs && hasBatches && tableExists(db, 'app_settings')
    && columnExists(db, 'brain_lana_orders', 'brain_authorized') && columnExists(db, 'brain_lana_orders', 'batch_ref');
  let treasuryBackfill: TreasuryBackfill | null = null;
  if (canBackfill) {
    const done = db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(TREASURY_MIGRATION_SETTING_KEY);
    if (!done) {
      db.transaction(() => {
        treasuryBackfill = backfillTreasurySettlements(db);
        db.prepare("INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, 'migration')").run(
          TREASURY_MIGRATION_SETTING_KEY,
          JSON.stringify({ at: new Date().toISOString(), purchases: treasuryBackfill.purchases, legs: treasuryBackfill.legs, settled: treasuryBackfill.settled }),
        );
      }).immediate();
    }
  }
  return { treasuryBackfill };
}

/** The boot log line for migrateFinancerSchema; quiet when nothing ran. */
export function logFinancerMigration(m: FinancerMigration): void {
  const b = m.treasuryBackfill;
  if (!b) return;
  console.log(`[lana-discount] Financer settlement migration: ${b.purchases} purchase(s), ${b.legs} pending leg(s) the treasury already owed were given to the treasury; ${b.settled} purchase(s) it had already sent stay its own for any late leg`);
  // Pending legs of purchases the treasury already owed are for the owner to
  // see, by purchase. Only those: the settled ones are history, thousands of them.
  if (b.purchases > 0) {
    const more = b.refs.length > LOGGED_REFS ? ` … and ${b.refs.length - LOGGED_REFS} more (purchase_settlement, confirmed_by 'migration')` : '';
    console.warn(`[lana-discount] Treasury keeps sending: ${b.refs.slice(0, LOGGED_REFS).join(', ')}${more}`);
  }
}
