/**
 * KIND 30960 — Treasury Acquisition Mandate (Financing Round) — into
 * acquisition_mandates. Contract: scratchpad/kind30960-contract.md (v1).
 *
 * Two roads in, one door:
 *   - the brain PUSHES each signed event to POST /api/treasury/mandates/ingest
 *     right after publishing it;
 *   - the heartbeat PULLS kinds:[30960] authors:[pin] from the relays.
 * Both call ingestMandateEvent, which does the same four checks in the same
 * order: author pin → signature (id recomputed, Schnorr verified) → contract
 * parse → newest created_at per d wins. The push exists because a quiet
 * relay returns [] (ops_quiet_relay_retires_plan); it must not be that
 * nobody can sell at the Split because a relay did not answer. Same bytes,
 * two roads, one verifier.
 *
 * FAIL CLOSED. Anything unverifiable is ignored and never stored — a mandate
 * row opens a treasury cap, so its absence is the safe state. Sync never
 * deletes rows: only a newer signed event for the same d replaces one.
 */
import type Database from 'better-sqlite3';
import { verifyEventSignature, queryEventsFromRelays, type NostrEvent } from './nostr.js';
import type { MandateCandidate, MandateWallet, RoundTerms } from './roundMandate.js';
import { LAST_SYNC_SETTING_KEY } from '../db/roundMandateSchema.js';
import { consumedByMandate } from './acquisitionOffer.js';
import {
  roundStandings, sequenceOpenings, remainingOfMember,
  type RoundOpening, type OpensMode,
} from './roundSequence.js';

/** The LanaPays.us processor key — the ONLY author whose mandates count. */
export const LANAPAYS_PROCESSOR_PUBKEY = '79730aba75d71584e8a4f9d0cc1173085e75590ce489760078d2bf6f5210d692';
export const MANDATE_KIND = 30960;

export type ParsedMandate =
  | { ok: true; row: MandateCandidate }
  | { ok: false; reason: string };

/** The only reasons a tombstone may give (contract, status=closed). */
export const CLOSED_REASONS = ['window_ended', 'financer_request', 'superseded'] as const;

const HEX64 = /^[0-9a-f]{64}$/;
/** Exactly 8 decimals — the contract's LANA format. */
const LANA_8DP = /^(\d+)\.(\d{8})$/;

/** "32527.97000000" → 3252797000000n; null when not exactly 8dp. */
function lanaToLanoshis(s: string): bigint | null {
  const m = LANA_8DP.exec(String(s || ''));
  if (!m) return null;
  return BigInt(m[1]) * 100_000_000n + BigInt(m[2]);
}

const first = (tags: string[][], name: string): string | undefined =>
  tags.find(t => t[0] === name)?.[1];
const all = (tags: string[][], name: string): string[][] =>
  tags.filter(t => t[0] === name);

/**
 * Contract rules 2–4 plus the required-tag list, and nothing about WHO
 * signed: the author pin and the signature are ingestMandateEvent's job,
 * this only reads the shape. Pure.
 *
 * TAGS ARE AUTHORITATIVE. `event.content` is a JSON mirror of the tags for
 * human readers (repeatable tags become arrays there); it is never read
 * here, so a content that disagrees with the tags — or is not JSON at all —
 * changes nothing. What was signed is what the tags say.
 */
export function parseMandate30960(event: NostrEvent): ParsedMandate {
  if (!event || event.kind !== MANDATE_KIND) return { ok: false, reason: 'not kind 30960' };
  const tags = Array.isArray(event.tags) ? event.tags : [];

  const d = first(tags, 'd');
  const p = first(tags, 'p');
  const splitRaw = first(tags, 'split');
  const roundRaw = first(tags, 'round');
  const status = first(tags, 'status');

  if (!d) return { ok: false, reason: 'missing d' };
  if (!p || !HEX64.test(p)) return { ok: false, reason: 'p must be 64 lowercase hex' };
  const split = Number(splitRaw);
  const round = Number(roundRaw);
  if (!/^\d+$/.test(String(splitRaw)) || !Number.isInteger(split) || split < 1) return { ok: false, reason: 'bad split' };
  if (!/^[123]$/.test(String(roundRaw))) return { ok: false, reason: 'round must be 1, 2 or 3' };
  if (status !== 'announced' && status !== 'closed') return { ok: false, reason: 'status must be announced or closed' };
  // Rule 2: the address IS the identity — a d that names a different
  // split/round/hex than the tags would let one event masquerade as another.
  if (d !== `${splitRaw}:${roundRaw}:${p}`) return { ok: false, reason: 'd does not equal split:round:p' };

  const base = { dTag: d, eventId: event.id, split, round, financerHex: p };

  if (status === 'closed') {
    // Rule 4: a tombstone carries nothing that could be mistaken for a live cap.
    const forbidden = ['wallet', 'a', 'lana_received', 'lana_received_lanoshis', 'indicative', 'acquisition_discount_percent'];
    const carried = forbidden.filter(n => tags.some(t => t[0] === n));
    if (carried.length) return { ok: false, reason: `closed event carries ${carried.join(', ')}` };
    // A tombstone must say why, and only in the contract's words. That is the
    // ONLY extra demand on a tombstone on purpose: rejecting one for a
    // missing informational tag would keep a cap OPEN — the unsafe direction.
    const closedReason = first(tags, 'closed_reason');
    if (!closedReason) return { ok: false, reason: 'closed event has no closed_reason' };
    if (!(CLOSED_REASONS as readonly string[]).includes(closedReason)) {
      return { ok: false, reason: `closed_reason must be one of ${CLOSED_REASONS.join(', ')}` };
    }
    return { ok: true, row: { ...base, status: 'closed', wallets: [], lanaReceivedLanoshis: 0 } };
  }

  // An announced event OPENS a cap, so every required tag is required: the
  // Split it was built from (e), when (snapshot_at), whose key it names
  // (lanapays_pubkey — must be the pin; a different value is a different
  // publisher's idea of a mandate), and which contract it speaks
  // (bef_version). Missing any one of them, it is not a mandate we read.
  const splitEvent = first(tags, 'e');
  if (!splitEvent || !HEX64.test(splitEvent)) return { ok: false, reason: 'announced event needs e (the KIND 38888 event id, 64 hex)' };
  const snapshotAt = first(tags, 'snapshot_at');
  if (!snapshotAt || !/^\d+$/.test(snapshotAt)) return { ok: false, reason: 'announced event needs snapshot_at (unix seconds)' };
  const lanapaysPubkey = first(tags, 'lanapays_pubkey');
  if (!lanapaysPubkey) return { ok: false, reason: 'announced event needs lanapays_pubkey' };
  if (lanapaysPubkey.toLowerCase() !== LANAPAYS_PROCESSOR_PUBKEY) return { ok: false, reason: 'lanapays_pubkey is not the LanaPays.us processor key' };
  // Presence only: a newer contract string must not silently close every cap
  // on the day the publisher bumps it; the shape checks above and below are
  // what protect us, and they run regardless of the version named.
  if (!first(tags, 'bef_version')) return { ok: false, reason: 'announced event needs bef_version' };

  // Rule 3: the two totals and the wallet shares must all agree, to the lanoshi.
  const receivedLanoshis = lanaToLanoshis(first(tags, 'lana_received') || '');
  if (receivedLanoshis === null) return { ok: false, reason: 'lana_received must have exactly 8 decimals' };
  const lanoshisRaw = first(tags, 'lana_received_lanoshis') || '';
  if (!/^\d+$/.test(lanoshisRaw) || BigInt(lanoshisRaw) !== receivedLanoshis) {
    return { ok: false, reason: 'lana_received_lanoshis does not equal lana_received × 1e8' };
  }

  const walletTags = all(tags, 'wallet');
  if (walletTags.length === 0) return { ok: false, reason: 'announced event has no wallet tag' };
  const wallets: MandateWallet[] = [];
  let sum = 0n;
  for (const w of walletTags) {
    const [, address, currency, share, fundSettingId] = w;
    if (!address || !currency || !fundSettingId) return { ok: false, reason: 'wallet tag needs address, currency, share, fund_setting_id' };
    const shareLanoshis = lanaToLanoshis(share || '');
    if (shareLanoshis === null) return { ok: false, reason: 'wallet share must have exactly 8 decimals' };
    sum += shareLanoshis;
    wallets.push({ address, currency: currency.toUpperCase(), lanaLanoshis: Number(shareLanoshis), fundSettingId });
  }
  if (sum !== receivedLanoshis) return { ok: false, reason: 'wallet shares do not sum to lana_received' };
  if (receivedLanoshis > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'lana_received exceeds safe integer range' };

  return { ok: true, row: { ...base, status: 'announced', wallets, lanaReceivedLanoshis: Number(receivedLanoshis) } };
}

export interface IngestResult {
  stored: boolean;
  dTag?: string;
  reason?: string;
}

/**
 * The one door into acquisition_mandates.
 *
 * `authorizedPubkey` is a parameter ONLY so the tests can sign with a key
 * they hold; production callers never pass it and get the pin.
 */
export function ingestMandateEvent(
  db: Database.Database,
  event: NostrEvent,
  opts: { authorizedPubkey?: string } = {},
): IngestResult {
  const pin = (opts.authorizedPubkey || LANAPAYS_PROCESSOR_PUBKEY).toLowerCase();

  // Author first: an event from anyone else is not a mandate, however well
  // formed, and its signature is not worth the CPU to check.
  if (!event || String(event.pubkey || '').toLowerCase() !== pin) {
    return { stored: false, reason: 'author is not the LanaPays.us processor key' };
  }
  if (event.kind !== MANDATE_KIND) return { stored: false, reason: 'not kind 30960' };
  if (!verifyEventSignature(event)) return { stored: false, reason: 'id or signature does not verify' };

  const parsed = parseMandate30960(event);
  if (parsed.ok === false) return { stored: false, reason: parsed.reason };
  const row = parsed.row;

  // Newest created_at per d wins (NIP-33). A 'closed' tombstone lands here
  // like any other replacement and empties the wallets — the cap is gone.
  const r = db.prepare(`
    INSERT INTO acquisition_mandates (
      d_tag, event_id, pubkey, event_created_at, split, round, financer_hex,
      wallets_json, lana_received_lanoshis, status, raw_event, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(d_tag) DO UPDATE SET
      event_id = excluded.event_id,
      pubkey = excluded.pubkey,
      event_created_at = excluded.event_created_at,
      split = excluded.split,
      round = excluded.round,
      financer_hex = excluded.financer_hex,
      wallets_json = excluded.wallets_json,
      lana_received_lanoshis = excluded.lana_received_lanoshis,
      status = excluded.status,
      raw_event = excluded.raw_event,
      fetched_at = datetime('now')
    WHERE excluded.event_created_at > acquisition_mandates.event_created_at
  `).run(
    row.dTag, row.eventId, event.pubkey.toLowerCase(), event.created_at, row.split, row.round,
    row.financerHex, JSON.stringify(row.wallets), row.lanaReceivedLanoshis, row.status,
    JSON.stringify(event),
  );
  return r.changes === 1
    ? { stored: true, dTag: row.dTag }
    : { stored: false, dTag: row.dTag, reason: 'an equal or newer event for this d is already stored' };
}

/** Rows as the decision module wants them. */
export function rowToCandidate(r: any): MandateCandidate {
  let wallets: MandateWallet[] = [];
  try { wallets = JSON.parse(r.wallets_json || '[]'); } catch { wallets = []; }
  return {
    dTag: r.d_tag,
    eventId: r.event_id,
    split: Number(r.split),
    round: Number(r.round),
    financerHex: String(r.financer_hex || '').toLowerCase(),
    wallets,
    lanaReceivedLanoshis: Number(r.lana_received_lanoshis) || 0,
    status: r.status === 'closed' ? 'closed' : 'announced',
  };
}

export function listMandatesForHex(db: Database.Database, hexId: string): MandateCandidate[] {
  return (db.prepare('SELECT * FROM acquisition_mandates WHERE lower(financer_hex) = lower(?)').all(hexId) as any[])
    .map(rowToCandidate);
}

export function listMandatesForSplit(db: Database.Database, split: number): MandateCandidate[] {
  return (db.prepare('SELECT * FROM acquisition_mandates WHERE split = ? ORDER BY round ASC, financer_hex ASC').all(split) as any[])
    .map(rowToCandidate);
}

/**
 * acquisition_rounds for one split, as the decision module wants them —
 * including HOW each round opens and whether its turn has already come.
 *
 * The recorded turn is joined in here rather than looked up separately so that
 * the gate, the seller's panel and the admin worklist cannot end up asking
 * different questions about the same round. One row, one answer.
 */
export function loadRoundTerms(handle: Database.Database, split: number): RoundTerms[] {
  const rows = handle.prepare(`
    SELECT r.round, r.opens_at, r.discount_percent, r.opens_mode, o.opened_at
      FROM acquisition_rounds r
      LEFT JOIN acquisition_round_opens o ON o.split = r.split AND o.round = r.round
     WHERE r.split = ?
  `).all(split) as any[];
  return rows
    .map(r => {
      // An unparseable date must not take the whole row with it. It used to:
      // the row was dropped, so "this round opens by sequence, and its date is
      // gibberish" became indistinguishable from "nothing was ever published
      // for this round" — and the second one is the state that hides a
      // financer's money from them.
      const parsed = r.opens_at ? Math.floor(Date.parse(r.opens_at) / 1000) : null;
      const openedParsed = r.opened_at ? Math.floor(Date.parse(r.opened_at + 'Z') / 1000) : null;
      return {
        round: Number(r.round),
        opensAt: parsed !== null && Number.isFinite(parsed) ? parsed : null,
        discountPercent: r.discount_percent === null || r.discount_percent === undefined ? null : Number(r.discount_percent),
        opensMode: (r.opens_mode === 'date' || r.opens_mode === 'sequence' ? r.opens_mode : null) as OpensMode,
        openedAt: openedParsed !== null && Number.isFinite(openedParsed) ? openedParsed : null,
      };
    });
}

/** 24 h: below that a quiet relay is a blip, above it we stop assuming. */
export const SEQUENCE_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Have we verifiably heard from a relay recently enough to act on what we hold?
 *
 * The last-sync stamp is written only when at least one VERIFIED event came
 * back, so "we asked and heard nothing" never reads as "we are in sync". A
 * round's turn is read off mandates, and stale mandates are a reason to wait
 * rather than to open a treasury cap.
 */
export function syncIsFresh(handle: Database.Database, now = Date.now()): boolean {
  const row = handle.prepare('SELECT value FROM app_settings WHERE key = ?').get(LAST_SYNC_SETTING_KEY) as any;
  const ms = row?.value ? Date.parse(String(row.value)) : NaN;
  return Number.isFinite(ms) && now - ms <= SEQUENCE_SYNC_MAX_AGE_MS;
}

/**
 * RECORD ANY ROUND WHOSE TURN HAS COME. Idempotent, monotone, cheap.
 *
 * Called from the proposal transaction (so the proposal that empties a round
 * opens the next one in the same breath), from the heartbeat (so a round opens
 * even on a quiet day), and from the reads (so the screen never shows a shut
 * round the gate would have opened — that gap is a dead button in front of an
 * open door, and it is the exact failure this whole module exists to end).
 *
 * Writing from a read is deliberate. What is written is not the reader's
 * doing: it is a fact about mandates and offers that was already true, and
 * INSERT OR IGNORE means the first observer merely stamps the moment we first
 * noticed. Nothing a caller passes can change the outcome.
 */
export function syncRoundOpenings(
  handle: Database.Database,
  split: number,
  opts: { now?: number; syncFresh?: boolean } = {},
): { round: number; trigger: string }[] {
  const nowMs = opts.now ?? Date.now();
  const syncFresh = opts.syncFresh ?? syncIsFresh(handle, nowMs);
  const terms = loadRoundTerms(handle, split);
  const openings: RoundOpening[] = terms.map(t => ({
    round: t.round, opensAt: t.opensAt,
    opensMode: t.opensMode ?? null, openedAt: t.openedAt ?? null,
  }));
  if (!openings.some(o => o.opensMode === 'sequence' && o.openedAt === null)) return [];

  const live = listMandatesForSplit(handle, split).filter(m => m.status === 'announced');
  const consumed = consumedByMandate(handle, live.map(m => m.dTag));
  const standings = roundStandings(live.map(m => ({
    round: m.round,
    remainingLanoshis: remainingOfMember(m.lanaReceivedLanoshis, consumed.get(m.dTag) || 0),
  })));

  const due = sequenceOpenings({ openings, standings, syncFresh });
  if (due.length === 0) return [];
  const insert = handle.prepare(
    'INSERT OR IGNORE INTO acquisition_round_opens (split, round, evidence) VALUES (?, ?, ?)',
  );
  const written: { round: number; trigger: string }[] = [];
  for (const d of due) {
    if (insert.run(split, d.round, d.trigger).changes === 1) {
      written.push(d);
      console.log(`[lana-discount] Split ${split} round ${d.round} opened by sequence — ${d.trigger}`);
    }
  }
  return written;
}

export function loadReleases(handle: Database.Database, dTags: string[]): Set<string> {
  if (dTags.length === 0) return new Set();
  const rows = handle.prepare(
    `SELECT d_tag FROM acquisition_mandate_releases WHERE d_tag IN (${dTags.map(() => '?').join(',')})`,
  ).all(...dTags) as any[];
  return new Set(rows.map(r => r.d_tag));
}

export interface PullResult {
  seen: number;
  stored: number;
  rejected: number;
}

/**
 * Relay sync. The last-sync setting is written only when at least one
 * VERIFIED event came back: "we asked and heard nothing" must not read as
 * "we are in sync" on the admin's screen, because a quiet relay looks exactly
 * like that (ops_quiet_relay_retires_plan).
 */
export async function pullRoundMandates(
  db: Database.Database,
  relays: string[],
  deps: { query?: typeof queryEventsFromRelays; setSetting?: (key: string, value: string) => void } = {},
): Promise<PullResult> {
  const query = deps.query || queryEventsFromRelays;
  if (!relays || relays.length === 0) return { seen: 0, stored: 0, rejected: 0 };

  const events = await query(relays, { kinds: [MANDATE_KIND], authors: [LANAPAYS_PROCESSOR_PUBKEY], limit: 1000 }, 15000);
  let stored = 0, rejected = 0, verified = 0;
  const ingestAll = db.transaction((evs: NostrEvent[]) => {
    for (const e of evs) {
      const r = ingestMandateEvent(db, e);
      if (r.stored) { stored++; verified++; }
      else if (r.dTag) verified++;   // verified, just not newer
      else rejected++;
    }
  });
  ingestAll(events);

  if (verified > 0) {
    const set = deps.setSetting || ((key, value) =>
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), 'sync')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = 'sync'
      `).run(key, value));
    set(LAST_SYNC_SETTING_KEY, new Date().toISOString());
  }
  console.log(`[lana-discount] Round mandates sync — ${events.length} events, ${stored} stored, ${rejected} rejected`);
  return { seen: events.length, stored, rejected };
}
