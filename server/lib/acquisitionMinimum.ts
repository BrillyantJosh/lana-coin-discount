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
 * Would a proposal for this much LANA be refused as too small?
 * `referenceRate` is the reference this round would be priced against; null
 * when there is none yet, and then nothing can be said — so nothing is.
 */
export function proposalTooSmall(
  lanaAmount: number,
  referenceRate: number | null,
  minimumFiat: number,
): boolean {
  if (minimumFiat <= 0 || referenceRate === null || !(referenceRate > 0)) return false;
  if (!(lanaAmount > 0)) return true;
  return belowMinimum(lanaAmount * referenceRate, minimumFiat);
}

/**
 * The least LANA that would clear the bar, for telling somebody where it is.
 * Rounded UP to the hundredth so the figure shown cannot itself be refused.
 */
export function smallestProposableLana(referenceRate: number | null, minimumFiat: number): number | null {
  if (minimumFiat <= 0 || referenceRate === null || !(referenceRate > 0)) return null;
  return Math.ceil((minimumFiat / referenceRate) * 100) / 100;
}
