/**
 * Relay READS for the dealer reader — the read half of BEF Explorer's
 * server/lib/relayClient.ts (bef-explorer a7d3702), copied verbatim:
 * bareEvent, checkEventSignature / verifyBareEvent, normaliseRelay (exported
 * here: ./systemParams.ts uses it on the stored KIND 38888's relay list),
 * queryRelay and queryRelays. Nothing that publishes came along: lana.discount
 * only reads KIND 30972, it never writes one.
 *
 * Why not server/lib/nostr.ts, which already reads relays: its queryRelay has
 * no EOSE "completed" signal (silence cannot be told from "nothing there"),
 * does not check the subscription id, and dedupes on `event.id` before any
 * verification — so a forged frame carrying a real id hides the real event.
 * The dealer rule needs all three, so the reader brings the code it was
 * written against rather than a second, looser copy of the idea.
 *
 * Which relays are asked is not decided here: the caller hands in the list
 * the verified stored KIND 38888 publishes (./systemParams.ts), nothing else.
 */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NostrEvent } from '../nostr.js';

export type { NostrEvent };

/* ── events ──────────────────────────────────────────────────────────────────── */

/** A fresh object holding exactly the signed fields, or null when the value is
 * not shaped like an event at all. Nothing is verified yet. */
export function bareEvent(raw: unknown): NostrEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.pubkey !== 'string' ||
    typeof r.created_at !== 'number' ||
    !Number.isInteger(r.created_at) ||
    typeof r.kind !== 'number' ||
    !Number.isInteger(r.kind) ||
    !Array.isArray(r.tags) ||
    !r.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string')) ||
    typeof r.content !== 'string' ||
    typeof r.sig !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    pubkey: r.pubkey,
    created_at: r.created_at,
    kind: r.kind,
    tags: (r.tags as string[][]).map((t) => [...t]),
    content: r.content,
    sig: r.sig,
  };
}

export type EventVerifyError = 'malformed_event' | 'id_mismatch' | 'bad_signature';

/** NIP-01: lower-case hex fields, the id is the sha256 of the canonical
 * serialisation, and the Schnorr signature verifies against the event's own
 * pubkey. Call on a bareEvent() copy. */
export function checkEventSignature(event: NostrEvent): { ok: true } | { ok: false; error: EventVerifyError } {
  if (!/^[0-9a-f]{64}$/.test(event.id) || !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig)) {
    return { ok: false, error: 'malformed_event' };
  }
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const expectedId = createHash('sha256').update(serialized, 'utf8').digest('hex');
  if (expectedId !== event.id) return { ok: false, error: 'id_mismatch' };
  try {
    if (!schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(event.id, 'hex'), Buffer.from(event.pubkey, 'hex'))) {
      return { ok: false, error: 'bad_signature' };
    }
  } catch {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true };
}

export const verifyBareEvent = (event: NostrEvent): boolean => checkEventSignature(event).ok;

/* ── which relays ────────────────────────────────────────────────────────────── */

export const normaliseRelay = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    // wss only: a profile or an interest never travels in the clear.
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
};

/* ── reading ─────────────────────────────────────────────────────────────────── */

interface RelayAnswer {
  accepted: NostrEvent[];
  /** The connection opened. */
  connected: boolean;
  /** The relay said it had sent everything it holds (EOSE). */
  completed: boolean;
}

/** Ask one relay. Collects until EOSE, so a relay that sends more than one event
 * cannot make an older one win by arriving first. Never throws. */
function queryRelay(
  url: string,
  filter: Record<string, unknown>,
  accept: (raw: unknown) => NostrEvent | null,
  timeoutMs: number,
): Promise<RelayAnswer> {
  return new Promise((resolve) => {
    const accepted: NostrEvent[] = [];
    let connected = false;
    let completed = false;
    let settled = false;
    let ws: WebSocket | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
      resolve({ accepted, connected, completed });
    };
    const timer = setTimeout(finish, timeoutMs);
    const subscription = `bef_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      ws = new WebSocket(url);
    } catch {
      finish();
      return;
    }
    ws.on('open', () => {
      connected = true;
      ws?.send(JSON.stringify(['REQ', subscription, filter]));
    });
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message[0] === 'EVENT' && message[1] === subscription) {
          const event = accept(message[2]);
          if (event) accepted.push(event);
        } else if (message[0] === 'EOSE' && message[1] === subscription) {
          completed = true;
          finish();
        } else if (message[0] === 'CLOSED' && message[1] === subscription) {
          finish();
        }
      } catch {
        // Ignore malformed relay frames.
      }
    });
    ws.on('error', finish);
    ws.on('close', finish);
  });
}

export interface RelayQueryResult {
  /** Accepted events from every relay, newest first (NIP-01: equal times, lowest id first). */
  events: NostrEvent[];
  /** Relays that delivered at least one accepted event. */
  relaysWithEvents: number;
  /** Relays whose connection opened. */
  relaysConnected: number;
  /** Relays that finished their answer (EOSE) — "none" is only a real answer from these. */
  relaysCompleted: number;
}

export async function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
  accept: (raw: unknown) => NostrEvent | null,
  timeoutMs = 6000,
): Promise<RelayQueryResult> {
  const answers = await Promise.all(relays.map((url) => queryRelay(url, filter, accept, timeoutMs)));
  const events = answers
    .flatMap((a) => a.accepted)
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    events,
    relaysWithEvents: answers.filter((a) => a.accepted.length > 0).length,
    relaysConnected: answers.filter((a) => a.connected).length,
    relaysCompleted: answers.filter((a) => a.completed).length,
  };
}
