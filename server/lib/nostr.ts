import WebSocket from 'ws';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Kind38888Data {
  event_id: string;
  pubkey: string;
  created_at: number;
  relays: string[];
  electrum_servers: Array<{ host: string; port: string }>;
  exchange_rates: { EUR: number; USD: number; GBP: number };
  split: string;
  split_target_lana?: number;
  split_started_at?: number;
  version: string;
  valid_from: number;
  trusted_signers: Record<string, string[]>;
  raw_event: string;
}

const DEFAULT_RELAYS = [
  'wss://relay.lanavault.space',
  'wss://relay.lanacoin-eternity.com',
];

const AUTHORIZED_PUBKEY = '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3';

/**
 * Query events from a single relay
 */
function queryRelay(relay: string, filter: Record<string, any>, timeout = 10000): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(events); } };

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done();
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay, { handshakeTimeout: 10000 });
    } catch {
      clearTimeout(timer);
      done();
      return;
    }

    ws.on('open', () => {
      const subId = 'q_' + Math.random().toString(36).slice(2, 8);
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[2]) events.push(msg[2]);
        if (msg[0] === 'EOSE') { ws.close(); clearTimeout(timer); done(); }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(timer); done(); });
    ws.on('close', () => { clearTimeout(timer); done(); });
  });
}

/**
 * Query events from multiple relays (deduplicated)
 */
export async function queryEventsFromRelays(
  relays: string[],
  filter: Record<string, any>,
  timeout = 10000
): Promise<NostrEvent[]> {
  const results = await Promise.allSettled(
    relays.map(r => queryRelay(r, filter, timeout))
  );

  const seen = new Set<string>();
  const events: NostrEvent[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const event of result.value) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      }
    }
  }

  return events;
}

/**
 * Parse KIND 38888 event into structured data (same as MejmoseFajn)
 */
function parseKind38888Event(event: NostrEvent): Kind38888Data {
  let content: any = {};
  try {
    content = typeof event.content === 'string' && event.content.trim().startsWith('{')
      ? JSON.parse(event.content)
      : {};
  } catch {
    console.warn('[lana-discount] Failed to parse KIND 38888 content as JSON, using tags only');
  }

  const tags = event.tags;

  const relays = tags
    .filter(t => t[0] === 'relay')
    .map(t => t[1]);

  const electrum_servers = tags
    .filter(t => t[0] === 'electrum')
    .map(t => ({ host: t[1], port: t[2] || '5097' }));

  const fxTags = tags.filter(t => t[0] === 'fx');
  const exchange_rates = {
    EUR: parseFloat(fxTags.find(t => t[1] === 'EUR')?.[2] || '0'),
    USD: parseFloat(fxTags.find(t => t[1] === 'USD')?.[2] || '0'),
    GBP: parseFloat(fxTags.find(t => t[1] === 'GBP')?.[2] || '0'),
  };

  const split = tags.find(t => t[0] === 'split')?.[1] || content.split || '';
  const split_target_lana = parseInt(tags.find(t => t[0] === 'split_target_lana')?.[1] || content.split_target_lana || '0');
  const split_started_at = parseInt(tags.find(t => t[0] === 'split_started_at')?.[1] || content.split_started_at || '0');
  const version = tags.find(t => t[0] === 'version')?.[1] || content.version || '1';
  const valid_from = parseInt(tags.find(t => t[0] === 'valid_from')?.[1] || content.valid_from || '0');

  const trusted_signers = content.trusted_signers || {};

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    relays: relays.length > 0 ? relays : content.relays || DEFAULT_RELAYS,
    electrum_servers: electrum_servers.length > 0 ? electrum_servers : content.electrum || [],
    exchange_rates,
    split,
    split_target_lana,
    split_started_at,
    version,
    valid_from,
    trusted_signers,
    raw_event: JSON.stringify(event),
  };
}

/**
 * Fetch KIND 38888 system parameters from Nostr relays
 */
export async function fetchKind38888(): Promise<Kind38888Data | null> {
  console.log('[lana-discount] Fetching KIND 38888 from Lana relays...');

  const events = await queryEventsFromRelays(DEFAULT_RELAYS, {
    kinds: [38888],
    authors: [AUTHORIZED_PUBKEY],
    limit: 1,
  }, 15000);

  if (events.length === 0) {
    console.error('[lana-discount] No valid KIND 38888 events received from any relay');
    return null;
  }

  // Pick newest
  const newest = events.reduce((a, b) => a.created_at > b.created_at ? a : b);
  console.log(`[lana-discount] Using KIND 38888 event: ${newest.id} (created_at: ${newest.created_at})`);

  return parseKind38888Event(newest);
}

/**
 * Fetch KIND 0 profile for a given pubkey
 */
export async function fetchKind0(pubkey: string, relays?: string[]): Promise<NostrEvent | null> {
  const useRelays = relays && relays.length > 0 ? relays : DEFAULT_RELAYS;

  const events = await queryEventsFromRelays(useRelays, {
    kinds: [0],
    authors: [pubkey],
    limit: 1,
  }, 10000);

  if (events.length === 0) return null;

  // Return newest
  return events.reduce((a, b) => a.created_at > b.created_at ? a : b);
}
