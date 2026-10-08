/**
 * WHAT THE WALLET LACKS, SAID BEFORE ANY KEY IS ASKED FOR.
 *
 * Owner, 8 Oct 2026: a financer moves to their Lana.Discount wallet as much
 * LANA as they owe, plus about 1 % for fees. The page says how much is missing
 * for the purchases chosen: the legs, plus the fee of the smallest send to that
 * many wallets (one coin, no change) — payoutView.ts leastShortfall — less the
 * CONFIRMED balance. Pinned here:
 *   - the figure is exact, to the lanoshi, fee included;
 *   - it follows the choice (fewer purchases, fewer wallets, a smaller figure);
 *   - a balance that may cover it says so, and the figure is 0;
 *   - nothing can be prepared while the page says why not.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FINANCER } from '@/copy';
import { ALL_CHOSEN, FinancerSendable, choiceAfterSend, choose, fittingRefs, type Choice } from './FinancerSendable';
import { fill } from './financerText';
import { lanoshisText } from '@/lib/financer/payoutView';
import { feeFor } from '../../../server/shared/lana-tx/fee.ts';
import { LANA, LIMITS, purchaseOf, sendableOf, throwawayAddress } from '@/test/financerFixtures';
import type { SendableAnswer } from '@/lib/financer/financerApi';

const t = FINANCER;

/**
 * Draws the list with its own choice, as the page keeps it (src/pages/Financer.tsx: `choose`, and `choiceAfterSend`
 * once a send went). `sent(answer)`: a send went, and the list is read again as the server answers it now.
 */
function draw(answer: SendableAnswer, opts: { blocked?: string | null; onPrepare?: () => void } = {}) {
  let choice: Choice = ALL_CHOSEN;
  let current = answer;
  const view = () => (
    <FinancerSendable
      t={t}
      answer={current}
      choice={choice}
      onChoose={(refs, on, byHand) => {
        choice = choose(choice, refs, on, byHand);
        rerender(view());
      }}
      locked={false}
      blocked={opts.blocked ?? null}
      preparing={false}
      onPrepare={opts.onPrepare ?? (() => {})}
    />
  );
  const { rerender } = render(view());
  return {
    sent(next: SendableAnswer) {
      choice = choiceAfterSend(choice);
      current = next;
      rerender(view());
    },
  };
}

const [w1, w2, w3] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
// The brain's real leg amounts of 8 Oct 2026: whole lanoshis, never round LANA.
const purchases = [
  purchaseOf('TX-A', [
    { id: 'a1', type: 'customer_cashback', to: w1, lanoshis: 1_004_492_188n },
    { id: 'a2', type: 'caretaker_commission', to: w2, lanoshis: 10_338_867_187n },
  ]),
  purchaseOf('TX-B', [{ id: 'b1', type: 'investor_lana', to: w3, lanoshis: 3_446_289_063n }]),
];
const total = 1_004_492_188n + 10_338_867_187n + 3_446_289_063n;

describe('the shortfall', () => {
  it('is the legs plus the fee of the smallest send, less the confirmed balance — to the lanoshi', () => {
    const balance = 50n * LANA;
    draw(sendableOf('L-mine', purchases, balance));
    const expected = total + feeFor(1, 3) - balance;
    expect(expected).toBeGreaterThan(0n);
    expect(screen.getByTestId('financer-to-send').textContent).toBe(`${lanoshisText(total)} LANA`);
    expect(screen.getByTestId('financer-shortfall').textContent).toBe(`${lanoshisText(expected)} LANA`);
    expect(screen.getByTestId('financer-shortfall-hint').textContent).toContain(lanoshisText(expected));
  });

  it('follows the choice: one purchase fewer, one wallet fewer, a smaller figure', () => {
    const balance = 20n * LANA;
    draw(sendableOf('L-mine', purchases, balance));
    fireEvent.click(screen.getByRole('checkbox', { name: /TX-A/ }));
    const expected = 3_446_289_063n + feeFor(1, 1) - balance;
    expect(expected).toBeGreaterThan(0n);
    expect(expected).toBeLessThan(total + feeFor(1, 3) - balance);
    expect(screen.getByTestId('financer-to-send').textContent).toBe(`${lanoshisText(3_446_289_063n)} LANA`);
    expect(screen.getByTestId('financer-shortfall').textContent).toBe(`${lanoshisText(expected)} LANA`);
  });

  it('is 0 when the confirmed balance may cover it, and says so', () => {
    draw(sendableOf('L-mine', purchases, 1_000n * LANA));
    expect(screen.getByTestId('financer-shortfall').textContent).toBe(`${lanoshisText(0n)} LANA`);
    expect(screen.getByTestId('financer-shortfall-hint').textContent).toBe(t.enough);
  });

  it('for all purchases, the server’s own figure is said above the list', () => {
    draw(sendableOf('L-mine', purchases, 0n, { shortfallLanoshis: (total + feeFor(1, 3)).toString() }));
    expect(screen.getByTestId('financer-sendable').textContent).toContain(lanoshisText(total + feeFor(1, 3)));
  });

  it('nothing is prepared while the page says why not', () => {
    const onPrepare = vi.fn();
    draw(sendableOf('L-mine', purchases, 1_000n * LANA), { blocked: t.inFlightBlock, onPrepare });
    expect(screen.getByText(t.inFlightBlock)).toBeInTheDocument();
    const prepare = screen.getByRole('button', { name: t.prepare });
    expect(prepare).toBeDisabled();
    fireEvent.click(prepare);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it('nothing chosen, nothing to prepare', () => {
    const onPrepare = vi.fn();
    draw(sendableOf('L-mine', purchases, 1_000n * LANA), { onPrepare });
    fireEvent.click(screen.getByRole('button', { name: t.chooseNone }));
    expect(screen.getByRole('button', { name: t.prepare })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: t.chooseAll }));
    fireEvent.click(screen.getByRole('button', { name: t.prepare }));
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });
});

/**
 * ONE SEND HAS LIMITS (review C18/C21): at most 98 wallets AND at most 400
 * payments (legs, sends.ts MAX_ORDER_IDS). A financer with repeat customers has
 * hundreds of purchases, all chosen by default, sharing the budget, merchant
 * and caretaker wallets — so the 400 payments fill before the 98 wallets do,
 * and the server's refusal used to read "could not be read, refresh".
 */
describe('what one send can carry', () => {
  const [budget, merchant, caretaker] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
  const customers = Array.from({ length: 20 }, () => throwawayAddress());
  /** 101 purchases of 4 legs each (404 payments), to 23 wallets: under the wallet limit, over the payment limit. */
  const repeat = Array.from({ length: 101 }, (_, i) =>
    purchaseOf(`TX-${String(i).padStart(3, '0')}`, [
      { id: `p${i}-1`, type: 'customer_cashback', to: customers[i % customers.length], lanoshis: 1_004_492_188n },
      { id: `p${i}-2`, type: 'merchant_commission', to: merchant, lanoshis: 10_338_867_187n },
      { id: `p${i}-3`, type: 'caretaker_commission', to: caretaker, lanoshis: 3_446_289_063n },
      { id: `p${i}-4`, type: 'investor_lana', to: budget, lanoshis: 2_000_000_000n },
    ]),
  );

  it('over 400 payments, under 98 wallets: the payments are counted, Prepare is off and one sentence says why', () => {
    const onPrepare = vi.fn();
    draw(sendableOf('L-mine', repeat, 100_000n * LANA), { onPrepare });
    expect(screen.getByTestId('financer-legs').textContent).toBe('404 of at most 400');
    expect(screen.getByTestId('financer-over-limits').textContent).toBe(fill(t.overLimits, { wallets: 98, legs: 400, button: t.chooseFits }));
    const prepare = screen.getByRole('button', { name: t.prepare });
    expect(prepare).toBeDisabled();
    fireEvent.click(prepare);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it('»Choose what fits« takes the oldest purchases while they fit — 100 of them, 400 payments — and Prepare is on', () => {
    const onPrepare = vi.fn();
    draw(sendableOf('L-mine', repeat, 100_000n * LANA), { onPrepare });
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByTestId('financer-legs').textContent).toBe('400 of at most 400');
    expect(screen.queryByTestId('financer-over-limits')).toBeNull();
    // The newest one waits for the next send; every older one is chosen.
    expect(screen.getByRole('checkbox', { name: /TX-100/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-099/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: t.prepare }));
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });

  it('over 98 wallets: the same sentence, and »Choose what fits« stops at the wallet limit', () => {
    // Each purchase pays a new customer and the shared budget: 120 purchases, 121 wallets, 240 payments.
    const many = Array.from({ length: 120 }, (_, i) =>
      purchaseOf(`TX-${String(i).padStart(3, '0')}`, [
        { id: `w${i}-1`, type: 'customer_cashback', to: throwawayAddress(), lanoshis: 1_004_492_188n },
        { id: `w${i}-2`, type: 'investor_lana', to: budget, lanoshis: 2_000_000_000n },
      ]),
    );
    draw(sendableOf('L-mine', many, 100_000n * LANA));
    expect(screen.getByRole('button', { name: t.prepare })).toBeDisabled();
    expect(screen.getByTestId('financer-over-limits')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('button', { name: t.prepare })).toBeEnabled();
    expect(fittingRefs(many, LIMITS)).toEqual(many.slice(0, 97).map((p) => p.transactionRef));
  });

  it('takes purchases in the order listed and stops at the first that does not fit — never a newer one before an older', () => {
    const [a, b, c] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
    const list = [
      purchaseOf('TX-1', [{ id: '1', type: 'customer_cashback', to: a, lanoshis: 1_004_492_188n }]),
      purchaseOf('TX-2', [
        { id: '2', type: 'customer_cashback', to: b, lanoshis: 1_004_492_188n },
        { id: '3', type: 'investor_lana', to: c, lanoshis: 1_004_492_188n },
      ]),
      purchaseOf('TX-3', [{ id: '4', type: 'customer_cashback', to: a, lanoshis: 1_004_492_188n }]),
    ];
    expect(fittingRefs(list, { maxWallets: 2, maxLegs: 400 })).toEqual(['TX-1']);
    expect(fittingRefs(list, { maxWallets: 98, maxLegs: 3 })).toEqual(['TX-1', 'TX-2']);
    expect(fittingRefs(list, LIMITS)).toEqual(['TX-1', 'TX-2', 'TX-3']);
  });

  it('»Choose what fits« keeps a purchase the financer unticked unticked — it chooses within the choice (review N11)', () => {
    // A refused send holds the oldest purchase back (MUST_SPEND_OTHER_WALLET says: untick it). The financer does, then
    // presses the button: it must never tick that one again — the same refusal would follow, round in a circle.
    draw(sendableOf('L-mine', repeat, 100_000n * LANA));
    fireEvent.click(screen.getByRole('checkbox', { name: /TX-000/ }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    // The other 100 (400 payments) fit together, so every one of them stays chosen — the newest included.
    expect(screen.getByRole('checkbox', { name: /TX-001/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-100/ })).toBeChecked();
    expect(screen.getByTestId('financer-legs').textContent).toBe('400 of at most 400');
    expect(screen.queryByTestId('financer-over-limits')).toBeNull();
  });

  it('»Choose what fits« over a choice still too big keeps its oldest that fit, and never one unticked; with nothing chosen it chooses from all but the ones unticked by hand', () => {
    // 103 purchases (412 payments). Untick TX-001: 102 chosen, 408 payments — still over.
    const more = [...repeat, ...[101, 102].map((i) =>
      purchaseOf(`TX-${i}`, [
        { id: `q${i}-1`, type: 'customer_cashback', to: customers[0], lanoshis: 1_004_492_188n },
        { id: `q${i}-2`, type: 'merchant_commission', to: merchant, lanoshis: 10_338_867_187n },
        { id: `q${i}-3`, type: 'caretaker_commission', to: caretaker, lanoshis: 3_446_289_063n },
        { id: `q${i}-4`, type: 'investor_lana', to: budget, lanoshis: 2_000_000_000n },
      ]))];
    draw(sendableOf('L-mine', more, 100_000n * LANA));
    fireEvent.click(screen.getByRole('checkbox', { name: /TX-001/ }));
    expect(screen.getByTestId('financer-over-limits')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-001/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-100/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).not.toBeChecked();
    expect(screen.getByTestId('financer-legs').textContent).toBe('400 of at most 400');

    // Nothing chosen: the oldest that fit, from all of them but TX-001, which the financer unticked by hand (review M8).
    fireEvent.click(screen.getByRole('button', { name: t.chooseNone }));
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-001/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-099/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-100/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).not.toBeChecked();
    expect(screen.getByTestId('financer-legs').textContent).toBe('400 of at most 400');

    // »Choose all« is the financer's own word too: every one chosen again, TX-001 included.
    fireEvent.click(screen.getByRole('button', { name: t.chooseAll }));
    expect(screen.getByRole('checkbox', { name: /TX-001/ })).toBeChecked();
  });

  it('round after round, a purchase unticked by hand stays out — never ticked again by »Choose what fits« (review M8)', () => {
    // 300 purchases of 4 payments; TX-000 is held by an earlier send refused from another wallet, so the financer
    // unticks it. Round 1: »Choose what fits« takes TX-001..TX-100 (400 payments) and they are sent.
    const list = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => {
      const i = from + k;
      return purchaseOf(`TX-${String(i).padStart(3, '0')}`, [
        { id: `r${i}-1`, type: 'customer_cashback', to: customers[i % customers.length], lanoshis: 1_004_492_188n },
        { id: `r${i}-2`, type: 'merchant_commission', to: merchant, lanoshis: 10_338_867_187n },
        { id: `r${i}-3`, type: 'caretaker_commission', to: caretaker, lanoshis: 3_446_289_063n },
        { id: `r${i}-4`, type: 'investor_lana', to: budget, lanoshis: 2_000_000_000n },
      ]);
    });
    const all = list(0, 300);
    const view = draw(sendableOf('L-mine', all, 100_000n * LANA));
    fireEvent.click(screen.getByRole('checkbox', { name: /TX-000/ }));
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-001/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-100/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).not.toBeChecked();

    // Sent: TX-000 and TX-101..TX-299 are left (800 payments, still over). What the button left out is chosen again;
    // TX-000 stays out.
    view.sent(sendableOf('L-mine', [all[0], ...list(101, 300)], 100_000n * LANA));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-299/ })).toBeChecked();
    expect(screen.getByTestId('financer-over-limits')).toBeInTheDocument();

    // Round 2: the button takes TX-101..TX-200 — and never TX-000 again.
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-200/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-201/ })).not.toBeChecked();
    expect(screen.getByTestId('financer-legs').textContent).toBe('400 of at most 400');

    // The same after »Choose none«: with nothing chosen, the button chooses from all but TX-000.
    fireEvent.click(screen.getByRole('button', { name: t.chooseNone }));
    fireEvent.click(screen.getByRole('button', { name: t.chooseFits }));
    expect(screen.getByRole('checkbox', { name: /TX-000/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-101/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-200/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TX-201/ })).not.toBeChecked();
  });

  it('when all of them fit, there is nothing to say and no »Choose what fits«', () => {
    draw(sendableOf('L-mine', purchases, 1_000n * LANA));
    expect(screen.getByTestId('financer-legs').textContent).toBe('3 of at most 400');
    expect(screen.queryByTestId('financer-over-limits')).toBeNull();
    expect(screen.queryByRole('button', { name: t.chooseFits })).toBeNull();
  });
});
