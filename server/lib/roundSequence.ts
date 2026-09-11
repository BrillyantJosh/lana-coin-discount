/**
 * WHEN A ROUND OPENS, WHEN NOBODY CAN SAY THE DATE.
 *
 * Owner, 11 Sept 2026: "Krog 2 se odpre ko se krog 1 zapre.. avtomatsko...
 * nemogoče je zares povedati v naprej kdaj bo.. ko zmanjka denarja :)"
 *
 * Round 2 opens when round 1 closes, automatically, because there is no honest
 * way to put a date on "when the money runs out". Until now a round opened on
 * a hand-typed date and on nothing else, which is why Split 9's rounds sat
 * empty with five mandates already pointing at them: the date nobody had
 * thought to type was the only thing that could ever open them, and no screen
 * said so.
 *
 * ── The two rules this module is built on ─────────────────────────────────
 *
 * 1. AN OPENING IS WRITTEN DOWN, NOT RECOMPUTED.
 *    "Round 1 is spent" is derived from live offers, and a live offer expires.
 *    Recomputed per request, the answer flaps: round 1 empties, round 2 opens,
 *    an offer lapses, round 1 has money again — and round 2 would shut under
 *    the people who had just been told it was open. So the first observation
 *    that a round's turn has come is recorded (acquisition_round_opens) and
 *    that record is what every later read consults. Once a turn has come, it
 *    has come. Round 1 stays sellable if money comes back to it, and the
 *    decision loop still tries it first, so nothing jumps the order.
 *
 * 2. EXHAUSTION NEEDS POSITIVE EVIDENCE, AND IS CURRENCY-FREE.
 *    A round with no live mandates is NOT exhausted — it is unknown, and
 *    unknown keeps the next round shut. Mandates arrive one event at a time
 *    from relays, and a quiet relay returns nothing at all
 *    (ops_quiet_relay_retires_plan), so "I see no round-1 mandates" is far more
 *    often "I have not heard yet" than "round 1 is done". Reading silence as
 *    done would open round 2 ahead of round 1 at the very start of a window —
 *    exactly backwards from the FIFO order the treasury publishes.
 *
 *    And the crumb test is made of LANA, not of a currency. Whether a
 *    remainder is too small to sell depends on min_sell_<currency> and a live
 *    rate, and the public rounds page has neither; judged per currency, the
 *    same round would be closed for a EUR reader and open for a GBP one, and
 *    the screen and the gate would disagree about the same LANA. One floor, in
 *    LANA, for the round-wide question.
 */

/** Which rule this round opens by. NULL means nothing was chosen: stay shut. */
export type OpensMode = 'date' | 'sequence' | null;

/**
 * The smallest remainder that still counts as "there is money in this round",
 * for the round-wide close only.
 *
 * A proposal is refused below min_sell_<currency> (≈ 8 LANA at a 2 EUR minimum
 * and 0.256 EUR/LANA), and the decision loop already steps over a mandate
 * holding less than that so one financer's crumb cannot block the rounds
 * behind it. This floor is the same idea one level up: without it, a single
 * financer leaving 3 LANA behind would hold the whole round open forever and
 * the next round could never begin.
 *
 * Set well above any per-currency minimum and far below any real allocation —
 * the smallest live mandate on 11 Sept 2026 was 3,208 LANA, so 100 LANA is two
 * orders of magnitude away from taking anyone's money out of reach. A
 * remainder above the floor is always still sellable; the floor only decides
 * when the treasury stops waiting for it.
 */
export const ROUND_CLOSE_FLOOR_LANOSHIS = 100 * 100_000_000;

/**
 * What one mandate still has in it. The same subtraction `remainingOf` makes,
 * kept here too so the round-wide count and the per-mandate cap can never
 * drift apart by a rounding.
 */
export function remainingOfMember(receivedLanoshis: number, consumedLanoshis: number): number {
  return Math.max(0, receivedLanoshis - consumedLanoshis);
}

/** One live mandate of a round, reduced to the only number this needs. */
export interface RoundMember {
  round: number;
  remainingLanoshis: number;
}

export interface RoundStanding {
  round: number;
  /** Live mandates counted — zero means we know nothing, not that it is done. */
  members: number;
  remainingLanoshis: number;
  /** At least one mandate seen, and none of them holds a sellable remainder. */
  exhausted: boolean;
}

/**
 * What each round of one split still holds, across EVERY financer in it.
 *
 * Round-wide on purpose. A financer whose own round 1 is spent has not brought
 * round 1 to a close — the others in it are still waiting to be bought from,
 * and serving round 2 ahead of them is the FIFO order run backwards. An admin
 * who wants to let one person through early still can: that is what a mandate
 * release is for, and it is recorded with a reason.
 */
export function roundStandings(members: RoundMember[]): Map<number, RoundStanding> {
  const out = new Map<number, RoundStanding>();
  for (const m of members) {
    const remaining = Math.max(0, Math.floor(m.remainingLanoshis));
    const s = out.get(m.round) || { round: m.round, members: 0, remainingLanoshis: 0, exhausted: false };
    s.members += 1;
    s.remainingLanoshis += remaining;
    out.set(m.round, s);
  }
  for (const s of out.values()) {
    // Positive evidence, both halves: something was seen, and what was seen is
    // spent down to the floor.
    s.exhausted = s.members > 0 && s.remainingLanoshis <= ROUND_CLOSE_FLOOR_LANOSHIS;
  }
  return out;
}

/** Everything that decides whether one round is open, in one place. */
export interface RoundOpening {
  round: number;
  /** acquisition_rounds.opens_at, unix seconds. */
  opensAt: number | null;
  /** acquisition_rounds.opens_mode. */
  opensMode: OpensMode;
  /** acquisition_round_opens.opened_at, unix seconds — the recorded turn. */
  openedAt: number | null;
}

/**
 * IS THIS ROUND OPEN? The single definition, for the gate and for the screen.
 *
 * A date and a recorded turn are not rivals: whichever arrives first opens the
 * round, and neither can push the other back. That is what lets a date stay on
 * a round that has switched to sequence — Split 8 round 2 carries 26 October,
 * and 26 October remains the day it opens at the latest, whether or not round 1
 * has emptied by then. No financer is ever made to wait longer than the date
 * they were already shown.
 */
export function roundIsOpen(o: RoundOpening, now: number): boolean {
  if (o.openedAt !== null && now >= o.openedAt) return true;
  return o.opensAt !== null && now >= o.opensAt;
}

/**
 * Has a round been given any way at all to open?
 *
 * This is the question the admin screen has to ask, and the one nothing asked
 * before: a round with neither a date nor a sequence rule can never open, no
 * matter how long anyone waits, and until now it looked exactly like a round
 * whose date simply had not arrived.
 */
export function roundCanEverOpen(o: Pick<RoundOpening, 'opensAt' | 'opensMode'>): boolean {
  return o.opensAt !== null || o.opensMode === 'sequence';
}

export interface SequenceOpening {
  round: number;
  /** Why it opened — stored, so the record reads back (P08 §12). */
  trigger: string;
}

/**
 * Which rounds have just earned their turn and should be written down.
 *
 * Returns only rounds that are in sequence mode, have no record yet, and whose
 * predecessor is exhausted on the evidence given. Round 1 has no predecessor:
 * its turn is the window itself, so it opens as soon as the window does.
 *
 * Pure, so the caller can record the result inside whatever transaction it is
 * already holding, and so a test can hand it a standings map and read the
 * answer back without a database.
 */
export function sequenceOpenings(input: {
  openings: RoundOpening[];
  standings: Map<number, RoundStanding>;
  /**
   * False when we have not verifiably heard from a relay recently. Sequence is
   * suspended then: exhaustion is read off mandates, and stale mandates are a
   * reason to wait rather than to open a treasury cap.
   */
  syncFresh: boolean;
}): SequenceOpening[] {
  if (!input.syncFresh) return [];
  const out: SequenceOpening[] = [];
  for (const o of input.openings) {
    if (o.opensMode !== 'sequence' || o.openedAt !== null) continue;
    if (o.round <= 1) {
      out.push({ round: o.round, trigger: 'window opened' });
      continue;
    }
    const before = input.standings.get(o.round - 1);
    if (!before || !before.exhausted) continue;
    out.push({
      round: o.round,
      trigger: `round ${o.round - 1} spent: ${before.members} mandate(s), ` +
        `${(before.remainingLanoshis / 100_000_000).toFixed(8)} LANA left`,
    });
  }
  return out;
}
