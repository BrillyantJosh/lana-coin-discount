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
 * Admin screens are deliberately out of scope FOR THE WHOLE LIST: they are read
 * by us, they describe our own internal work, and forcing them into
 * counterparty-facing language would make them less clear to the people who use
 * them. `buyback`, `investor` and `exchange rate` are all legitimate there and
 * appear in eight admin files today.
 *
 * That blanket exclusion once hid a term that was NOT an internal one. See the
 * second half of this file: one phrase — the name of the review state — is
 * checked on the admin screens and in the server sources as well, because those
 * are the two places it survived a rename of the very badge above it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FORBIDDEN_PUBLIC_TERMS } from './copy';

const SRC = path.resolve(__dirname);

/**
 * Everything a member of the public or a counterparty can read. Admin pages
 * (src/pages/Admin*.tsx) and this file are excluded.
 *
 * copy.ts IS included, and used not to be. That exemption was the hole in the
 * middle of this guard: every counterparty-facing string in the app lives in
 * copy.ts, so the one file the scan skipped was the only file the words were
 * ever written in. A banned term placed there passed `npm test`. It is scanned
 * now, with only the FORBIDDEN_PUBLIC_TERMS array itself stripped out — that
 * literal is the list, not a sentence anybody reads.
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
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * The banned list itself, removed before matching. Without this, copy.ts would
 * report every term as an offence against itself. Nothing else in the file is
 * exempt: the §9 mapping table in its header is inside a block comment and is
 * already gone by the time this runs.
 */
function withoutBannedListLiteral(source: string): string {
  return source.replace(/export const FORBIDDEN_PUBLIC_TERMS\s*=\s*\[[\s\S]*?\]\s*as const;/, ' ');
}

/** Strip comments — a note to a future developer is not user-visible copy. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/**
 * A few WIRE IDENTIFIERS other systems already speak contain a banned word:
 * `buyback_wallet_id` on /api/external/sale, the `/api/brain/buyback-balance`
 * path, the `buyback_wallet` response key, the `investor_lana` order type and
 * the sample address `LBuybackAddress…` on /docs/api. Renaming them would
 * break counterparties and would not change one sentence a person reads.
 *
 * They are listed VERBATIM and stripped before matching. Nothing is exempt by
 * shape: a new identifier that carries a banned word has to be added here by
 * name, in a commit a reviewer can see — that is the whole point. (A shape
 * rule once exempted anything glued to a letter, which is a loophole, not a
 * list.)
 */
const PROTOCOL_TOKENS = ['buyback_wallet_id', '/api/brain/buyback-balance', 'buyback_wallet', 'investor_lana'];
const SAMPLE_ADDRESS = /lbuybackaddress[0-9a-z]*/g;
function withoutProtocolTokens(body: string): string {
  let out = body.replace(SAMPLE_ADDRESS, ' ');
  for (const token of PROTOCOL_TOKENS) out = out.split(token).join(' ');
  return out;
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
        const body = withoutBannedListLiteral(withoutComments(fs.readFileSync(file, 'utf8'))).toLowerCase();
        if (withoutProtocolTokens(body).includes(term)) offenders.push(path.relative(SRC, file));
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
      const body = withoutBannedListLiteral(withoutComments(fs.readFileSync(file, 'utf8')));
      if (/\bqueue\b/i.test(body)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders, `"queue" appears in: ${offenders.join(', ')}`).toEqual([]);
  });
});

/**
 * THE REVIEW STATE IS NOT A GOVERNMENT DEPARTMENT.
 *
 * "Under Treasury Review" was correct English and a false statement in
 * Slovenian, where *treasury* is `ministrstvo za finance` — the Ministry of
 * Finance. A seller read that a state body was sitting in judgement on his
 * sale. It is a person at this company, spending this company's money.
 *
 * `under treasury review` is on FORBIDDEN_PUBLIC_TERMS, which stops the phrase
 * being typed out again anywhere a counterparty reads. That alone would not
 * stop the same idea arriving in different words, or the three places that
 * show this state drifting apart, so this block pins the state itself.
 *
 * THE GAP THAT LET IT SURVIVE THE FIRST FIX, now closed. `UI.reviewState` was
 * renamed and the badge changed; the sentence under it did not, because the
 * words were not in copy.ts at all. They were a hardcoded literal on
 * src/pages/AdminOffers.tsx, which this scan skips by name, and four sentences
 * in server/lib, which it never walked. The suite stayed green while the phrase
 * was still on the seller's own screen and on the admin queue.
 *
 * So the ONE phrase is checked in both of those places too, below — one phrase
 * and not the whole list, because widening the list to Admin* would light up
 * `buyback`, `investor` and `exchange rate`, which belong there.
 */
describe('the state a proposal sits in names no institution', () => {
  it('the review state does not put a public body over a private sale', async () => {
    const { UI } = await import('./copy');
    expect(UI.reviewState).not.toMatch(/treasur|ministr|government|authorit|department|official/i);
  });

  it('and neither does the sentence about who decides', async () => {
    const { OFFER } = await import('./copy');
    expect(OFFER.reviewBody).not.toMatch(/treasur|ministr|government|authorit|department/i);
    // The thing that sentence exists to say: a human, not a rule.
    expect(OFFER.reviewBody).toMatch(/\bperson\b/i);
  });

  it('the seller\'s screen, the dashboard badge and the chip are one string', () => {
    // Three surfaces showed this state and each could be renamed alone. They
    // are the same constant, so a future rename cannot land on two of three.
    return import('./copy').then(({ UI, OFFER, OFFER_STATUS_LABELS }) => {
      expect(OFFER.reviewStateLabel).toBe(UI.reviewState);
      expect(OFFER_STATUS_LABELS.under_review).toBe(UI.reviewState);
    });
  });
});

/**
 * THE SAME PHRASE, ON THE TWO SURFACES THE LIST CANNOT REACH.
 *
 * `FORBIDDEN_PUBLIC_TERMS` is checked over `src/` with Admin* skipped, which is
 * right for the list as a whole and wrong for this one entry. The review state
 * is not internal vocabulary: the server writes it into
 * `acquisition_offers.decision_reason`, and SubmitOffer renders that column
 * verbatim under "Why a person is looking at this" — so a sentence typed in
 * `server/lib` lands on the seller's screen one line below the badge. The admin
 * chip is named in the same decision and drifted apart from it because it was a
 * literal rather than a read of `UI.reviewState`.
 *
 * Both are checked here, for this phrase only. The server walk is not a fixed
 * list of files: a NEW server source that writes the phrase fails this on the
 * day it is written, which a hand-kept list would not do.
 */
const REVIEW_PHRASE = 'under treasury review';

/**
 * KNOWN, NAMED, AND SELF-RETIRING. `restrictionReason` still writes the phrase
 * twice (server/lib/acquisitionRestriction.ts:33-34, the second reading "the
 * treasury reviews every proposal from this counterparty by hand" — a person
 * and a ministry in one line). It was outside the lane that fixed the other
 * four and is left for its owner rather than reached into mid-session.
 *
 * The exemption cannot rot: the test below asserts the file STILL says it, so
 * the moment someone fixes those two literals this goes red and tells them to
 * delete this line. Fix and deletion belong in the same commit.
 */
/**
 * One file, and it is here to DELETE the phrase, not to write it.
 *
 * `decision_reason` is a stored column, so the 10 Sept rename left older rows
 * still handing the old words to the person who wrote the proposal. The repair
 * is a boot migration, and a migration that rewrites a sentence has to name the
 * sentence. Exempting it is safe only while that stays true — which the test
 * straight after this list checks, so the exemption cannot quietly become a
 * licence to write the words again.
 */
const REVIEW_PHRASE_EXEMPT: string[] = ['db/roundMandateSchema.ts'];

const SERVER = path.resolve(SRC, '..', 'server');

/** Every server source that can put a sentence in front of a counterparty. */
function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(SERVER);
  return out;
}

/** The admin screens the whole-list scan skips by name. */
function adminSurfaceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      if (!/^Admin/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe('the review state is checked where it actually lives', () => {
  it('is the same phrase the public list bans, not a second copy of it', () => {
    // If someone edits the list entry and not this constant, the two scans
    // start guarding different words and one of them guards nothing.
    expect([...FORBIDDEN_PUBLIC_TERMS] as string[]).toContain(REVIEW_PHRASE);
  });

  it('finds both surfaces to check', () => {
    // A guard on the guard: an empty walk passes every assertion below.
    expect(serverSources().length).toBeGreaterThan(20);
    expect(adminSurfaceFiles().length).toBeGreaterThan(5);
  });

  it('no server source writes it into a sentence the seller is served', () => {
    const offenders: string[] = [];
    for (const file of serverSources()) {
      const rel = path.relative(SERVER, file);
      if (REVIEW_PHRASE_EXEMPT.includes(rel)) continue;
      const body = withoutComments(fs.readFileSync(file, 'utf8')).toLowerCase();
      if (body.includes(REVIEW_PHRASE)) offenders.push(rel);
    }
    expect(
      offenders,
      `"${REVIEW_PHRASE}" is written by: ${offenders.join(', ')} — it reaches the seller ` +
      'through acquisition_offers.decision_reason, under a badge that says UI.reviewState',
    ).toEqual([]);
  });

  it('the one exempt file names the phrase only in order to delete it', () => {
    // The guard on the exemption. If this file ever starts BUILDING a sentence
    // with those words instead of replacing them, this goes red and the
    // exemption has to go with it.
    const body = fs.readFileSync(path.join(SERVER, 'db', 'roundMandateSchema.ts'), 'utf8');
    expect(body.toLowerCase()).toContain(REVIEW_PHRASE);
    expect(body.toLowerCase()).toContain('under financial review');
    expect(body).toMatch(/SET decision_reason = REPLACE\(/);
    expect(withoutComments(body)).not.toMatch(/is\s+under treasury review/i);
  });

  it('no admin screen prints it either', () => {
    const offenders: string[] = [];
    for (const file of adminSurfaceFiles()) {
      const body = withoutComments(fs.readFileSync(file, 'utf8')).toLowerCase();
      if (body.includes(REVIEW_PHRASE)) offenders.push(path.relative(SRC, file));
    }
    expect(
      offenders,
      `"${REVIEW_PHRASE}" appears in: ${offenders.join(', ')} — read UI.reviewState instead ` +
      'so the chip cannot drift away from the badge again',
    ).toEqual([]);
  });

  it('the one exempted file is still the only one, and still needs fixing', () => {
    // Self-retiring. When acquisitionRestriction.ts stops saying it, delete the
    // entry from REVIEW_PHRASE_EXEMPT in the same commit and this passes again.
    for (const rel of REVIEW_PHRASE_EXEMPT) {
      const full = path.join(SERVER, rel);
      expect(fs.existsSync(full), `${rel} is exempted but does not exist`).toBe(true);
      const body = withoutComments(fs.readFileSync(full, 'utf8')).toLowerCase();
      expect(
        body.includes(REVIEW_PHRASE),
        `${rel} no longer says "${REVIEW_PHRASE}" — remove it from REVIEW_PHRASE_EXEMPT ` +
        'so the scan covers it from now on',
      ).toBe(true);
    }
  });
});


/**
 * THE TWO CLOCKS, AND THE ONE THE SERVER ACTUALLY KEEPS.
 *
 * A purchase offer a person made stands eight days; accepting it ends that
 * window and starts a 24-hour one for the transfer. The owner accepted
 * believing the first number and found the second. The copy now says so before
 * and after — and the number in it is checked against the server constant that
 * enforces it, because a warning that names the wrong figure is worse than no
 * warning at all.
 */
describe('the transfer window the copy names is the one the sweeper enforces', () => {
  const serverSource = () =>
    fs.readFileSync(path.resolve(SRC, '..', 'server', 'lib', 'acquisitionOffer.ts'), 'utf8');

  const constant = (name: string) => {
    const m = serverSource().match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    expect(m, `${name} not found in server/lib/acquisitionOffer.ts`).toBeTruthy();
    return m![1];
  };

  it('says the same number of hours expireStaleOffers sweeps at', async () => {
    const { OFFER } = await import('./copy');
    const hours = constant('ACCEPTED_TRANSFER_WINDOW_HOURS');
    expect(OFFER.acceptStartsBody).toContain(`${hours} hours`);
    expect(OFFER.acceptStartsWhen).toContain(`${hours} hours`);
  });

  it('and the page that picks which sentence to show counts in the same hours', () => {
    // /offer has to decide whether the sweep or the offer window closes first,
    // which it cannot do without the number. It is mirrored there, used only
    // to choose a sentence — never to draw a clock — and pinned here so the
    // two cannot drift into disagreeing about the same 24 hours.
    const page = fs.readFileSync(path.resolve(SRC, 'pages', 'SubmitOffer.tsx'), 'utf8');
    const mirrored = page.match(/TRANSFER_WINDOW_HOURS\s*=\s*(\d+)/);
    expect(mirrored, 'TRANSFER_WINDOW_HOURS not found in src/pages/SubmitOffer.tsx').toBeTruthy();
    expect(mirrored![1]).toBe(constant('ACCEPTED_TRANSFER_WINDOW_HOURS'));
  });

  it('warns before the acceptance, not only after it', async () => {
    const { OFFER } = await import('./copy');
    // Said in front of the button, where he can still choose to accept later.
    expect(OFFER.acceptStartsBody).toMatch(/transferred/i);
    expect(OFFER.acceptStartsWhen).toMatch(/start when you accept, not now/i);
    // And named afterwards, when the number on screen has changed under him.
    expect(OFFER.windowChangedBody).toContain('{was}');
    expect(OFFER.windowChangedBody).toContain('{now}');
  });

  it('invents no second clock on a row nothing sweeps', async () => {
    const { OFFER } = await import('./copy');
    // A legacy offer carries no mandate, so expireStaleOffers never voids it
    // and the offer window IS the transfer deadline. Naming 24 hours there
    // would be manufactured urgency about a sweep that does not run.
    expect(OFFER.acceptStartsBodyWindow).not.toMatch(/24 hours/);
    expect(OFFER.acceptStartsBodyWindow).toContain('{until}');
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
