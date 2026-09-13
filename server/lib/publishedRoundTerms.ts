/**
 * ROUND TERMS PUBLISHED IN KIND 38888 — when each round's payouts open, and
 * the sell fee (acquisition discount) that round is bought at.
 *
 * Owner, 13 Sept 2026: "Trenutno imamo na bazi objavljeno kdaj se začnejo
 * izplačila iz kroga 1, kroga 2 in kroga 3. Pravtako iz baze vzemamo koliko so
 * provizije. Prosim dodelaj kind 38888 … da tam objavim te podatke tako, da se
 * od tam distribuirajo … in boš prevzel v bazo vse podatke."
 *
 * Until then the dates and discounts were typed on /admin/treasury-rounds and
 * lived only in this database. Now the owner publishes them in the signed
 * system parameters, one tag per round of a split:
 *
 *   ["split_payout", "<split>", "<round>", "<opens_at unix | ''>", "<sell_fee_percent | ''>"]
 *
 * and this module copies them into acquisition_rounds, which every decision
 * already reads. Nothing downstream changes: the offer route, the round state
 * on the seller's page and the terms the brain echoes into KIND 30960 all keep
 * reading the same table.
 *
 * ── The rules, each one a way this could otherwise go wrong ──────────────
 *
 * 1. ONLY THE SIGNED EVENT OF THE PINNED AUTHOR. The id is recomputed and the
 *    Schnorr signature checked. These numbers open treasury money; a relay that
 *    serves a doctored event must change nothing.
 *
 * 2. AN OLDER EVENT NEVER UNDOES A NEWER ONE. A lagging relay can hand back
 *    yesterday's parameters; the created_at of the last applied event is kept
 *    and anything older is ignored.
 *
 * 3. A SPLIT IS TAKEN WHOLE OR NOT AT ALL. One malformed row, a date without a
 *    fee, or dates that run backwards reject that split and leave its last good
 *    terms in place — half of a split's terms applied is a round priced at a
 *    number nobody published.
 *
 * 4. A SPLIT THE EVENT DOES NOT MENTION IS LEFT ALONE. Absence is not "closed":
 *    the first deploy of this code must not close every round the owner set by
 *    hand, and dropping an old split from the event only stops publishing its
 *    history. To close a round, the owner publishes it with no date.
 *
 * 5. ONCE A SPLIT CAME FROM THE EVENT, THE EVENT IS ITS ONLY AUTHORITY. Its
 *    rows carry `kind38888:<event id>` in updated_by, and the admin form refuses
 *    to overwrite them — two places to change one number means the one you
 *    changed is silently put back a minute later.
 *
 * ── The general fee (owner, 13 Sept 2026) ────────────────────────────────
 *
 *   ["lana_discount_general_fee_percent", "30"]
 *
 * The discount for every acquisition outside a round mandate. It used to be
 * two fields on /admin/settings (other wallets 30, LanaPays.Us without a
 * mandate 22); now it is one published number, written into both settings
 * the pricing already reads. Same rules: only the verified event, never an
 * older one, a malformed value changes nothing, and an event without the tag
 * leaves the fee as it was.
 */
import type Database from 'better-sqlite3';
import { verifyEventSignature, type NostrEvent } from './nostr.js';
import { validateRoundTerms } from './roundMandate.js';

/** Lana Core Authority — the only key whose KIND 38888 counts. */
export const SYSTEM_PARAMETERS_PUBKEY = '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3';
export const SPLIT_PAYOUT_TAG = 'split_payout';
/** updated_by on acquisition_rounds rows written from the event. */
export const PUBLISHED_SOURCE_PREFIX = 'kind38888:';

export const GENERAL_FEE_TAG = 'lana_discount_general_fee_percent';
/** The settings priceAcquisition and the external sale API read — both follow the one published fee. */
export const GENERAL_FEE_SETTINGS = ['commission_other', 'commission_lanapays'] as const;

const SETTING_EVENT_ID = 'acq_terms_38888_event_id';
const SETTING_GENERAL_FEE_REJECTED = 'acq_general_fee_38888_rejected';
const SETTING_CREATED_AT = 'acq_terms_38888_created_at';
const SETTING_REJECTED = 'acq_terms_38888_rejected';

export interface PublishedRound {
  round: number;
  /** ISO-8601 UTC, or null = no date = closed. */
  opensAt: string | null;
  /** Percent under the reference, or null = cannot be priced. */
  discountPercent: number | null;
}

export interface PublishedSplitTerms {
  split: number;
  /** Always rounds 1, 2 and 3, in order. */
  rounds: PublishedRound[];
}

export interface RejectedSplit {
  /** As written in the tag — it may not even be a number. */
  split: string;
  reason: string;
}

export interface ParsedSplitPayouts {
  splits: PublishedSplitTerms[];
  rejected: RejectedSplit[];
}

const WHOLE_SPLIT = /^[1-9]\d*$/;
const UNIX_SECONDS = /^\d{1,11}$/;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/**
 * Read every split_payout tag. Tags are the authority — the content mirror is
 * for readers, and two sources for one number is how they come to disagree.
 */
export function parseSplitPayouts(tags: unknown): ParsedSplitPayouts {
  const bySplit = new Map<string, Array<{ round: number; opensAt: string | null; discountPercent: number | null }>>();
  const broken = new Map<string, string>();
  const breakSplit = (split: string, reason: string) => { if (!broken.has(split)) broken.set(split, reason); };

  for (const t of Array.isArray(tags) ? tags : []) {
    if (!Array.isArray(t) || t[0] !== SPLIT_PAYOUT_TAG) continue;
    const split = String(t[1] ?? '').trim();
    if (!WHOLE_SPLIT.test(split)) { breakSplit(split, 'the split is not a positive whole number'); continue; }

    const roundRaw = String(t[2] ?? '').trim();
    if (!/^[123]$/.test(roundRaw)) { breakSplit(split, `round "${roundRaw}" is not 1, 2 or 3`); continue; }
    const round = Number(roundRaw);

    const opensRaw = String(t[3] ?? '').trim();
    let opensAt: string | null = null;
    if (opensRaw !== '') {
      if (!UNIX_SECONDS.test(opensRaw)) { breakSplit(split, `round ${round}: "${opensRaw}" is not a Unix time in seconds`); continue; }
      opensAt = new Date(Number(opensRaw) * 1000).toISOString();
    }

    const feeRaw = String(t[4] ?? '').trim();
    let discountPercent: number | null = null;
    if (feeRaw !== '') {
      if (!PLAIN_NUMBER.test(feeRaw) || Number(feeRaw) > 100) {
        breakSplit(split, `round ${round}: sell fee "${feeRaw}" is not a percent between 0 and 100`);
        continue;
      }
      discountPercent = Number(feeRaw);
    }

    const rows = bySplit.get(split) ?? [];
    if (rows.some(r => r.round === round)) { breakSplit(split, `round ${round} is published twice`); continue; }
    rows.push({ round, opensAt, discountPercent });
    bySplit.set(split, rows);
  }

  const splits: PublishedSplitTerms[] = [];
  const rejected: RejectedSplit[] = [];
  for (const [split, reason] of broken) rejected.push({ split, reason });

  for (const [split, rows] of bySplit) {
    if (broken.has(split)) continue;
    const rounds: PublishedRound[] = [1, 2, 3].map(round =>
      rows.find(r => r.round === round) ?? { round, opensAt: null, discountPercent: null });

    const undatable = rounds.find(r => r.opensAt !== null && r.discountPercent === null);
    if (undatable) {
      rejected.push({ split, reason: `round ${undatable.round} opens on a date but has no sell fee, so it could not be priced` });
      continue;
    }
    // Rounds open in order. Checked between every two dates that are set, so a
    // split may carry round 1 and round 2 before anyone has decided round 3.
    const dated = rounds.filter(r => r.opensAt !== null);
    const backwards = dated.find((r, i) => i > 0 && Date.parse(r.opensAt!) < Date.parse(dated[i - 1].opensAt!));
    if (backwards) {
      rejected.push({ split, reason: `round ${backwards.round} opens before an earlier round; rounds open in order 1, 2, 3` });
      continue;
    }
    // The admin form's own validator, so both entry points agree on what a
    // valid set of terms is.
    const v = validateRoundTerms(rounds);
    if (!v.ok) { rejected.push({ split, reason: v.error || 'invalid round terms' }); continue; }
    splits.push({ split: Number(split), rounds: v.rows });
  }

  splits.sort((a, b) => a.split - b.split);
  rejected.sort((a, b) => a.split.localeCompare(b.split, undefined, { numeric: true }));
  return { splits, rejected };
}

export interface ApplyPublishedTermsResult {
  outcome: 'applied' | 'ignored';
  /** Why nothing was read, when outcome is 'ignored'. */
  reason?: 'unverified' | 'older_event';
  /** Splits whose rows were written. */
  changed: number[];
  /** Splits the event carries that already matched. */
  unchanged: number[];
  rejected: RejectedSplit[];
  /** True when the rejection list differs from the last one — log it once, not every minute. */
  rejectedChanged: boolean;
  generalFee: {
    /** The fee the event publishes, or null when it carries none (or a broken one). */
    published: number | null;
    /** The settings were written this time. */
    changed: boolean;
    /** Why a published value was not used; null when there is nothing wrong. */
    rejected: string | null;
    rejectedChanged: boolean;
  };
}

/** The general fee as the event carries it: a number, nothing, or why not. */
export function parseGeneralFee(tags: unknown): { value: number | null; rejected: string | null } {
  const tag = (Array.isArray(tags) ? tags : []).find((t: any) => Array.isArray(t) && t[0] === GENERAL_FEE_TAG);
  if (!tag) return { value: null, rejected: null };
  const raw = String(tag[1] ?? '').trim();
  if (!PLAIN_NUMBER.test(raw) || Number(raw) > 100) {
    return { value: null, rejected: `general fee "${raw}" is not a percent between 0 and 100` };
  }
  return { value: Number(raw), rejected: null };
}

const getSetting = (db: Database.Database, key: string): string | null =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any)?.value ?? null;

const putSetting = (db: Database.Database, key: string, value: string) => {
  if (getSetting(db, key) === value) return;
  db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), 'kind38888')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`)
    .run(key, value);
};

const sameInstant = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

const samePercent = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) < 1e-9;

/**
 * Copy the published terms into acquisition_rounds. Safe to call on every
 * heartbeat: it writes only what differs.
 */
export function applyPublishedRoundTerms(
  db: Database.Database,
  event: NostrEvent,
  /** The pinned author. Overridable only so a test can sign a real event. */
  opts: { author?: string } = {},
): ApplyPublishedTermsResult {
  const author = opts.author ?? SYSTEM_PARAMETERS_PUBKEY;
  const nothing = (reason: ApplyPublishedTermsResult['reason']): ApplyPublishedTermsResult =>
    ({
      outcome: 'ignored', reason, changed: [], unchanged: [], rejected: [], rejectedChanged: false,
      generalFee: { published: null, changed: false, rejected: null, rejectedChanged: false },
    });

  if (!event || event.kind !== 38888 || event.pubkey !== author || !verifyEventSignature(event)) {
    return nothing('unverified');
  }
  const lastCreatedAt = Number(getSetting(db, SETTING_CREATED_AT) || 0);
  if (event.created_at < lastCreatedAt) return nothing('older_event');

  const { splits, rejected } = parseSplitPayouts(event.tags);
  const source = `${PUBLISHED_SOURCE_PREFIX}${event.id}`;
  const changed: number[] = [];
  const unchanged: number[] = [];

  const readRows = db.prepare('SELECT round, opens_at, discount_percent, updated_by FROM acquisition_rounds WHERE split = ?');
  const upsert = db.prepare(`
    INSERT INTO acquisition_rounds (split, round, opens_at, discount_percent, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(split, round) DO UPDATE SET
      opens_at = excluded.opens_at, discount_percent = excluded.discount_percent,
      updated_by = excluded.updated_by, updated_at = datetime('now')
  `);

  const previousRejected = getSetting(db, SETTING_REJECTED) || '[]';
  const rejectedJson = JSON.stringify(rejected);

  const fee = parseGeneralFee(event.tags);
  const previousFeeRejected = getSetting(db, SETTING_GENERAL_FEE_REJECTED) || '';
  let feeChanged = false;

  db.transaction(() => {
    for (const s of splits) {
      const stored = readRows.all(s.split) as any[];
      const matches = s.rounds.every(r => {
        const row = stored.find(x => Number(x.round) === r.round);
        return !!row
          && String(row.updated_by || '').startsWith(PUBLISHED_SOURCE_PREFIX)
          && sameInstant(row.opens_at ?? null, r.opensAt)
          && samePercent(row.discount_percent ?? null, r.discountPercent);
      });
      if (matches) { unchanged.push(s.split); continue; }
      for (const r of s.rounds) upsert.run(s.split, r.round, r.opensAt, r.discountPercent, source);
      changed.push(s.split);
    }
    if (fee.value !== null) {
      const text = String(fee.value);
      for (const key of GENERAL_FEE_SETTINGS) {
        const row = db.prepare('SELECT value, updated_by FROM app_settings WHERE key = ?').get(key) as any;
        if (row && row.value === text && String(row.updated_by || '').startsWith(PUBLISHED_SOURCE_PREFIX)) continue;
        db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`)
          .run(key, text, source);
        feeChanged = true;
      }
    }
    putSetting(db, SETTING_GENERAL_FEE_REJECTED, fee.rejected ?? '');
    putSetting(db, SETTING_EVENT_ID, event.id);
    putSetting(db, SETTING_CREATED_AT, String(event.created_at));
    putSetting(db, SETTING_REJECTED, rejectedJson);
  })();

  return {
    outcome: 'applied', changed, unchanged, rejected, rejectedChanged: previousRejected !== rejectedJson,
    generalFee: {
      published: fee.value,
      changed: feeChanged,
      rejected: fee.rejected,
      rejectedChanged: (fee.rejected ?? '') !== previousFeeRejected,
    },
  };
}

/** Did this split's terms come from KIND 38888? Then only KIND 38888 changes them. */
export function isSplitPublishedIn38888(db: Database.Database, split: number): boolean {
  return !!db.prepare('SELECT 1 FROM acquisition_rounds WHERE split = ? AND updated_by LIKE ? LIMIT 1')
    .get(split, `${PUBLISHED_SOURCE_PREFIX}%`);
}

export interface PublishedTermsStatus {
  eventId: string | null;
  /** Unix seconds of the last applied event. */
  createdAt: number | null;
  rejected: RejectedSplit[];
}

export function publishedTermsStatus(db: Database.Database): PublishedTermsStatus {
  let rejected: RejectedSplit[] = [];
  try { rejected = JSON.parse(getSetting(db, SETTING_REJECTED) || '[]'); } catch { rejected = []; }
  const createdAt = Number(getSetting(db, SETTING_CREATED_AT) || 0);
  return { eventId: getSetting(db, SETTING_EVENT_ID), createdAt: createdAt || null, rejected };
}
