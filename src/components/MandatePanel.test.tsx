/**
 * The mandate panel is the one place a public page shows a figure next to a
 * discount. It must carry its non-binding heading every time, keep the
 * propose button dead before the round date, phrase a counteroffer as the
 * framework does, and get the arithmetic right to the cent.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MandatePanel, indicativeFiat, proposalGate, counterBody, timingLine, fmtUtc,
  type MandateView, type MandateInfo,
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

const info = (mandates: MandateView[], gateActive = true): MandateInfo => ({
  nonBinding: true, note: '', gateActive, currentSplit: 9, mandates,
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

  it('is left to the server when the gate is off or no mandate exists', () => {
    expect(proposalGate(info([{ ...base, state: 'not_open' }], false)).allowed).toBe(true);
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
