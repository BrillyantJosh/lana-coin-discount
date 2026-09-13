// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  parseSplitPayouts, applyPublishedRoundTerms, isSplitPublishedIn38888, publishedTermsStatus,
  SYSTEM_PARAMETERS_PUBKEY,
} from './publishedRoundTerms';
import { createMandateTestDb, makeKey, signEvent, setRoundTerms } from './roundMandateTestKit';
import { loadRoundTerms } from './roundMandateSync';

/** 9 Sept 2026 05:53 UTC and 26 Oct 2026 00:54 UTC — Split 8's live dates when this was built. */
const R1_OPENS = Date.UTC(2026, 8, 9, 5, 53) / 1000;
const R2_OPENS = Date.UTC(2026, 9, 26, 0, 54) / 1000;

const payout = (split: number | string, round: number | string, opens: number | string, fee: number | string) =>
  ['split_payout', String(split), String(round), String(opens), String(fee)];

/** Split 8 as the owner will publish it: rounds 1 and 2 dated, round 3 empty. */
const SPLIT_8 = [payout(8, 1, R1_OPENS, 22), payout(8, 2, R2_OPENS, 25), payout(8, 3, '', '')];

describe('reading the split_payout tags', () => {
  it('reads a split the way the owner publishes it', () => {
    const { splits, rejected } = parseSplitPayouts([['d', 'main'], ['split', '9'], ...SPLIT_8]);
    expect(rejected).toEqual([]);
    expect(splits).toEqual([{
      split: 8,
      rounds: [
        { round: 1, opensAt: '2026-09-09T05:53:00.000Z', discountPercent: 22 },
        { round: 2, opensAt: '2026-10-26T00:54:00.000Z', discountPercent: 25 },
        { round: 3, opensAt: null, discountPercent: null },
      ],
    }]);
  });

  it('a round the event leaves out is closed, not inherited', () => {
    const { splits } = parseSplitPayouts([payout(8, 1, R1_OPENS, 22)]);
    expect(splits[0].rounds.map(r => r.opensAt === null)).toEqual([false, true, true]);
  });

  it('a fee with no date yet is allowed — the fee is known before the date is decided', () => {
    const { splits, rejected } = parseSplitPayouts([payout(9, 1, '', 21)]);
    expect(rejected).toEqual([]);
    expect(splits[0].rounds[0]).toEqual({ round: 1, opensAt: null, discountPercent: 21 });
  });

  it('keeps each split apart', () => {
    const { splits } = parseSplitPayouts([...SPLIT_8, payout(9, 1, '', 21)]);
    expect(splits.map(s => s.split)).toEqual([8, 9]);
  });

  it('reads nothing from an event without the tag', () => {
    expect(parseSplitPayouts([['d', 'main'], ['split_round', 'current', '1', 'EUR', '1', '2', '3']]))
      .toEqual({ splits: [], rejected: [] });
  });

  describe('a split is taken whole or not at all', () => {
    const rejects = (tags: string[][], split: string, reason: RegExp) => {
      const { splits, rejected } = parseSplitPayouts(tags);
      expect(splits.find(s => String(s.split) === split)).toBeUndefined();
      expect(rejected.find(r => r.split === split)?.reason).toMatch(reason);
    };

    it('a date with no fee could not be priced', () => {
      rejects([payout(8, 1, R1_OPENS, '')], '8', /no sell fee/);
    });

    it('dates that run backwards', () => {
      rejects([payout(8, 1, R2_OPENS, 22), payout(8, 2, R1_OPENS, 25)], '8', /opens before an earlier round/);
    });

    it('backwards is caught even while round 3 has no date', () => {
      rejects([payout(8, 1, R2_OPENS, 22), payout(8, 2, R1_OPENS, 25), payout(8, 3, '', '')], '8', /opens before/);
    });

    it('a thousands separator is not a number', () => {
      rejects([payout(8, 1, R1_OPENS, '22,5')], '8', /not a percent/);
    });

    it('a fee over 100', () => {
      rejects([payout(8, 1, R1_OPENS, 122)], '8', /not a percent/);
    });

    it('a date in milliseconds, or as text', () => {
      rejects([payout(8, 1, R1_OPENS * 1000, 22)], '8', /Unix time in seconds/);
      rejects([payout(8, 1, '2026-09-09', 22)], '8', /Unix time in seconds/);
    });

    it('a round outside 1–3', () => {
      rejects([...SPLIT_8, payout(8, 4, R2_OPENS, 30)], '8', /not 1, 2 or 3/);
    });

    it('the same round twice', () => {
      rejects([payout(8, 1, R1_OPENS, 22), payout(8, 1, R2_OPENS, 25)], '8', /published twice/);
    });

    it('one broken split does not take a good one down with it', () => {
      const { splits, rejected } = parseSplitPayouts([...SPLIT_8, payout(9, 1, R1_OPENS, '')]);
      expect(splits.map(s => s.split)).toEqual([8]);
      expect(rejected.map(r => r.split)).toEqual(['9']);
    });
  });
});

describe('copying the published terms into the database', () => {
  let db: Database.Database;
  const authority = makeKey();
  const apply = (event: any) => applyPublishedRoundTerms(db, event, { author: authority.pub });
  const event38888 = (tags: string[][], createdAt = 1_789_300_000, key = authority) =>
    signEvent(key, { kind: 38888, tags: [['d', 'main'], ['split', '9'], ...tags], content: '{}', created_at: createdAt });

  beforeEach(() => { db = createMandateTestDb(); });

  it('writes the split, and the decision code reads exactly those terms', () => {
    const r = apply(event38888(SPLIT_8));
    expect(r).toMatchObject({ outcome: 'applied', changed: [8], rejected: [] });
    expect(loadRoundTerms(db, 8)).toEqual([
      { round: 1, opensAt: R1_OPENS, discountPercent: 22 },
      { round: 2, opensAt: R2_OPENS, discountPercent: 25 },
      { round: 3, opensAt: null, discountPercent: null },
    ]);
  });

  it('records where the terms came from, so the admin form will not overwrite them', () => {
    const e = event38888(SPLIT_8);
    expect(isSplitPublishedIn38888(db, 8)).toBe(false);
    apply(e);
    expect(isSplitPublishedIn38888(db, 8)).toBe(true);
    expect(isSplitPublishedIn38888(db, 9)).toBe(false);
    const by = (db.prepare('SELECT DISTINCT updated_by FROM acquisition_rounds WHERE split = 8').all() as any[]).map(x => x.updated_by);
    expect(by).toEqual([`kind38888:${e.id}`]);
    expect(publishedTermsStatus(db)).toEqual({ eventId: e.id, createdAt: e.created_at, rejected: [] });
  });

  it('replaces terms the owner had typed by hand', () => {
    setRoundTerms(db, 8, 1, R1_OPENS, 21);
    setRoundTerms(db, 8, 2, null, 25);
    apply(event38888(SPLIT_8));
    expect(loadRoundTerms(db, 8).find(t => t.round === 1)?.discountPercent).toBe(22);
    expect(loadRoundTerms(db, 8).find(t => t.round === 2)?.opensAt).toBe(R2_OPENS);
  });

  /**
   * The first minute after deploy, before the owner has published anything:
   * every round the owner set by hand must still stand.
   */
  it('leaves alone a split the event does not mention', () => {
    setRoundTerms(db, 8, 1, R1_OPENS, 22);
    const r = apply(event38888([]));
    expect(r.changed).toEqual([]);
    expect(loadRoundTerms(db, 8)).toEqual([{ round: 1, opensAt: R1_OPENS, discountPercent: 22 }]);
    expect(isSplitPublishedIn38888(db, 8)).toBe(false);
  });

  it('closes a round when the owner publishes it without a date', () => {
    apply(event38888(SPLIT_8, 1_789_300_000));
    apply(event38888([payout(8, 1, R1_OPENS, 22), payout(8, 2, '', 25), payout(8, 3, '', '')], 1_789_300_100));
    expect(loadRoundTerms(db, 8).find(t => t.round === 2)?.opensAt).toBeNull();
  });

  it('writes nothing the second time the same terms are read', () => {
    apply(event38888(SPLIT_8, 1_789_300_000));
    const before = db.prepare('SELECT updated_by FROM acquisition_rounds WHERE split = 8 AND round = 1').get();
    const again = apply(event38888(SPLIT_8, 1_789_300_060));
    expect(again).toMatchObject({ changed: [], unchanged: [8] });
    // Still attributed to the event that set them.
    expect(db.prepare('SELECT updated_by FROM acquisition_rounds WHERE split = 8 AND round = 1').get()).toEqual(before);
  });

  it('keeps the last good terms when the new event carries a broken split', () => {
    apply(event38888(SPLIT_8, 1_789_300_000));
    const r = apply(event38888([payout(8, 1, R1_OPENS, ''), payout(8, 2, R2_OPENS, 25)], 1_789_300_100));
    expect(r.changed).toEqual([]);
    expect(r.rejected).toEqual([{ split: '8', reason: expect.stringMatching(/no sell fee/) }]);
    expect(r.rejectedChanged).toBe(true);
    expect(loadRoundTerms(db, 8).find(t => t.round === 1)?.discountPercent).toBe(22);
    // Read again a minute later: still refused, but not news any more.
    expect(apply(event38888([payout(8, 1, R1_OPENS, ''), payout(8, 2, R2_OPENS, 25)], 1_789_300_100)).rejectedChanged).toBe(false);
  });

  it('an older event from a lagging relay changes nothing', () => {
    apply(event38888([payout(8, 1, R1_OPENS, 22)], 1_789_300_100));
    const r = apply(event38888([payout(8, 1, R1_OPENS, 30)], 1_789_300_000));
    expect(r).toMatchObject({ outcome: 'ignored', reason: 'older_event' });
    expect(loadRoundTerms(db, 8)[0].discountPercent).toBe(22);
  });

  describe('only the signed event of the pinned author', () => {
    it('refuses another author, however well signed', () => {
      const stranger = makeKey();
      expect(apply(event38888(SPLIT_8, 1_789_300_000, stranger))).toMatchObject({ outcome: 'ignored', reason: 'unverified' });
      expect(loadRoundTerms(db, 8)).toEqual([]);
    });

    it('refuses a doctored fee on a real event', () => {
      const e = event38888(SPLIT_8);
      const doctored = { ...e, tags: e.tags.map(t => (t[0] === 'split_payout' && t[2] === '1' ? [...t.slice(0, 4), '10'] : t)) };
      expect(apply(doctored)).toMatchObject({ outcome: 'ignored', reason: 'unverified' });
      expect(loadRoundTerms(db, 8)).toEqual([]);
    });

    it('refuses the wrong kind', () => {
      const e = signEvent(authority, { kind: 30960, tags: SPLIT_8, content: '{}', created_at: 1_789_300_000 });
      expect(apply(e)).toMatchObject({ outcome: 'ignored', reason: 'unverified' });
    });

    it('in production the pin is Lana Core Authority', () => {
      expect(SYSTEM_PARAMETERS_PUBKEY).toBe('9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3');
      // Signed by our test key, so under the real pin it must not count.
      expect(applyPublishedRoundTerms(db, event38888(SPLIT_8))).toMatchObject({ outcome: 'ignored', reason: 'unverified' });
    });
  });
});
