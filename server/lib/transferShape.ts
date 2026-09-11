/**
 * WHICH SHAPE A TRANSFER TAKES, AS A FUNCTION AND NOT AS A PARAGRAPH.
 *
 * This lived inside the transfer route, where the only way to exercise it was
 * to stand up an HTTP server, a database and an offer. So it was tested at
 * points — the numbers from whichever incident had just happened — and every
 * time one of those points was fixed, the fix moved the boundary and put
 * somebody else in a hole nobody had a point for:
 *
 *   10 Sept  a wallet holding EXACTLY the agreed amount could not pay the fee
 *   11 Sept  a counteroffer decided the shape from the mandate, not the wallet
 *   11 Sept  a surplus of 0.00125 LANA: too much to sweep, too little to pay
 *            for the change output — the gap between a CONSTANT dust allowance
 *            and a fee that depends on how many pieces the wallet is in
 *
 * Three incidents, one cause: two numbers that have to agree, in two places,
 * and no way to ask "is there any wallet for which neither shape works?"
 * Pulled out here, that question is a loop — see transferInvariants.test.ts,
 * which sweeps the whole space instead of sampling it.
 *
 * THIS LAYER PROPOSES; planTransfer DISPOSES. Everything decided here rests on
 * a balance read a moment ago over the network. The layer below reads the
 * UTXOs themselves, so it knows the exact figure AND the real fee at the
 * moment of signing — which is why the ceiling travels with every call rather
 * than only when this layer already believes it is a sweep.
 */

/** Three network fees' worth of slack, priced on a one-input transaction. */
export const EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS = 100_800;

/** What electrum's printed figure can be out by when the exact integer is missing. */
export const BALANCE_ROUNDING_LANOSHIS = 500_000;

export type ShapeDecision =
  | {
      kind: 'proceed';
      /** Ask the chain layer to sweep. It may still decide otherwise. */
      emptyWallet: boolean;
      /** Permission to empty this wallet, and the mandate it is bounded by. */
      sweepCeilingLanoshis: number;
    }
  | { kind: 'refuse'; status: number; code: string; error: string };

export function decideTransferShape(p: {
  /** The chain's own integer, or null when it could not be established. */
  balanceLanoshis: number | null;
  agreedLanoshis: number;
  /** The browser's derived flag. ADVICE — it can never cause a refusal on its own. */
  askedToEmpty: boolean;
  /** 0 when electrum carried its exact integer through, the rounding step otherwise. */
  roundingSlack: number;
}): ShapeDecision {
  const { balanceLanoshis, agreedLanoshis, askedToEmpty, roundingSlack } = p;
  const sweepCeilingLanoshis = agreedLanoshis + EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS + roundingSlack;

  if (balanceLanoshis === null) {
    // An outage used to restore the 10 Sept bug in full: with no balance and no
    // browser flag, a whole-wallet offer fell through to an ordinary transfer
    // and failed by the fee, every press. The question does not need the
    // balance call — it needs the UTXOs, which the next layer is about to read
    // anyway — so it goes down with the ceiling rather than being guessed here.
    //
    // An explicit ask still fails closed: somebody who chose to empty a wallet
    // deserves to hear that we could not check it, not to have it decided for
    // him. This is the ONE refusal a flag takes part in, and it is about
    // evidence rather than about the flag.
    if (askedToEmpty) {
      return {
        kind: 'refuse', status: 503, code: 'BALANCE_UNVERIFIABLE',
        error: 'The wallet balance could not be read right now. Please try again shortly.',
      };
    }
    return { kind: 'proceed', emptyWallet: true, sweepCeilingLanoshis };
  }

  // A wallet holding more than the mandate is not swept — and that is the whole
  // of it. A 409 used to stand here when the browser had also concluded
  // "empty", and it stranded OFF-2026-062: the flag is derived from a balance
  // rounded to 0.01 LANA while this line turns on 0.001008, so the browser is
  // ten times too coarse to ever agree. Nothing was protected by refusing —
  // the agreed amount simply moves, which is what the seller wanted.
  const surplus = balanceLanoshis - agreedLanoshis;
  return {
    kind: 'proceed',
    emptyWallet: surplus <= EMPTY_WALLET_DUST_ALLOWANCE_LANOSHIS + roundingSlack,
    sweepCeilingLanoshis,
  };
}
