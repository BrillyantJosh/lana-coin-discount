// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildBudgetSettlements, type BudgetDefinition, type SaleInput, type PayoutInput } from './budgetSettlement';
import { roundProgress } from './publicRoundProgress';

const HEX = 'a'.repeat(64);
const LANA = 100_000_000;

const budget = (o: Partial<BudgetDefinition> & { fundSettingId: string }): BudgetDefinition => ({
  split: 8, round: 1, financerHex: HEX, currency: 'EUR', wallet: `W${o.fundSettingId}`, walletHistory: [`W${o.fundSettingId}`],
  lanaReceivedLanoshis: 1000 * LANA, mandateDTag: `8:${o.round ?? 1}:${HEX}`, mandateAddress: 'x', budgetAddress: null,
  mandateStatus: 'announced', ...o,
});
const sale = (o: Partial<SaleInput> & { offerRef: string; senderWallet: string }): SaleInput => ({
  mandateRef: `8:1:${HEX}`, currency: 'EUR', offerStatus: 'settled', lanaLanoshis: 1000 * LANA,
  referenceRate: 0.256, discountPercent: 22, grossFiat: 256, netFiat: 199.68, acceptedAt: 1, transactionId: 1,
  txHash: 'f'.repeat(64), txStatus: 'paid', lanaMovedLanoshis: null, completedAt: 2, blockHeight: null, ...o,
});
const pay = (o: Partial<PayoutInput> & { payoutId: string; transactionId: number; amount: number }): PayoutInput =>
  ({ currency: 'EUR', recordedAt: 3, ...o });

function progress(budgets: BudgetDefinition[], sales: SaleInput[], payouts: PayoutInput[], discounts = new Map([[1, 22], [2, 25]])) {
  const { events } = buildBudgetSettlements({
    budgets, sales, payouts, terms: new Map(), signerPubkey: '', sellable: (lana) => lana >= 1, now: 1,
  });
  return roundProgress(events, {
    split: 8, currentSplit: 9, rates: { EUR: 0.256, GBP: 0.256 }, discountByRound: discounts, sellable: (lana) => lana >= 1,
  });
}

describe('paid out, and out of how much', () => {
  it('a round: paid, agreed, and what the unsold LANA comes to at the round terms', () => {
    const p = progress(
      [budget({ fundSettingId: '1' }), budget({ fundSettingId: '2', currency: 'GBP', lanaReceivedLanoshis: 2000 * LANA })],
      [sale({ offerRef: 'OFF-1', senderWallet: 'W1' })],
      [pay({ payoutId: 'PAY-1', transactionId: 1, amount: 100 })],
    ).get(1)!;

    expect(p).toMatchObject({ budgets: 2, lanaReceived: 3000, lanaAcquired: 1000, lanaUnsold: 2000, acquiredPercent: 33.33 });
    // 1,000 LANA × 0.256 = 256.00 − 22 % (56.32) = 199.68, paid 100 of it.
    expect(p.money.find(m => m.currency === 'EUR')).toEqual({
      currency: 'EUR', paid: 100, agreed: 199.68, inProgress: 0, unsoldValue: 0, total: 199.68, owed: 99.68, paidPercent: 50.08,
    });
    // 2,000 LANA × 0.256 = 512.00 − 22 % (112.64) = 399.36, nothing paid yet.
    expect(p.money.find(m => m.currency === 'GBP')).toEqual({
      currency: 'GBP', paid: 0, agreed: 0, inProgress: 0, unsoldValue: 399.36, total: 399.36, owed: 0, paidPercent: 0,
    });
  });

  /** A GBP budget whose LANA was sold in EUR is counted once, in EUR — never also as unsold GBP. */
  it('a budget sold in another currency is counted once, in the currency of the sale', () => {
    const p = progress(
      [
        budget({ fundSettingId: '1', round: 2, wallet: 'W', walletHistory: ['W'], lanaReceivedLanoshis: 1000 * LANA }),
        budget({ fundSettingId: '2', round: 2, currency: 'GBP', wallet: 'W', walletHistory: ['W'], lanaReceivedLanoshis: 1000 * LANA }),
      ],
      [sale({ offerRef: 'OFF-1', senderWallet: 'W', mandateRef: `8:2:${HEX}`, lanaLanoshis: 2000 * LANA, netFiat: 384 })],
      [pay({ payoutId: 'PAY-1', transactionId: 1, amount: 384 })],
    ).get(2)!;
    expect(p.lanaUnsold).toBe(0);
    expect(p.money).toEqual([
      { currency: 'EUR', paid: 384, agreed: 384, inProgress: 0, unsoldValue: 0, total: 384, owed: 0, paidPercent: 100 },
    ]);
  });

  it('an accepted offer not yet transferred is part of the total, and not paid', () => {
    const p = progress(
      [budget({ fundSettingId: '1' })],
      [sale({ offerRef: 'OFF-1', senderWallet: 'W1', offerStatus: 'accepted', transactionId: null, txHash: null, txStatus: null, completedAt: null })],
      [],
    ).get(1)!;
    expect(p.lanaInProgress).toBe(1000);
    expect(p.money[0]).toMatchObject({ currency: 'EUR', paid: 0, agreed: 0, inProgress: 199.68, total: 199.68, paidPercent: 0 });
  });

  it('a remainder too small to sell is worth nothing, not a few cents of "still to come"', () => {
    const p = progress(
      [budget({ fundSettingId: '1', lanaReceivedLanoshis: 1000.5 * LANA })],
      [sale({ offerRef: 'OFF-1', senderWallet: 'W1' })],
      [pay({ payoutId: 'PAY-1', transactionId: 1, amount: 199.68 })],
    ).get(1)!;
    expect(p.money[0]).toMatchObject({ unsoldValue: 0, total: 199.68, paidPercent: 100 });
  });

  it('without published terms the estimate is unknown, and so is the total — never zero', () => {
    const p = progress([budget({ fundSettingId: '1' })], [], [], new Map()).get(1)!;
    expect(p.money[0]).toMatchObject({ currency: 'EUR', unsoldValue: null, total: null, paidPercent: null });
  });

  it('a round with no budget is not reported', () => {
    expect(progress([budget({ fundSettingId: '1' })], [], []).has(2)).toBe(false);
  });
});
