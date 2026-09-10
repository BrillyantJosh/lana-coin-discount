/**
 * One way to write a purchase price, so one screen cannot disagree with itself.
 *
 * The dashboard printed money with `toFixed(2)` and no thousands separator,
 * which is survivable at 13px in a list and not at 30px on a card: "€6498.88"
 * reads as a different number from "€6,498.88" at a glance, and the card exists
 * to be read at a glance. The grouping is inserted into the `toFixed` output
 * rather than handed to `toLocaleString`, so the decimal point stays exactly
 * what it has always been on this page and does not follow the reader's locale
 * into a comma while the cents beside it stay a point.
 */
export function formatFiat(symbol: string, amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${symbol}${grouped}.${cents}`;
}

/**
 * A LANA amount, grouped the same way `formatFiat` groups a purchase price.
 *
 * `toLocaleString` with the reader's locale was the obvious thing and is the
 * wrong thing HERE: on sl-SI — the owner's own browser, and the locale this
 * app's dates are pinned to — 20070.5 renders "20.070,5", which put a point
 * where the price beside it puts a comma. The one card built to be read at a
 * glance then carried "€6,498.88" three lines above "for 20.070,5 LANA", two
 * decimal conventions in one glance. Both figures follow one convention now,
 * and it is the one the money on this page has always used.
 *
 * Fractions are kept to two places and trailing zeroes dropped: LANA amounts
 * are usually whole, and "20,070.00 LANA" reads as money rather than coins.
 */
export function formatLana(amount: number): string {
  const n = amount || 0;
  const sign = n < 0 ? '-' : '';
  const fixed = Math.abs(n).toFixed(2).replace(/\.?0+$/, '');
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`;
}
