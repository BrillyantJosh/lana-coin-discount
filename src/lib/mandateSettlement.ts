/**
 * HAS THIS FINANCER BEEN BOUGHT OUT YET?
 *
 * The mandates screen lists every financer of a Split, and on a busy round
 * that is dozens of rows in which the two that still owe somebody money look
 * exactly like the sixty that are finished. Owner, 11 Sept 2026: "želil bi si
 * da tukaj lahko izberem filter da mi pokaže seznam vseh, neplačane, plačane."
 *
 * ── WHAT COUNTS AS PAID ───────────────────────────────────────────────────
 *
 * Two things have to be true, and the first one alone is a trap I shipped and
 * the owner caught within the hour.
 *
 * 1. It is measured from SETTLED LANA — purchases that completed — and not
 *    from `remaining`. `remaining` reaches zero the moment a live offer
 *    reserves the last of a mandate, but an offer is a question the seller has
 *    not answered and the cap comes straight back if they let it lapse.
 *    Filing that under "paid" would hide exactly the rows this filter exists
 *    to find.
 *
 * 2. A REMAINDER TOO SMALL TO SELL IS NOT A DEBT. A mandate almost never
 *    settles to the exact lanoshi. Boštjan Zajc's round-1 mandate was for
 *    32,535.08 LANA and 32,535.06 arrived — the proposal was a figure rounded
 *    down from the mandate, and 0.02 LANA stayed behind. He had been bought
 *    out and paid, and subtraction alone put him in the unpaid list beside
 *    people who have not sold anything at all.
 *
 *    That 0.02 cannot be proposed: the offer route refuses anything under
 *    min_sell_<currency> and the round steps over it as a crumb. So it is not
 *    owed and it is not coming. Whether a remainder is still sellable is
 *    decided ON THE SERVER, with the same test the refusal uses and against
 *    the same live rate, and arrives here as `unsoldSellable`. This module
 *    does not second-guess it: a browser has neither the rate nor the
 *    per-currency minimum, and a second opinion built out of neither is how
 *    the screen and the gate come to disagree about the same LANA.
 *
 * And what "paid" does NOT claim, said on the screen as well as here: that the
 * money reached the person. A settled purchase means the LANA arrived and the
 * treasury owes the price; whether that price has been sent is the Payouts
 * screen's question.
 */

export type SettlementFilter = 'all' | 'unpaid' | 'paid';

export interface SettlementShape {
  /** Received minus settled, in LANA. Never negative; the server floors it. */
  unsoldLana: number;
  /** Could anybody still sell what is left? The server's answer, not ours. */
  unsoldSellable: boolean;
}

/** What the treasury has still to acquire — nothing, once it is unsellable. */
export function owedLana(m: SettlementShape): number {
  if (!m.unsoldSellable) return 0;
  const owed = Number(m.unsoldLana) || 0;
  return owed > 0 ? owed : 0;
}

/** Paid = nothing is left that anybody could still sell us. */
export function isPaid(m: SettlementShape): boolean {
  return !m.unsoldSellable;
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
    if (isPaid(m)) paid += 1;
    else owed += owedLana(m);
  }
  return {
    all: rows.length,
    paid,
    unpaid: rows.length - paid,
    owedLana: Math.round(owed * 100_000_000) / 100_000_000,
  };
}
