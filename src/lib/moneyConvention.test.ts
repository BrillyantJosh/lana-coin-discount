/**
 * One convention per screen.
 *
 * The bug this guards is not arithmetic — every figure was correct. It was that
 * `€6,498.88` and `20.070,5 LANA` shared one card, three lines apart, because
 * the price was grouped by hand and the LANA amount was handed to the reader's
 * locale. On a Slovenian browser the two swapped the meaning of a comma and a
 * point, on the one card built to be read at a glance.
 *
 * So the rule is not "use toLocaleString" or "don't" — it is that any two
 * numbers a person can see at once must be written the same way. These tests
 * read the seller-facing sources, because a rendering test would only catch it
 * on the states someone thought to render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatFiat, formatLana } from './money.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Every surface where a purchase price and a LANA amount can share a glance. */
const SELLER_SURFACES = [
  'pages/Dashboard.tsx',
  'pages/SubmitOffer.tsx',
  'components/WaitingOffer.tsx',
  'components/MandatePanel.tsx',
];

describe('the two figures agree with each other', () => {
  it('groups a price and a LANA amount the same way', () => {
    expect(formatFiat('€', 6498.88)).toBe('€6,498.88');
    expect(formatLana(20070.5)).toBe('20,070.5');
    // The failure was a point against a comma. Neither may produce the other's.
    expect(formatLana(20070.5)).not.toContain('.070');
  });

  it('keeps whole LANA whole, and never invents cents on coins', () => {
    expect(formatLana(1500)).toBe('1,500');
    expect(formatLana(32546.484)).toBe('32,546.48');
    expect(formatLana(0)).toBe('0');
  });

  it('survives the values a real offer carries', () => {
    expect(formatFiat('€', 0)).toBe('€0.00');
    expect(formatFiat('£', 501.2)).toBe('£501.20');
    expect(formatFiat('€', -12.5)).toBe('-€12.50');
    expect(formatLana(-3)).toBe('-3');
  });
});

describe('no seller-facing figure is left to the reader\'s locale', () => {
  it('no LANA amount is printed with toLocaleString()', () => {
    const leaks: string[] = [];
    for (const rel of SELLER_SURFACES) {
      for (const line of read(rel).split('\n')) {
        // `toLocaleString()` with no argument follows the browser. Beside a
        // hand-grouped price that is the exact defect.
        if (/toLocaleString\(\s*\)/.test(line)) leaks.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('no seller-facing money is printed with an undefined locale', () => {
    const leaks: string[] = [];
    for (const rel of SELLER_SURFACES) {
      for (const line of read(rel).split('\n')) {
        if (/toLocaleString\(\s*undefined/.test(line)) leaks.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe('the clock speaks digits, not a language', () => {
  it('never abbreviates a month into a word', () => {
    // The clock's locale is pinned, so `month: 'short'` prints a Slovenian
    // month name — inside English copy, on the card a person reads first.
    const code = read('lib/offerClock.ts')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // prose may name the trap; code may not set it
      .join('\n');
    expect(code).not.toMatch(/month:\s*'short'/);
    expect(code).not.toMatch(/month:\s*'long'/);
  });
});
