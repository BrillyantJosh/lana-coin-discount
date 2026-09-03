/**
 * Which pending LANA orders go into the next auto-send broadcast.
 *
 * The rule is: a purchase's legs (investor, cashback, merchant, caretaker) go
 * out TOGETHER or not at all. Until 2026-09-03 the sender took the first 100
 * pending rows and only then grouped them by purchase, so the 100th row could
 * fall in the middle of a purchase — the investor leg went out in one
 * broadcast, the other three in the next. That is harmless on-chain but the
 * brain records one hash per purchase, and the auditor then looked for the
 * customer's cashback in a transaction it was never in.
 *
 * So the cap is applied to whole groups, in arrival order, and the caller
 * tells us whether its window of rows was cut short: the last group of a
 * truncated window may itself be incomplete (its remaining legs are just past
 * the window), and it waits for the next run rather than being sent in part.
 */

export interface PendingLanaRow {
  id: string;
  transaction_ref: string | null;
  lana_amount: number;
  /** Second-resolution timestamp from the DB; used to find the cut second of a truncated window. */
  created_at?: string | null;
}

export interface SelectionOptions {
  /** Most recipient outputs one broadcast may carry (the change output is extra). */
  maxOutputs: number;
  /** True when the caller's SELECT hit its row limit, so the tail may be cut. */
  windowTruncated: boolean;
}

export interface Selection<T> {
  /** Groups chosen for this broadcast, in arrival order. */
  groups: T[][];
  /** The same, flattened — what to sign and broadcast. */
  orders: T[];
  /** Purchases held back because they touch the cut second of a truncated window (comma-joined refs). */
  droppedTail: string | null;
  /** Purchases bigger than the cap that were not first in line; they go alone next time. */
  deferredOversized: string[];
}

export function groupByPurchase<T extends PendingLanaRow>(rows: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.transaction_ref || r.id;
    const g = map.get(key);
    if (g) g.push(r); else map.set(key, [r]);
  }
  return Array.from(map.values());
}

export function selectWholeGroups<T extends PendingLanaRow>(rows: T[], opts: SelectionOptions): Selection<T> {
  let groups = groupByPurchase(rows);
  let droppedTail: string | null = null;
  if (opts.windowTruncated && rows.length > 0) {
    // The window ended somewhere inside the last row's SECOND: created_at has
    // one-second resolution and legs of purchases created in the same second
    // interleave, so any purchase with a leg in that second may have more legs
    // just past the window. All of them wait; the ones before that second are
    // provably complete within the window.
    const cutSecond = rows[rows.length - 1].created_at ?? null;
    const inCut = (g: T[]) => cutSecond === null
      ? g === groups[groups.length - 1]
      : g.some(r => (r.created_at ?? null) === cutSecond);
    const held = groups.filter(inCut);
    groups = groups.filter(g => !inCut(g));
    droppedTail = held.map(g => g[0].transaction_ref || g[0].id).join(',') || null;
  }

  const chosen: T[][] = [];
  const deferredOversized: string[] = [];
  let outputs = 0;
  for (const g of groups) {
    if (g.length > opts.maxOutputs) {
      // Bigger than a whole broadcast. Never split it; send it on its own when
      // it is first in line, otherwise let the groups ahead of it go first.
      if (chosen.length === 0) { chosen.push(g); break; }
      deferredOversized.push(g[0].transaction_ref || g[0].id);
      continue;
    }
    if (outputs + g.length > opts.maxOutputs) break; // arrival order: nothing jumps the queue
    chosen.push(g);
    outputs += g.length;
  }
  return { groups: chosen, orders: chosen.flat(), droppedTail, deferredOversized };
}
