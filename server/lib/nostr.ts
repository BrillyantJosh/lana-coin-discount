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
 * Fetch KIND 38888 system parameters
 */
export async function fetchKind38888(): Promise<{ relays: string[]; rawEvent: NostrEvent | null }> {
  const events = await queryEventsFromRelays(DEFAULT_RELAYS, {
    kinds: [38888],
    authors: [AUTHORIZED_PUBKEY],
    limit: 1,
  }, 15000);

  if (events.length === 0) {
    return { relays: DEFAULT_RELAYS, rawEvent: null };
  }

  // Pick newest
  const newest = events.reduce((a, b) => a.created_at > b.created_at ? a : b);

  try {
    const content = JSON.parse(newest.content);
    const relays = content.relays || DEFAULT_RELAYS;
    return { relays, rawEvent: newest };
  } catch {
    return { relays: DEFAULT_RELAYS, rawEvent: newest };
  }
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
