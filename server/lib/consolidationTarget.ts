/**
 * CONSOLIDATING ONLY AS MUCH AS A TRANSFER NEEDS — when an offer is open.
 *
 * MejmoSeFajn's planner (consolidationPlan.ts, copied unchanged) merges
 * everything it can afford, 20 pieces a batch. That is right for a wallet with
 * nothing promised out of it, and it was wrong here in one case the review of
 * 13 Sept 2026 proved with the repo's own functions: a seller whose accepted
 * offer covers the WHOLE wallet. One 20-piece merge costs 546,600 lanoshis; a
 * wallet may come up at most BACKING_TOLERANCE_LANOSHIS (500,000) short of what
 * it promised; so the seller pressed Consolidate exactly as the refusal told him
 * to, and the transfer was then refused for good.
 *
 * So while an offer from the wallet is open, the page plans the CHEAPEST set of
 * merges that brings the wallet down to what one transfer can carry — a
 * 21-piece wallet needs one 2-piece merge (60,600), not a 20-piece one — and
 * only offers it when its fees fit in the room the open offers leave. The server
 * checks the same room before it signs (consolidation.ts feeRoomLanoshis).
 *
 * Pure. Builds on the copied module's own primitives, so the fee, the input
 * limit and the "a batch must pay for itself" rule are the same numbers.
 */
import {
  composeBatch, consolidationFee, requiredFor, largestAffordableSize, DUST_DISPLAY, MAX_INPUTS, MIN_INPUTS,
  type ConsolidationPlan, type PlannedBatch, type PlanUtxo,
} from './consolidationPlan.js';

export interface TargetPlan extends ConsolidationPlan {
  /** Whether these merges bring the wallet to `maxPieces` or fewer once they confirm. */
  reachesTarget: boolean;
  /** Pieces the wallet will hold once these merges (and any already on their way) confirm. */
  piecesAfter: number;
}

const sumOf = (u: PlanUtxo[]) => u.reduce((s, x) => s + x.value, 0);

/**
 * The fewest inputs that take `piecesNow` down to `maxPieces`.
 *
 * `piecesNow` is what a transfer will see once merges already on their way have
 * confirmed — the caller passes it, because the pieces those merges spend are
 * not in `allUtxos`. A merge of n pieces removes n − 1, so the cheapest merge is
 * the smallest viable n ≥ (pieces to remove + 1); viability is not monotone in
 * n (see consolidationPlan.ts), so it is searched upward, and when no size up to
 * the largest affordable one qualifies, the largest affordable is used.
 */
export function buildTargetPlan(allUtxos: PlanUtxo[], piecesNow: number, maxPieces = MAX_INPUTS): TargetPlan {
  const spendable = allUtxos.filter(u => u.height === undefined || u.height > 0);
  let pool = [...spendable].sort((a, b) => b.value - a.value);
  let count = piecesNow;
  const batches: PlannedBatch[] = [];

  while (count > maxPieces) {
    const affordable = largestAffordableSize(pool);
    if (affordable === 0) break;
    const wanted = Math.max(MIN_INPUTS, count - maxPieces + 1);
    let n = affordable;
    const prefix: number[] = [0];
    for (let i = 0; i < Math.min(MAX_INPUTS, pool.length); i++) prefix.push(prefix[i] + pool[i].value);
    for (let size = Math.min(wanted, affordable); size <= affordable; size++) {
      if (prefix[size] >= requiredFor(size)) { n = size; break; }
    }
    const chosen = composeBatch(pool, n);
    const totalValue = sumOf(chosen);
    const fee = consolidationFee(chosen.length);
    batches.push({
      id: batches.length + 1, utxos: chosen, totalValue,
      dustCount: chosen.filter(u => u.value < DUST_DISPLAY).length,
      fee, net: totalValue - fee, removes: chosen.length - 1,
    });
    count -= chosen.length - 1;
    const spent = new Set(chosen.map(u => `${u.tx_hash}:${u.tx_pos}`));
    pool = pool.filter(u => !spent.has(`${u.tx_hash}:${u.tx_pos}`));
  }

  return {
    batches,
    leftovers: [...pool, ...allUtxos.filter(u => u.height !== undefined && u.height <= 0)].sort((a, b) => b.value - a.value),
    totalRemoved: batches.reduce((s, b) => s + b.removes, 0),
    totalFee: batches.reduce((s, b) => s + b.fee, 0),
    depositToUnstick: 0,
    reachesTarget: count <= maxPieces,
    piecesAfter: count,
  };
}

/**
 * HOW MUCH A SELLER WOULD HAVE TO ADD for the target plan to fit its room —
 * or null when adding LANA would not help (nothing can reach the target).
 *
 * A top-up arrives as one more piece, and that piece has to be carried too:
 * usually one more input (MARGINAL), but when the count crosses a 19-piece
 * batch boundary it needs a whole further consolidation. So the figure is
 * not guessed from a formula; the plan is rebuilt with the extra piece and the
 * enlarged room until it fits (review of the fixes, 13 Sept 2026: the formula
 * asked a 39-piece wallet for 0.0004 LANA, which then fell short again).
 *
 * `roomUnclamped` may be negative — offers already beyond what the wallet can
 * back — and the answer then includes that shortfall.
 */
export function topUpToFit(allUtxos: PlanUtxo[], piecesNow: number, roomUnclamped: number, maxPieces = MAX_INPUTS): number | null {
  const fitsWith = (topUp: number) => {
    const extra: PlanUtxo = { tx_hash: 'top-up'.padStart(64, '0'), tx_pos: 0, value: topUp, height: 1 };
    const plan = buildTargetPlan([...allUtxos, extra], piecesNow + 1, maxPieces);
    return { plan, fits: plan.reachesTarget && plan.totalFee <= roomUnclamped + topUp };
  };
  const base = buildTargetPlan(allUtxos, piecesNow, maxPieces);
  const largestFirst = allUtxos.filter(u => u.height === undefined || u.height > 0).map(u => u.value).sort((a, b) => b - a);
  let topUp = Math.max(1, base.totalFee - roomUnclamped + MARGINAL_INPUT);
  // Only ever raised, so the answer is the first amount that works from below.
  for (let i = 0; i < 12; i++) {
    const { plan, fits } = fitsWith(topUp);
    if (fits) return topUp;
    if (plan.reachesTarget) {
      topUp = Math.max(topUp + 1, plan.totalFee - roomUnclamped);
    } else {
      // Too small even to FUND the first consolidation — a wallet of dust. The
      // top-up has to pay for it together with the largest pieces beside it.
      const n = Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, piecesNow + 1 - maxPieces + 1));
      const beside = largestFirst.slice(0, n - 1).reduce((s, v) => s + v, 0);
      const funded = requiredFor(n) - beside;
      if (funded <= topUp) return null;   // raising it no further helps: the pieces are not there to merge
      topUp = funded;
    }
  }
  return null;
}

/** fee(n+1) − fee(n), from the copied module's own formula. */
const MARGINAL_INPUT = consolidationFee(2) - consolidationFee(1);
