/**
 * WHERE ONE MANDATE STANDS: untouched, part sold, or finished.
 *
 * Owner, 12 Sept 2026: "želil bi si da tukaj lahko izberem filter da mi pokaže
 * seznam vseh, neplačane, plačane" — and then, on seeing the result: "Primož
 * Medjo je že dobil izplačilo pa je še vedno na seznamu med neplačanimi."
 *
 * He was right that it read wrong, and the fix is not a new rule but a third
 * box. Two boxes put a financer who has had money and a financer who has had
 * none in the same one, and on a list of seventy-four rows that is the only
 * thing anybody wants to tell apart.
 *
 * ── The two rules the boxes are built on, both paid for by a mistake ──────
 *
 * 1. FINISHED IS MEASURED FROM SETTLED LANA, never from `remaining`.
 *    `remaining` reaches zero the moment a live offer reserves the last of a
 *    mandate, and an offer is a question the seller has not answered: the cap
 *    comes straight back if they let it lapse.
 *
 * 2. A REMAINDER TOO SMALL TO SELL IS NOT UNFINISHED BUSINESS. A transfer
 *    almost never lands on the exact lanoshi; fourteen of Split 8's mandates
 *    ended with between 0.0003 and 0.73 LANA left over, which the offer route
 *    refuses as below the minimum and the round steps over as a crumb. Whether
 *    a remainder can still be sold is decided with the same test the refusal
 *    uses, against the same live rate, and it is what separates "finished"
 *    from "part sold" — no second threshold, no share of the mandate, nothing
 *    to tune. Asked of Split 8 it puts exactly one row in the middle box:
 *    Primož Medjo, who sold 2,510 of 3,191.17 LANA and left 21% behind, which
 *    is the one the owner had in mind.
 *
 * PER MANDATE, never per person. Someone who sold the whole of round 1 while
 * round 2 has not opened yet is finished with round 1 and has not started
 * round 2 — aggregating the two says "part sold" about somebody who has done
 * everything that was open to them. Nine rows read that way before this was
 * counted the way the table is.
 */

export type SettlementCategory = 'none' | 'partly' | 'paid';

export const SETTLEMENT_CATEGORIES: readonly SettlementCategory[] = ['none', 'partly', 'paid'] as const;

export interface MandateSettlementInput {
  /** LANA the budget received — the ceiling of what may be acquired. */
  expectedLana: number;
  /** LANA in purchases that COMPLETED. Not reserved, not agreed: completed. */
  settledLana: number;
  /**
   * Could anybody still sell what is left? Decided by the caller with the live
   * rate and min_sell_<currency>, because that is where those live.
   */
  unsoldSellable: boolean;
}

export function categorise(m: MandateSettlementInput): SettlementCategory {
  if (!m.unsoldSellable) return 'paid';
  return m.settledLana > 0 ? 'partly' : 'none';
}

/**
 * Parse the `settlement` query parameter.
 *
 * A comma-separated list, because the owner asked to be able to choose more
 * than one box at a time. Absent, empty, or "all" means every category — and
 * so does a list naming all three, so the screen and the URL agree about what
 * "everything" looks like. "unpaid" is kept as the two boxes it used to mean,
 * so a link sent before there were three still opens what it promised.
 */
export function parseSettlementParam(raw: unknown): Set<SettlementCategory> {
  const every = new Set<SettlementCategory>(SETTLEMENT_CATEGORIES);
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === 'all') return every;

  const out = new Set<SettlementCategory>();
  for (const part of text.split(',').map(p => p.trim()).filter(Boolean)) {
    if (part === 'all') return every;
    if (part === 'unpaid') { out.add('none'); out.add('partly'); continue; }
    if (part === 'none' || part === 'partly' || part === 'paid') out.add(part);
    // Anything else is ignored rather than refused: a stale link should show
    // the list, not an error page.
  }
  // Nothing recognised at all is a filter nobody chose; show everything rather
  // than an empty table the operator would read as "there are none".
  return out.size ? out : every;
}

export interface SettlementCounts {
  all: number;
  none: number;
  partly: number;
  paid: number;
  /** LANA still to acquire across everything not finished. */
  owedLana: number;
}

export function settlementCounts(rows: MandateSettlementInput[]): SettlementCounts {
  const counts: SettlementCounts = { all: rows.length, none: 0, partly: 0, paid: 0, owedLana: 0 };
  for (const m of rows) {
    const c = categorise(m);
    counts[c] += 1;
    if (c !== 'paid') counts.owedLana += Math.max(0, m.expectedLana - m.settledLana);
  }
  counts.owedLana = Math.round(counts.owedLana * 100_000_000) / 100_000_000;
  return counts;
}
