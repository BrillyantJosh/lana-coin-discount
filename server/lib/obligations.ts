/**
 * THE PUBLIC SETTLEMENT ORDER — by financing round.
 *
 * Every purchase price we have agreed and not yet paid, per currency, in the
 * order we settle them. The owner's instruction (4 Sep 2026) is that there is
 * exactly ONE order now: financing round 1, then round 2, then round 3 — each
 * opened on its published date — and acquisitions outside any round after
 * them. Inside a round (and among the round-less), the earliest acquisition
 * comes first. Nothing else ranks a counterparty: no Direct Fund rank, no
 * crowd-funding band, no "payable / waiting" verdict. The date on each offer
 * is the promise; this list is the order.
 *
 * Pure by design — no database, no clock, no network — so the ordering can be
 * proven in a unit test and reused by the public board and the admin screen.
 *
 * One line per counterparty per currency, because the public board names a
 * person and what we owe them, not our individual purchases. A counterparty
 * with acquisitions in more than one round is listed under the earliest of
 * them: that is when we start settling them.
 */
import type { FreezeSummary } from './frozenDirectory.js';

export interface ObligationSale {
  status: string;
  currency: string;
  /** Purchase price still owed, in the sale's currency. */
  remaining?: number | null;
  createdAt?: string | null;
  /** Financing round of the offer this sale came from; null outside a round. */
  round?: number | null;
  /** Split the mandate was published for; null outside a round. */
  mandateSplit?: number | null;
}

export interface ObligationUser {
  hexId: string;
  displayName?: string | null;
  sales?: ObligationSale[] | null;
}

export interface SettlementLine {
  position: number;
  name: string;
  hex_short: string;
  frozen: boolean | null;
  freeze_level: FreezeSummary['level'] | null;
  frozen_wallets: number | null;
  total_wallets: number | null;
  freeze_reasons: string[];
  /** 1 | 2 | 3, or null for an acquisition outside a financing round. */
  round: number | null;
  mandate_split: number | null;
  outstanding: number;
}

export interface CurrencyObligations {
  total_outstanding: number;
  count: number;
  settlements: SettlementLine[];
  /** @deprecated Alias of `settlements`, kept for one more release. */
  queue: SettlementLine[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Round 1 before 2 before 3; no round last. */
export function roundRank(round: number | null | undefined): number {
  return round === null || round === undefined ? Number.POSITIVE_INFINITY : round;
}

/**
 * The order two lines settle in: lower round first, null round last, then
 * the earlier acquisition. Exported so the admin screen sorts the same way.
 */
export function compareSettlementOrder(
  a: { round: number | null; earliestAt: string },
  b: { round: number | null; earliestAt: string },
): number {
  const ra = roundRank(a.round), rb = roundRank(b.round);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.earliestAt < b.earliestAt ? -1 : a.earliestAt > b.earliestAt ? 1 : 0;
}

export function groupObligations(
  users: ObligationUser[],
  freezeOf: (hexId: string) => FreezeSummary | null,
): { currencies: Record<string, CurrencyObligations>; total_currencies: number } {
  interface Agg { outstanding: number; earliestAt: string; round: number | null; mandateSplit: number | null }
  const nameOf = new Map<string, string>();
  const perCur = new Map<string, Map<string, Agg>>();

  for (const u of users) {
    nameOf.set(u.hexId, u.displayName || 'Anonymous');
    for (const sale of u.sales || []) {
      if (sale.status !== 'completed' && sale.status !== 'paid') continue;
      const rem = sale.remaining || 0;
      if (rem <= 0) continue;
      if (!perCur.has(sale.currency)) perCur.set(sale.currency, new Map());
      const m = perCur.get(sale.currency)!;
      const createdAt = sale.createdAt || '';
      const e = m.get(u.hexId) || { outstanding: 0, earliestAt: createdAt, round: null, mandateSplit: null };
      e.outstanding += rem;
      if (createdAt && (!e.earliestAt || createdAt < e.earliestAt)) e.earliestAt = createdAt;
      // The earliest round this counterparty is settled in.
      const round = sale.round ?? null;
      if (round !== null && roundRank(round) < roundRank(e.round)) {
        e.round = round;
        e.mandateSplit = sale.mandateSplit ?? null;
      }
      m.set(u.hexId, e);
    }
  }

  const currencies: Record<string, CurrencyObligations> = {};
  for (const [currency, hexMap] of perCur) {
    const ordered = [...hexMap.entries()]
      .map(([hex, v]) => ({ hex, ...v }))
      .sort(compareSettlementOrder);
    const settlements: SettlementLine[] = ordered.map((e, i) => {
      // Freeze status is already public (KIND 30889); surfaced so a reader can
      // see that someone on the list cannot be settled the usual way.
      // null = not resolved yet, which is NOT "clean".
      const fz = freezeOf(e.hex);
      return {
        position: i + 1,
        name: nameOf.get(e.hex) || 'Anonymous',
        hex_short: e.hex.slice(0, 8),
        frozen: fz ? fz.frozen : null,
        freeze_level: fz?.level ?? null,
        frozen_wallets: fz?.frozenWallets ?? null,
        total_wallets: fz?.totalWallets ?? null,
        freeze_reasons: fz?.reasons ?? [],
        round: e.round,
        mandate_split: e.mandateSplit,
        outstanding: r2(e.outstanding),
      };
    });
    currencies[currency] = {
      total_outstanding: r2(ordered.reduce((s, v) => s + v.outstanding, 0)),
      count: settlements.length,
      settlements,
      // DEPRECATED alias, kept for one more release so anything already
      // reading this public feed does not break. New readers use `settlements`.
      queue: settlements,
    };
  }
  return { currencies, total_currencies: Object.keys(currencies).length };
}
