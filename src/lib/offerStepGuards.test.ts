/**
 * Three things a real seller hit, and the ways they were nearly re-introduced.
 *
 * These are source-reading tests on purpose. Each one guards a rule that lives
 * in the relationship BETWEEN two places — a cap and a button, a claim and the
 * server behaviour it rests on, an order and a viewport — and a rendering test
 * only sees the states someone thought to render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OFFER, MANDATE } from '../copy';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('Max never answers with a number it does not stand behind', () => {
  const page = read('pages/SubmitOffer.tsx');

  it('treats an UNREADABLE mandate the same as a loading one, not as an absent one', () => {
    // Both arrive as `mandateInfo === null`. Collapsing them put the original
    // complaint straight back: on a failed fetch the cap became null, Max went
    // live and filled the whole wallet — the exact figure Dejan deleted by hand.
    expect(page).toContain('mandateLoading || mandateError !== null');
    expect(page).toMatch(/roundCapLana\s*=\s*capUnknown\s*\?\s*null/);
    expect(page).toMatch(/maxUnavailable\s*=\s*capUnknown/);
  });

  it('does not read the wallet balance straight into the field any more', () => {
    expect(page).not.toMatch(/setLanaAmount\(String\(Math\.max\(0,\s*walletBalance/);
  });
});

describe('the review screen completes its own sentence', () => {
  it('says the review has no clock AND that what follows one does', () => {
    // Each sentence was true; together they said "no clock, no message" and so
    // "no reason to come back" — while a purchase offer, once made, does lapse.
    expect(OFFER.reviewNoDeadline).toMatch(/no deadline/i);
    expect(OFFER.reviewNoMessage).toMatch(/nothing is sent to you/i);
    expect(OFFER.reviewAfterDecision).toMatch(/lapses|clock/i);
    expect(OFFER.reviewAfterDecision).toMatch(/come back/i);
  });

  it('promises no figure the wire has not sent', () => {
    // The real window rides on the offered row and is shown there. A number
    // typed into this sentence is one the server may change without it.
    expect(OFFER.reviewAfterDecision).not.toMatch(/\b\d+\s*(day|hour|minute)/i);
  });

  it('is actually rendered, not merely written', () => {
    expect(read('pages/SubmitOffer.tsx')).toContain('OFFER.reviewAfterDecision');
  });
});

describe('the answer sits above the question without burying it', () => {
  const panel = read('components/MandatePanel.tsx');

  it('folds the round-by-round detail on the step that stands above the field', () => {
    // The panel moved above the amount card, which is what was asked for. At
    // full height with three rounds that pushed the input two swipes down a
    // phone, so the figure stays open and the working folds.
    expect(panel).toContain('function RoundDetail');
    expect(panel).toContain('<details');
    expect(MANDATE.roundDetailToggle).toBeTruthy();
  });

  it('keeps the availability figure OUT of the fold — it is the answer', () => {
    const from = panel.indexOf('data-testid="availability"');
    const to = panel.indexOf('<RoundDetail');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
  });

  it('leaves the wallet step at full height', () => {
    expect(panel).toContain('compact = false');
    const page = read('pages/SubmitOffer.tsx');
    // Exactly one of the two call sites folds: the amount step.
    expect((page.match(/^\s*compact$/gm) || []).length).toBe(1);
  });
});
