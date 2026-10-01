// @vitest-environment node
/**
 * THE BUTTON SENDS ONLY WHAT THE AUTO-SENDER WOULD.
 *
 * POST /api/admin/send-batch-lana used to broadcast every pending order of the
 * refs it was given, authorised or not. selectManualSendOrders() is the rule
 * that replaced it — the auto-sender's own (brain_authorized = 1, or the batch
 * is at 'lana_bought') — and the route sends nothing unless `unauthorised` is 0.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { selectManualSendOrders } from './manualSendSelection';

let db: Database.Database;

beforeEach(() => {
  db = new DatabaseCtor(':memory:');
  db.exec(`
    CREATE TABLE incoming_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_ref TEXT NOT NULL UNIQUE,
      investor_hex TEXT NOT NULL DEFAULT '',
      total_amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      payment_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'incoming',
      received_at TEXT, lana_bought_at TEXT, lana_sent_at TEXT, lana_tx_hash TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE brain_lana_orders (
      id TEXT PRIMARY KEY,
      transaction_ref TEXT,
      order_type TEXT NOT NULL DEFAULT 'merchant_commission',
      to_wallet TEXT NOT NULL DEFAULT 'L1',
      to_hex TEXT NOT NULL DEFAULT '',
      lana_amount INTEGER NOT NULL DEFAULT 0,
      fiat_value REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      exchange_rate REAL NOT NULL DEFAULT 0,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      batch_ref TEXT, brain_authorized INTEGER DEFAULT 0,
      brain_authorized_at TEXT, cancel_reason TEXT
    );
  `);
});

const batch = (ref: string, status: string) =>
  db.prepare('INSERT INTO incoming_batches (batch_ref, status) VALUES (?, ?)').run(ref, status);
let seq = 0;
const order = (txRef: string, o: { batch?: string | null; brain?: 0 | 1; status?: string; at?: string } = {}) => {
  const id = `O${++seq}`;
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, lana_amount, status, batch_ref, brain_authorized, created_at)
              VALUES (?, ?, 100, ?, ?, ?, ?)`)
    .run(id, txRef, o.status ?? 'pending', o.batch ?? null, o.brain ?? 0, o.at ?? `2026-10-01 10:00:${String(seq).padStart(2, '0')}`);
  return id;
};
const ids = (rows: any[]) => rows.map(r => r.id);

describe('selectManualSendOrders', () => {
  it('a batch at lana_bought authorises its orders', () => {
    batch('B1', 'lana_bought');
    const a = order('T1', { batch: 'B1' });
    const b = order('T1', { batch: 'B1' });
    const sel = selectManualSendOrders(db, ['T1']);
    expect(ids(sel.pending)).toEqual([a, b]);
    expect(sel.unauthorised).toBe(0);
  });

  it('brain_authorized authorises an order whatever its batch says', () => {
    batch('B1', 'received');
    order('T1', { batch: 'B1', brain: 1 });
    order('T2', { batch: null, brain: 1 });
    expect(selectManualSendOrders(db, ['T1', 'T2']).unauthorised).toBe(0);
  });

  it('counts orders whose money is not confirmed: batch not yet bought, or no batch at all', () => {
    batch('B1', 'received');
    order('T1', { batch: 'B1' });
    order('T2', { batch: null });
    order('T3', { batch: 'NO-SUCH-BATCH' });
    const sel = selectManualSendOrders(db, ['T1', 'T2', 'T3']);
    expect(sel.pending).toHaveLength(3);
    expect(sel.unauthorised).toBe(3);
  });

  it('one unauthorised order among authorised ones is enough to refuse the lot', () => {
    batch('B1', 'lana_bought');
    batch('B2', 'incoming');
    order('T1', { batch: 'B1' });
    order('T1', { batch: 'B1' });
    order('T2', { batch: 'B2' });
    const sel = selectManualSendOrders(db, ['T1', 'T2']);
    expect(sel.pending).toHaveLength(3);
    expect(sel.unauthorised).toBe(1);
  });

  it('takes only pending orders of the requested refs, oldest first, without the helper column', () => {
    batch('B1', 'lana_bought');
    const late = order('T1', { batch: 'B1', at: '2026-10-01 12:00:00' });
    const early = order('T1', { batch: 'B1', at: '2026-10-01 09:00:00' });
    order('T1', { batch: 'B1', status: 'sent' });
    order('T9', { batch: 'B1' });
    const sel = selectManualSendOrders(db, ['T1']);
    expect(ids(sel.pending)).toEqual([early, late]);
    expect(sel.pending[0]).not.toHaveProperty('send_authorised');
    expect(sel.pending[0]).toMatchObject({ transaction_ref: 'T1', lana_amount: 100, batch_ref: 'B1' });
  });

  it('nothing requested, nothing selected', () => {
    expect(selectManualSendOrders(db, [])).toEqual({ pending: [], unauthorised: 0 });
  });
});
