/**
 * HOW FAR A ROUND HAS BEEN PAID OUT — for the public round cards.
 *
 * Owner, 13 Sept 2026, looking at the landing page: "prvo rundo in drugo
 * rundo malce bolje opiši … v smislu koliko si izplačal od koliko, tudi v
 * FIAT". The cards said how much LANA was received and settled; they did not
 * say how much money had been paid, or out of what.
 *
 * Built from the same per-budget totals lana.discount publishes as KIND 30961
 * (budgetSettlement.ts), so the card, the relays and BEF Explorer cannot tell
 * three different stories:
 *
 *   paid          payments recorded, in the currency they were paid in
 *   agreed        purchase prices of LANA already transferred
 *   inProgress    purchase prices of accepted offers not yet transferred
 *   unsoldValue   the LANA no budget has sold yet, at today's reference value
 *                 and the round's published terms — an ESTIMATE that moves
 *                 with the reference value, in the budget's own currency
 *   total         agreed + inProgress + unsoldValue — "of how much"
 *
 * Nothing sold is counted twice: a budget's LANA is either sold (its price is
 * in agreed, in the currency of the sale) or unsold (valued in the budget's
 * currency). A remainder too small to sell is worth nothing here, as it is on
 * the offer page. When the reference value or the round's terms are unknown,
 * the estimate is unknown and so is the total — never a zero.
 */
import type { BudgetSettlementEvent } from './budgetSettlement.js';
import { projectPrice, referenceForCurrency } from './roundFunding.js';

export interface RoundMoneyLine {
  currency: string;
  paid: number;
  agreed: number;
  inProgress: number;
  /** null when it cannot be estimated (no reference value or no published terms). */
  unsoldValue: number | null;
  total: number | null;
  /** Agreed and not yet paid. */
  owed: number;
  /** paid ÷ total × 100, two decimals; null without a total. */
  paidPercent: number | null;
}

export interface RoundProgress {
  round: number;
  budgets: number;
  lanaReceived: number;
  lanaAcquired: number;
  lanaInProgress: number;
  lanaUnsold: number;
  lanaPaid: number;
  acquiredPercent: number | null;
  paidPercent: number | null;
  money: RoundMoneyLine[];
}

export interface RoundProgressInput {
  split: number;
  currentSplit: number | null;
  /** KIND 38888 fx per currency. */
  rates: Record<string, number>;
  /** round → published sell fee, or null. */
  discountByRound: Map<number, number | null>;
  /** The crumb rule: could this much LANA, in this currency, still be sold? */
  sellable: (lana: number, currency: string) => boolean;
}

const tagOf = (e: BudgetSettlementEvent, name: string) => e.tags.find(t => t[0] === name)?.[1];
const cents = (v: number) => Math.round(v * 100);
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10_000n * 2n + whole) / (whole * 2n)) / 100 : null);

export function roundProgress(events: BudgetSettlementEvent[], input: RoundProgressInput): Map<number, RoundProgress> {
  const out = new Map<number, RoundProgress>();

  for (const round of [1, 2, 3]) {
    const own = events.filter(e => Number(tagOf(e, 'split')) === input.split && Number(tagOf(e, 'round')) === round);
    if (own.length === 0) continue;

    let received = 0n, acquired = 0n, inProgress = 0n, unsold = 0n, paidLana = 0n;
    const lines = new Map<string, { paid: number; agreed: number; inProgress: number; unsold: number; unknown: boolean }>();
    const line = (c: string) => {
      const l = lines.get(c) ?? { paid: 0, agreed: 0, inProgress: 0, unsold: 0, unknown: false };
      lines.set(c, l);
      return l;
    };

    for (const e of own) {
      const t = e.totals;
      received += t.lanaReceivedLanoshis;
      acquired += t.lanaAcquiredLanoshis;
      inProgress += t.lanaInProgressLanoshis;
      unsold += t.lanaRemainingLanoshis;
      paidLana += t.lanaPaidLanoshis;
      for (const [c, v] of t.agreedCents) line(c).agreed += Number(v);
      for (const [c, v] of t.paidCents) line(c).paid += Number(v);
      for (const s of e.tags) {
        if (s[0] === 'sale' && s[2] === 'accepted') line(s[3]).inProgress += cents(Number(s[7]) || 0);
      }

      const currency = String(tagOf(e, 'currency') || '').toUpperCase();
      const lana = Number(t.lanaRemainingLanoshis) / 1e8;
      if (currency && lana > 0 && input.sellable(lana, currency)) {
        const reference = referenceForCurrency({ currency, split: input.split, currentSplit: input.currentSplit, rates: input.rates });
        const price = projectPrice(lana, reference?.rate ?? null, input.discountByRound.get(round) ?? null);
        if (price === null) line(currency).unknown = true;
        else line(currency).unsold += cents(price);
      }
    }

    const money: RoundMoneyLine[] = [...lines.entries()]
      .map(([currency, l]) => {
        const total = l.unknown ? null : l.agreed + l.inProgress + l.unsold;
        return {
          currency,
          paid: l.paid / 100,
          agreed: l.agreed / 100,
          inProgress: l.inProgress / 100,
          unsoldValue: l.unknown ? null : l.unsold / 100,
          total: total === null ? null : total / 100,
          owed: (l.agreed - l.paid) / 100,
          paidPercent: total && total > 0 ? Math.round((l.paid / total) * 10_000) / 100 : null,
        };
      })
      // A currency in which nothing was paid and nothing is to come says nothing.
      .filter(m => m.paid !== 0 || (m.total ?? 0) !== 0 || m.total === null)
      .sort((a, b) => (b.total ?? b.paid) - (a.total ?? a.paid) || a.currency.localeCompare(b.currency));

    out.set(round, {
      round,
      budgets: own.length,
      lanaReceived: Number(received) / 1e8,
      lanaAcquired: Number(acquired) / 1e8,
      lanaInProgress: Number(inProgress) / 1e8,
      lanaUnsold: Number(unsold) / 1e8,
      lanaPaid: Number(paidLana) / 1e8,
      acquiredPercent: pct(acquired, received),
      paidPercent: pct(paidLana, received),
      money,
    });
  }
  return out;
}
