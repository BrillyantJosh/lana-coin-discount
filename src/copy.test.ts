// @vitest-environment node
/**
 * THE VOCABULARY IS ENFORCED, NOT ASPIRED TO.
 *
 * A terminology decision that lives only in a document drifts back within a
 * release or two: someone adds a helpful sentence, and "cash out" is on the
 * page again. This test reads the actual public and counterparty-facing source
 * and fails if a banned phrase reappears.
 *
 * The banned list is not stylistic. Each phrase carries a model of the
 * business that is not ours — an exchange rate anyone may rely on, a queue you
 * hold a place in, a guarantee of execution, an off-ramp that is always open.
 * The framework names them as the characteristics of a crypto-asset service to
 * clients (§9, §10), which is exactly what Lana.discount is not doing.
 *
 * Admin screens are deliberately out of scope: they are read by us, they
 * describe our own internal work, and forcing them into counterparty-facing
 * language would make them less clear to the people who use them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FORBIDDEN_PUBLIC_TERMS } from './copy';

const SRC = path.resolve(__dirname);

/**
 * Everything a member of the public or a counterparty can read. Admin pages
 * (src/pages/Admin*.tsx, ExpectingCashout.tsx) and this file are excluded.
 */
function publicSurfaceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'ui') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      if (/^Admin/.test(entry.name)) continue;
      // Admin-only, despite living in components/ — it renders only inside
      // ExpectingCashout, which is behind the admin guard.
      if (entry.name === 'ExpectingCashout.tsx' || entry.name === 'CrowdfundCashout.tsx') continue;
      if (entry.name === 'copy.ts') continue; // it defines the banned list
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** Strip comments — a note to a future developer is not user-visible copy. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('the words a counterparty never sees', () => {
  const files = publicSurfaceFiles();

  it('finds the public surface to check', () => {
    // A guard on the guard: if the walk silently returned nothing, every
    // assertion below would pass while checking nothing at all.
    expect(files.length).toBeGreaterThan(10);
  });

  for (const term of FORBIDDEN_PUBLIC_TERMS) {
    it(`never says "${term}"`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const body = withoutComments(fs.readFileSync(file, 'utf8')).toLowerCase();
        if (body.includes(term)) offenders.push(path.relative(SRC, file));
      }
      expect(offenders, `"${term}" appears in: ${offenders.join(', ')}`).toEqual([]);
    });
  }

  it('nobody assembles a banned word to slip past this test', () => {
    // A reviewer found `'que' + 'ue'` in a component: the render was clean and
    // the scan was satisfied, which is worse than an honest failure. If the
    // underlying API field really is the problem, rename the field.
    const offenders: string[] = [];
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      if (/['"`][a-z]{1,4}['"`]\s*\+\s*['"`][a-z]{1,4}['"`]/i.test(body)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders, `suspicious string concatenation in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never calls a place in the settlement order a queue', () => {
    // "Queue" is the single most load-bearing wrong word on the old site: it
    // says a service is owed to you and you are waiting your turn for it.
    const offenders: string[] = [];
    for (const file of files) {
      const body = withoutComments(fs.readFileSync(file, 'utf8'));
      if (/\bqueue\b/i.test(body)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders, `"queue" appears in: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('the framework paragraphs are reproduced, not paraphrased', () => {
  it('keeps the sentence that says a submission obliges us to nothing', async () => {
    const { FRAMEWORK_COPY } = await import('./copy');
    expect(FRAMEWORK_COPY.website).toContain(
      'Submission of an offer does not create an obligation for Lana.discount to transact',
    );
    expect(FRAMEWORK_COPY.website).toContain('accepted, rejected or subject to a counteroffer');
    expect(FRAMEWORK_COPY.website).toContain('does not hold seller crypto-assets on behalf of sellers');
  });

  it('keeps the sentence that a price creates no right to the same price again', async () => {
    const { FRAMEWORK_COPY } = await import('./copy');
    expect(FRAMEWORK_COPY.pricing).toContain('does not create a right to the same price in any future transaction');
  });

  it('keeps the sentence that we may decline on provenance', async () => {
    const { FRAMEWORK_COPY } = await import('./copy');
    expect(FRAMEWORK_COPY.provenance).toContain('may decline any proposed acquisition');
  });
});
