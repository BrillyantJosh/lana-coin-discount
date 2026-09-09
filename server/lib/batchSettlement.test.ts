// @vitest-environment node
/**
 * THE LAST TWO TICKS ARE NOT DECISIONS.
 *
 * A batch reaches 'received' because the operator saw the FIAT on the bank
 * statement — that stays a human call. Everything after it is bookkeeping, and
 * these tests pin what may and may not be ticked off from the evidence:
 * a batch closes only when its OWN LANA orders prove the coins went out.
 *
 * The case that gave this file its reason to exist is the first test: eight
 * batches sat in RECEIVED for four days, all of their LANA long since sent,
 * because nobody pressed a button.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { settleBatchesWithSentLana } from './batchSettlement';

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

let seq = 0;
const batch = (ref: string, status: string, over: Record<string, unknown> = {}) => {
  db.prepare(
    "INSERT INTO incoming_batches (batch_ref, status, lana_bought_at, lana_tx_hash) VALUES (?, ?, ?, ?)"
  ).run(ref, status, (over.lana_bought_at as string) ?? null, (over.lana_tx_hash as string) ?? null);
};
const order = (batchRef: string | null, status: string, over: { txHash?: string; completedAt?: string } = {}) => {
  db.prepare(
    "INSERT INTO brain_lana_orders (id, batch_ref, status, tx_hash, completed_at) VALUES (?, ?, ?, ?, ?)"
  ).run(`o${++seq}`, batchRef, status, over.txHash ?? (status === 'sent' ? 'hash' : null), over.completedAt ?? null);
};
const read = (ref: string) =>
  db.prepare('SELECT * FROM incoming_batches WHERE batch_ref = ?').get(ref) as any;

describe('closing a batch whose LANA has gone out', () => {
  it("closes a 'received' batch nobody ever ticked, and backfills when the coins were in hand", () => {
    batch('2026001775', 'received');
    order('2026001775', 'sent', { txHash: 'aaa', completedAt: '2026-09-09 09:19:12' });
    order('2026001775', 'sent', { txHash: 'bbb', completedAt: '2026-09-09 09:24:18' });

    const settled = settleBatchesWithSentLana(db);

    expect(settled).toEqual([{ batchRef: '2026001775', from: 'received', orders: 2, txHash: 'bbb' }]);
    const row = read('2026001775');
    expect(row.status).toBe('lana_sent');
    expect(row.lana_sent_at).toBeTruthy();
    expect(row.lana_bought_at).toBe('2026-09-09 09:19:12'); // the first send, not now
    expect(row.lana_tx_hash).toBe('bbb');
  });

  it("closes a 'lana_bought' batch too — the step the operator used to do by hand", () => {
    batch('2026001784', 'lana_bought', { lana_bought_at: '2026-09-05 14:47:09' });
    order('2026001784', 'sent', { completedAt: '2026-09-05 14:47:16' });

    expect(settleBatchesWithSentLana(db).map(s => s.from)).toEqual(['lana_bought']);
    const row = read('2026001784');
    expect(row.status).toBe('lana_sent');
    expect(row.lana_bought_at).toBe('2026-09-05 14:47:09'); // the operator's own timestamp survives
  });

  it('leaves a batch alone while any of its LANA is still owed', () => {
    batch('2026001831', 'received');
    order('2026001831', 'sent');
    order('2026001831', 'pending');

    expect(settleBatchesWithSentLana(db)).toEqual([]);
    expect(read('2026001831').status).toBe('received');
  });

  it('never guesses: a batch with no linked orders stays where it is', () => {
    batch('2026001900', 'received');
    order(null, 'sent');

    expect(settleBatchesWithSentLana(db)).toEqual([]);
    expect(read('2026001900').status).toBe('received');
  });

  it('does not dress up a batch whose every leg was cancelled', () => {
    batch('2026001901', 'received');
    order('2026001901', 'cancelled');
    order('2026001901', 'cancelled');

    expect(settleBatchesWithSentLana(db)).toEqual([]);
    expect(read('2026001901').status).toBe('received');
  });

  it('closes a batch whose remaining legs were cancelled, as long as one was sent', () => {
    batch('2026001902', 'received');
    order('2026001902', 'sent', { completedAt: '2026-09-08 10:00:00' });
    order('2026001902', 'cancelled');

    expect(settleBatchesWithSentLana(db).map(s => s.batchRef)).toEqual(['2026001902']);
    expect(read('2026001902').status).toBe('lana_sent');
  });

  it("will not confirm the bank for the operator: 'incoming' is never touched", () => {
    batch('2026001903', 'incoming');
    order('2026001903', 'sent');

    expect(settleBatchesWithSentLana(db)).toEqual([]);
    expect(read('2026001903').status).toBe('incoming');
  });

  it('settles once and then has nothing to say', () => {
    batch('2026001904', 'received');
    order('2026001904', 'sent', { completedAt: '2026-09-09 11:43:08' });

    const first = settleBatchesWithSentLana(db);
    const sentAt = read('2026001904').lana_sent_at;
    const second = settleBatchesWithSentLana(db);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(read('2026001904').lana_sent_at).toBe(sentAt);
  });

  it('closes several batches in one pass and reports each', () => {
    batch('A', 'received'); order('A', 'sent');
    batch('B', 'lana_bought'); order('B', 'sent');
    batch('C', 'received'); order('C', 'pending');

    expect(settleBatchesWithSentLana(db).map(s => s.batchRef).sort()).toEqual(['A', 'B']);
    expect(read('C').status).toBe('received');
  });
});
