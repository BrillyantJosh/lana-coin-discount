/**
 * WHICH REFERENCE PRICE an indicative figure is built on.
 *
 * lana.discount only ever reads the CURRENT split's fx from KIND 38888. A
 * mandate, though, is published for the split the budget targeted, and the
 * seller looks at it BEFORE that split ends — when the LANA in the wallet has
 * not yet been through the Split, and the reference that will apply once it
 * has is the projected next-split price (2 × fx, direct.lana.fund's
 * SPLIT_MULTIPLIER). Once the split has turned, the live fx IS that price.
 *
 * So there are exactly two honest bases, and one moment where neither holds:
 *
 *   currentSplit === mandateSplit      projected_next_split   rate = 2 × fx
 *   currentSplit === mandateSplit + 1  current_split          rate = fx
 *   anything else                      null — the window has passed (or has
 *                                      not arrived), there is nothing to quote
 *
 * The basis is informational. A BINDING purchase price is only ever made in
 * the `current_split` state, from the live fx, by priceAcquisition — this
 * module never sets a price, it says which figure a projection may cite and
 * makes the seller's page say so (BEF P08 §4: not a rate, not a guarantee).
 */
import { BUYBACK_SPLIT_OFFSET } from './buybackSplit.js';

/** direct.lana.fund/src/lib/projection.ts SPLIT_MULTIPLIER — the Split lands at ×2. */
export const SPLIT_MULTIPLIER = 2;

export type ReferenceBasis = 'projected_next_split' | 'current_split';

export interface ResolvedReference {
  basis: ReferenceBasis;
  /** Fiat per LANA under that basis. */
  rate: number;
}

export function resolveReferenceBasis(input: {
  mandateSplit: number | null | undefined;
  currentSplit: number | null | undefined;
  /** The live fx for the currency, from KIND 38888. */
  fx: number | null | undefined;
}): ResolvedReference | null {
  const mandateSplit = Number.isFinite(input.mandateSplit as number) ? Number(input.mandateSplit) : null;
  const currentSplit = Number.isFinite(input.currentSplit as number) ? Number(input.currentSplit) : null;
  const fx = Number.isFinite(input.fx as number) ? Number(input.fx) : null;
  if (mandateSplit === null || currentSplit === null || fx === null || fx <= 0) return null;

  if (currentSplit === mandateSplit) {
    return { basis: 'projected_next_split', rate: fx * SPLIT_MULTIPLIER };
  }
  // The same one-split window evaluateBuybackSplit enforces on the wallet.
  if (currentSplit === mandateSplit + BUYBACK_SPLIT_OFFSET) {
    return { basis: 'current_split', rate: fx };
  }
  return null;
}
