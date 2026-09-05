/**
 * WHAT EACH FINANCING BUDGET PAID IN, from direct.lana.fund.
 *
 * The mandate events say how much LANA a budget received; they deliberately
 * never carry the fiat that bought it (BEF P18 data minimisation — the relay
 * copy holds no paid-in amounts). So the "they paid X, we pay out Y" line on
 * the operator's worklist has to come from direct.lana.fund itself, over the
 * private side, keyed by the fund_setting_id that is already on every wallet
 * tag of the mandate.
 *
 * Only the money fields are kept. investorName comes back in the same rows and
 * is dropped here on purpose: the page resolves display names from KIND 0, and
 * a name has no business travelling with a treasury figure.
 *
 * Read-only, with a short cache. direct.lana.fund is not changed by this.
 */
import { DIRECT_FUND_URL } from './directFund.js';

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface FundBudgetMoney {
  id: number;
  currency: string;
  /** Fiat actually paid in and deployed by this budget. */
  investedAmount: number;
  /** The budget's agreed size, whether or not it is fully deployed. */
  investmentAmount: number;
  round: number | null;
  targetSplit: number | null;
}

export interface BudgetMoneyIndex {
  byId: Map<number, FundBudgetMoney>;
  /** True when the figures come from the cache after a failed read. */
  stale: boolean;
  fetchedAt: number;
}

let cache: { at: number; byId: Map<number, FundBudgetMoney> } | null = null;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Budgets by fund_setting_id. Throws only when there is nothing to answer with
 * at all — a failed read with a warm cache returns the cache, marked stale, so
 * a blip on direct.lana.fund blanks a column instead of the whole page.
 */
export async function fetchBudgetMoney(maxAgeMs = CACHE_TTL_MS): Promise<BudgetMoneyIndex> {
  if (cache && Date.now() - cache.at < maxAgeMs) {
    return { byId: cache.byId, stale: false, fetchedAt: cache.at };
  }
  try {
    const res = await fetch(`${DIRECT_FUND_URL}/api/admin/budgets`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`budgets HTTP ${res.status}`);
    const data = await res.json() as any;
    const rows = Array.isArray(data?.budgets) ? data.budgets : null;
    if (!rows) throw new Error('budgets: response has no budgets array');
    const byId = new Map<number, FundBudgetMoney>();
    for (const b of rows) {
      const id = Number(b?.id);
      if (!Number.isInteger(id)) continue;
      byId.set(id, {
        id,
        currency: String(b?.investmentCurrency || '').toUpperCase(),
        investedAmount: num(b?.investedAmount),
        investmentAmount: num(b?.investmentAmount),
        round: Number.isInteger(Number(b?.round)) ? Number(b.round) : null,
        targetSplit: Number.isInteger(Number(b?.targetSplit)) ? Number(b.targetSplit) : null,
      });
    }
    cache = { at: Date.now(), byId };
    return { byId, stale: false, fetchedAt: cache.at };
  } catch (err: any) {
    console.warn('[lana-discount] direct.lana.fund budgets unavailable:', err?.message || err);
    if (cache) return { byId: cache.byId, stale: true, fetchedAt: cache.at };
    throw err;
  }
}

/** Tests only. */
export function resetBudgetMoneyCache(): void { cache = null; }
