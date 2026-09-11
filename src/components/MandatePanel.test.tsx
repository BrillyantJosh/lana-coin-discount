/**
 * The mandate panel is the one place a public page shows a figure next to a
 * discount. It must carry its non-binding heading every time, keep the
 * propose button dead before the round date, phrase a counteroffer as the
 * framework does, and get the arithmetic right to the cent.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MandatePanel, indicativeFiat, proposalGate, proposableCapLana, counterBody, timingLine, fmtUtc,
  availabilityOf, type MandateView, type MandateInfo,
} from './MandatePanel';
import { OFFER } from '@/copy';

const base: MandateView = {
  mandateRef: '8:1:' + 'a'.repeat(64),
  eventId: 'e'.repeat(64),
  split: 8, round: 1, state: 'open', opensAt: '2026-09-14T22:00:00.000Z',
  discountPercent: 22, released: false, inWindow: true,
  walletCurrency: 'EUR', walletShareLana: 32527.97,
  expectedLana: 32527.97, remainingLana: 32527.97, proposedLana: 0, acceptedLana: 0, settledLana: 0,
  basis: 'current_split', referenceRate: 0.256, indicativeFor: null,
};

const info = (mandates: MandateView[]): MandateInfo => ({
  nonBinding: true, note: '', currentSplit: 9, mandates,
});

describe('the indicative figure', () => {
  it('is the server maths: LANA × reference × (1 − discount), to the cent', () => {
    // The worked example from the plan: 32,527.97 × 0.256 × 0.78 = 6,495.19.
    expect(indicativeFiat(32527.97, 0.256, 22)).toBe(6495.19);
    expect(indicativeFiat(1000, 0.256, 22)).toBe(199.68);
    expect(indicativeFiat(1000, 0.512, 25)).toBe(384);
  });

  it('is shown under the exact non-binding heading, with its basis', () => {
    render(<MandatePanel info={info([base])} loading={false} error={null} lanaAmount={1000} currency="EUR" showIndicative />);
    expect(screen.getByText('Indicative figure — not a price, not a rate, not a guarantee.')).toBeInTheDocument();
    expect(screen.getByText(OFFER.indicativeBasisCurrent)).toBeInTheDocument();
    expect(screen.getByTestId('indicative-amount').textContent).toBe('199.68 EUR');
  });

  it('names the projected basis before the Split', () => {
    render(<MandatePanel info={info([{ ...base, state: 'upcoming_split', basis: 'projected_next_split', referenceRate: 0.512 }])}
      loading={false} error={null} lanaAmount={1000} currency="EUR" showIndicative />);
    expect(screen.getByText(OFFER.indicativeBasisProjected)).toBeInTheDocument();
    expect(screen.getByTestId('indicative-amount').textContent).toBe('399.36 EUR');
  });

  it('is capped at what remains under the mandate', () => {
    render(<MandatePanel info={info([{ ...base, remainingLana: 500 }])} loading={false} error={null} lanaAmount={1000} currency="EUR" showIndicative />);
    expect(screen.getByTestId('indicative-amount').textContent).toBe('99.84 EUR');
  });

  it('is absent when there is no mandate', () => {
    render(<MandatePanel info={info([])} loading={false} error={null} lanaAmount={1000} currency="EUR" showIndicative />);
    expect(screen.queryByTestId('indicative-box')).toBeNull();
    expect(screen.getByText('No financing-round mandate for this wallet')).toBeInTheDocument();
  });
});

describe('proposing before the date', () => {
  it('is not allowed, and the reason is the round date in UTC', () => {
    const gate = proposalGate(info([{ ...base, state: 'not_open' }]));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('Round 1 opens on 14 Sep 2026, 22:00 UTC');
  });

  it('is not allowed while the Split is still running', () => {
    const gate = proposalGate(info([{ ...base, state: 'upcoming_split' }]));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('This Split is still running; your mandate opens after the Split, on the round date');
  });

  it('is allowed on the lowest open round, and a released round counts as open', () => {
    const r2 = { ...base, round: 2, mandateRef: '8:2:x', state: 'released' as const };
    const gate = proposalGate(info([{ ...base, state: 'fully_acquired', remainingLana: 0 }, r2]));
    expect(gate.allowed).toBe(true);
    expect(gate.openRound?.round).toBe(2);
    expect(timingLine(r2)).toBe('Opened early by the treasury');
  });

  it('is left to the server when no mandate exists', () => {
    // A mandate that is not open is NOT left to the server — the button is
    // disabled until the round date (covered above). Only the absence of any
    // mandate defers to the server's NO_MANDATE review.
    expect(proposalGate(info([])).allowed).toBe(true);
    expect(proposalGate(null).allowed).toBe(true);
  });

  it('the panel says when the round opens', () => {
    render(<MandatePanel info={info([{ ...base, state: 'not_open' }])} loading={false} error={null} lanaAmount={null} currency="EUR" showIndicative={false} />);
    expect(screen.getByText('Round 1 opens on 14 Sep 2026, 22:00 UTC')).toBeInTheDocument();
    expect(screen.getByText('A round date opens a treasury mandate. It creates no right to sell (BEF P08 §8).')).toBeInTheDocument();
  });
});

describe('a counteroffer', () => {
  it('says what was proposed, what the treasury can acquire now, and leaves the choice', () => {
    expect(counterBody(40000, 32527.97)).toBe(
      'You proposed 40,000 LANA; the treasury can acquire 32,527.97 LANA now — your remaining mandate. Accept 32,527.97 LANA or not now.',
    );
  });

  it('the open line names the remaining cap', () => {
    expect(timingLine(base)).toBe('Round 1 is open — you may propose up to 32,527.97 LANA');
    expect(fmtUtc(null)).toBe('—');
  });
});

/**
 * HOW MUCH CAN GO INTO A SALE TODAY.
 *
 * The owner's point (9 Sep 2026): somebody holding LANA from round 1 and round 2
 * cannot sell all of it during round 1, and nothing on the page said so. These
 * pin the number and, just as much, what it must NOT include.
 */
const r2 = (over: Partial<MandateView> = {}): MandateView => ({
  ...base, mandateRef: '8:2:' + 'a'.repeat(64), round: 2, state: 'not_open',
  opensAt: '2026-10-26T22:00:00.000Z', discountPercent: 25,
  expectedLana: 800, remainingLana: 800, walletShareLana: 800, ...over,
});
const r1 = (over: Partial<MandateView> = {}): MandateView => ({
  ...base, expectedLana: 1000, remainingLana: 1000, walletShareLana: 1000, ...over,
});

describe('what the holder may propose now', () => {
  it('counts the open round only — a later round is not on the table', () => {
    const a = availabilityOf(info([r1(), r2()]))!;
    expect(a.nowLana).toBe(1000);
    expect(a.laterLana).toBe(800);
    expect(a.perProposalLana).toBe(1000);
    expect(a.perProposalRound).toBe(1);
  });

  it('counts a released round as open, whatever its date says', () => {
    const a = availabilityOf(info([r1(), r2({ state: 'released', released: true })]))!;
    expect(a.nowLana).toBe(1800);
    expect(a.laterLana).toBe(0);
    expect(a.anyReleased).toBe(true);
  });

  it('with two rounds open, one proposal still carries only the first', () => {
    const a = availabilityOf(info([r1(), r2({ state: 'open' })]))!;
    expect(a.nowLana).toBe(1800);
    expect(a.perProposalLana).toBe(1000);
    expect(a.perProposalRound).toBe(1);
  });

  it('counts what REMAINS, not what the budget received', () => {
    const a = availabilityOf(info([r1({ remainingLana: 250, acceptedLana: 750 })]))!;
    expect(a.nowLana).toBe(250);
  });

  it('leaves out what is spent, gone or closed — that is not waiting on a date', () => {
    const a = availabilityOf(info([
      r1({ state: 'fully_acquired', remainingLana: 0 }),
      r2({ state: 'window_passed' }),
      { ...r2(), mandateRef: 'x', round: 3, state: 'closed' },
    ]))!;
    expect(a.nowLana).toBe(0);
    expect(a.laterLana).toBe(0);
    expect(a.laterRounds).toHaveLength(0);
  });

  it('after round 1 is sold, the next proposal is round 2 — what the "propose the rest" button offers', () => {
    // The state a holder is in the moment a sale completes: round 1 spent to
    // the last lanoshi, round 2 still open. Before this existed the page ended
    // here and the rest looked refused.
    const a = availabilityOf(info([
      r1({ state: 'fully_acquired', remainingLana: 0, settledLana: 1000 }),
      r2({ state: 'released', released: true }),
    ]))!;
    expect(a.nowLana).toBe(800);
    expect(a.perProposalLana).toBe(800);
    expect(a.perProposalRound).toBe(2);
  });

  it('says nothing at all when there is no mandate', () => {
    expect(availabilityOf(info([]))).toBeNull();
    expect(availabilityOf(null)).toBeNull();
  });

  it('shows the number, the wait and its date on the panel', () => {
    render(<MandatePanel info={info([r1(), r2()])} loading={false} error={null} lanaAmount={null} currency="EUR" showIndicative={false} />);
    expect(screen.getByTestId('available-now').textContent).toContain('1,000');
    const later = screen.getByTestId('available-later').textContent || '';
    expect(later).toContain('800');
    expect(later).toContain('round 2');
    expect(later).toContain(fmtUtc('2026-10-26T22:00:00.000Z'));
  });

  /**
   * THE BIG NUMBER IS WHAT THIS PROPOSAL CAN CARRY.
   *
   * It used to be the sum of every open round, with the real per-proposal
   * limit in small grey type underneath. Someone with 32,527.97 open in round 1
   * and 19,916.48 in round 2 read 52,444.45 in large figures and took that for
   * what he was selling (11 Sept 2026: "rabiš takoj pokazati, da se prodaja
   * samo toliko in ne celotni znesek"). Two open rounds is the only case where
   * the two numbers differ, so it is the only case that can prove this.
   */
  /**
   * A CRUMB IS NOT AN OFFER — 11 September 2026.
   *
   * A completed sale left 0.73 LANA in round 2, worth about twenty cents, and
   * the page said "You can still propose — 0.73 LANA" under a button offering
   * to do exactly that. `min_sell_<currency>` has always refused it. The
   * invitation and the refusal now ask the SAME question, and the server
   * answers it: the page does not re-derive the rule, because a second
   * definition of one rule is how the two came apart in the first place.
   */
  it('does not offer a round whose whole remainder is below the minimum', () => {
    const crumb = r2({ state: 'open', remainingLana: 0.73, belowMinimum: true, minimumLana: 97.66 });
    const a = availabilityOf(info([r1({ remainingLana: 0 }), crumb]))!;
    expect(a.perProposalLana).toBe(0);      // nothing to propose…
    expect(a.nowLana).toBe(0);
    expect(a.tooSmallLana).toBe(0.73);      // …and we know exactly why
    expect(proposableCapLana(info([r1({ remainingLana: 0 }), crumb]))).toBe(0);
  });

  it('and says where it went, in LANA, rather than going quiet', () => {
    const crumb = r2({ state: 'open', remainingLana: 0.73, belowMinimum: true, minimumLana: 97.66 });
    render(<MandatePanel info={info([r1({ remainingLana: 0 }), crumb])} loading={false} error={null} lanaAmount={null} currency="EUR" showIndicative={false} />);
    const said = screen.getByTestId('too-small').textContent || '';
    expect(said).toContain('0.73');
    expect(said).toContain('97.66');
    expect(said).toMatch(/stays in your wallet/i);
  });

  it('but a round that is merely SMALL is still offered', () => {
    // The flag comes from the server, and only the server. Without it, a small
    // round is an ordinary round — the page must never invent the refusal.
    const small = r2({ state: 'open', remainingLana: 0.73 });
    const a = availabilityOf(info([r1({ remainingLana: 0 }), small]))!;
    expect(a.perProposalLana).toBe(0.73);
    expect(a.tooSmallLana).toBe(0);
  });

  /**
   * THE HEADLINE AND THE "MAX" BUTTON MUST BE THE SAME NUMBER.
   *
   * They are computed by two different functions — availabilityOf for the
   * panel, proposableCapLana for the amount field — and if they ever drift the
   * page says one thing in large figures and fills in another. That is the
   * confusion this whole block exists to end, so it is asserted rather than
   * assumed.
   */
  it('is the same number the Max button fills in', () => {
    const two = info([r1(), r2({ state: 'open' })]);
    expect(availabilityOf(two)!.perProposalLana).toBe(proposableCapLana(two));
    const one = info([r1(), r2()]);
    expect(availabilityOf(one)!.perProposalLana).toBe(proposableCapLana(one));
  });

  it('leads with what ONE proposal can carry, never the sum of the open rounds', () => {
    const { unmount } = render(<MandatePanel info={info([r1(), r2({ state: 'open' })])} loading={false} error={null} lanaAmount={null} currency="EUR" showIndicative={false} />);
    const headline = screen.getByTestId('available-now').textContent || '';
    expect(headline).toContain('1,000');   // round 1, and this proposal's limit
    expect(headline).not.toContain('1,800'); // the sum — the number that misled
    // The rest is still named, as the rest, and it is the OTHER round's amount.
    const rest = screen.getByTestId('per-proposal').textContent || '';
    expect(rest).toContain('800');
    expect(rest).toContain('round 2');
    expect(rest).not.toContain('1,800');
    unmount();
    // One open round: what is open and what one proposal carries are the same
    // number, and saying it twice would only muddy it.
    render(<MandatePanel info={info([r1(), r2()])} loading={false} error={null} lanaAmount={null} currency="EUR" showIndicative={false} />);
    expect(screen.getByTestId('available-now').textContent).toContain('1,000');
    expect(screen.queryByTestId('per-proposal')).toBeNull();
  });
});

/**
 * THE NUMBER THE "MAX" BUTTON HAS TO OBEY.
 *
 * `availabilityOf` answers a holder's question in prose; this answers a
 * button's question in one number, and it has a third answer the prose does
 * not need: NOTHING IS KNOWN. A page that collapses "not told" into "zero"
 * empties the field of a seller nobody capped, which is the same class of
 * mistake as the one being fixed, pointed the other way.
 */
describe('the cap a single proposal may carry', () => {
  it('is the lowest open round\'s remainder — one proposal draws on one round', () => {
    expect(proposableCapLana(info([r1(), r2({ state: 'open' })]))).toBe(1000);
  });

  it('follows a round the treasury opened early, like any other open round', () => {
    expect(proposableCapLana(info([
      r1({ state: 'fully_acquired', remainingLana: 0 }),
      r2({ state: 'released', released: true }),
    ]))).toBe(800);
  });

  it('is zero — a real zero — when a mandate exists and no round is open', () => {
    expect(proposableCapLana(info([r1({ state: 'not_open' }), r2()]))).toBe(0);
  });

  it('is null, not zero, when there is no mandate at all', () => {
    // The legacy path: the server judges the proposal on receipt, and the
    // panel on the same screen says so. Nobody has capped this wallet.
    expect(proposableCapLana(info([]))).toBeNull();
  });

  it('is null, not zero, when the mandate has not been read', () => {
    // Still loading, or it could not be read. Either way this browser has not
    // been told a cap, and it must not invent one.
    expect(proposableCapLana(null)).toBeNull();
  });
});
