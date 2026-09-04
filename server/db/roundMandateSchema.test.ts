// @vitest-environment node
/**
 * The column migrations must be idempotent — a column that is already there
 * is not an error — but NOTHING ELSE may be swallowed: a locked, read-only
 * or half-built database has to stop the boot, not yield a server whose
 * offers endpoint fails on every insert because a column never arrived.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { addColumnIfMissing, ROUND_MANDATE_OFFER_COLUMNS, KIND_38888_SPLIT_ENDS_AT_COLUMN } from './roundMandateSchema';

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);

describe('addColumnIfMissing', () => {
  it('adds the column once and is silent when it already exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE acquisition_offers (id INTEGER PRIMARY KEY)');
    expect(addColumnIfMissing(db, ROUND_MANDATE_OFFER_COLUMNS[0])).toBe(true);
    expect(addColumnIfMissing(db, ROUND_MANDATE_OFFER_COLUMNS[0])).toBe(false);
    expect(columns(db, 'acquisition_offers')).toContain('mandate_ref');
  });

  it('rethrows every error that is not "duplicate column"', () => {
    const noTable = new Database(':memory:');
    expect(() => addColumnIfMissing(noTable, KIND_38888_SPLIT_ENDS_AT_COLUMN)).toThrow(/no such table/i);

    const readOnly = new Database(':memory:');
    readOnly.exec('CREATE TABLE kind_38888 (id TEXT PRIMARY KEY)');
    readOnly.pragma('query_only = 1');
    expect(() => addColumnIfMissing(readOnly, KIND_38888_SPLIT_ENDS_AT_COLUMN)).toThrow();
    expect(columns(readOnly, 'kind_38888')).not.toContain('split_ends_at');

    const closed = new Database(':memory:');
    closed.close();
    expect(() => addColumnIfMissing(closed, KIND_38888_SPLIT_ENDS_AT_COLUMN)).toThrow(/not open/i);
  });
});
