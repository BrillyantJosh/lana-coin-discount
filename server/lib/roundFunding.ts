/**
 * HOW MUCH MONEY EACH FINANCING ROUND NEEDS, per currency.
 *
 * The mandates say how much LANA the treasury may acquire in each round. This
 * turns that into what it costs, so the operator can see the whole obligation
 * of a Split in EUR and GBP before the first proposal arrives.
 *
 * The price rule is the owner's (5 Sep 2026) and it is the one already used
 * for indicative figures: read the current Split from KIND 38888, and if the
 * mandate's Split has not landed yet, the LANA in those wallets still has the
 * doubling ahead of it, so the reference is 2 × the live rate. Once the Split
 * has turned, the live rate IS the price. resolveReferenceBasis owns that
 * decision; this module only spends it.
 *
 * The arithmetic mirrors priceAcquisition exactly — gross, then discount, each
 * rounded to the cent — so the forecast equals the sum of the purchase prices
 * that would actually be agreed. Round-by-round, because each round carries
 * its own discount.
 *
 * Everything here is a PROJECTION at today's reference. It is not a price, not
 * an offer and not a promise (BEF P08 §4); only an accepted purchase price
 * binds. Money already agreed or already paid is reported from the offers
 * themselves, never re-projected.
 */
import { resolveReferenceBasis, type ReferenceBasis } from './referenceBasis.js';

const LANOSHI = 100_000_000;

/** Cents, half-up, the way priceAcquisition does it. */
const cents = (n: number) => Math.round(n * 100) / 100;

export interface FundingMandate {
  dTag: string;
  round: number;
  split: number;
  status: 'announced' | 'closed';
  wallets: Array<{ currency: string; lanaLanoshis: number; fundSettingId?: string | number | null }>;
}

/** What one financing budget paid in, from direct.lana.fund. */
export interface BudgetPaidIn {
  currency: string;
  investedAmount: number;
}

export interface FundingOffer {
  mandateRef: string;
  currency: string;
  status: string;
  lanoshis: number;
  purchasePriceFiat: number | null;
  /** True for an 'offered' row that has not lapsed — reserved, not yet ours. */
  live: boolean;
}

/** Why a money figure is missing. Shown to the operator instead of a zero. */
export type FundingGap = 'NO_RATE' | 'NO_DISCOUNT' | 'NO_REFERENCE';

export interface CurrencyFunding {
  currency: string;
  /** What the financers of this round paid in, in this currency. */
  fiatPaidIn: number | null;
  /** ((payout / paid in) − 1) × 100 for the whole round, when both are known. */
  returnPercent: number | null;
  /** LANA the round may still acquire, and what it was granted in total. */
  lanaExpected: number;
  lanaRemaining: number;
  lanaProposed: number;
  lanaAccepted: number;
  lanaSettled: number;
  /** Fiat per LANA before the round's discount, and the basis it stands on. */
  referenceRate: number | null;
  basis: ReferenceBasis | null;
  discountPercent: number | null;
  /** What the treasury pays per LANA at that reference, after the discount. */
  pricePerLana: number | null;
  /** Projections: the whole round, and what is still outstanding. */
  fiatExpected: number | null;
  fiatRemaining: number | null;
  /** Real money from the offers themselves — agreed, and already paid. */
  fiatAccepted: number;
  fiatSettled: number;
  gaps: FundingGap[];
}

export interface RoundFunding {
  round: number;
  mandateCount: number;
  currencies: CurrencyFunding[];
  /** Sum over currencies of what is still outstanding, for a one-line read. */
  totalsByCurrency: Record<string, number | null>;
}

/**
 * The purchase price of an amount of LANA, built the way priceAcquisition
 * builds a real one: gross to the cent, the round's discount to the cent, then
 * the difference. Null when either half of the input is missing — an unpriced
 * figure must stay unpriced rather than fall back to zero.
 */
export function projectPrice(
  lana: number,
  rate: number | null | undefined,
  discountPercent: number | null | undefined,
): number | null {
  if (!(typeof rate === 'number' && rate > 0)) return null;
  if (!(typeof discountPercent === 'number' && Number.isFinite(discountPercent))) return null;
  const gross = cents(lana * rate);
  const discount = cents(gross * discountPercent / 100);
  return cents(gross - discount);
}

/** The reference a mandate's Split stands on right now, for one currency. */
export function referenceForCurrency(input: {
  currency: string;
  split: number;
  currentSplit: number | null;
  rates: Record<string, number>;
}) {
  return resolveReferenceBasis({
    mandateSplit: input.split, currentSplit: input.currentSplit, fx: input.rates[input.currency],
  });
}

export interface FundingInput {
  /** The Split the mandates were published for. */
  split: number;
  /** From KIND 38888. null when the Split is unknown — then nothing is priced. */
  currentSplit: number | null;
  mandates: FundingMandate[];
  offers: FundingOffer[];
  terms: Array<{ round: number; discountPercent: number | null }>;
  /** KIND 38888 exchange_rates: fiat per LANA at the CURRENT Split. */
  rates: Record<string, number>;
  /**
   * fund_setting_id → what that budget paid in, from direct.lana.fund. Absent
   * when it could not be read; then the paid-in figures are null, never zero.
   */
  paidByBudget?: Map<number, BudgetPaidIn> | null;
}

/**
 * Per round, per currency. Closed mandates are left out — a tombstone carries
 * no LANA and the treasury owes nothing against it.
 */
export function fundingByRound(input: FundingInput): RoundFunding[] {
  const live = input.mandates.filter(m => m.status === 'announced');
  const byRef = new Map<string, FundingMandate>(live.map(m => [m.dTag, m]));
  const discountOf = new Map<number, number | null>(input.terms.map(t => [t.round, t.discountPercent ?? null]));

  // round → currency → tally, in lanoshis so nothing is lost before the end.
  type Tally = {
    expected: number; consumed: number; proposed: number; accepted: number; settled: number;
    fiatAccepted: number; fiatSettled: number;
    paidIn: number; paidInKnown: boolean; budgets: Set<number>;
  };
  const tally = new Map<number, Map<string, Tally>>();
  const blank = (): Tally => ({
    expected: 0, consumed: 0, proposed: 0, accepted: 0, settled: 0, fiatAccepted: 0, fiatSettled: 0,
    paidIn: 0, paidInKnown: true, budgets: new Set<number>(),
  });
  const cell = (round: number, currency: string): Tally => {
    if (!tally.has(round)) tally.set(round, new Map());
    const row = tally.get(round)!;
    if (!row.has(currency)) row.set(currency, blank());
    return row.get(currency)!;
  };

  const mandatesPerRound = new Map<number, number>();
  for (const m of live) {
    mandatesPerRound.set(m.round, (mandatesPerRound.get(m.round) || 0) + 1);
    for (const w of m.wallets) {
      const c = cell(m.round, w.currency);
      c.expected += w.lanaLanoshis;
      if (!input.paidByBudget) { c.paidInKnown = false; continue; }
      const id = Number(w.fundSettingId);
      if (!Number.isInteger(id)) { c.paidInKnown = false; continue; }
      if (c.budgets.has(id)) continue;              // a budget pays in once
      const paid = input.paidByBudget.get(id);
      if (!paid) { c.paidInKnown = false; continue; }
      c.budgets.add(id);
      c.paidIn += paid.investedAmount;
    }
  }

  for (const o of input.offers) {
    const m = byRef.get(o.mandateRef);
    if (!m) continue;                       // an offer against a closed or foreign mandate
    const c = cell(m.round, o.currency);
    // The same definition of "consumed" the cap uses: settled and accepted are
    // ours, a live offer is reserved. A lapsed or declined one frees its LANA.
    if (o.status === 'settled') { c.settled += o.lanoshis; c.consumed += o.lanoshis; c.fiatSettled += o.purchasePriceFiat || 0; }
    else if (o.status === 'accepted') { c.accepted += o.lanoshis; c.consumed += o.lanoshis; c.fiatAccepted += o.purchasePriceFiat || 0; }
    else if (o.status === 'offered' && o.live) { c.proposed += o.lanoshis; c.consumed += o.lanoshis; }
  }

  const rounds = [...new Set([...tally.keys(), ...input.terms.map(t => t.round)])].sort((a, b) => a - b);
  return rounds.map(round => {
    const row = tally.get(round) || new Map<string, Tally>();
    const discountPercent = discountOf.has(round) ? discountOf.get(round)! : null;
    const currencies: CurrencyFunding[] = [...row.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, t]) => {
        const reference = resolveReferenceBasis({
          mandateSplit: input.split, currentSplit: input.currentSplit, fx: input.rates[currency],
        });
        const gaps: FundingGap[] = [];
        const fx = input.rates[currency];
        if (!(typeof fx === 'number' && fx > 0)) gaps.push('NO_RATE');
        else if (!reference) gaps.push('NO_REFERENCE');
        if (discountPercent === null) gaps.push('NO_DISCOUNT');

        const lana = (lanoshis: number) => lanoshis / LANOSHI;
        const expected = lana(t.expected);
        const remaining = lana(Math.max(0, t.expected - t.consumed));

        const priceFor = (amount: number): number | null => projectPrice(amount, reference?.rate ?? null, discountPercent);
        const fiatPaidIn = t.paidInKnown ? cents(t.paidIn) : null;
        const fiatExpected = priceFor(expected);

        return {
          currency,
          lanaExpected: expected,
          lanaRemaining: remaining,
          lanaProposed: lana(t.proposed),
          lanaAccepted: lana(t.accepted),
          lanaSettled: lana(t.settled),
          referenceRate: reference?.rate ?? null,
          basis: reference?.basis ?? null,
          discountPercent,
          pricePerLana: reference && discountPercent !== null
            ? reference.rate * (1 - discountPercent / 100)
            : null,
          fiatPaidIn,
          returnPercent: fiatPaidIn !== null && fiatPaidIn > 0 && fiatExpected !== null
            ? Math.round(((fiatExpected / fiatPaidIn) - 1) * 1000) / 10
            : null,
          fiatExpected,
          fiatRemaining: priceFor(remaining),
          fiatAccepted: cents(t.fiatAccepted),
          fiatSettled: cents(t.fiatSettled),
          gaps,
        };
      });

    const totalsByCurrency: Record<string, number | null> = {};
    for (const c of currencies) totalsByCurrency[c.currency] = c.fiatRemaining;

    return {
      round,
      mandateCount: mandatesPerRound.get(round) || 0,
      currencies,
      totalsByCurrency,
    };
  });
}
