/**
 * THE STORED KIND 38888, VERIFIED — the only source of the relays the dealer
 * reader asks and of the reliable people whose signature admits a dealer.
 *
 * Why not the `relays` column, getRelaysFromDb() or parseKind38888Event:
 * all three fall back to relays written into this repository when the stored
 * event says nothing, and the row itself can be the boot seed (sig
 * 'local_seed') or whatever the public POST /api/sync-kind-38888 last wrote.
 * Nothing on this path trusts a column. It reads the stored raw event, copies
 * it to its seven NIP-01 fields, and accepts it only when it is the system
 * parameters event — KIND 38888, d "main", signed by the Lana Core Authority —
 * and its signature verifies. Then, from THAT event only:
 *
 *   relays    the ["relay", url] tags, else content.relays (as BEF Explorer
 *             reads them: bef-explorer server/lib/nostr.ts parseKind38888Event),
 *             wss only, no credentials, no trailing slash, each once. Nothing
 *             is added: an event that names no relay is asked of no relay.
 *   reliable  the ["reliable_person", hex, name] tags, else
 *             content.reliable_people[].hex — trimmed, lower-cased, exactly 64
 *             hex, each once (the same parser, lines 314-321 and 393-399).
 *
 * Anything else — no row, a seed row, a forged or altered event, another
 * author — answers null: "unknown", and the page names no firm.
 */
import type Database from 'better-sqlite3';
import { SYSTEM_PARAMETERS_PUBKEY } from '../publishedRoundTerms.js';
import { bareEvent, normaliseRelay, verifyBareEvent } from './relayRead.ts';

export interface Verified38888 {
  eventId: string;
  createdAt: number;
  /** wss relays the event itself publishes, in its order, each once. */
  relays: string[];
  /** 64-hex keys of the reliable people the event names. */
  reliable: Set<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The verdict on the last raw text read. The event is about 100 KB, and
 * hashing it on every request is wasted work when the row has not changed; the
 * key is the raw text itself, so a changed row can never reuse an old verdict.
 */
let memo: { raw: string; author: string; answer: Verified38888 | null } | null = null;

export function parseVerified38888(raw: string, author: string = SYSTEM_PARAMETERS_PUBKEY): Verified38888 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = bareEvent(parsed);
  if (!event || event.kind !== 38888 || event.pubkey !== author) return null;
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === 'main')) return null;
  if (!verifyBareEvent(event)) return null;

  let content: { relays?: unknown; reliable_people?: unknown } = {};
  try {
    const parsed: unknown = event.content.trim().startsWith('{') ? JSON.parse(event.content) : {};
    content = parsed && typeof parsed === 'object' ? (parsed as typeof content) : {};
  } catch {
    content = {};
  }

  const tagRelays = event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]);
  const named: unknown[] = tagRelays.length > 0 ? tagRelays : Array.isArray(content.relays) ? content.relays : [];
  const relays: string[] = [];
  for (const candidate of named) {
    const url = normaliseRelay(candidate);
    if (url && !relays.includes(url)) relays.push(url);
  }

  const reliable = new Set<string>();
  for (const t of event.tags) {
    if (t[0] !== 'reliable_person') continue;
    const hex = String(t[1] ?? '').trim().toLowerCase();
    if (HEX64.test(hex)) reliable.add(hex);
  }
  if (reliable.size === 0 && Array.isArray(content.reliable_people)) {
    for (const entry of content.reliable_people as { hex?: unknown }[]) {
      const hex = String(entry?.hex ?? '').trim().toLowerCase();
      if (HEX64.test(hex)) reliable.add(hex);
    }
  }

  return { eventId: event.id, createdAt: event.created_at, relays, reliable };
}

/** The newest stored KIND 38888, verified, or null. Never throws. */
export function verifiedKind38888(db: Database.Database, opts: { author?: string } = {}): Verified38888 | null {
  const author = opts.author ?? SYSTEM_PARAMETERS_PUBKEY;
  let raw: string | null = null;
  try {
    const row = db.prepare('SELECT raw_event FROM kind_38888 ORDER BY created_at DESC, id DESC LIMIT 1').get() as
      | { raw_event: string | null }
      | undefined;
    raw = typeof row?.raw_event === 'string' ? row.raw_event : null;
  } catch {
    return null;
  }
  if (!raw) return null;
  if (memo && memo.raw === raw && memo.author === author) return memo.answer;
  const answer = parseVerified38888(raw, author);
  memo = { raw, author, answer };
  return answer;
}
