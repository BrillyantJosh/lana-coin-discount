/**
 * HAS THIS FINANCER BEEN BOUGHT OUT YET?
 *
 * The mandates screen lists every financer of a Split, and on a busy round
 * that is dozens of rows in which the two that still owe somebody money look
 * exactly like the sixty that are finished. Owner, 11 Sept 2026: "želil bi si
 * da tukaj lahko izberem filter da mi pokaže seznam vseh, neplačane, plačane."
 *
 * WHAT COUNTS AS PAID, and why it is settled LANA rather than anything nearer:
 *
 *   expected  the LANA this budget received, and the ceiling of what the
 *             treasury may acquire from it
 *   proposed  the seller asked; we have not answered
 *   accepted  we agreed; the LANA has not arrived
 *   settled   the LANA arrived and the purchase completed
 *
 * Only the last one is money that moved. A mandate whose whole amount sits in
 * a live offer has `remaining` of zero and yet nothing has happened — the
 * seller may let it lapse and the cap comes straight back. Calling that "paid"
 * would hide exactly the rows an operator is looking for. So what is still
 * owed is measured from `settled`, and everything short of it — untouched,
 * proposed, accepted, half sold, or abandoned half way — is not paid.
 *
 * Note what this deliberately does NOT claim: that the fiat has reached the
 * person. A settled purchase means the LANA arrived and the treasury owes the
 * price; whether that price has been sent is the Payouts screen's question,
 * not this one. "Paid" here means the treasury has finished acquiring.
 */

/** A tenth of a lanoshi in LANA — below this, two figures are the same figure. */
const DUST = 1e-8;

export type SettlementFilter = 'all' | 'unpaid' | 'paid';

export interface SettlementShape {
  expectedLana: number;
  settledLana: number;
}

/**
 * What the treasury has still to acquire from this mandate, in LANA.
 *
 * Never negative: a re-allocation can shrink `expected` below what was already
 * bought, and a negative "still owed" is a number nobody can act on. That case
 * carries its own ACCEPTED_EXCEEDS_RECEIVED warning on the row; it must not
 * also quietly subtract from a total.
 */
export function owedLana(m: SettlementShape): number {
  const owed = (Number(m.expectedLana) || 0) - (Number(m.settledLana) || 0);
  return owed > DUST ? owed : 0;
}

/** Paid = the treasury has finished acquiring: nothing is left to settle. */
export function isPaid(m: SettlementShape): boolean {
  return owedLana(m) === 0;
}

export function matchesSettlement(m: SettlementShape, filter: SettlementFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'paid' ? isPaid(m) : !isPaid(m);
}

export interface SettlementCounts {
  all: number;
  unpaid: number;
  paid: number;
  /** LANA still to acquire across the unpaid rows — the size of what is left. */
  owedLana: number;
}

/**
 * The three counts, so each choice can say how many rows it holds before it is
 * chosen. A filter that has to be tried to find out it is empty is a filter
 * that gets tried once and then distrusted.
 */
export function settlementCounts(rows: SettlementShape[]): SettlementCounts {
  let paid = 0;
  let owed = 0;
  for (const m of rows) {
    const o = owedLana(m);
    if (o === 0) paid += 1;
    else owed += o;
  }
  return {
    all: rows.length,
    paid,
    unpaid: rows.length - paid,
    owedLana: Math.round(owed * 100_000_000) / 100_000_000,
  };
}
