// @vitest-environment node
/**
 * NO ACCEPTED OFFER, NO TRANSFER — AND THE PRICE IS THE ONE WE OFFERED.
 *
 * These are the two facts the whole regulatory position rests on. If a seller
 * can move LANA without us having accepted first, we are back to a standing
 * service with new labels on it; and if the price can drift between the offer
 * and the transfer, there was no agreed purchase price to speak of.
 *
 * Driven against a real in-memory SQLite with the production schema, because
 * the transitions are conditional UPDATEs and their whole value is in what
 * SQLite does when two of them race.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  generateOfferRef, insertOffer, getOfferByRef, sqliteFuture,
  markOffered, markDeclined, markAccepted, markSettled, markWithdrawn,
  expireStaleOffers, listOffersForReview, assertTransferable,
  OFFER_VALIDITY_MINUTES, type NewOffer,
} from './acquisitionOffer';

const SELLER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

let db: Database.Database;

// The production DDL for the two tables under test, kept in step with
// server/db/index.ts.
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE buyback_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, net_fiat REAL);
    CREATE TABLE acquisition_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_ref TEXT NOT NULL UNIQUE,
      user_hex_id TEXT NOT NULL,
      sender_wallet_id TEXT NOT NULL,
      wallet_class TEXT NOT NULL,
      lana_amount_lanoshis INTEGER NOT NULL,
      lana_amount_display REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      reference_rate REAL, discount_percent REAL, purchase_price_fiat REAL, gross_fiat REAL,
      mandate_code TEXT, eligibility_json TEXT,
      settlement_due_at TEXT, offer_expires_at TEXT,
      decided_by TEXT, decided_at TEXT, decision_reason TEXT,
      accepted_at TEXT, terms_version TEXT,
      transaction_id INTEGER REFERENCES buyback_transactions(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

const draft = (over: Partial<NewOffer> = {}): NewOffer => ({
  offerRef: generateOfferRef(db),
  userHexId: SELLER,
  senderWalletId: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB',
  walletClass: 'lanapays',
  lanaAmountLanoshis: 100_000_000_000,
  lanaAmountDisplay: 1000,
  currency: 'EUR',
  status: 'submitted',
  referenceRate: 0.128,
  discountPercent: 21,
  purchasePriceFiat: null,
  grossFiat: null,
  mandateCode: 'WITHIN_MANDATE',
  eligibility: { freeze: 'ok', split: 'ok' },
  settlementDueAt: null,
  offerExpiresAt: null,
  decisionReason: null,
  ...over,
});

const price = (over: Partial<Parameters<typeof markOffered>[2]> = {}) => ({
  purchasePriceFiat: 101.12,
  grossFiat: 128,
  referenceRate: 0.128,
  discountPercent: 21,
  settlementDueAt: sqliteFuture(db, '+15 days'),
  offerExpiresAt: sqliteFuture(db, `+${OFFER_VALIDITY_MINUTES} minutes`),
  decidedBy: null,
  ...over,
});

/** Walk an offer all the way to acceptance. */
function accepted(): string {
  const o = insertOffer(db, draft());
  markOffered(db, o.offer_ref, price());
  markAccepted(db, o.offer_ref, 'v1.0');
  return o.offer_ref;
}

describe('no transfer without an accepted offer', () => {
  it('refuses a submitted offer — we have not decided yet', () => {
    const o = insertOffer(db, draft());
    const gate = assertTransferable(db, o.offer_ref, SELLER);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('NOT_ACCEPTED');
  });

  it('refuses one that is under review', () => {
    const o = insertOffer(db, draft({ status: 'under_review' }));
    expect(assertTransferable(db, o.offer_ref, SELLER).code).toBe('NOT_ACCEPTED');
  });

  it('refuses one we offered but the seller never accepted', () => {
    const o = insertOffer(db, draft());
    markOffered(db, o.offer_ref, price());
    expect(assertTransferable(db, o.offer_ref, SELLER).code).toBe('NOT_ACCEPTED');
  });

  it('refuses one we declined', () => {
    const o = insertOffer(db, draft());
    markDeclined(db, o.offer_ref, 'Not acquiring this class at the moment.', null);
    expect(assertTransferable(db, o.offer_ref, SELLER).code).toBe('NOT_ACCEPTED');
  });

  it('lets an accepted, unexpired offer through', () => {
    const gate = assertTransferable(db, accepted(), SELLER);
    expect(gate.ok).toBe(true);
    expect(gate.offer!.purchase_price_fiat).toBe(101.12);
  });

  it('a reference that does not exist and one belonging to someone else read the same', () => {
    // Otherwise the endpoint becomes an oracle for other people's offers.
    const mine = accepted();
    expect(assertTransferable(db, 'OFF-1999-001', SELLER).code).toBe('NO_SUCH_OFFER');
    expect(assertTransferable(db, mine, OTHER).code).toBe('NO_SUCH_OFFER');
  });
});

describe('a lapsed offer is not a price', () => {
  it('refuses once the window has closed', () => {
    const o = insertOffer(db, draft());
    markOffered(db, o.offer_ref, price({ offerExpiresAt: sqliteFuture(db, '-1 minute') }));
    // Acceptance itself is refused after the window…
    expect(markAccepted(db, o.offer_ref, 'v1.0')).toBe(false);
    // …and so is the transfer.
    expect(assertTransferable(db, o.offer_ref, SELLER).ok).toBe(false);
  });

  it('refuses an accepted offer whose window closed before the transfer', () => {
    const ref = accepted();
    db.prepare(`UPDATE acquisition_offers SET offer_expires_at = datetime('now','-1 minute') WHERE offer_ref = ?`).run(ref);
    const gate = assertTransferable(db, ref, SELLER);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('OFFER_EXPIRED');
  });

  it('the sweeper lapses only unaccepted offers', () => {
    const stale = insertOffer(db, draft());
    markOffered(db, stale.offer_ref, price({ offerExpiresAt: sqliteFuture(db, '-1 minute') }));
    const live = insertOffer(db, draft());
    markOffered(db, live.offer_ref, price());
    const alreadyAccepted = accepted();
    db.prepare(`UPDATE acquisition_offers SET offer_expires_at = datetime('now','-1 minute') WHERE offer_ref = ?`)
      .run(alreadyAccepted);

    expect(expireStaleOffers(db)).toBe(1);
    expect(getOfferByRef(db, stale.offer_ref)!.status).toBe('expired');
    expect(getOfferByRef(db, live.offer_ref)!.status).toBe('offered');
    expect(getOfferByRef(db, alreadyAccepted)!.status).toBe('accepted');
  });
});

describe('an offer is used exactly once', () => {
  it('settles once and refuses a second attempt', () => {
    const ref = accepted();
    const txId = Number(db.prepare('INSERT INTO buyback_transactions (net_fiat) VALUES (101.12)').run().lastInsertRowid);

    expect(markSettled(db, ref, txId)).toBe(true);
    expect(markSettled(db, ref, txId)).toBe(false);

    const gate = assertTransferable(db, ref, SELLER);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('ALREADY_SETTLED');
  });

  it('two racing acceptances cannot both win', () => {
    const o = insertOffer(db, draft());
    markOffered(db, o.offer_ref, price());
    expect(markAccepted(db, o.offer_ref, 'v1.0')).toBe(true);
    expect(markAccepted(db, o.offer_ref, 'v1.0')).toBe(false);
  });

  it('a decision cannot be reopened after it is made', () => {
    const o = insertOffer(db, draft());
    expect(markDeclined(db, o.offer_ref, 'no', null)).toBe(true);
    expect(markOffered(db, o.offer_ref, price())).toBe(false);
    expect(getOfferByRef(db, o.offer_ref)!.status).toBe('declined');
  });
});

describe('what the offer carries', () => {
  it('records the terms version at the moment of acceptance', () => {
    // The old terms gate lived in React state and left no trace; this is the
    // evidence that the seller saw what they agreed to.
    const ref = accepted();
    const row = getOfferByRef(db, ref)!;
    expect(row.terms_version).toBe('v1.0');
    expect(row.accepted_at).toBeTruthy();
  });

  it('carries a settlement date we owe by', () => {
    const row = getOfferByRef(db, accepted())!;
    expect(row.settlement_due_at).toBeTruthy();
    expect(row.settlement_due_at! > row.created_at).toBe(true);
  });

  it('keeps the basis of the decision for later reading', () => {
    const row = getOfferByRef(db, accepted())!;
    expect(JSON.parse(row.eligibility_json!)).toEqual({ freeze: 'ok', split: 'ok' });
    expect(row.reference_rate).toBe(0.128);
    expect(row.discount_percent).toBe(21);
    expect(row.mandate_code).toBe('WITHIN_MANDATE');
  });

  it('a seller can withdraw their own offer, and only their own', () => {
    const o = insertOffer(db, draft());
    expect(markWithdrawn(db, o.offer_ref, OTHER)).toBe(false);
    expect(markWithdrawn(db, o.offer_ref, SELLER)).toBe(true);
    expect(assertTransferable(db, o.offer_ref, SELLER).ok).toBe(false);
  });

  it('lists what is waiting for a person, oldest first', () => {
    const a = insertOffer(db, draft({ status: 'under_review' }));
    insertOffer(db, draft());
    const c = insertOffer(db, draft({ status: 'under_review' }));
    const queue = listOffersForReview(db);
    expect(queue.map(o => o.offer_ref)).toEqual([a.offer_ref, c.offer_ref]);
  });

  it('gives every offer its own reference', () => {
    const refs = new Set([insertOffer(db, draft()).offer_ref, insertOffer(db, draft()).offer_ref]);
    expect(refs.size).toBe(2);
  });
});
