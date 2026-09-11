// @vitest-environment node
/**
 * The column migrations must be idempotent — a column that is already there
 * is not an error — but NOTHING ELSE may be swallowed: a locked, read-only
 * or half-built database has to stop the boot, not yield a server whose
 * offers endpoint fails on every insert because a column never arrived.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  addColumnIfMissing, ROUND_MANDATE_OFFER_COLUMNS, KIND_38888_SPLIT_ENDS_AT_COLUMN,
  rewriteStoredReviewPhrase, stuckTransfers, REVIEW_PHRASE_WAS, REVIEW_PHRASE_IS,
} from './roundMandateSchema';

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

/**
 * THE HALF OF THE 10 SEPT RENAME THAT LIVED IN THE DATABASE.
 *
 * `decision_reason` is stored, not computed, so renaming the review state in
 * the code left every older row still saying "under treasury review" to the
 * person who wrote the proposal — under a badge reading financial review.
 */
describe('rewriteStoredReviewPhrase', () => {
  const withOffers = () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE acquisition_offers (offer_ref TEXT PRIMARY KEY, decision_reason TEXT, status TEXT, transaction_id INTEGER)');
    return db;
  };
  const put = (db: Database.Database, ref: string, reason: string | null) =>
    db.prepare('INSERT INTO acquisition_offers (offer_ref, decision_reason, status) VALUES (?, ?, ?)').run(ref, reason, 'offered');
  const reasonOf = (db: Database.Database, ref: string) =>
    (db.prepare('SELECT decision_reason AS r FROM acquisition_offers WHERE offer_ref = ?').get(ref) as any).r;

  it('rewrites the stored sentence and leaves the rest of it alone', () => {
    const db = withOffers();
    put(db, 'A', `This proposal is ${REVIEW_PHRASE_WAS}; a person looks at every proposal by hand.`);
    expect(rewriteStoredReviewPhrase(db)).toBe(1);
    expect(reasonOf(db, 'A')).toBe(`This proposal is ${REVIEW_PHRASE_IS}; a person looks at every proposal by hand.`);
  });

  it('is EXACTLY idempotent — a second boot changes nothing', () => {
    const db = withOffers();
    put(db, 'A', `This proposal is ${REVIEW_PHRASE_WAS}: waiting on a person.`);
    expect(rewriteStoredReviewPhrase(db)).toBe(1);
    expect(rewriteStoredReviewPhrase(db)).toBe(0);
    expect(rewriteStoredReviewPhrase(db)).toBe(0);
  });

  /**
   * The mutation this kills: matching on LIKE alone. SQLite's LIKE ignores
   * case and REPLACE does not, so a differently-cased row would be "updated"
   * to itself on every boot and report the same count for ever.
   */
  it('does not touch a row in another casing, and does not keep reporting it', () => {
    const db = withOffers();
    put(db, 'A', 'Under Treasury Review, as the admin typed it.');
    expect(rewriteStoredReviewPhrase(db)).toBe(0);
    expect(reasonOf(db, 'A')).toBe('Under Treasury Review, as the admin typed it.');
  });

  it('leaves rows with no reason at all alone', () => {
    const db = withOffers();
    put(db, 'A', null);
    put(db, 'B', 'Declined: the round is fully acquired.');
    expect(rewriteStoredReviewPhrase(db)).toBe(0);
    expect(reasonOf(db, 'B')).toBe('Declined: the round is fully acquired.');
  });
});

describe('stuckTransfers', () => {
  const world = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acquisition_offers (offer_ref TEXT PRIMARY KEY, status TEXT, transaction_id INTEGER);
      CREATE TABLE buyback_transactions (id INTEGER PRIMARY KEY, offer_ref TEXT, status TEXT, error_message TEXT);
    `);
    return db;
  };
  const offer = (db: Database.Database, ref: string, status: string, tx: number | null = null) =>
    db.prepare('INSERT INTO acquisition_offers (offer_ref, status, transaction_id) VALUES (?, ?, ?)').run(ref, status, tx);
  const attempt = (db: Database.Database, ref: string, status: string, msg: string) =>
    db.prepare('INSERT INTO buyback_transactions (offer_ref, status, error_message) VALUES (?, ?, ?)').run(ref, status, msg);

  it('names the offer our own code is refusing, with the last thing it said', () => {
    const db = world();
    offer(db, 'OFF-1', 'accepted');
    attempt(db, 'OFF-1', 'failed', 'short by the fee');
    attempt(db, 'OFF-1', 'failed', 'short by the fee, again');
    const [row] = stuckTransfers(db);
    expect(row.offerRef).toBe('OFF-1');
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe('short by the fee, again');
  });

  it('says nothing about an offer that went through in the end', () => {
    const db = world();
    offer(db, 'OFF-2', 'settled', 7);
    attempt(db, 'OFF-2', 'failed', 'the first press');
    attempt(db, 'OFF-2', 'broadcast', '');
    expect(stuckTransfers(db)).toEqual([]);
  });

  it('and nothing about one nobody has tried yet — that is the whole distinction', () => {
    const db = world();
    offer(db, 'OFF-3', 'accepted');
    expect(stuckTransfers(db)).toEqual([]);
  });

  it('survives a database that has none of these columns', () => {
    const bare = new Database(':memory:');
    expect(stuckTransfers(bare)).toEqual([]);
  });
});
