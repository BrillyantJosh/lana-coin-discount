// @vitest-environment node
/**
 * THE ONE SETTLEMENT ORDER — round 1, then 2, then 3, then outside a round.
 *
 * The owner's instruction (4 Sep 2026): the financing-round order is the only
 * order now. The old ranks, bands and "payable / waiting" verdicts are gone,
 * and nothing must quietly reintroduce them. These tests pin the public list:
 * what is ranked, what is not, and what the feed no longer says.
 */
import { describe, it, expect } from 'vitest';
import { groupObligations, compareSettlementOrder, type ObligationUser } from './obligations';

const noFreeze = () => null;

const sale = (over: Partial<ObligationUser['sales'][number]> & { currency: string }) => ({
  status: 'completed',
  remaining: 10,
  createdAt: '2026-09-20 10:00:00',
  round: null,
  mandateSplit: null,
  ...over,
});

describe('the public settlement order', () => {
  it('lists round 1 before round 2 before round 3, and a sale outside a round last', () => {
    const users: ObligationUser[] = [
      { hexId: 'c'.repeat(64), displayName: 'Outside', sales: [sale({ currency: 'EUR', createdAt: '2026-09-01 00:00:00' })] },
      { hexId: 'b'.repeat(64), displayName: 'Round two', sales: [sale({ currency: 'EUR', round: 2, mandateSplit: 8, createdAt: '2026-09-02 00:00:00' })] },
      { hexId: 'd'.repeat(64), displayName: 'Round three', sales: [sale({ currency: 'EUR', round: 3, mandateSplit: 8, createdAt: '2026-09-03 00:00:00' })] },
      { hexId: 'a'.repeat(64), displayName: 'Round one', sales: [sale({ currency: 'EUR', round: 1, mandateSplit: 8, createdAt: '2026-09-04 00:00:00' })] },
    ];
    const { currencies } = groupObligations(users, noFreeze);
    const names = currencies.EUR.settlements.map(s => s.name);
    expect(names).toEqual(['Round one', 'Round two', 'Round three', 'Outside']);
    expect(currencies.EUR.settlements.map(s => s.round)).toEqual([1, 2, 3, null]);
    expect(currencies.EUR.settlements.map(s => s.mandate_split)).toEqual([8, 8, 8, null]);
    expect(currencies.EUR.settlements.map(s => s.position)).toEqual([1, 2, 3, 4]);
  });

  it('inside a round, and among the round-less, the earliest acquisition comes first', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'Later', sales: [sale({ currency: 'EUR', round: 1, createdAt: '2026-09-05 00:00:00' })] },
      { hexId: 'b'.repeat(64), displayName: 'Earlier', sales: [sale({ currency: 'EUR', round: 1, createdAt: '2026-09-04 00:00:00' })] },
      { hexId: 'c'.repeat(64), displayName: 'Legacy later', sales: [sale({ currency: 'EUR', createdAt: '2026-08-02 00:00:00' })] },
      { hexId: 'd'.repeat(64), displayName: 'Legacy earlier', sales: [sale({ currency: 'EUR', createdAt: '2026-08-01 00:00:00' })] },
    ];
    const { currencies } = groupObligations(users, noFreeze);
    expect(currencies.EUR.settlements.map(s => s.name)).toEqual(['Earlier', 'Later', 'Legacy earlier', 'Legacy later']);
  });

  it('orders each currency on its own', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'A', sales: [
        sale({ currency: 'EUR', round: 3 }),
        sale({ currency: 'GBP', round: 1 }),
      ] },
      { hexId: 'b'.repeat(64), displayName: 'B', sales: [
        sale({ currency: 'EUR', round: 1 }),
        sale({ currency: 'GBP', round: 2 }),
      ] },
    ];
    const { currencies, total_currencies } = groupObligations(users, noFreeze);
    expect(total_currencies).toBe(2);
    expect(currencies.EUR.settlements.map(s => s.name)).toEqual(['B', 'A']);
    expect(currencies.GBP.settlements.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('places a counterparty with several acquisitions under the earliest round', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'Two rounds', sales: [
        sale({ currency: 'EUR', round: 3, mandateSplit: 8, remaining: 5, createdAt: '2026-09-01 00:00:00' }),
        sale({ currency: 'EUR', round: 1, mandateSplit: 8, remaining: 7, createdAt: '2026-09-09 00:00:00' }),
        sale({ currency: 'EUR', remaining: 1, createdAt: '2026-09-10 00:00:00' }),
      ] },
      { hexId: 'b'.repeat(64), displayName: 'Round two', sales: [sale({ currency: 'EUR', round: 2, createdAt: '2026-09-02 00:00:00' })] },
    ];
    const { currencies } = groupObligations(users, noFreeze);
    const [first, second] = currencies.EUR.settlements;
    expect(first.name).toBe('Two rounds');
    expect(first.round).toBe(1);
    expect(first.outstanding).toBe(13);
    expect(second.name).toBe('Round two');
    expect(currencies.EUR.total_outstanding).toBe(23);
  });

  it('counts only completed or paid sales with a purchase price still owed', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'Settled', sales: [sale({ currency: 'EUR', status: 'paid', remaining: 0 })] },
      { hexId: 'b'.repeat(64), displayName: 'Confirming', sales: [sale({ currency: 'EUR', status: 'broadcast' })] },
      { hexId: 'c'.repeat(64), displayName: 'Owed', sales: [sale({ currency: 'EUR', round: 2 })] },
    ];
    const { currencies } = groupObligations(users, noFreeze);
    expect(currencies.EUR.count).toBe(1);
    expect(currencies.EUR.settlements[0].name).toBe('Owed');
  });

  it('says nothing about ranks, bands or who is payable — the round is the whole story', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'A', sales: [sale({ currency: 'EUR', round: 1 })] },
    ];
    const { currencies } = groupObligations(users, noFreeze);
    const line = currencies.EUR.settlements[0] as unknown as Record<string, unknown>;
    for (const gone of ['is_financier', 'finance_rank', 'is_crowdfunder', 'payable', 'priority']) {
      expect(line).not.toHaveProperty(gone);
    }
    const block = currencies.EUR as unknown as Record<string, unknown>;
    expect(block).not.toHaveProperty('financier_count');
    expect(block).not.toHaveProperty('crowdfunder_count');
    // The deprecated alias still points at the same list for one release.
    expect(block.queue).toBe(currencies.EUR.settlements);
    // Only the short hex is published.
    expect(line.hex_short).toBe('aaaaaaaa');
  });

  it('carries the freeze status through, and null when it is not resolved yet', () => {
    const users: ObligationUser[] = [
      { hexId: 'a'.repeat(64), displayName: 'Frozen', sales: [sale({ currency: 'EUR' })] },
      { hexId: 'b'.repeat(64), displayName: 'Unknown', sales: [sale({ currency: 'EUR' })] },
    ];
    const freezeOf = (hex: string) => hex.startsWith('a')
      ? { frozen: true, level: 'wallet' as const, frozenWallets: 1, totalWallets: 3, reasons: ['frozen_max_cap'] }
      : null;
    const { currencies } = groupObligations(users, freezeOf);
    const [frozen, unknown] = currencies.EUR.settlements;
    expect(frozen.frozen).toBe(true);
    expect(frozen.freeze_level).toBe('wallet');
    expect(unknown.frozen).toBeNull();
    expect(unknown.freeze_level).toBeNull();
  });
});

describe('compareSettlementOrder', () => {
  it('is the same comparison the admin screen uses: round, null last, then date', () => {
    const rows = [
      { round: null, earliestAt: '2026-01-01' },
      { round: 2, earliestAt: '2026-01-05' },
      { round: 1, earliestAt: '2026-01-09' },
      { round: 1, earliestAt: '2026-01-02' },
      { round: 3, earliestAt: '2026-01-01' },
    ];
    expect([...rows].sort(compareSettlementOrder)).toEqual([
      { round: 1, earliestAt: '2026-01-02' },
      { round: 1, earliestAt: '2026-01-09' },
      { round: 2, earliestAt: '2026-01-05' },
      { round: 3, earliestAt: '2026-01-01' },
      { round: null, earliestAt: '2026-01-01' },
    ]);
  });
});
