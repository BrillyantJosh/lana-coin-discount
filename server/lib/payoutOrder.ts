/**
 * Payout-order enforcement (lana.discount) — pure logic, no I/O.
 *
 * Per currency, payouts must follow: financiers first — strictly by their FIFO
 * financing rank — then everyone else. Among non-financiers there is NO enforced
 * order (so one unpayable non-financier can't freeze the rest). This module is
 * pure so it can be unit-tested and reused by both the POST guard and the GET
 * annotation in server/routes/api.ts.
 *
 * The caller scopes everything to ONE currency: it builds the per-currency seller
 * list and passes the currency's financier ranks. Cross-currency independence is
 * therefore automatic — a GBP seller simply never appears in the EUR list.
 */

/** Priority sentinel for a seller who does not finance the currency in question. */
export const NON_FINANCIER = Number.POSITIVE_INFINITY;

/**
 * Priority band for a crowd-funding project owner (Tier 2): paid right after
 * financiers, ahead of everyone else. A finite value greater than any real
 * financier rank M but less than NON_FINANCIER (+Infinity). Flat: all
 * crowd-funders share this band, so they never block each other.
 */
export const CROWDFUND_TIER = 1_000_000;

export interface QueueSeller {
  hex: string;
  remaining: number; // outstanding fiat in THIS currency (completed/paid sales only)
  priority: number;  // financier: financeRank (1..M, sweeper last); crowd-funder: CROWDFUND_TIER; other: NON_FINANCIER
}

export interface BlockResult {
  blocked: boolean;
  blockedByHex: string | null; // the highest-priority still-outstanding seller ahead of target
}

/**
 * Priority for a seller, given the currency's financier rank map (hex → rank) and
 * the optional set of crowd-funding-eligible owners in this currency. Three tiers:
 *   1. financier  → its financing rank (1..M; is_last_budget sweeper ranked last)
 *   2. crowd-funder (not a financier, but has raised & unpaid donations this split)
 *      → CROWDFUND_TIER (flat)
 *   3. everyone else → NON_FINANCIER
 * Ranks come from Direct Fund's /api/admin/financing-order?currency=C; the crowd
 * set comes from lana.discount's local donation ledger (getCrowdfundBandSet).
 */
export function priorityFor(hex: string, rankByHex: Map<string, number>, crowdSet?: Set<string>): number {
  const r = rankByHex.get(hex);
  if (r != null) return r;
  if (crowdSet && crowdSet.has(hex)) return CROWDFUND_TIER;
  return NON_FINANCIER;
}

/**
 * Is a payout to `targetHex` blocked by a higher-priority, still-unpaid seller in
 * the SAME currency? `sellers` must already be scoped to one currency.
 *
 * Blocked iff some OTHER seller Q has remaining > 0 and priority(Q) < priority(target).
 * `blockedByHex` = that Q with the lowest priority (the current queue head).
 *
 * Consequences fall out of the priority numbers:
 *   - two non-financiers (both NON_FINANCIER) never block each other;
 *   - any outstanding financier blocks every non-financier;
 *   - financiers block each other strictly by ascending rank (sweeper last).
 * A seller with nothing outstanding is never blocked.
 */
export function computeBlocker(sellers: QueueSeller[], targetHex: string): BlockResult {
  const target = sellers.find(s => s.hex === targetHex);
  if (!target || target.remaining <= 0) return { blocked: false, blockedByHex: null };

  let head: QueueSeller | null = null;
  for (const s of sellers) {
    if (s.hex === targetHex) continue;
    if (s.remaining > 0 && s.priority < target.priority) {
      if (head === null || s.priority < head.priority) head = s;
    }
  }
  return head ? { blocked: true, blockedByHex: head.hex } : { blocked: false, blockedByHex: null };
}
