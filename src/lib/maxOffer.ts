/**
 * WHAT "MAX" MAY TRUTHFULLY FILL IN.
 *
 * A seller pressed Max with 22,775.139664 LANA in his wallet and got all of it
 * in the field, while the line two rows below the same field said the treasury
 * could acquire 3,251.48 from that wallet under round 1. He deleted the number
 * and typed the smaller one by hand. The page already knew the answer and the
 * button was the only part of it that did not.
 *
 * Max therefore takes the SMALLER of two limits, and the arithmetic is here
 * rather than inside a click handler so both of them can be pinned by a test:
 *
 *   the wallet   balance less an estimated network fee — because the transfer
 *                that follows has to empty the wallet, and a fee has to come
 *                from somewhere;
 *   the round    what a single proposal may carry under the open financing
 *                round, which is what the treasury will actually take today.
 *
 * WHICH ONE BINDS CHANGES WHAT THE TRANSFER DOES. Emptying the wallet is a
 * property of the wallet limit and of nothing else: when the round cap is what
 * stops it, LANA stays behind, the transfer keeps a change output, and the fee
 * comes out of that — so `emptiesWallet` follows the limit that bound, and is
 * never simply asserted the way it used to be.
 *
 * A cap of `null` is NOT a cap of zero. It means this browser has not been
 * told one — the mandate is still being read, could not be read, or does not
 * exist at all because the wallet is on the legacy path where the server
 * decides. In every one of those cases Max behaves exactly as it did before
 * any of this: the whole wallet, less the fee.
 */

/**
 * The network fee a one-input, one-output transfer is estimated at, in LANA.
 *
 * The same expression used to be written out twice inside SubmitOffer — once
 * in the Max handler and once in the effect that recovers the empty-wallet
 * flag for a resumed offer — which is two copies of one number that decide
 * whether a transfer can pay its own fee. One copy now.
 */
export const ESTIMATED_TRANSFER_FEE_LANA = Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5) / 100_000_000;

export interface MaxOffer {
  /** What goes in the amount field. */
  amountLana: number;
  /** Whether the transfer that follows has to sweep the wallet empty. */
  emptiesWallet: boolean;
  /** True when the round cap, not the wallet, is what stopped it. */
  cappedByRound: boolean;
}

/**
 * The largest amount Max may put in the field, and what that implies for the
 * transfer. `capLana` is the round cap, or null when it is not known.
 */
export function maxProposable(balanceLana: number, feeLana: number, capLana: number | null): MaxOffer {
  const spendable = Math.max(0, balanceLana - feeLana);
  // Unknown, or simply not the binding constraint: exactly the old behaviour,
  // down to the unrounded float — this is the emptying case, and rounding it
  // is what would leave a few lanoshis behind for a fee that has no output.
  if (capLana === null || capLana >= spendable) {
    return { amountLana: spendable, emptiesWallet: true, cappedByRound: false };
  }
  // The cap arrives as lanoshis ÷ 1e8; it is put back on the lanoshi grid the
  // same way the server converts it, so the field can never carry float noise
  // a hair above the cap and earn a counteroffer for the difference.
  const capped = Math.max(0, Math.round(capLana * 1e8) / 1e8);
  return { amountLana: capped, emptiesWallet: false, cappedByRound: true };
}
