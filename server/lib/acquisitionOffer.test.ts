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
  markVoidedByAdmin, consumedByMandate,
  sellerDecisionReason, sellerActionDeadline,
  OFFER_VALIDITY_MINUTES, MANUAL_OFFER_VALIDITY_DAYS,
  ACCEPTED_TRANSFER_WINDOW_HOURS, TRANSFER_NOT_COMPLETED, type NewOffer,
} from './acquisitionOffer';
import { ROUND_MANDATE_OFFER_COLUMNS, OFFER_DECISION_REASON_STATUS_COLUMN } from '../db/roundMandateSchema';

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
  // The round-mandate columns are added by the same migration strings
  // production runs, so this DDL cannot drift from them.
  for (const sql of ROUND_MANDATE_OFFER_COLUMNS) db.exec(sql);
  db.exec(OFFER_DECISION_REASON_STATUS_COLUMN);
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

  /**
   * THIS ASSERTED THE OPPOSITE UNTIL 11 SEPT 2026 — "the sweeper lapses only
   * unaccepted offers" — and an ACCEPTED offer whose own window had closed was
   * therefore swept by nothing at all. It stayed `accepted`, `accepted` means
   * "waiting on the seller", and so it sat at the top of his dashboard under
   * "waiting on you" for ever. OFF-2026-003 was still there months later,
   * drawing itself as lapsed.
   *
   * Nothing about money changes: assertTransferable already refuses on that
   * same timestamp, so such a row was dead before this ran. The sweep only
   * makes the row say what was already true — and releases the mandate cap it
   * was holding for a sale that could never happen.
   */
  it('lapses an unaccepted offer AND an accepted one whose window has closed', () => {
    const stale = insertOffer(db, draft());
    markOffered(db, stale.offer_ref, price({ offerExpiresAt: sqliteFuture(db, '-1 minute') }));
    const live = insertOffer(db, draft());
    markOffered(db, live.offer_ref, price());
    const acceptedButLapsed = accepted();
    db.prepare(`UPDATE acquisition_offers SET offer_expires_at = datetime('now','-1 minute') WHERE offer_ref = ?`)
      .run(acceptedButLapsed);
    const acceptedAndLive = accepted();   // window still open — must survive

    expect(expireStaleOffers(db)).toBe(2);
    expect(getOfferByRef(db, stale.offer_ref)!.status).toBe('expired');
    expect(getOfferByRef(db, live.offer_ref)!.status).toBe('offered');
    expect(getOfferByRef(db, acceptedButLapsed)!.status).toBe('expired');
    expect(getOfferByRef(db, acceptedAndLive)!.status).toBe('accepted');
  });

  it('and never one that has already settled, whatever its dates say', () => {
    // transaction_id IS NULL is the guard: coins that moved are not undone by
    // a clock.
    const settled = accepted();
    const txId = Number(db.prepare('INSERT INTO buyback_transactions (net_fiat) VALUES (101.12)').run().lastInsertRowid);
    db.prepare(`UPDATE acquisition_offers SET transaction_id = ?, offer_expires_at = datetime('now','-1 day') WHERE offer_ref = ?`)
      .run(txId, settled);
    expect(expireStaleOffers(db)).toBe(0);
    expect(getOfferByRef(db, settled)!.status).toBe('accepted');
  });
});

/**
 * AN ACCEPTED OFFER WITHOUT A TRANSFER MUST NOT HOLD THE MANDATE FOREVER.
 *
 * consumedByMandate counts 'accepted', and nothing moved an accepted row on
 * if the seller never signed the transfer — so one abandoned acceptance
 * would consume a financer's remaining cap for good. Two ways out, both
 * guarded by `transaction_id IS NULL`: the sweeper after 24 h, and an admin
 * with a reason. A transferred row is a sale and is never touched by either.
 */
describe('an accepted offer whose transfer never comes', () => {
  const MANDATE = `8:1:${SELLER}`;
  const acceptedUnderMandate = (): string => {
    const o = insertOffer(db, draft({ mandateRef: MANDATE, round: 1 }));
    markOffered(db, o.offer_ref, price());
    markAccepted(db, o.offer_ref, 'v1.0');
    return o.offer_ref;
  };
  const acceptedHoursAgo = (ref: string, hours: number) =>
    db.prepare(`UPDATE acquisition_offers SET accepted_at = datetime('now', ?) WHERE offer_ref = ?`).run(`-${hours} hours`, ref);

  it('the sweeper lapses it after ACCEPTED_TRANSFER_WINDOW_HOURS, with the reason, and frees the mandate', () => {
    const stale = acceptedUnderMandate();
    acceptedHoursAgo(stale, ACCEPTED_TRANSFER_WINDOW_HOURS + 1);
    expect(consumedByMandate(db, [MANDATE]).get(MANDATE)).toBe(100_000_000_000);

    expect(expireStaleOffers(db)).toBe(1);
    const row = getOfferByRef(db, stale)!;
    expect(row.status).toBe('expired');
    expect(row.decision_reason).toBe(TRANSFER_NOT_COMPLETED);
    expect(consumedByMandate(db, [MANDATE]).get(MANDATE)).toBeUndefined();
    expect(assertTransferable(db, stale, SELLER).code).toBe('OFFER_EXPIRED');
  });

  it('the sweeper leaves a recently accepted one, and one accepted a minute inside the window, alone', () => {
    const fresh = acceptedUnderMandate();
    const nearly = acceptedUnderMandate();
    db.prepare(`UPDATE acquisition_offers SET accepted_at = datetime('now', ?) WHERE offer_ref = ?`)
      .run(`-${ACCEPTED_TRANSFER_WINDOW_HOURS * 60 - 1} minutes`, nearly);
    expect(expireStaleOffers(db)).toBe(0);
    expect(getOfferByRef(db, fresh)!.status).toBe('accepted');
    expect(getOfferByRef(db, nearly)!.status).toBe('accepted');
  });

  it('a TRANSFERRED offer (transaction_id set) is never lapsed, however old', () => {
    const ref = acceptedUnderMandate();
    const txId = Number(db.prepare('INSERT INTO buyback_transactions (net_fiat) VALUES (101.12)').run().lastInsertRowid);
    // Status left at 'accepted' on purpose: the transaction_id alone must protect it.
    db.prepare('UPDATE acquisition_offers SET transaction_id = ? WHERE offer_ref = ?').run(txId, ref);
    acceptedHoursAgo(ref, 1000);
    expect(expireStaleOffers(db)).toBe(0);
    expect(getOfferByRef(db, ref)!.status).toBe('accepted');
    expect(consumedByMandate(db, [MANDATE]).get(MANDATE)).toBe(100_000_000_000);
  });

  it('a LEGACY accepted offer (no mandate_ref) is NOT lapsed by the 24 h sweep — that path is unchanged from before rounds', () => {
    // At HEAD the sweeper touched only 'offered' rows. The transfer-window
    // sweep exists to free a financer's cap, which a legacy offer never held,
    // so it must stay outside the sweep; the admin void still reaches it.
    const legacy = accepted();
    acceptedHoursAgo(legacy, ACCEPTED_TRANSFER_WINDOW_HOURS + 1);
    const mandate = acceptedUnderMandate();
    acceptedHoursAgo(mandate, ACCEPTED_TRANSFER_WINDOW_HOURS + 1);

    expect(expireStaleOffers(db)).toBe(1);
    expect(getOfferByRef(db, legacy)!.status).toBe('accepted');
    expect(getOfferByRef(db, legacy)!.decision_reason).toBeNull();
    expect(getOfferByRef(db, mandate)!).toMatchObject({ status: 'expired', decision_reason: TRANSFER_NOT_COMPLETED });
    expect(markVoidedByAdmin(db, legacy, 'seller asked', OTHER)).toBe(true);
    expect(getOfferByRef(db, legacy)!.status).toBe('withdrawn');
  });

  it('an admin can void it with a reason, which frees the mandate and records who did it', () => {
    const ref = acceptedUnderMandate();
    expect(markVoidedByAdmin(db, ref, 'seller asked to start over', OTHER)).toBe(true);
    const row = getOfferByRef(db, ref)!;
    expect(row.status).toBe('withdrawn');
    expect(row.decision_reason).toBe('seller asked to start over');
    expect(row.decided_by).toBe(OTHER);
    expect(row.decided_at).not.toBeNull();
    expect(consumedByMandate(db, [MANDATE]).get(MANDATE)).toBeUndefined();
    // …and voiding is not reopening: it cannot be accepted or transferred after.
    expect(markAccepted(db, ref, 'v1.0')).toBe(false);
    expect(assertTransferable(db, ref, SELLER).code).toBe('NOT_ACCEPTED');
  });

  it('an admin cannot void a transferred offer, nor one that was never accepted', () => {
    const transferred = acceptedUnderMandate();
    const txId = Number(db.prepare('INSERT INTO buyback_transactions (net_fiat) VALUES (101.12)').run().lastInsertRowid);
    db.prepare('UPDATE acquisition_offers SET transaction_id = ? WHERE offer_ref = ?').run(txId, transferred);
    expect(markVoidedByAdmin(db, transferred, 'no', OTHER)).toBe(false);
    expect(getOfferByRef(db, transferred)!.status).toBe('accepted');

    const merelyOffered = insertOffer(db, draft({ mandateRef: MANDATE, round: 1 }));
    markOffered(db, merelyOffered.offer_ref, price());
    expect(markVoidedByAdmin(db, merelyOffered.offer_ref, 'no', OTHER)).toBe(false);
    expect(getOfferByRef(db, merelyOffered.offer_ref)!.status).toBe('offered');
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

/**
 * WHAT THE SELLER IS STILL WAITING TO DO, AND BY WHEN.
 *
 * /dashboard draws a countdown from this. If it named the wrong moment the
 * page would be inventing a deadline, which is the same species of falsehood
 * as the stale verdict below — so the arithmetic lives here, on the server
 * that owns both horizons, and is pinned.
 */
describe('the deadline the seller is actually working to', () => {
  const eightDays = () => sqliteFuture(db, `+${MANUAL_OFFER_VALIDITY_DAYS} days`);

  it('on an open offer it is the offer window', () => {
    const until = eightDays();
    const o = insertOffer(db, draft());
    markOffered(db, o.offer_ref, price({ offerExpiresAt: until }));
    expect(sellerActionDeadline(getOfferByRef(db, o.offer_ref)!)).toBe(until);
  });

  it('nothing is waiting on a seller whose proposal is still with the treasury', () => {
    const o = insertOffer(db, draft({ status: 'under_review' }));
    expect(sellerActionDeadline(getOfferByRef(db, o.offer_ref)!)).toBeNull();
  });

  it('nothing is waiting on a seller once the offer is over', () => {
    const o = insertOffer(db, draft());
    markDeclined(db, o.offer_ref, 'not today', null);
    expect(sellerActionDeadline(getOfferByRef(db, o.offer_ref)!)).toBeNull();
  });

  /**
   * The one that matters. An 8-day offer accepted on day one has SEVEN days
   * of window left and FOUR AND TWENTY HOURS before the sweeper voids it to
   * give the financer's cap back. Counting down to the window would print six
   * days left on a row this server kills tomorrow.
   */
  it('on an accepted mandate-bound offer it is the 24-hour sweep, not the 8-day window', () => {
    const until = eightDays();
    const o = insertOffer(db, draft({ mandateRef: '8:1:seller', round: 1 }));
    markOffered(db, o.offer_ref, price({ offerExpiresAt: until }));
    markAccepted(db, o.offer_ref, 'v1.0');
    const row = getOfferByRef(db, o.offer_ref)!;
    const due = sellerActionDeadline(row)!;
    expect(due).not.toBe(until);
    expect(due < until).toBe(true);
    const sweepsAt = new Date(`${row.accepted_at!.replace(' ', 'T')}Z`).getTime()
      + ACCEPTED_TRANSFER_WINDOW_HOURS * 3600_000;
    expect(new Date(`${due.replace(' ', 'T')}Z`).getTime()).toBe(sweepsAt);
  });

  it('a legacy accepted offer is never swept, so its window is the whole story', () => {
    const until = eightDays();
    const o = insertOffer(db, draft());
    markOffered(db, o.offer_ref, price({ offerExpiresAt: until }));
    markAccepted(db, o.offer_ref, 'v1.0');
    expect(sellerActionDeadline(getOfferByRef(db, o.offer_ref)!)).toBe(until);
  });

  it('a 30-minute window beats the 24-hour sweep, because it closes first', () => {
    const o = insertOffer(db, draft({ mandateRef: '8:1:seller', round: 1 }));
    markOffered(db, o.offer_ref, price());
    markAccepted(db, o.offer_ref, 'v1.0');
    const row = getOfferByRef(db, o.offer_ref)!;
    expect(sellerActionDeadline(row)).toBe(row.offer_expires_at);
  });
});

/**
 * A VERDICT ABOUT A STATE THE ROW HAS LEFT IS NOT A DESCRIPTION OF IT.
 *
 * The three production rows the complaint came from, in one sentence: two
 * `offered` and one `withdrawn`, all three still carrying "This proposal is
 * under treasury review." because markOffered and markWithdrawn write no
 * decision_reason and the sweeper's unaccepted lapse writes none either. The
 * column is audit data and is left alone; what changed is that the writers now
 * say WHICH status they wrote the sentence about, and the seller sees it only
 * while that is still the status the row is in.
 */
describe('whether a decision reason describes the row it is on', () => {
  const seen = (ref: string) => sellerDecisionReason(getOfferByRef(db, ref)!);

  it('a proposal still being decided says why it is being decided', () => {
    const o = insertOffer(db, draft({ status: 'under_review', decisionReason: 'This proposal is under treasury review.' }));
    expect(seen(o.offer_ref)).toBe('This proposal is under treasury review.');
  });

  it('once priced, the live offer stops repeating it — and the trail keeps it', () => {
    const o = insertOffer(db, draft({ status: 'under_review', decisionReason: 'This proposal is under treasury review.' }));
    markOffered(db, o.offer_ref, price());
    expect(seen(o.offer_ref)).toBeNull();
    expect(getOfferByRef(db, o.offer_ref)!.decision_reason).toBe('This proposal is under treasury review.');
  });

  /**
   * OFF-2026-047. A seller withdrew a proposal that was under review, and the
   * row kept telling him it was under treasury review beneath a badge reading
   * "Closed" — the same sentence, on the same screen, weeks later.
   */
  it('a proposal its own seller withdrew does not still say it is under review', () => {
    const o = insertOffer(db, draft({ status: 'under_review', decisionReason: 'This proposal is under treasury review.' }));
    markWithdrawn(db, o.offer_ref, SELLER);
    expect(getOfferByRef(db, o.offer_ref)!.status).toBe('withdrawn');
    expect(seen(o.offer_ref)).toBeNull();
    expect(getOfferByRef(db, o.offer_ref)!.decision_reason).toBe('This proposal is under treasury review.');
  });

  it('nor does one the sweeper simply let lapse', () => {
    const o = insertOffer(db, draft({ status: 'under_review', decisionReason: 'This proposal is under treasury review.' }));
    markOffered(db, o.offer_ref, price());
    db.prepare("UPDATE acquisition_offers SET offer_expires_at = datetime('now','-1 minute') WHERE offer_ref = ?")
      .run(o.offer_ref);
    expireStaleOffers(db);
    expect(getOfferByRef(db, o.offer_ref)!.status).toBe('expired');
    expect(seen(o.offer_ref)).toBeNull();
  });

  it('but an ending that DID write a reason still speaks for itself', () => {
    const declined = insertOffer(db, draft());
    markDeclined(db, declined.offer_ref, 'Above the amount this mandate covers.', 'admin');
    expect(seen(declined.offer_ref)).toBe('Above the amount this mandate covers.');

    const voided = insertOffer(db, draft({ mandateRef: '8:1:seller', round: 1 }));
    markOffered(db, voided.offer_ref, price());
    markAccepted(db, voided.offer_ref, 'v1.0');
    markVoidedByAdmin(db, voided.offer_ref, 'You asked us to cancel it.', 'admin');
    expect(getOfferByRef(db, voided.offer_ref)!.status).toBe('withdrawn');
    expect(seen(voided.offer_ref)).toBe('You asked us to cancel it.');

    const swept = insertOffer(db, draft({ mandateRef: '8:1:seller', round: 1 }));
    markOffered(db, swept.offer_ref, price({ offerExpiresAt: sqliteFuture(db, '+8 days') }));
    markAccepted(db, swept.offer_ref, 'v1.0');
    db.prepare("UPDATE acquisition_offers SET accepted_at = datetime('now','-25 hours') WHERE offer_ref = ?")
      .run(swept.offer_ref);
    expireStaleOffers(db);
    expect(seen(swept.offer_ref)).toBe(TRANSFER_NOT_COMPLETED);
  });

  /**
   * Rows written before the marker existed cannot prove anything, and an
   * unproven verdict is not shown to the person it is about. `expired` and
   * `withdrawn` are exactly the two endings whose writers disagree.
   */
  it('an old row with no marker is trusted only where every writer wrote at the transition', () => {
    const stale = (status: string) => {
      const o = insertOffer(db, draft({ status: 'under_review', decisionReason: 'This proposal is under treasury review.' }));
      db.prepare('UPDATE acquisition_offers SET status = ?, decision_reason_status = NULL WHERE offer_ref = ?')
        .run(status, o.offer_ref);
      return seen(o.offer_ref);
    };
    expect(stale('under_review')).toBe('This proposal is under treasury review.');
    expect(stale('declined')).toBe('This proposal is under treasury review.');
    expect(stale('withdrawn')).toBeNull();
    expect(stale('expired')).toBeNull();
    expect(stale('offered')).toBeNull();
    expect(stale('accepted')).toBeNull();
    expect(stale('settled')).toBeNull();
  });
});
