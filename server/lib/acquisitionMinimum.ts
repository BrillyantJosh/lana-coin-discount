/**
 * THE SMALLEST SALE WORTH MAKING, IN ONE PLACE.
 *
 * `min_sell_<currency>` has always been enforced, and only at the very end: a
 * proposal whose market value falls under it is refused with BELOW_MINIMUM.
 * What the seller was never told is that the figure the page was INVITING him
 * to propose was under it.
 *
 * 11 Sept 2026: a completed sale left 0.73 LANA in round 2, and the page said
 * "You can still propose — 0.73 LANA" under a button offering to do exactly
 * that. Twenty cents of LANA; the proposal could only ever be refused. The
 * owner: "ne ponujaj v naslednjo prodajo, če je manjše od zneska v settingsih,
 * to nima nobenega smisla."
 *
 * So the rule lives here rather than inline at the two places that refuse, and
 * the page asks the same question the server answers. The comparison is on the
 * REFERENCE GROSS, not on the purchase price, because that is what the two
 * refusals already compare and a second definition is how this goes wrong.
 */

/** What the settings say, for this currency. 0 (or absent) means no minimum. */
export function minimumFiatFor(settings: Record<string, string>, currency: string): number {
  const raw = settings[`min_sell_${String(currency || '').toLowerCase()}`];
  const n = parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The one comparison, used by the refusal and by the invitation alike. */
export function belowMinimum(grossFiat: number, minimumFiat: number): boolean {
  return minimumFiat > 0 && grossFiat < minimumFiat;
}

/**
 * The gross this much LANA is worth, priced the way priceAcquisition prices it
 * — the LIVE rate for the currency, rounded to cents BEFORE the comparison.
 *
 * Both halves of that sentence are load-bearing, and I got the first one wrong
 * on 11 Sept 2026 and the test did not catch it. The mandate endpoint reports
 * a reference that can be the PROJECTED next-Split rate (twice the live one)
 * while the refusal always prices on the live rate; pricing the invitation
 * against the projection would put the bar in a different place from the
 * refusal, which is the very thing this module exists to prevent. The fixture
 * had a split where the two rates coincide, so "they agree" was asserted
 * against a case where they could not disagree.
 */
export function grossFiatOf(lanaAmount: number, liveRate: number): number {
  return Math.round(lanaAmount * liveRate * 100) / 100;
}

/**
 * Would a proposal for this much LANA be refused as too small?
 * `liveRate` must be the rate the REFUSAL prices against — rates[currency] —
 * and never a projected one. Null when there is none, and then nothing can be
 * said, so nothing is.
 */
export function proposalTooSmall(
  lanaAmount: number,
  liveRate: number | null,
  minimumFiat: number,
): boolean {
  if (minimumFiat <= 0 || liveRate === null || !(liveRate > 0)) return false;
  if (!(lanaAmount > 0)) return true;
  return belowMinimum(grossFiatOf(lanaAmount, liveRate), minimumFiat);
}

/**
 * The least LANA that would clear the bar, for telling somebody where it is.
 * Rounded UP to the hundredth so the figure shown cannot itself be refused.
 */
export function smallestProposableLana(liveRate: number | null, minimumFiat: number): number | null {
  if (minimumFiat <= 0 || liveRate === null || !(liveRate > 0)) return null;
  const lana = Math.ceil((minimumFiat / liveRate) * 100) / 100;
  // Rounding up by a hundredth of a LANA is not always enough on its own: the
  // gross is itself rounded to cents, so walk until the figure we print would
  // actually be accepted. A number shown as "the minimum" that is refused the
  // moment somebody types it is worse than no number.
  let out = lana;
  for (let i = 0; i < 4 && belowMinimum(grossFiatOf(out, liveRate), minimumFiat); i++) out = Math.round((out + 0.01) * 100) / 100;
  return out;
}
