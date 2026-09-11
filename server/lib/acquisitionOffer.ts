/**
 * The life of one acquisition offer.
 *
 * submitted ─┬─ accept (within mandate) ─▶ offered ─┬─ seller accepts ─▶ accepted ─┬─ transfer ─▶ settled
 *            │                                      │                             ├─ no transfer in 24 h ─▶ expired
 *            │                                      │                             └─ admin voids ─────────▶ withdrawn
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

/**
 * How long a purchase offer the machine made stands before it lapses.
 *
 * Thirty minutes because the seller is on the page when it is made: they asked,
 * we priced it at the live reference, and they answer. A window this short is
 * what lets the price be a real price rather than an option written against a
 * moving market.
 */
export const OFFER_VALIDITY_MINUTES = 30;

/**
 * How long a purchase offer a PERSON made stands before it lapses.
 *
 * A proposal parked for review is not answered while the seller waits — the
 * treasury may take hours or days over it, and by the time an offer comes back
 * the seller has long since closed the tab. Thirty minutes would then be an
 * offer nobody could ever accept; the seller would find it already expired,
 * every time. Eight days is the owner's decision (9 Sep 2026), and it is a
 * price the treasury can stand behind because the reference only moves at a
 * Split: within one Split it does not move at all, and when it does, the
 * REFERENCE_MOVED guard on acceptance lapses the offer rather than honouring a
 * stale price.
 */
export const MANUAL_OFFER_VALIDITY_DAYS = 8;

/**
 * How long an ACCEPTED offer may sit without its transfer before it lapses.
 *
 * An accepted offer reserves its amount on the mandate (consumedByMandate
 * counts 'accepted'), and nothing else ever moves it on: the seller may
 * close the tab, lose the key, or simply never sign. Without a horizon such
 * a row would hold the financer's remaining cap forever. 24 hours is far
 * beyond the 30-minute window in which assertTransferable still lets the
 * transfer happen, so nothing that could still settle is ever lapsed.
 */
export const ACCEPTED_TRANSFER_WINDOW_HOURS = 24;
/** decision_reason written by the sweeper on such a lapse. */
export const TRANSFER_NOT_COMPLETED = 'TRANSFER_NOT_COMPLETED';

/**
 * WHETHER `decision_reason` DESCRIBES THE ROW IT IS SITTING ON.
 *
 * The column is written at some transitions and not at others. It is written
 * at SUBMISSION (the review verdict from treasuryMandate/roundMandate) and at
 * SOME endings — markDeclined, markExpiredWithReason, the sweeper's
 * TRANSFER_NOT_COMPLETED, markVoidedByAdmin. It is written at NO other
 * transition: markOffered, markAccepted, markSettled, markWithdrawn and the
 * sweeper's unaccepted lapse all leave whatever the last writer left.
 *
 * So the status is not the question. A live purchase offer saying "This
 * proposal is under treasury review." and a proposal its own seller withdrew
 * saying the same thing under a badge reading "Closed" are the same bug: a
 * verdict about a state the row has already left, still being presented as a
 * description of the state it is in now. Asking "which status is it?" cannot
 * separate those from a `withdrawn` row carrying an admin's real void reason,
 * because both are TEXT in one column.
 *
 * The honest question is "did anything write this reason AT the transition
 * into the status the row is in now?", and since 10 Sep 2026 the writers
 * answer it: `decision_reason_status` records what the reason was written
 * about. The seller sees the sentence only while that answer still matches.
 *
 * It is a projection, never an UPDATE: `decision_reason` is audit data, and
 * why a proposal went to manual review in the first place must survive both
 * being priced and being withdrawn. `offerView` reads this before shipping the
 * field to a seller; the admin mandate view (routes/treasury.ts) reads the raw
 * column and keeps the whole trail.
 *
 * A row written before the marker existed has none, and cannot prove anything.
 * For those the fallback is the set of statuses where EVERY writer has always
 * written at the transition — a proposal still being decided, and a decline.
 * On an unmarked `expired` or `withdrawn` row the sentence is withheld: those
 * are exactly the two endings whose writers disagree, and an unproven verdict
 * is not shown to the person it is about.
 */
const REASON_PROVEN_WITHOUT_MARKER: readonly OfferStatus[] = [
  'submitted', 'under_review', 'declined',
];

export function reasonDescribesStatus(
  o: Pick<OfferRow, 'status'> & { decision_reason_status?: string | null },
): boolean {
  const marker = o.decision_reason_status ?? null;
  if (marker !== null) return marker === o.status;
  return (REASON_PROVEN_WITHOUT_MARKER as readonly string[]).includes(o.status);
}

/**
 * What a seller is shown in place of `decision_reason` — the sentence, or
 * nothing at all. The column itself is never changed by this.
 */
export function sellerDecisionReason(
  o: Pick<OfferRow, 'status' | 'decision_reason'> & { decision_reason_status?: string | null },
): string | null {
  return reasonDescribesStatus(o) ? o.decision_reason : null;
}

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
  /** The status `decision_reason` was written to describe; null on old rows. */
  decision_reason_status: string | null;
  accepted_at: string | null;
  terms_version: string | null;
  transaction_id: number | null;
  /** Financing-round mandate this offer drew on (KIND 30960 d tag); null on the legacy path. */
  mandate_ref: string | null;
  round: number | null;
  /** The seller's ORIGINAL ask when we countered with the remaining mandate. */
  proposed_lana_lanoshis: number | null;
  reference_basis: string | null;
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
  /** Round-mandate fields; all optional so the legacy path is unchanged. */
  mandateRef?: string | null;
  round?: number | null;
  proposedLanaLanoshis?: number | null;
  referenceBasis?: string | null;
}

export function insertOffer(db: Database.Database, o: NewOffer): OfferRow {
  db.prepare(`
    INSERT INTO acquisition_offers (
      offer_ref, user_hex_id, sender_wallet_id, wallet_class,
      lana_amount_lanoshis, lana_amount_display, currency, status,
      reference_rate, discount_percent, purchase_price_fiat, gross_fiat,
      mandate_code, eligibility_json, settlement_due_at, offer_expires_at,
      decision_reason, decision_reason_status,
      mandate_ref, round, proposed_lana_lanoshis, reference_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.offerRef, o.userHexId, o.senderWalletId, o.walletClass,
    o.lanaAmountLanoshis, o.lanaAmountDisplay, o.currency, o.status,
    o.referenceRate, o.discountPercent, o.purchasePriceFiat, o.grossFiat,
    o.mandateCode, o.eligibility === null || o.eligibility === undefined ? null : JSON.stringify(o.eligibility),
    o.settlementDueAt, o.offerExpiresAt, o.decisionReason,
    // A verdict written here is written ABOUT the status it is inserted with.
    o.decisionReason === null || o.decisionReason === undefined ? null : o.status,
    o.mandateRef ?? null, o.round ?? null, o.proposedLanaLanoshis ?? null, o.referenceBasis ?? null,
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
       SET status = 'declined', decision_reason = ?, decision_reason_status = 'declined',
           decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now')
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

/**
 * Lapse ONE offer for a stated reason — used when the reference price moved
 * between the offer and the seller's acceptance (REFERENCE_MOVED). The reason
 * lands in decision_reason so the audit trail says why a live offer died
 * before its 30 minutes were up.
 */
export function markExpiredWithReason(db: Database.Database, offerRef: string, reason: string): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'expired', decision_reason = ?, decision_reason_status = 'expired',
           updated_at = datetime('now')
     WHERE offer_ref = ? AND status = 'offered'
  `).run(reason, offerRef);
  return r.changes === 1;
}

/**
 * How much of each mandate is spoken for — THE one definition of "consumed"
 * (plan: "ena definicija"). Counts what we owe or will owe:
 *
 *   accepted, settled            the purchase happened or is contracted
 *   offered AND not yet lapsed   a live purchase offer reserves its amount,
 *                                otherwise two proposals inside the same 30
 *                                minutes could both be offered the last of it
 *
 * expired / declined / withdrawn / under_review reserve nothing. Called
 * inside the same transaction as the insert that depends on it.
 */
export function consumedByMandate(db: Database.Database, dTags: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!dTags || dTags.length === 0) return out;
  const placeholders = dTags.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT mandate_ref, COALESCE(SUM(lana_amount_lanoshis), 0) AS consumed
      FROM acquisition_offers
     WHERE mandate_ref IN (${placeholders})
       AND (
         status IN ('accepted', 'settled')
         OR (status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at > datetime('now'))
       )
     GROUP BY mandate_ref
  `).all(...dTags) as any[];
  for (const r of rows) out.set(r.mandate_ref, Number(r.consumed) || 0);
  return out;
}

/**
 * The offer rows the funding view needs: one line per offer, with its currency,
 * so money can be totalled per round AND per currency. `live` marks an
 * 'offered' row that has not lapsed — reserved against the mandate, exactly as
 * consumedByMandate counts it.
 */
export function offerRowsForFunding(db: Database.Database, dTags: string[]): Array<{
  mandateRef: string; currency: string; status: string; lanoshis: number; purchasePriceFiat: number | null; live: boolean;
}> {
  if (!dTags || dTags.length === 0) return [];
  const placeholders = dTags.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT mandate_ref, currency, status, lana_amount_lanoshis, purchase_price_fiat,
           CASE WHEN offer_expires_at IS NOT NULL AND offer_expires_at > datetime('now') THEN 1 ELSE 0 END AS live
      FROM acquisition_offers
     WHERE mandate_ref IN (${placeholders})
  `).all(...dTags) as any[];
  return rows.map(r => ({
    mandateRef: r.mandate_ref,
    currency: String(r.currency || '').toUpperCase(),
    status: r.status,
    lanoshis: Number(r.lana_amount_lanoshis) || 0,
    purchasePriceFiat: r.purchase_price_fiat === null || r.purchase_price_fiat === undefined ? null : Number(r.purchase_price_fiat),
    live: r.live === 1,
  }));
}

export interface MandateOfferTotals {
  /** Live purchase offers (offered, not lapsed) — reserved, not yet ours. */
  proposed: number;
  accepted: number;
  settled: number;
}

/**
 * The same rows consumedByMandate sums, split by status for a screen. Kept
 * beside it so the tiles an admin reads add up to the figure the gate uses.
 */
export function offerTotalsByMandate(db: Database.Database, dTags: string[]): Map<string, MandateOfferTotals> {
  const out = new Map<string, MandateOfferTotals>();
  if (!dTags || dTags.length === 0) return out;
  const placeholders = dTags.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT mandate_ref,
           COALESCE(SUM(CASE WHEN status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at > datetime('now') THEN lana_amount_lanoshis ELSE 0 END), 0) AS proposed,
           COALESCE(SUM(CASE WHEN status = 'accepted' THEN lana_amount_lanoshis ELSE 0 END), 0) AS accepted,
           COALESCE(SUM(CASE WHEN status = 'settled' THEN lana_amount_lanoshis ELSE 0 END), 0) AS settled
      FROM acquisition_offers
     WHERE mandate_ref IN (${placeholders})
     GROUP BY mandate_ref
  `).all(...dTags) as any[];
  for (const r of rows) {
    out.set(r.mandate_ref, { proposed: Number(r.proposed) || 0, accepted: Number(r.accepted) || 0, settled: Number(r.settled) || 0 });
  }
  return out;
}

/**
 * The sweeper, called by the heartbeat. Two kinds of stale row:
 *
 *   offered   nobody accepted inside OFFER_VALIDITY_MINUTES → expired
 *   accepted  MANDATE-BOUND (mandate_ref IS NOT NULL), but no transfer for
 *             ACCEPTED_TRANSFER_WINDOW_HOURS → expired with decision_reason
 *             TRANSFER_NOT_COMPLETED, so the mandate it reserved is free
 *             again (consumedByMandate ignores 'expired'). `transaction_id
 *             IS NULL` is the guard: a row whose transfer DID happen is
 *             never touched here, whatever its clock.
 *
 * The second sweep exists only to free a financer's cap, which a legacy
 * offer (no mandate_ref) never held — so legacy rows are left exactly as the
 * sweeper left them before rounds existed. An admin can still void any
 * accepted-but-untransferred row, legacy or not (markVoidedByAdmin).
 */
export function expireStaleOffers(db: Database.Database): number {
  const unaccepted = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'expired', updated_at = datetime('now')
     WHERE status = 'offered'
       AND offer_expires_at IS NOT NULL
       AND offer_expires_at <= datetime('now')
  `).run().changes;
  // EVERY accepted offer, not only the ones that came from a round mandate.
  // The window is the same for both and always was — the mandate gate here was
  // why an accepted offer with no mandate was swept by nothing at all and sat
  // at the top of a dashboard for months.
  const untransferred = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'expired', decision_reason = ?, decision_reason_status = 'expired',
           updated_at = datetime('now')
     WHERE status = 'accepted'
       AND transaction_id IS NULL
       AND accepted_at IS NOT NULL
       AND accepted_at <= datetime('now', ?)
  `).run(TRANSFER_NOT_COMPLETED, `-${ACCEPTED_TRANSFER_WINDOW_HOURS} hours`).changes;

  /**
   * An accepted row with no acceptance timestamp cannot be counted from, and
   * an old one may have none. Its offer window is the only clock it has.
   */
  const undatedAccepted = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'expired', decision_reason = ?, decision_reason_status = 'expired',
           updated_at = datetime('now')
     WHERE status = 'accepted'
       AND transaction_id IS NULL
       AND accepted_at IS NULL
       AND offer_expires_at IS NOT NULL
       AND offer_expires_at <= datetime('now')
  `).run(TRANSFER_NOT_COMPLETED).changes;

  return unaccepted + untransferred + undatedAccepted;
}

/** `YYYY-MM-DD HH:MM:SS` UTC plus N hours, in the shape SQLite writes. */
function sqlitePlusHours(ts: string, hours: number): string | null {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(utc);
  if (isNaN(d.getTime())) return null;
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function asUtcMs(ts: string): number {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  return new Date(utc).getTime();
}

/**
 * When the thing the SELLER must do next has to be done by, or null when
 * nothing is waiting on them.
 *
 * Two different horizons, and only the server knows both:
 *
 *   offered    accept before `offer_expires_at`, which is also the wall
 *              assertTransferable refuses at.
 *   accepted   transfer before the EARLIER of that same window and the
 *              24-hour sweep — because expireStaleOffers voids a
 *              mandate-bound accepted row at accepted_at + 24 h to give the
 *              financer's cap back. On an 8-day manual offer accepted on day
 *              one, counting down to offer_expires_at would print six days
 *              left on a row this server kills in four hours. Legacy rows
 *              (no mandate_ref) are never swept, so for them the offer window
 *              is the whole story.
 *
 * It is computed here rather than in a browser so that no page has to hold an
 * opinion about which sweep applies to which row.
 */
export function sellerActionDeadline(o: OfferRow): string | null {
  // TWO WINDOWS, AND THEY ARE NOT THE SAME WINDOW.
  //
  // `offer_expires_at` is how long the OFFER stands — the time to say yes.
  // Once it is said, what is left to do is the transfer, and that has its own
  // clock: ACCEPTED_TRANSFER_WINDOW_HOURS from the moment of acceptance.
  //
  // Until 11 Sept 2026 this returned the EARLIER of the two, and for an
  // automatic offer the earlier one is always the offer's own thirty minutes.
  // So a seller who accepted a minute after we priced it had twenty-nine
  // minutes to find a WIF private key, paste it and sign — and then
  // assertTransferable refused on the same timestamp. Three people were
  // stopped by it in one morning; the admin page showed a wall of "window
  // closed" thirty minutes after each acceptance.
  //
  // The constant beside it has always said what it meant — "how long an
  // ACCEPTED offer may sit without its transfer" — and so has the screen the
  // seller reads, which is headed "Time left to transfer". The code was the
  // only part that disagreed.
  if (o.status === 'offered') return o.offer_expires_at;
  if (o.status !== 'accepted') return null;
  if (o.accepted_at) {
    const byTransfer = sqlitePlusHours(o.accepted_at, ACCEPTED_TRANSFER_WINDOW_HOURS);
    if (byTransfer && !isNaN(asUtcMs(byTransfer))) return byTransfer;
  }
  // No acceptance timestamp to count from — an old row. The offer's own window
  // is the only thing there is, and saying nothing would be worse.
  return o.offer_expires_at && !isNaN(asUtcMs(o.offer_expires_at)) ? o.offer_expires_at : null;
}

/**
 * An admin voids an accepted offer whose transfer never came — before the
 * 24-hour sweep would, e.g. when the seller says so. Same guard as the
 * sweeper: only `accepted` AND `transaction_id IS NULL`; a transferred offer
 * cannot be voided by anyone. Lands as 'withdrawn' with the admin's name and
 * reason, so the audit trail says who freed the mandate and why.
 */
export function markVoidedByAdmin(db: Database.Database, offerRef: string, reason: string, by: string): boolean {
  const r = db.prepare(`
    UPDATE acquisition_offers
       SET status = 'withdrawn', decision_reason = ?, decision_reason_status = 'withdrawn',
           decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now')
     WHERE offer_ref = ? AND status = 'accepted' AND transaction_id IS NULL
  `).run(reason, by, offerRef);
  return r.changes === 1;
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
  //
  // WHICH window is the whole of the 11 Sept 2026 incident. This asked
  // `offer_expires_at` — the time to say YES — of a row that had already said
  // it, so an automatic offer left the seller the remainder of thirty minutes
  // to sign a transfer. It asks the deadline the seller is actually shown now,
  // which for an accepted row is ACCEPTED_TRANSFER_WINDOW_HOURS from
  // acceptance. One definition, one clock, on screen and at the door.
  const clock = now ?? (db.prepare(`SELECT datetime('now') AS t`).get() as any).t;
  const deadline = sellerActionDeadline(offer);
  if (deadline && deadline <= clock) {
    return { ok: false, code: 'OFFER_EXPIRED', reason: 'This purchase offer has lapsed. Please submit a new offer.', offer };
  }
  if (offer.purchase_price_fiat === null || !(offer.purchase_price_fiat > 0)) {
    return { ok: false, code: 'NO_PRICE', reason: 'This offer carries no purchase price.', offer };
  }
  return { ok: true, offer };
}
