/**
 * A PROPOSAL MUST BE BACKED BY THE WALLET IT COMES FROM.
 *
 * Nothing checked this until the coins actually moved. On 9 Sept 2026 an offer
 * stood under treasury review for 20,070 LANA from a wallet holding 2,200.72 —
 * nine times more than it could ever deliver — and the only thing that would
 * have stopped it was the network refusing the transfer at the very end, after
 * the treasury had reviewed it, priced it and possibly agreed to pay for it.
 *
 * So the balance is now read at every step that COMMITS something: when the
 * proposal is made, when the treasury accepts or counters, and when the seller
 * accepts a price. The rule lives here, apart from the reading of it, so it can
 * be tested without a chain.
 *
 * Fail closed. A balance that cannot be read is not a balance of zero and not a
 * balance of enough — it is a reason to come back in a minute. The same
 * principle already governs the transfer guard (verifiedBalanceLanoshis).
 */

/**
 * A wallet showing a hair less than the amount is not short. Displays round,
 * and a seller offering their whole balance types what the screen showed them.
 * Same 0.005 LANA the transfer guard already tolerates.
 */
export const BACKING_TOLERANCE_LANOSHIS = 500_000;

export type BackingVerdict =
  | { ok: true; balanceLanoshis: number }
  | { ok: false; code: 'BALANCE_UNVERIFIABLE'; status: 503; error: string }
  | { ok: false; code: 'INSUFFICIENT_BALANCE'; status: 409; error: string; balanceLanoshis: number; shortfallLanoshis: number };

const lana = (lanoshis: number) => (lanoshis / 100_000_000).toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 8,
});

/**
 * @param balanceLanoshis what the chain says the wallet holds, or null when
 *        that could not be established (an outage, an unreadable answer, an
 *        answer about some other wallet — see verifiedBalanceLanoshis).
 * @param offeredLanoshis the amount being committed to.
 */
export function verifyBacking(balanceLanoshis: number | null, offeredLanoshis: number): BackingVerdict {
  if (balanceLanoshis === null || !Number.isFinite(balanceLanoshis)) {
    return {
      ok: false, code: 'BALANCE_UNVERIFIABLE', status: 503,
      error: 'The balance of this wallet could not be read right now. Please try again shortly.',
    };
  }
  if (balanceLanoshis + BACKING_TOLERANCE_LANOSHIS < offeredLanoshis) {
    return {
      ok: false, code: 'INSUFFICIENT_BALANCE', status: 409,
      error: `This wallet holds ${lana(balanceLanoshis)} LANA, less than the ${lana(offeredLanoshis)} LANA in this proposal.`,
      balanceLanoshis,
      shortfallLanoshis: offeredLanoshis - balanceLanoshis,
    };
  }
  return { ok: true, balanceLanoshis };
}

/** True when the wallet can still deliver the amount — for display, never for a decision. */
export function isBacked(balanceLanoshis: number | null, offeredLanoshis: number): boolean {
  return verifyBacking(balanceLanoshis, offeredLanoshis).ok;
}
