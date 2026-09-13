/**
 * UTXO consolidation planning — the shared, pure rules.
 *
 * COPIED FROM MejmoSeFajn (mejmosefajnver3/src/lib/consolidationPlan.ts, as of
 * commit 1a0c7e7), where the Consolidate page has been used on real wallets
 * since August 2026. The owner, 13 Sept 2026: "V kolikor rabi uporabnik prvo
 * konsolidirat račun, naredi možnost konsolidacije kar na Lana.discount …
 * skopiraj rešitev iz MejmoSeFajn". The planning rules below are that
 * solution unchanged; only this paragraph and the location are new.
 *
 * It lives under server/ rather than src/ because the production image ships
 * server/ and the built page only (see Dockerfile) — the page imports it from
 * here, the way MandatePanel already imports server/lib. Both sides therefore
 * read one copy and can never disagree about what is spendable. No imports,
 * no browser or node APIs.
 *
 * Two numbers here restate what server/lib/transaction.ts already says, and
 * consolidationPlan.test.ts pins them to it: consolidationFee(n) is
 * estimateFeeLanoshis(n, 1), and MAX_INPUTS is MAX_TRANSACTION_INPUTS.
 *
 * A consolidation spends n inputs of one address into ONE output back to the
 * same address, so it removes exactly (n − 1) UTXOs and costs fee(n).
 *
 * Two facts drive everything here:
 *
 *  1. Each extra input costs MARGINAL (27,000) in fee. Dust is worth far less
 *     than that, so a batch is paid for by its largest UTXOs, not its count.
 *
 *  2. Viability is NOT monotone in n. Adding an input raises the requirement by
 *     27,000 while adding only its own value, but a bigger n can still succeed
 *     where a smaller one failed — five UTXOs of 28,750 fail at n = 2, 3 and 4
 *     and succeed at n = 5. So the size must be found by scanning DOWNWARD from
 *     the largest affordable size; a "grow while it still fits" loop silently
 *     reports such a wallet as impossible.
 */
export const MAX_INPUTS = 20;
/** A 1-input consolidation removes zero UTXOs while paying a full fee. */
export const MIN_INPUTS = 2;
/** Mirrors the server's MIN_CONSOLIDATE_OUTPUT: below this the output is dust. */
export const MIN_NET = 1000;
/** Display-only classification, never used to decide anything. */
export const DUST_DISPLAY = 10000;
/** fee(n+1) − fee(n): what one more input really costs. */
export const MARGINAL = 27000;

/**
 * floor((n*180 + 34 + 10) * 100 * 1.5) — exact integer arithmetic, so the page
 * and the server always compute the same number to the lanoshi.
 */
export const consolidationFee = (inputs: number): number => 27000 * inputs + 6600;

/** The value a batch of n inputs must reach to leave a spendable output. */
export const requiredFor = (inputs: number): number => consolidationFee(inputs) + MIN_NET;

export interface PlanUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height?: number;
  value_lana?: string;
}

export interface PlannedBatch {
  id: number;
  utxos: PlanUtxo[];
  totalValue: number;
  dustCount: number;
  fee: number;
  /** What lands back in the wallet. Always ≥ MIN_NET by construction. */
  net: number;
  /** UTXOs this batch removes: n − 1. */
  removes: number;
}

export interface ConsolidationPlan {
  batches: PlannedBatch[];
  /** UTXOs no batch can pay for. Never hidden — shown as unmovable, not as a button. */
  leftovers: PlanUtxo[];
  /** How many UTXOs the whole plan removes. */
  totalRemoved: number;
  /** Combined fee of every batch in the plan. */
  totalFee: number;
  /**
   * An incoming payment of at least this much would make the leftovers movable.
   * 0 when nothing is stranded or the figure would be meaningless.
   */
  depositToUnstick: number;
}

const sumOf = (u: PlanUtxo[]): number => u.reduce((s, x) => s + x.value, 0);

/**
 * The largest batch size this pool can actually pay for, or 0 if none can.
 *
 * The n largest UTXOs maximise the sum attainable at size n, so "a viable batch
 * of size n exists" is exactly "sum of the n largest ≥ requiredFor(n)" — an
 * equivalence, not a heuristic. Scanned downward because of fact 2 above.
 */
export function largestAffordableSize(sortedDesc: PlanUtxo[]): number {
  if (sortedDesc.length < MIN_INPUTS) return 0;
  const upper = Math.min(MAX_INPUTS, sortedDesc.length);
  let prefix = 0;
  const prefixes: number[] = [0];
  for (let i = 0; i < upper; i++) {
    prefix += sortedDesc[i].value;
    prefixes.push(prefix);
  }
  for (let n = upper; n >= MIN_INPUTS; n--) {
    if (prefixes[n] >= requiredFor(n)) return n;
  }
  return 0;
}

/**
 * Choose WHICH n UTXOs to spend: the fewest large ones that cover the fee, plus
 * as much dust as the size allows. The fee depends only on n and never on which
 * UTXOs are picked, so paying with the fewest funders is free — it clears the
 * most dust and leaves the other funders available to seed a further batch.
 */
export function composeBatch(sortedDesc: PlanUtxo[], n: number): PlanUtxo[] {
  const m = sortedDesc.length;
  const target = requiredFor(n);
  for (let k = 1; k <= n; k++) {
    const head = sortedDesc.slice(0, k);
    const tail = n - k > 0 ? sortedDesc.slice(m - (n - k)) : [];
    if (sumOf(head) + sumOf(tail) >= target) return [...head, ...tail];
  }
  // largestAffordableSize guarantees k = n satisfies the target, so this is
  // unreachable; returning the n largest keeps the caller safe regardless.
  return sortedDesc.slice(0, n);
}

/**
 * What an incoming payment would have to be, as a single new UTXO, to let the
 * stranded UTXOs move. Returns 0 when they are not stranded or when no sensible
 * figure exists.
 */
function depositNeededFor(leftovers: PlanUtxo[]): number {
  if (leftovers.length < 1) return 0;
  // The cheapest escape is a 2-input batch pairing the deposit with the largest
  // leftover: deposit + largest ≥ requiredFor(2).
  const largest = leftovers[0]?.value ?? 0;
  const shortfall = requiredFor(2) - largest;
  return shortfall > 0 ? shortfall : 0;
}

/**
 * Build every consolidation this wallet can actually perform right now.
 *
 * Batches are input-disjoint, so they can all be signed in the same round. Only
 * viable batches are produced — a batch that cannot succeed is never built, so
 * the screen never shows a button that is guaranteed to fail.
 */
export function buildConsolidationPlan(allUtxos: PlanUtxo[]): ConsolidationPlan {
  // Unconfirmed outputs cannot be spent, so they can neither fund nor be moved.
  const spendable = allUtxos.filter((u) => u.height === undefined || u.height > 0);
  let pool = [...spendable].sort((a, b) => b.value - a.value);

  const batches: PlannedBatch[] = [];
  for (;;) {
    const n = largestAffordableSize(pool);
    if (n === 0) break;

    const chosen = composeBatch(pool, n);
    const totalValue = sumOf(chosen);
    const fee = consolidationFee(chosen.length);
    batches.push({
      id: batches.length + 1,
      utxos: chosen,
      totalValue,
      dustCount: chosen.filter((u) => u.value < DUST_DISPLAY).length,
      fee,
      net: totalValue - fee,
      removes: chosen.length - 1,
    });

    const spent = new Set(chosen.map((u) => `${u.tx_hash}:${u.tx_pos}`));
    pool = pool.filter((u) => !spent.has(`${u.tx_hash}:${u.tx_pos}`));
  }

  // Anything still here plus anything unconfirmed is reported, never dropped.
  const leftovers = [
    ...pool,
    ...allUtxos.filter((u) => u.height !== undefined && u.height <= 0),
  ].sort((a, b) => b.value - a.value);

  return {
    batches,
    leftovers,
    totalRemoved: batches.reduce((s, b) => s + b.removes, 0),
    totalFee: batches.reduce((s, b) => s + b.fee, 0),
    depositToUnstick: batches.length === 0 ? depositNeededFor(leftovers) : 0,
  };
}
