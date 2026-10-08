// @vitest-environment node
/**
 * THE FINANCER MIGRATION: ADDITIVE, REPEATABLE, AND HANDING THE TREASURY ONLY
 * WHAT IT ALREADY OWED — ONCE.
 *
 * Pinned here: every new column on brain_lana_orders is nullable (a NOT NULL
 * one would make the brain's POST fail, and the brain closes a purchase on a
 * failed POST); running it twice changes nothing; on a fresh database it
 * waits for brain_lana_orders and finishes on the second call; and the
 * purchases the treasury owed on the day — a pending leg authorised, or in a
 * batch already received / bought — and the ones it had already SENT (or
 * whose old-flow batch was marked received / bought / sent) get a 'treasury'
 * owner exactly once, so a late leg of one is still sent (review C5/C10),
 * while everything else waits for a confirmation, including a leg authorised
 * after the deploy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { migrateFinancerSchema, logFinancerMigration, TREASURY_MIGRATION_SETTING_KEY } from './financerSchema';

let db: Database.Database;
const LEGS_DDL = `
  CREATE TABLE brain_lana_orders (
    id TEXT PRIMARY KEY, transaction_ref TEXT, order_type TEXT NOT NULL, to_wallet TEXT NOT NULL, to_hex TEXT NOT NULL,
    lana_amount INTEGER NOT NULL, fiat_value REAL NOT NULL, currency TEXT NOT NULL, exchange_rate REAL NOT NULL,
    tx_hash TEXT, status TEXT DEFAULT 'pending', error_message TEXT, created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, batch_ref TEXT, brain_authorized INTEGER DEFAULT 0, brain_authorized_at TEXT, cancel_reason TEXT
  );`;

beforeEach(() => {
  db = new DatabaseCtor(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT);
    CREATE TABLE incoming_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_ref TEXT NOT NULL UNIQUE, investor_hex TEXT NOT NULL,
      total_amount REAL NOT NULL, currency TEXT NOT NULL, payment_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'incoming', received_at TEXT, lana_bought_at TEXT, lana_sent_at TEXT,
      lana_tx_hash TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
const batch = (ref: string, status: string, investor = 'f-batch') =>
  db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status) VALUES (?, ?, 0, 'EUR', ?)").run(ref, investor, status);
let n = 0;
const leg = (ref: string, o: { auth?: 0 | 1; batch?: string; status?: string; type?: string; toHex?: string } = {}) =>
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized, batch_ref)
              VALUES (?, ?, ?, 'L', ?, 1, 1, 'EUR', 1, ?, ?, ?)`)
    .run(`L${++n}`, ref, o.type ?? 'merchant_commission', o.toHex ?? 'h', o.status ?? 'pending', o.auth ?? 0, o.batch ?? null);
const owners = () => db.prepare('SELECT transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by FROM purchase_settlement ORDER BY transaction_ref').all();

describe('migrateFinancerSchema', () => {
  it('on a fresh database: the new tables now, the leg columns once brain_lana_orders exists', () => {
    expect(migrateFinancerSchema(db).treasuryBackfill).toBeNull();
    for (const t of ['purchase_settlement', 'lana_sends', 'brain_callback_outbox']) expect(columns(t).length).toBeGreaterThan(0);
    expect(columns('incoming_batches').map(c => c.name)).toContain('settled_by');

    db.exec(LEGS_DDL);
    const second = migrateFinancerSchema(db);
    expect(second.treasuryBackfill).toEqual({ purchases: 0, legs: 0, refs: [], settled: 0 });
    expect(columns('brain_callback_outbox').find(c => c.name === 'accepted_at')!.notnull).toBe(0);
    const legCols = columns('brain_lana_orders');
    for (const name of ['send_txid', 'must_spend_json']) {
      const c = legCols.find(x => x.name === name);
      expect(c, name).toBeTruthy();
      // NULLABLE — the brain's POST must never fail on a column it does not send.
      expect(c!.notnull).toBe(0);
    }
    expect(columns('incoming_batches').find(c => c.name === 'settled_by')!.notnull).toBe(0);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'brain_lana_orders'").all() as any[];
    expect(idx.map(i => i.name)).toContain('idx_brain_lana_orders_transaction_ref');
  });

  it('twice, three times: the same schema and no error', () => {
    db.exec(LEGS_DDL);
    migrateFinancerSchema(db);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    migrateFinancerSchema(db);
    migrateFinancerSchema(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).toEqual(before);
  });

  it('gives the treasury exactly the purchases it already owed or sent, owned by their batch financer', () => {
    db.exec(LEGS_DDL);
    batch('B-RECEIVED', 'received');
    batch('B-BOUGHT', 'lana_bought', 'f-bought');
    batch('B-INCOMING', 'incoming');
    batch('B-SENT', 'lana_sent');
    batch('B-OLD-SENT', 'lana_sent', 'f-old');
    leg('T-AUTH', { auth: 1, type: 'investor_lana', toHex: 'f-investor' });           // authorised, no batch
    leg('T-AUTH', { auth: 0 });                                                          // its sibling comes along
    leg('T-RECEIVED', { batch: 'B-RECEIVED' });
    leg('T-BOUGHT', { batch: 'B-BOUGHT' });
    leg('T-INCOMING', { batch: 'B-INCOMING' });                                           // money not confirmed
    leg('T-OPEN');                                                                        // nothing at all
    leg('T-DONE', { auth: 1, status: 'sent', batch: 'B-SENT' });                          // sent: the treasury's for any late leg
    leg('T-SENT-ALONE', { status: 'sent', type: 'investor_lana', toHex: 'f-alone' });     // sent before batches were linked
    leg('T-LATE', { auth: 1, status: 'sent', type: 'investor_lana', toHex: 'f-late' });
    leg('T-LATE', { auth: 0 });                                                           // a leg the brain released after the send, not authorised yet
    leg('T-OLD-BATCH', { batch: 'B-OLD-SENT' });                                          // pending, in an old-flow batch marked LANA sent
    leg('T-CANCELLED', { auth: 1, status: 'cancelled' });
    leg('T-FAILED', { status: 'failed', batch: 'B-INCOMING' });

    const r = migrateFinancerSchema(db).treasuryBackfill!;
    // purchases/legs/refs: those with legs still to send — T-AUTH's two, T-RECEIVED, T-BOUGHT, T-LATE's late leg, T-OLD-BATCH.
    expect({ ...r, refs: [...r.refs].sort() }).toEqual({ purchases: 5, legs: 6, settled: 2, refs: ['T-AUTH', 'T-BOUGHT', 'T-LATE', 'T-OLD-BATCH', 'T-RECEIVED'] });
    expect(owners()).toEqual([
      { transaction_ref: 'T-AUTH', owner_hex: 'f-investor', settled_by: 'treasury', batch_ref: null, confirmed_by: 'migration' },
      { transaction_ref: 'T-BOUGHT', owner_hex: 'f-bought', settled_by: 'treasury', batch_ref: 'B-BOUGHT', confirmed_by: 'migration' },
      { transaction_ref: 'T-DONE', owner_hex: 'f-batch', settled_by: 'treasury', batch_ref: 'B-SENT', confirmed_by: 'migration' },
      { transaction_ref: 'T-LATE', owner_hex: 'f-late', settled_by: 'treasury', batch_ref: null, confirmed_by: 'migration' },
      { transaction_ref: 'T-OLD-BATCH', owner_hex: 'f-old', settled_by: 'treasury', batch_ref: 'B-OLD-SENT', confirmed_by: 'migration' },
      { transaction_ref: 'T-RECEIVED', owner_hex: 'f-batch', settled_by: 'treasury', batch_ref: 'B-RECEIVED', confirmed_by: 'migration' },
      { transaction_ref: 'T-SENT-ALONE', owner_hex: 'f-alone', settled_by: 'treasury', batch_ref: null, confirmed_by: 'migration' },
    ]);
    const marker = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(TREASURY_MIGRATION_SETTING_KEY) as any;
    expect(JSON.parse(marker.value)).toMatchObject({ purchases: 5, legs: 6, settled: 2 });
  });

  it('a batch a financer or the treasury already settled is not an old-flow batch', () => {
    db.exec(LEGS_DDL);
    migrateFinancerSchema(db); // adds settled_by
    db.prepare('DELETE FROM app_settings').run();
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status, settled_by) VALUES ('B-FIN', 'f', 0, 'EUR', 'lana_sent', 'financer')").run();
    leg('T-FIN', { batch: 'B-FIN' });
    expect(migrateFinancerSchema(db).treasuryBackfill).toEqual({ purchases: 0, legs: 0, refs: [], settled: 0 });
    expect(owners()).toEqual([]);
  });

  it('the boot log names only purchases with legs still to send — never the thousands the treasury already sent', () => {
    db.exec(LEGS_DDL);
    batch('B-SENT', 'lana_sent');
    const insert = db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized, batch_ref)
                               VALUES (?, ?, 'merchant_commission', 'L', 'h', 1, 1, 'EUR', 1, 'sent', 1, 'B-SENT')`);
    db.transaction(() => { for (let i = 0; i < 3000; i++) for (let k = 0; k < 4; k++) insert.run(`S${i}-${k}`, `T-HIST-${i}`); })();
    leg('T-HIST-7', { auth: 0 }); // one late leg on an old purchase
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logs.push(a.join(' ')); });
    try {
      const m = migrateFinancerSchema(db);
      expect(m.treasuryBackfill).toEqual({ purchases: 1, legs: 1, refs: ['T-HIST-7'], settled: 2999 });
      logFinancerMigration(m);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('1 purchase(s), 1 pending leg(s)');
    expect(logs[0]).toContain('2999 purchase(s) it had already sent');
    expect(logs[1]).toMatch(/Treasury keeps sending: T-HIST-7$/);
    expect((db.prepare("SELECT COUNT(*) c FROM purchase_settlement WHERE settled_by = 'treasury'").get() as any).c).toBe(3000);
  });

  it('runs once: a leg the brain authorises after the deploy is NOT handed to the treasury by the next restart', () => {
    db.exec(LEGS_DDL);
    migrateFinancerSchema(db);
    leg('T-LATER', { auth: 1 });
    expect(migrateFinancerSchema(db).treasuryBackfill).toBeNull();
    expect(owners()).toEqual([]);
  });

  it('never rewrites an owner that is already there', () => {
    db.exec(LEGS_DDL);
    migrateFinancerSchema(db); // the tables
    db.prepare('DELETE FROM app_settings').run();
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('T1', 'f-fin', 'financer', 'f-fin')").run();
    leg('T1', { auth: 1 });
    expect(migrateFinancerSchema(db).treasuryBackfill).toMatchObject({ purchases: 0 });
    expect(owners()).toEqual([{ transaction_ref: 'T1', owner_hex: 'f-fin', settled_by: 'financer', batch_ref: null, confirmed_by: 'f-fin' }]);
  });

  it('the owner columns refuse anything but the two senders', () => {
    migrateFinancerSchema(db);
    expect(() => db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES ('T', 'h', 'someone', 'x')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO lana_sends (txid, sender, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis, state) VALUES ('t', 'treasury', 'w', 'r', '[]', '[]', 1, 1, 'lost')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO brain_callback_outbox (kind, dedupe_key, body_json) VALUES ('other', 'k', '{}')").run()).toThrow(/CHECK/);
  });
});
