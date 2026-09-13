// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildBudgetSettlements, largestRemainder, percent2, lana8, money2,
  type BudgetDefinition, type SaleInput, type PayoutInput, type BuildInput,
} from './budgetSettlement';

const SIGNER = '79730aba75d71584e8a4f9d0cc1173085e75590ce489760078d2bf6f5210d692';
const HEX = 'ce896dcbf1568709c3d89086279d7dbf69e95dea9d22af110be78febc4731602';
const W = 'LbyqPRBUQdkyzTDV9zBw4He9nUZ8gQQCci';
const LANA = 100_000_000;

const budget = (over: Partial<BudgetDefinition> = {}): BudgetDefinition => ({
  split: 8, round: 1, financerHex: HEX, fundSettingId: '70', currency: 'EUR',
  wallet: W, walletHistory: [W], lanaReceivedLanoshis: 3_201.875 * LANA,
  mandateDTag: `8:1:${HEX}`, mandateAddress: `30960:${SIGNER}:8:1:${HEX}`,
  budgetAddress: `30938:${SIGNER}:70`, mandateStatus: 'announced', ...over,
});

const sale = (over: Partial<SaleInput> = {}): SaleInput => ({
  offerRef: 'OFF-2026-052', mandateRef: `8:1:${HEX}`, senderWallet: W, currency: 'EUR',
  offerStatus: 'settled', lanaLanoshis: 3_201.875 * LANA, referenceRate: 0.256, discountPercent: 22,
  grossFiat: 819.68, netFiat: 639.35, acceptedAt: 1_789_000_000, transactionId: 357,
  txHash: 'a'.repeat(64), txStatus: 'paid', lanaMovedLanoshis: 3_201.8749 * LANA,
  completedAt: 1_789_000_600, blockHeight: 1_057_810, ...over,
});

const payout = (over: Partial<PayoutInput> = {}): PayoutInput => ({
  payoutId: 'PAY-2026-319', transactionId: 357, amount: 639.35, currency: 'EUR', recordedAt: 1_789_050_000, ...over,
});

const build = (over: Partial<BuildInput> = {}) => buildBudgetSettlements({
  budgets: [budget()], sales: [sale()], payouts: [payout()],
  terms: new Map([['8:1', { opensAt: 1_788_969_420, sellFeePercent: 22 }]]),
  signerPubkey: SIGNER, sellable: (lana) => lana >= 1, now: 1_789_300_000, ...over,
});

const tag = (tags: string[][], name: string) => tags.find(t => t[0] === name);
/** A money tag: ["fiat_paid", "<currency>", "<amount>"]. */
const fiat = (tags: string[][], name: string, currency = 'EUR') => tags.find(t => t[0] === name && t[1] === currency)?.[2];
const all = (tags: string[][], name: string) => tags.filter(t => t[0] === name);

describe('the arithmetic under it', () => {
  it('splits a whole so the parts add up exactly', () => {
    expect(largestRemainder(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(largestRemainder(100n, [2n, 1n])).toEqual([67n, 33n]);
    const parts = largestRemainder(63_935n, [320_187_500_000n, 161_234_567_891n, 7n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(63_935n);
  });

  it('shares equally when nobody received anything', () => {
    expect(largestRemainder(5n, [0n, 0n])).toEqual([3n, 2n]);
  });

  it('writes LANA to 8 decimals and money to cents, signs included', () => {
    expect(lana8(320_187_500_000n)).toBe('3201.87500000');
    expect(money2(-150n)).toBe('-1.50');
    expect(percent2(1n, 3n)).toBe('33.33');
    expect(percent2(2n, 3n)).toBe('66.67');
    expect(percent2(5n, 0n)).toBe('0.00');
  });
});

describe('one budget, sold and paid', () => {
  const { events, unattributed } = build();
  const e = events[0];

  it('is addressed by split, round and budget, and points at the budget and the mandate', () => {
    expect(unattributed).toEqual([]);
    expect(e.dTag).toBe('8:1:70');
    expect(e.tags.slice(0, 4)).toEqual([
      ['d', '8:1:70'], ['p', HEX], ['a', `30938:${SIGNER}:70`], ['a', `30960:${SIGNER}:8:1:${HEX}`],
    ]);
    expect(tag(e.tags, 'budget')).toEqual(['budget', '70']);
    expect(tag(e.tags, 'wallet')).toEqual(['wallet', W]);
  });

  it('carries the round terms published in KIND 38888', () => {
    expect(tag(e.tags, 'opens_at')).toEqual(['opens_at', '1788969420']);
    expect(tag(e.tags, 'sell_fee_percent')).toEqual(['sell_fee_percent', '22']);
  });

  it('adds up to a finished, fully paid budget', () => {
    expect(tag(e.tags, 'lana_received')).toEqual(['lana_received', '3201.87500000']);
    expect(tag(e.tags, 'lana_acquired_lanoshis')).toEqual(['lana_acquired_lanoshis', '320187500000']);
    expect(tag(e.tags, 'lana_remaining_lanoshis')).toEqual(['lana_remaining_lanoshis', '0']);
    expect(all(e.tags, 'fiat_agreed')).toEqual([['fiat_agreed', 'EUR', '639.35']]);
    expect(all(e.tags, 'fiat_paid')).toEqual([['fiat_paid', 'EUR', '639.35']]);
    expect(all(e.tags, 'fiat_outstanding')).toEqual([['fiat_outstanding', 'EUR', '0.00']]);
    expect(tag(e.tags, 'acquired_percent')).toEqual(['acquired_percent', '100.00']);
    expect(tag(e.tags, 'paid_percent')).toEqual(['paid_percent', '100.00']);
    expect(tag(e.tags, 'acquisition')).toEqual(['acquisition', 'full']);
    expect(tag(e.tags, 'payment')).toEqual(['payment', 'full']);
  });

  it('lists the sale, how it was priced, and the payment, each linked to its own event', () => {
    expect(all(e.tags, 'sale')).toEqual([[
      'sale', 'OFF-2026-052', 'confirmed', 'EUR', '320187500000', '639.35', '320187500000', '639.35', 'a'.repeat(64), '1789000600',
    ]]);
    expect(all(e.tags, 'sale_price')).toEqual([[
      'sale_price', 'OFF-2026-052', '0.256', '22', '819.68', '320187490000', '1789000000', '1057810',
    ]]);
    expect(all(e.tags, 'payout')).toEqual([['payout', 'PAY-2026-319', 'OFF-2026-052', 'EUR', '639.35', '639.35', '1789050000']]);
    expect(all(e.tags, 'a').map(t => t[1])).toContain(`30936:${SIGNER}:357`);
    expect(all(e.tags, 'a').map(t => t[1])).toContain(`30937:${SIGNER}:PAY-2026-319`);
  });

  it('mirrors the tags in content, and says tags are the authority', () => {
    const c = JSON.parse(e.content);
    expect(c.note).toMatch(/Tags are authoritative/);
    expect(c.totals).toMatchObject({ paid_percent: '100.00', fiat_paid: { EUR: '639.35' }, acquisition: 'full', payment: 'full' });
    expect(c.sales[0]).toMatchObject({ offer_ref: 'OFF-2026-052', budget_lana: '3201.87500000' });
    expect(c.payouts[0]).toMatchObject({ payout_id: 'PAY-2026-319', budget_amount: '639.35' });
  });

  it('ends with the moment it was taken', () => {
    expect(e.tags[e.tags.length - 1]).toEqual(['snapshot_at', '1789300000']);
  });
});

describe('states in between', () => {
  it('a budget nobody has sold from is published too — with nothing in it', () => {
    const e = build({ sales: [], payouts: [] }).events[0];
    expect(tag(e.tags, 'acquisition')?.[1]).toBe('none');
    expect(tag(e.tags, 'payment')?.[1]).toBe('none');
    expect(tag(e.tags, 'paid_percent')?.[1]).toBe('0.00');
    expect(tag(e.tags, 'lana_remaining_lanoshis')?.[1]).toBe('320187500000');
    expect(all(e.tags, 'sale')).toEqual([]);
  });

  it('agreed but not yet transferred is in progress, not acquired', () => {
    const e = build({ sales: [sale({ offerStatus: 'accepted', transactionId: null, txHash: null, txStatus: null, completedAt: null })], payouts: [] }).events[0];
    expect(tag(e.tags, 'lana_in_progress_lanoshis')?.[1]).toBe('320187500000');
    expect(tag(e.tags, 'lana_acquired_lanoshis')?.[1]).toBe('0');
    expect(fiat(e.tags, 'fiat_agreed')).toBe('0.00');
    expect(tag(e.tags, 'acquisition')?.[1]).toBe('partly');
    expect(all(e.tags, 'sale')[0][2]).toBe('accepted');
    expect(all(e.tags, 'a').some(t => t[1].startsWith('30936:'))).toBe(false);
  });

  it('transferred and waiting for confirmation is acquired, and says so', () => {
    const e = build({ sales: [sale({ txStatus: 'broadcast' })], payouts: [] }).events[0];
    expect(all(e.tags, 'sale')[0][2]).toBe('transferred');
    expect(tag(e.tags, 'acquired_percent')?.[1]).toBe('100.00');
    expect(tag(e.tags, 'payment')?.[1]).toBe('none');
  });

  /** Primož Medjo: 2,510 of 3,191.17 LANA sold, and paid in two parts. */
  it('part sold, part paid — the percent follows the money actually recorded', () => {
    const e = build({
      budgets: [budget({ lanaReceivedLanoshis: 3_191.17 * LANA })],
      sales: [sale({ lanaLanoshis: 2_510 * LANA, netFiat: 501.2 })],
      payouts: [payout({ amount: 250.6 })],
    }).events[0];
    expect(tag(e.tags, 'acquired_percent')?.[1]).toBe('78.65');
    expect(tag(e.tags, 'lana_paid_lanoshis')?.[1]).toBe(String(1_255 * LANA));
    expect(tag(e.tags, 'paid_percent')?.[1]).toBe('39.33');
    expect(fiat(e.tags, 'fiat_outstanding')).toBe('250.60');
    expect(tag(e.tags, 'acquisition')?.[1]).toBe('partly');
    expect(tag(e.tags, 'payment')?.[1]).toBe('partly');
  });

  /** Boštjan Zajc: 0.02 LANA short of the mandate, and finished. */
  it('a crumb left unsold does not keep a budget open', () => {
    const e = build({
      budgets: [budget({ lanaReceivedLanoshis: 32_535.08 * LANA })],
      sales: [sale({ lanaLanoshis: 32_535.06 * LANA })],
      payouts: [payout({ amount: 639.35 })],
    }).events[0];
    expect(tag(e.tags, 'lana_remaining_lanoshis')?.[1]).toBe('2000000');
    expect(tag(e.tags, 'acquisition')?.[1]).toBe('full');
  });

  it('an overpayment shows as a negative outstanding, and never lifts the percent over what was sold', () => {
    const e = build({ payouts: [payout({ amount: 700 })] }).events[0];
    expect(fiat(e.tags, 'fiat_outstanding')).toBe('-60.65');
    expect(tag(e.tags, 'paid_percent')?.[1]).toBe('100.00');
  });

  it('a payment in another currency is reported in that currency, and does not pay this price', () => {
    const e = build({ payouts: [payout({ currency: 'GBP' })] }).events[0];
    expect(fiat(e.tags, 'fiat_paid', 'EUR')).toBe('0.00');
    expect(fiat(e.tags, 'fiat_paid', 'GBP')).toBe('639.35');
    expect(tag(e.tags, 'paid_percent')?.[1]).toBe('0.00');
    expect(tag(e.tags, 'payment')?.[1]).toBe('partly');
  });
});

describe('which budget a sale belongs to', () => {
  /**
   * 8:1:e0136876… — two GBP budgets in one wallet. Nothing on the chain says
   * whose LANA left it, so each gets its share by what it received.
   */
  it('two budgets in one wallet share the sale and its payments in proportion, exactly', () => {
    const shared = 'LZBE9KtfPwcXyj5hRamhoHACyiWGwjoQxe';
    const { events } = build({
      budgets: [
        budget({ fundSettingId: '81', currency: 'GBP', wallet: shared, walletHistory: [shared], lanaReceivedLanoshis: 2_000 * LANA }),
        budget({ fundSettingId: '80', currency: 'GBP', wallet: shared, walletHistory: [shared], lanaReceivedLanoshis: 1_000 * LANA }),
      ],
      sales: [sale({ currency: 'GBP', senderWallet: shared, lanaLanoshis: 3_000 * LANA + 1, netFiat: 599.03 })],
      payouts: [payout({ currency: 'GBP', amount: 599.03 })],
    });
    expect(events.map(e => e.dTag)).toEqual(['8:1:80', '8:1:81']);
    const [b80, b81] = events;
    expect(all(b80.tags, 'sale')[0].slice(4, 8)).toEqual(['300000000001', '599.03', '100000000000', '199.68']);
    expect(all(b81.tags, 'sale')[0].slice(4, 8)).toEqual(['300000000001', '599.03', '200000000001', '399.35']);
    expect(b80.totals.lanaAcquiredLanoshis + b81.totals.lanaAcquiredLanoshis).toBe(300000000001n);
    expect(b80.totals.agreedCents.get('GBP')! + b81.totals.agreedCents.get('GBP')!).toBe(59903n);
    expect(b80.totals.paidCents.get('GBP')! + b81.totals.paidCents.get('GBP')!).toBe(59903n);
    expect(tag(b80.tags, 'paid_percent')?.[1]).toBe('100.00');
    expect(tag(b81.tags, 'paid_percent')?.[1]).toBe('100.00');
  });

  /**
   * Split 8, round 2: a EUR and a GBP budget in one wallet, all of it sold in
   * EUR. Read by currency alone this was 200% and 0%.
   */
  it('a EUR sale fills the EUR budget first, and the rest comes out of the GBP budget in that wallet', () => {
    const w = 'LbunaKqb5M5YfWWDPPzmZiihG2f8u1ijer';
    const { events } = build({
      budgets: [
        budget({ round: 2, mandateDTag: `8:2:${HEX}`, fundSettingId: '109', currency: 'EUR', wallet: w, walletHistory: [w], lanaReceivedLanoshis: 19_492.34375 * LANA }),
        budget({ round: 2, mandateDTag: `8:2:${HEX}`, fundSettingId: '110', currency: 'GBP', wallet: w, walletHistory: [w], lanaReceivedLanoshis: 19_495 * LANA }),
      ],
      sales: [
        sale({ offerRef: 'OFF-A', mandateRef: `8:2:${HEX}`, senderWallet: w, lanaLanoshis: 10_000 * LANA, netFiat: 1_920, acceptedAt: 1, transactionId: 1 }),
        sale({ offerRef: 'OFF-B', mandateRef: `8:2:${HEX}`, senderWallet: w, lanaLanoshis: 28_987.34375 * LANA, netFiat: 5_565.57, acceptedAt: 2, transactionId: 2 }),
      ],
      payouts: [payout({ transactionId: 1, amount: 1_920 }), payout({ payoutId: 'PAY-2', transactionId: 2, amount: 5_565.57 })],
      terms: new Map(),
    });
    const [eur, gbp] = events;
    // The first sale fits the EUR budget whole.
    expect(all(eur.tags, 'sale')[0].slice(6, 8)).toEqual([String(10_000 * LANA), '1920.00']);
    expect(all(gbp.tags, 'sale').map(x => x[1])).toEqual(['OFF-B']);
    // Both budgets end fully acquired and paid — and the GBP budget's money is EUR.
    expect(tag(eur.tags, 'acquired_percent')?.[1]).toBe('100.00');
    expect(tag(gbp.tags, 'acquired_percent')?.[1]).toBe('100.00');
    expect(tag(gbp.tags, 'paid_percent')?.[1]).toBe('100.00');
    expect(all(gbp.tags, 'fiat_paid')).toEqual([['fiat_paid', 'GBP', '0.00'], ['fiat_paid', 'EUR', expect.any(String)]]);
    expect(eur.totals.lanaAcquiredLanoshis + gbp.totals.lanaAcquiredLanoshis).toBe(BigInt(38_987.34375 * LANA));
    expect(eur.totals.paidCents.get('EUR')! + gbp.totals.paidCents.get('EUR')!).toBe(748_557n);
  });

  it('what no budget in the wallet still had stays with the sale currency', () => {
    const { events } = build({ sales: [sale({ lanaLanoshis: 4_000 * LANA })], payouts: [] });
    expect(tag(events[0].tags, 'lana_acquired_lanoshis')?.[1]).toBe(String(4_000 * LANA));
    expect(tag(events[0].tags, 'acquired_percent')?.[1]).toBe('124.93');
  });

  /** Rok Bele, 12 Sept 2026: the key was lost and the budget moved to a new wallet. */
  it('a wallet the budget used to have still counts', () => {
    const old = 'LbzwD8aDfgmPH65gstkLHYiXL14b2yTiR7';
    const now = 'LZCnJ282PPmkZiq11u4m1dieQrAvjm3wyo';
    const { events, unattributed } = build({
      budgets: [budget({ wallet: now, walletHistory: [old, now] })],
      sales: [sale({ senderWallet: old })],
    });
    expect(unattributed).toEqual([]);
    expect(all(events[0].tags, 'sale')).toHaveLength(1);
    expect(tag(events[0].tags, 'wallet')?.[1]).toBe(now);
  });

  it('never guesses: a sale no budget claims is reported, not attached', () => {
    const { events, unattributed } = build({ sales: [sale({ senderWallet: 'LsomethingElse' })] });
    expect(unattributed).toEqual(['OFF-2026-052']);
    expect(all(events[0].tags, 'sale')).toEqual([]);
  });

  it('a sale under another round is not this round', () => {
    const { unattributed } = build({ sales: [sale({ mandateRef: `8:2:${HEX}` })] });
    expect(unattributed).toEqual(['OFF-2026-052']);
  });
});

describe('what the event must not carry', () => {
  it('no bank account, no name, no operator note — they are not even inputs', () => {
    const e = build({ payouts: [{ ...payout(), paid_to_account: 'SI56 0204 5106 2428 193', note: 'called twice' } as any] }).events[0];
    const text = JSON.stringify(e.tags) + e.content;
    expect(text).not.toContain('SI56');
    expect(text).not.toContain('called twice');
  });
});

describe('when it has to be published again', () => {
  it('the same facts at a later moment hash the same', () => {
    const a = build({ now: 1_789_300_000 }).events[0];
    const b = build({ now: 1_789_999_999 }).events[0];
    expect(a.hash).toBe(b.hash);
    expect(a.content).not.toBe(b.content);
  });

  it('a new payment changes it', () => {
    const a = build({ payouts: [] }).events[0];
    const b = build().events[0];
    expect(a.hash).not.toBe(b.hash);
  });

  it('a moved round date changes it', () => {
    const a = build().events[0];
    const b = build({ terms: new Map([['8:1', { opensAt: 1_788_969_421, sellFeePercent: 22 }]]) }).events[0];
    expect(a.hash).not.toBe(b.hash);
  });
});
