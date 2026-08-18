/**
 * The life of one acquisition offer.
 *
 * submitted ─┬─ accept (within mandate) ─▶ offered ─┬─ seller accepts ─▶ accepted ─▶ settled
 *            │                                      └─ lapses ─────────▶ expired
 *            ├─ review ─▶ under_review ─┬─ admin accepts ─▶ offered
 *            │                          └─ admin declines ─▶ declined
 *            └─ decline ─────────────────────────────────────▶ declined
 *
 * Two properties this module exists to hold:
 *
 *   1. **A transfer is impossible without an accepted, unexpired offer.**
 *      That is the whole regulatory point — our decision comes first, the
 *      coins move second. `assertTransferable` is the only door.
 *
 *   2. **The price is the one we offered.** Today's `/sell/execute` re-reads
 *      the exchange rate and commission from scratch and charges whatever they
 *      say at that instant, which is how a seller can be shown one figure and
 *      charged another. Here the figures are frozen onto the offer when it is
 *      made and read back from it — a purchase price agreed before transfer,
 *      as section 7 requires, and a bug fixed on the way past.
 *
 * Every state change is a conditional UPDATE that names the status it expects,
 * the same shape as verifyTransaction/rejectTransaction in db/index.ts, so two
 * clicks or two tabs cannot both win.
 */
import type Database from 'better-sqlite3';

export type OfferStatus =
  | 'submitted'
  | 'under_review'
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'withdrawn'
  | 'settled';

/** How long a purchase offer stands before it lapses. */
export const OFFER_VALIDITY_MINUTES = 30;

export interface OfferRow {
  id: number;
  offer_ref: string;
  user_hex_id: string;
  sender_wallet_id: string;
  wallet_class: string;
  lana_amount_lanoshis: number;
  lana_amount_display: number;
  currency: string;
  status: OfferStatus;
  reference_rate: number | null;
  discount_percent: number | null;
  purchase_price_fiat: number | null;
  gross_fiat: number | null;
  mandate_code: string | null;
  eligibility_json: string | null;
  settlement_due_at: string | null;
  offer_expires_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  accepted_at: string | null;
  terms_version: string | null;
  transaction_id: number | null;
  created_at: string;
  updated_at: string;
}

/** `OFF-YYYY-NNN`, matching the shape of the existing PAY- references. */
export function generateOfferRef(db: Database.Database): string {
  const year = new Date().getFullYear();
  const count = (db.prepare('SELECT COUNT(*) as count FROM acquisition_offers').get() as any).count;
  return `OFF-${year}-${String(count + 1).padStart(3, '0')}`;
}

export function getOfferByRef(db: Database.Database, offerRef: string): OfferRow | null {
  return (db.prepare('SELECT * FROM acquisition_offers WHERE offer_ref = ?').get(offerRef) as OfferRow) || null;
}

export interface NewOffer {
  offerRef: string;
  userHexId: string;
  senderWalletId: string;
  walletClass: string;
  lanaAmountLanoshis: number;
  lanaAmountDisplay: number;
  currency: string;
  status: OfferStatus;
  referenceRate: number | null;
  discountPercent: number | null;
  purchasePriceFiat: number | null;
  grossFiat: number | null;
  mandateCode: string | null;
  eligibility: unknown;
  settlementDueAt: string | null;
  offerExpiresAt: string | null;
  decisionReason: string | null;
}

export function insertOffer(db: Database.Database, o: NewOffer): OfferRow {
  db.prepare(`
    INSERT INTO acquisition_offers (
      offer_ref, user_hex_id, sender_wallet_id, wallet_class,
      lana_amount_lanoshis, lana_amount_display, currency, status,
      reference_rate, discount_percent, purchase_price_fiat, gross_fiat,
      mandate_code, eligibility_json, settlement_due_at, offer_expires_at,
      decision_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.offerRef, o.userHexId, o.senderWalletId, o.walletClass,
    o.lanaAmountLanoshis, o.lanaAmountDisplay, o.currency, o.status,
    o.referenceRate, o.discountPercent, o.purchasePriceFiat, o.grossFiat,
    o.mandateCode, o.eligibility === null || o.eligibility === undefined ? null : JSON.stringify(o.eligibility),
    o.settlementDueAt, o.offerExpiresAt, o.decisionReason,
  );
  return getOfferByRef(db, o.offerRef)!;
}

/**
 * `datetime('now', '+N minutes')` computed by SQLite so the stored timestamps
 * are in the same clock and format as every other column in this database.
 */
export function sqliteFuture(db: Database.Database, modifier: string): string {
  return (db.prepare(`SELECT datetime('now', ?) AS t`).get(modifier) as any).t;
}

// ─── transitions ──────────────────────────────────────────────────────────
// Each names the status it expects; `changes === 0` means somebody else got
// there first, and the caller must re-read rather than assume.

/** Admin (or the mandate) turns a reviewed proposal into a live purchase offer. */
export function markOffered(db: Database.Database, offerRef: string, price: {
  purchasePriceFiat: number;
  grossFiat: number;
  referenceRate: number;
  discountPercent: number;
  settlementDueAt: string;
  offerExpiresAt: string;
  decidedBy: string | null;
}): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'offered', purchase_price_fiat = ?, gross_fiat = ?,
           reference_rate = ?, discount_percent = ?, settlement_due_at = ?,
           offer_expires_at = ?, decided_by = ?, decided_at = datetime('now'),
           updated_at = datetime('now')
     WHERE offer_ref = ? AND status IN ('submitted', 'under_review')
  `).run(
    price.purchasePriceFiat, price.grossFiat, price.referenceRate, price.discountPercent,
    price.settlementDueAt, price.offerExpiresAt, price.decidedBy, offerRef,
  );
  return r.changes === 1;
}

export function markDeclined(db: Database.Database, offerRef: string, reason: string, by: string | null): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'declined', decision_reason = ?, decided_by = ?,
           decided_at = datetime('now'), updated_at = datetime('now')
     WHERE offer_ref = ? AND status IN ('submitted', 'under_review', 'offered')
  `).run(reason, by, offerRef);
  return r.changes === 1;
}

/**
 * The seller accepts our purchase offer. This is the contract moment, so it
 * is recorded with the version of the terms they saw — until now the terms
 * gate lived only in React state and left no evidence at all.
 */
export function markAccepted(db: Database.Database, offerRef: string, termsVersion: string): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'accepted', accepted_at = datetime('now'),
           terms_version = ?, updated_at = datetime('now')
     WHERE offer_ref = ? AND status = 'offered'
       AND (offer_expires_at IS NULL OR offer_expires_at > datetime('now'))
  `).run(termsVersion, offerRef);
  return r.changes === 1;
}

/** The transfer happened; the offer is now a sale. */
export function markSettled(db: Database.Database, offerRef: string, transactionId: number): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'settled', transaction_id = ?, updated_at = datetime('now')
     WHERE offer_ref = ? AND status = 'accepted'
  `).run(transactionId, offerRef);
  return r.changes === 1;
}

export function markWithdrawn(db: Database.Database, offerRef: string, userHexId: string): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'withdrawn', updated_at = datetime('now')
     WHERE offer_ref = ? AND user_hex_id = ? AND status IN ('submitted', 'under_review', 'offered')
  `).run(offerRef, userHexId);
  return r.changes === 1;
}

/** Lapse offers nobody accepted in time. Called by the heartbeat. */
export function expireStaleOffers(db: Database.Database): number {
  return db.prepare(`
    UPDATE acquisition_offers
       SET status = 'expired', updated_at = datetime('now')
     WHERE status = 'offered'
       AND offer_expires_at IS NOT NULL
       AND offer_expires_at <= datetime('now')
  `).run().changes;
}

export function listOffersForReview(db: Database.Database): OfferRow[] {
  return db.prepare(`
    SELECT * FROM acquisition_offers WHERE status = 'under_review' ORDER BY created_at ASC
  `).all() as OfferRow[];
}

export function listOffersForUser(db: Database.Database, userHexId: string, limit = 20): OfferRow[] {
  return db.prepare(`
    SELECT * FROM acquisition_offers WHERE user_hex_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userHexId, limit) as OfferRow[];
}

export interface TransferGate {
  ok: boolean;
  code?: 'NO_SUCH_OFFER' | 'NOT_YOURS' | 'NOT_ACCEPTED' | 'OFFER_EXPIRED' | 'ALREADY_SETTLED' | 'NO_PRICE';
  reason?: string;
  offer?: OfferRow;
}

/**
 * The only door to a transfer.
 *
 * Deliberately strict and deliberately dumb: it asks whether THIS seller has
 * an offer WE accepted, that has not lapsed, that carries a price, and that
 * has not already been used. Anything else is a no. Everything the caller
 * needs to price the sale comes back on `offer` — it must not go looking up a
 * fresh rate.
 */
export function assertTransferable(
  db: Database.Database,
  offerRef: string,
  userHexId: string,
  now?: string,
): TransferGate {
  const offer = getOfferByRef(db, offerRef);
  if (!offer) {
    return { ok: false, code: 'NO_SUCH_OFFER', reason: 'No such acquisition offer.' };
  }
  if (offer.user_hex_id.toLowerCase() !== userHexId.toLowerCase()) {
    // Same answer as a missing offer, so the reference cannot be probed.
    return { ok: false, code: 'NO_SUCH_OFFER', reason: 'No such acquisition offer.' };
  }
  if (offer.status === 'settled' || offer.transaction_id !== null) {
    return { ok: false, code: 'ALREADY_SETTLED', reason: 'This acquisition has already been completed.', offer };
  }
  if (offer.status === 'expired') {
    return { ok: false, code: 'OFFER_EXPIRED', reason: 'This purchase offer has lapsed. Please submit a new offer.', offer };
  }
  if (offer.status !== 'accepted') {
    return {
      ok: false, code: 'NOT_ACCEPTED',
      reason: 'This offer has not been accepted yet, so no LANA should be transferred.',
      offer,
    };
  }
  // An accepted offer whose window has since closed is still not a licence to
  // transfer: the price we agreed was priced for that window.
  const clock = now ?? (db.prepare(`SELECT datetime('now') AS t`).get() as any).t;
  if (offer.offer_expires_at && offer.offer_expires_at <= clock) {
    return { ok: false, code: 'OFFER_EXPIRED', reason: 'This purchase offer has lapsed. Please submit a new offer.', offer };
  }
  if (offer.purchase_price_fiat === null || !(offer.purchase_price_fiat > 0)) {
    return { ok: false, code: 'NO_PRICE', reason: 'This offer carries no purchase price.', offer };
  }
  return { ok: true, offer };
}
