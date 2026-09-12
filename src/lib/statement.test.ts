import { describe, it, expect } from 'vitest';
import {
  buildStatementHtml, orderNewestFirst, totalsByCurrency, statementReference,
  type StatementSale, type StatementPayout,
} from './statement';

const HEX = 'ce896dcbf1568709c3d89086279d7dbf69e95dea9d22af110be78febc4731602';
const ISSUED = '2026-09-12T12:34:56.000Z';

const payout = (over: Partial<StatementPayout> = {}): StatementPayout => ({
  payoutId: 'PAY-2026-319', amount: 501.2, currency: 'EUR',
  paidAt: '2026-09-11 03:40:00', paidToAccount: 'SI56 1910 0000 1234 567', reference: null, ...over,
});

const sale = (over: Partial<StatementSale> = {}): StatementSale => ({
  id: 357, createdAt: '2026-09-10 02:07:30', acceptedAt: '2026-09-10 02:05:00',
  completedAt: '2026-09-10 02:12:00', settlementDueAt: '2026-09-25', offerRef: 'OFF-2026-052',
  round: 1, mandateSplit: 8, lanaAmount: 2510, currency: 'EUR', exchangeRate: 0.256,
  grossFiat: 642.56, commissionPercent: 22, netFiat: 501.2,
  txHash: 'a'.repeat(64), senderWalletId: 'LP4Lzr48qXK6GYHSKeeG2DmagbV26KXt6r',
  treasuryWalletId: 'Lg7iw2aQp8qazNsZVZFhf4rP7bikSrLRxB',
  rpcVerified: true, rpcConfirmations: 6, rpcBlockHeight: 1_057_810,
  rpcVerifiedAt: '2026-09-10 02:20:00', payouts: [payout()], ...over,
});

const html = (sales: StatementSale[], name = 'Primož Medjo') =>
  buildStatementHtml({ counterpartyName: name, counterpartyHex: HEX, sales, issuedAt: ISSUED });

describe('the order the owner asked for', () => {
  it('puts the most recent transaction first', () => {
    const out = orderNewestFirst([
      sale({ id: 1, createdAt: '2026-04-02 09:00:00' }),
      sale({ id: 2, createdAt: '2026-09-10 02:07:30' }),
      sale({ id: 3, createdAt: '2026-06-01 11:00:00' }),
    ]);
    expect(out.map(s => s.id)).toEqual([2, 3, 1]);
  });

  it('keeps a stable order for two sales in the same second', () => {
    const out = orderNewestFirst([
      sale({ id: 10, createdAt: '2026-09-10 02:07:30' }),
      sale({ id: 11, createdAt: '2026-09-10 02:07:30' }),
    ]);
    expect(out.map(s => s.id)).toEqual([11, 10]);
  });

  it('and the document is in that order too', () => {
    const doc = html([
      sale({ id: 1, createdAt: '2026-04-02 09:00:00', offerRef: 'OFF-OLD' }),
      sale({ id: 2, createdAt: '2026-09-10 02:07:30', offerRef: 'OFF-NEW' }),
    ]);
    expect(doc.indexOf('OFF-NEW')).toBeLessThan(doc.indexOf('OFF-OLD'));
  });
});

describe('the figures reconcile', () => {
  it('totals each currency on its own, never across them', () => {
    const t = totalsByCurrency([
      sale({ currency: 'EUR', lanaAmount: 100, netFiat: 20, payouts: [payout({ amount: 20 })] }),
      sale({ currency: 'GBP', lanaAmount: 50, netFiat: 10, payouts: [payout({ amount: 4, currency: 'GBP' })] }),
    ]);
    expect(t.map(x => x.currency)).toEqual(['EUR', 'GBP']);
    expect(t[0]).toMatchObject({ lana: 100, agreed: 20, recorded: 20, outstanding: 0 });
    expect(t[1]).toMatchObject({ lana: 50, agreed: 10, recorded: 4, outstanding: 6 });
  });

  /**
   * The payment is what was RECORDED, which the owner chose over the agreed
   * price: "3. zabeleženo izplačilo".
   */
  it('counts the recorded payment, not the agreed price', () => {
    const t = totalsByCurrency([sale({ netFiat: 501.2, payouts: [payout({ amount: 300 })] })]);
    expect(t[0].recorded).toBe(300);
    expect(t[0].outstanding).toBe(201.2);
  });

  it('a sale with nothing paid is outstanding in full', () => {
    expect(totalsByCurrency([sale({ payouts: [] })])[0]).toMatchObject({ recorded: 0, outstanding: 501.2 });
  });

  /** An overpayment reads as a credit; clamping it to zero hides a real error. */
  it('shows an overpayment as a negative outstanding, not as zero', () => {
    expect(totalsByCurrency([sale({ netFiat: 100, payouts: [payout({ amount: 150 })] })])[0].outstanding)
      .toBe(-50);
  });

  /** A payout made in another currency must not be added to this one. */
  it('files a payout under its own currency', () => {
    const t = totalsByCurrency([sale({ currency: 'EUR', payouts: [payout({ amount: 90, currency: 'GBP' })] })]);
    expect(t.find(x => x.currency === 'EUR')!.recorded).toBe(0);
    expect(t.find(x => x.currency === 'GBP')!.recorded).toBe(90);
  });
});

describe('what the document must not claim', () => {
  const doc = html([sale()]);

  /** `paid_at` is when an operator entered it, not when the transfer cleared. */
  it('says Recorded, never Paid, of a payout date', () => {
    expect(doc).toContain('Recorded');
    expect(doc).toMatch(/date a payment was entered in our records/);
    expect(doc).not.toMatch(/>Paid</);
  });

  /** The column is the acquisition discount; "commission" invents a fee. */
  it('calls the discount a discount', () => {
    expect(doc).toContain('Discount applied');
    expect(doc.toLowerCase()).not.toContain('commission');
  });

  /** The verifier visits a transaction once; the count never moves after that. */
  it('prints confirmations only beside the moment they were seen', () => {
    expect(doc).toMatch(/6 confirmations at that time/);
    expect(doc).not.toMatch(/>6 confirmations</);
  });

  it('marks the name as the counterparty’s own and disclaims identity checks', () => {
    expect(doc).toMatch(/as published by the counterparty in their own profile/);
    expect(doc).toMatch(/does not verify identity documents/);
  });

  /**
   * The operator's note was written for colleagues — the public board already
   * withholds it for that reason. It cannot reach the document because
   * StatementPayout has no such field, and this proves the gap is real by
   * handing one over anyway.
   */
  it('carries no operator note, even when the data has one', () => {
    const withNote = html([sale({
      payouts: [{ ...payout({ reference: 'wire 4471' }), note: 'chased him twice, seems flaky' } as never],
    })]);
    expect(withNote).toContain('wire 4471');                     // a bank reference belongs
    expect(withNote).not.toContain('chased him twice');          // the internal remark does not
    expect(withNote).not.toContain('flaky');
  });
});

describe('what a bank needs and a developer forgets', () => {
  const doc = html([sale({ createdAt: '2026-09-10 02:07:30' }), sale({ id: 1, createdAt: '2026-04-02 09:00:00' })]);

  it('names itself, its issuer and its website', () => {
    expect(doc).toContain('Statement of Account');
    expect(doc).toContain('Lana.discount P2P');
    expect(doc).toContain('https://lana.discount');
  });

  it('carries a reference the recipient can quote back, and an issue time', () => {
    expect(doc).toContain(statementReference(HEX, ISSUED));
    expect(statementReference(HEX, ISSUED)).toBe('LDS-20260912123456-CE896DCB');
    expect(doc).toMatch(/2026-09-12 12:34:56 UTC/);
  });

  it('states the period it covers and how many transactions are in it', () => {
    expect(doc).toContain('2026-04-02 to 2026-09-10');
    expect(doc).toMatch(/Transactions<\/th><td class="mono">2</);
  });

  it('says every time is UTC, and does not convert between currencies', () => {
    expect(doc).toContain('All times UTC');
    expect(doc).toMatch(/not converted between currencies/);
  });

  it('ends where it ends, so a truncated copy is obvious', () => {
    expect(doc).toContain('End of statement');
  });

  it('keeps one transaction on one page', () => {
    expect(doc).toMatch(/page-break-inside: avoid/);
  });
});

describe('the chain leg, which the owner asked to include', () => {
  it('carries the hash, both wallets and the block', () => {
    const doc = html([sale()]);
    expect(doc).toContain('a'.repeat(64));
    expect(doc).toContain('LP4Lzr48qXK6GYHSKeeG2DmagbV26KXt6r');
    expect(doc).toContain('Lg7iw2aQp8qazNsZVZFhf4rP7bikSrLRxB');
    expect(doc).toContain('1057810');
  });

  it('says plainly when a transfer was never verified', () => {
    const doc = html([sale({ rpcVerified: false, rpcVerifiedAt: null, rpcBlockHeight: null })]);
    expect(doc).toContain('not yet verified');
  });

  it('says when there is no hash rather than leaving a gap', () => {
    expect(html([sale({ txHash: null })])).toContain('— (not recorded)');
  });
});

describe('the ragged edges of real data', () => {
  it('survives a sale older than acquisition references', () => {
    const doc = html([sale({ offerRef: null, round: null, mandateSplit: null, acceptedAt: null, settlementDueAt: null })]);
    expect(doc).toContain('sold before acquisition references were issued');
    expect(doc).toContain('outside a financing round');
    expect(doc).toContain('Transaction #357');
  });

  it('says so when no payment has been recorded against a sale', () => {
    expect(html([sale({ payouts: [] })])).toContain('No payment recorded against this transaction');
  });

  it('keeps accented names intact — they are half the reason this is HTML', () => {
    const doc = html([sale()], 'Gašper Zorman · Boštjan Čarman');
    expect(doc).toContain('Gašper Zorman · Boštjan Čarman');
  });

  it('escapes anything that would otherwise break the document', () => {
    const doc = html([sale()], 'A <script>alert(1)</script> & Co');
    expect(doc).not.toContain('<script>alert');
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).toContain('&amp; Co');
  });

  it('an empty history is still a valid statement, not a blank page', () => {
    const doc = html([]);
    expect(doc).toContain('No transactions in this period');
    expect(doc).toContain('End of statement');
  });
});
