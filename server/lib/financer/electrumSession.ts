/**
 * The LANA on a wallet, read on this server from the Electrum servers the
 * signed KIND 38888 lists.
 *
 * Brilly (5. 10. 2026): "Also show the amount of LANA on the account, i.e. the
 * balance via the Electrum server — see the infrastructure at
 * https://app.mejmosefajn.org/wallet."
 *
 * THE SAME WAY AS THE FLEET. app.mejmosefajn.org/wallet asks its own server,
 * which asks Electrum (mejmosefajnver3 server/lib/electrum.ts); the LANA
 * Registrar does the same (new-lana-register server/lib/electrum.ts — the
 * structure ported here: one connection per server, every question written
 * at once, answers matched by id, the session settled exactly once, the
 * socket always closed). Measured against electrum1/2.lanacoin.com on
 * 5. 10. 2026:
 *   - plain TCP (node:net), no TLS — a TLS handshake on 5097 fails;
 *   - one JSON-RPC object per line, ended by "\n";
 *   - `blockchain.address.get_balance` with the plain LANA address as the only
 *     parameter. These servers speak the old protocol ("0.9"): there is no
 *     scripthash step, and `blockchain.scripthash.get_balance` is answered
 *     "unknown method";
 *   - the answer is {confirmed, unconfirmed} in lanoshi, 1 LANA = 100,000,000
 *     lanoshi; unconfirmed is negative while a payment out waits to confirm;
 *   - answers arrive out of order (id 2, 3, 4 before 1).
 *
 * WHAT IS DONE OTHERWISE THAN THE FLEET, ON PURPOSE.
 *   - Exact: lanoshi are whole numbers, kept as BigInt and written with all 8
 *     decimals — never a float, never rounded to 0.01 LANA (lana.discount once
 *     refused a real transfer over that rounding).
 *   - Unknown is unknown: an address that got no answer, an error, or an answer
 *     that is not two whole numbers is ABSENT from the result — never a balance
 *     of 0 (mejmosefajn and direct.lana.fund turn such an address into 0).
 *   - The servers come only from the newest verified KIND 38888 (its
 *     `["electrum", host, port]` tags; its content's `electrum` list only when no
 *     tag gives one) — none written in the code, as with the relays. With none
 *     listed, nothing is asked and every balance is unknown.
 *   - A closed connection ends the wait at once (the fleet's batch waited out
 *     its whole timeout); at most a few connections at a time; a short memory
 *     per address, so many people opening the page do not open many sockets.
 *   - An answer counts the moment it arrives: one address answered is known
 *     (and remembered) even while another on the same connection is still
 *     waited for, and a caller with a deadline (`waitMs`) gets what is known
 *     by then — one slow address never blanks another's balance.
 *   - The next server has a real chance: each server gets 2.5 s, two of them
 *     fit in the page's wait (6 s, routes/buy.ts); a server that answered
 *     nothing is asked last for a minute, so while one is down nobody waits
 *     for it first.
 *
 * Only addresses from the person's own signed wallet list are ever asked — and
 * one more since 6. 10. 2026: the address a signed-in person asks to register
 * as a new wallet, to make sure it is empty before the Registrar is asked
 * (routes/buy.ts; its Base58Check read in full first, one per request, under
 * its own rate limit). That one is asked `fresh`: never from the 30-second
 * memory and never joined to a question already on its way — an empty wallet
 * must be empty now, not half a minute ago. Never a server a request names.
 *
 * IN LANA.DISCOUNT (8. 10. 2026) this is Krog Menjave's server/lib/electrum.ts
 * (origin/main a46f618), copied for the financer's own sends: the session that
 * payoutChain.ts and chainPayment.ts ask through. It sits beside, and never
 * replaces, this repository's server/lib/electrum.ts, which the treasury's
 * auto-send and the balances already use. One change: the servers. Krog
 * Menjave reads them from the event (electrumServersOf); here they come from
 * the kind_38888 table the relay sync keeps (db/index.ts
 * getElectrumServersFromDb), so electrumServersFrom() below takes that list and
 * applies the same host and port rules. Every factory here takes `servers` as a
 * function, read at each question: the call site passes
 * `() => electrumServersFrom(getElectrumServersFromDb())`.
 */
import net from 'node:net';

/** Lanoshi as an exact decimal: 283984375n, 8 → "2.83984375" (Krog Menjave's server/lib/decimal.ts fromUnits). */
function fromUnits(units: bigint, scale: number): string {
  if (units < 0n) throw new RangeError('negative');
  const text = units.toString().padStart(scale + 1, '0');
  if (scale === 0) return text;
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

export interface ElectrumServer {
  host: string;
  port: number;
}

/** The only method asked: the balance of one address (old protocol, no scripthash). */
export const GET_BALANCE = 'blockchain.address.get_balance';
/** 1 LANA = 10⁸ lanoshi. */
export const LANA_DECIMALS = 8;

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_SERVERS = 8;
/** A LANA address: Base58, the length of a Base58Check of 25 bytes. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/;
/** More than this unread from one connection: the server is not answering balances. */
const MAX_BUFFER = 1024 * 1024;

/** A host as a domain name or IPv4 address, lower case; a port 1–65535 (a number, or digits). */
function serverOf(host: unknown, port: unknown): ElectrumServer | null {
  const name = typeof host === 'string' ? host.trim().toLowerCase() : '';
  const portText = typeof port === 'number' ? String(port) : typeof port === 'string' ? port.trim() : '';
  if (!HOST.test(name) || !/^\d{1,5}$/.test(portText)) return null;
  const number = Number(portText);
  return number >= 1 && number <= 65535 ? { host: name, port: number } : null;
}

/**
 * The Electrum servers of a list, in its order, each host and port read by the
 * same rules as Krog Menjave's electrumServersOf: a malformed host or port is
 * left out, a server listed twice is asked once, at most MAX_SERVERS. Built for
 * getElectrumServersFromDb() (db/index.ts: the newest kind_38888 row's list, or
 * its built-in fallback); anything else that is not a list gives none — and
 * with none, nothing is asked.
 */
export function electrumServersFrom(list: unknown): ElectrumServer[] {
  if (!Array.isArray(list)) return [];
  const servers: ElectrumServer[] = [];
  for (const entry of list) {
    const server = serverOf((entry as { host?: unknown } | null)?.host, (entry as { port?: unknown } | null)?.port);
    if (!server || servers.length >= MAX_SERVERS) continue;
    if (!servers.some((s) => s.host === server.host && s.port === server.port)) servers.push(server);
  }
  return servers;
}

export interface ElectrumRequest {
  id: number;
  method: string;
  params: unknown[];
}

export interface ElectrumReply {
  result?: unknown;
  error?: unknown;
}

/** Opens the connection; injectable so tests can count connections. */
export type ElectrumConnect = (server: ElectrumServer) => net.Socket;

const defaultConnect: ElectrumConnect = (server) => net.createConnection({ host: server.host, port: server.port });

/**
 * One connection: every request written at once on connect, the replies
 * matched by their numeric id, whatever order they come in. Settles exactly
 * once — every request answered, the time is up, the connection failed or was
 * closed — with the replies that arrived; the socket is always destroyed.
 * Never rejects: a server that did not answer simply answered nothing.
 */
export function electrumSession(
  server: ElectrumServer,
  requests: readonly ElectrumRequest[],
  timeoutMs: number,
  connect: ElectrumConnect = defaultConnect,
  /** Told of each reply the moment it arrives — before the session settles. */
  onReply?: (id: number, reply: ElectrumReply) => void,
): Promise<Map<number, ElectrumReply>> {
  return new Promise((resolve) => {
    const replies = new Map<number, ElectrumReply>();
    const wanted = new Set(requests.map((r) => r.id));
    let socket: net.Socket | undefined;
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(replies);
    };
    const timer = setTimeout(finish, timeoutMs);
    if (wanted.size === 0) return finish();
    try {
      socket = connect(server);
    } catch {
      return finish();
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket?.write(requests.map((r) => `${JSON.stringify({ id: r.id, method: r.method, params: r.params })}\n`).join(''));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) return finish();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = message?.id;
        if (typeof id !== 'number' || !wanted.has(id) || replies.has(id)) continue;
        const reply = { result: message.result, error: message.error };
        replies.set(id, reply);
        try {
          onReply?.(id, reply);
        } catch {
          // A listener that fails changes nothing here.
        }
        if (replies.size >= wanted.size) return finish();
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

/** A balance in lanoshi, exactly as the server answered it. */
export interface LanoshiBalance {
  confirmed: bigint;
  /** On its way in (+) or out (−), not yet confirmed. */
  unconfirmed: bigint;
}

/**
 * A get_balance reply as a balance — or null: an error (a string on these
 * servers, an object elsewhere), no result, or anything but two whole numbers
 * (and a confirmed balance below 0). Null is "unknown", never 0.
 */
export function readBalanceReply(reply: ElectrumReply | undefined): LanoshiBalance | null {
  if (!reply || (reply.error !== undefined && reply.error !== null)) return null;
  const result = reply.result as { confirmed?: unknown; unconfirmed?: unknown } | null | undefined;
  if (!result || typeof result !== 'object') return null;
  const { confirmed, unconfirmed } = result;
  if (typeof confirmed !== 'number' || typeof unconfirmed !== 'number') return null;
  if (!Number.isSafeInteger(confirmed) || !Number.isSafeInteger(unconfirmed) || confirmed < 0) return null;
  return { confirmed: BigInt(confirmed), unconfirmed: BigInt(unconfirmed) };
}

/** Lanoshi as LANA, exactly 8 decimals, a minus sign when below 0: 283984375n → "2.83984375". */
export function lanaText(lanoshi: bigint): string {
  return lanoshi < 0n ? `-${fromUnits(-lanoshi, LANA_DECIMALS)}` : fromUnits(lanoshi, LANA_DECIMALS);
}

export interface BalanceReader {
  /**
   * The balance of each address that an Electrum server of KIND 38888
   * answered; an address without a readable answer from any of them is
   * ABSENT (unknown — never 0). With `waitMs`: what is known when that time
   * is up, each address on its own — the rest absent (and still remembered
   * for the next question when it comes). With `fresh`: every address is
   * asked anew — not answered from memory, not joined to a question that was
   * already on its way (it may have been asked before something arrived);
   * what it learns is remembered as any answer is.
   */
  balances(addresses: readonly string[], options?: { waitMs?: number; fresh?: boolean }): Promise<Map<string, LanoshiBalance>>;
}

export interface BalanceReaderOptions {
  /** The servers, read at each question (here: electrumServersFrom(getElectrumServersFromDb())); none — nothing is asked. */
  servers: () => ElectrumServer[];
  /** How long one server has, connecting included. */
  timeoutMs?: number;
  /** How long an answer is reused. */
  cacheMs?: number;
  /** Connections open at once, across everyone. */
  maxConcurrent?: number;
  /** Addresses asked in one call at most (a person's list). */
  maxAddresses?: number;
  now?: () => number;
  connect?: ElectrumConnect;
}

/** One server's time, connecting included: two servers fit in the page's wait (BALANCE_WAIT_MS, 6 s). */
export const BALANCE_TIMEOUT_MS = 2500;
export const BALANCE_CACHE_MS = 30 * 1000;
export const BALANCE_MAX_CONCURRENT = 4;
/** A server that answered nothing is asked last for this long. */
export const BALANCE_SERVER_REST_MS = 60 * 1000;
const MAX_CACHED = 5000;

/** At most `max` tasks at once; a freed slot goes straight to the next in line. */
function slots(max: number) {
  let busy = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (busy < max) busy++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else busy--;
    }
  };
}

export function createBalanceReader(options: BalanceReaderOptions): BalanceReader {
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? BALANCE_CACHE_MS;
  const maxAddresses = options.maxAddresses ?? 50;
  const now = options.now ?? Date.now;
  const connect = options.connect ?? defaultConnect;
  const limit = slots(Math.max(1, options.maxConcurrent ?? BALANCE_MAX_CONCURRENT));
  const cache = new Map<string, { value: LanoshiBalance; until: number }>();
  const inflight = new Map<string, Promise<LanoshiBalance | null>>();
  /** "host:port" of a server that answered nothing → until when it is asked last. */
  const resting = new Map<string, number>();
  const nameOf = (server: ElectrumServer) => `${server.host}:${server.port}`;

  const remember = (address: string, value: LanoshiBalance) => {
    if (!cache.has(address) && cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.delete(address);
    cache.set(address, { value, until: now() + cacheMs });
  };

  /**
   * The next server to ask: the first in KIND 38888's order not yet asked and
   * not resting; a resting one (it answered nothing in the last minute) only
   * when no other is left — still asked, never dropped.
   */
  const nextOf = (servers: ElectrumServer[], asked: Set<string>): ElectrumServer | null => {
    const left = servers.filter((s) => !asked.has(nameOf(s)));
    const at = now();
    return left.find((s) => (resting.get(nameOf(s)) ?? 0) <= at) ?? left[0] ?? null;
  };

  /**
   * Each server in turn is asked for what is still unanswered; stop when
   * nothing is. The server is chosen once a connection slot is free, so one
   * found silent meanwhile (by anyone) is not the next one waited for; and it
   * is marked before the slot is given up. Every address is settled exactly
   * once: with its balance the moment a server answers it, or with null when
   * none did.
   */
  const fetchAll = async (addresses: string[], settle: (address: string, balance: LanoshiBalance | null) => void): Promise<void> => {
    const found = new Set<string>();
    let servers: ElectrumServer[] = [];
    try {
      servers = options.servers();
    } catch {
      servers = [];
    }
    const asked = new Set<string>();
    while (asked.size < servers.length) {
      const missing = addresses.filter((a) => !found.has(a));
      if (missing.length === 0) break;
      const requests = missing.map((address, i) => ({ id: i + 1, method: GET_BALANCE, params: [address] }));
      const went = await limit(async () => {
        const server = nextOf(servers, asked);
        if (!server) return false;
        asked.add(nameOf(server));
        let read = 0;
        await electrumSession(server, requests, timeoutMs, connect, (id, reply) => {
          const address = missing[id - 1];
          const balance = readBalanceReply(reply);
          if (address === undefined || !balance || found.has(address)) return;
          found.add(address);
          read++;
          remember(address, balance);
          settle(address, balance);
        });
        if (read === 0) resting.set(nameOf(server), now() + BALANCE_SERVER_REST_MS);
        else resting.delete(nameOf(server));
        return true;
      });
      if (!went) break;
    }
  };

  return {
    async balances(addresses, balanceOptions = {}) {
      const wanted = [...new Set(addresses.filter((a) => typeof a === 'string' && ADDRESS.test(a)))].slice(0, maxAddresses);
      const out = new Map<string, LanoshiBalance>();
      const pending: Promise<void>[] = [];
      const ask: string[] = [];
      const fresh = balanceOptions.fresh === true;
      for (const address of wanted) {
        const hit = fresh ? undefined : cache.get(address);
        if (hit && hit.until > now()) out.set(address, hit.value);
        else if (!fresh && inflight.has(address)) pending.push(inflight.get(address)!.then((balance) => void (balance && out.set(address, balance))));
        // A fresh question takes the place of one on its way: whoever asks after it joins it, and the older one, done, leaves it be.
        else ask.push(address);
      }
      if (ask.length > 0) {
        const settlers = new Map<string, (balance: LanoshiBalance | null) => void>();
        for (const address of ask) {
          const one = new Promise<LanoshiBalance | null>((resolve) => settlers.set(address, resolve));
          inflight.set(address, one);
          void one.then(() => {
            if (inflight.get(address) === one) inflight.delete(address);
          });
          pending.push(one.then((balance) => void (balance && out.set(address, balance))));
        }
        const settle = (address: string, balance: LanoshiBalance | null) => {
          const resolve = settlers.get(address);
          if (!resolve) return;
          settlers.delete(address);
          resolve(balance);
        };
        // Whatever happens, every address asked is settled: unknown when no server answered it.
        void fetchAll(ask, settle)
          .catch(() => undefined)
          .finally(() => {
            for (const address of ask) settle(address, null);
          });
      }
      const all = Promise.all(pending);
      const waitMs = balanceOptions.waitMs;
      if (waitMs === undefined) {
        await all;
        return out;
      }
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, waitMs));
      });
      try {
        await Promise.race([all, deadline]);
      } finally {
        clearTimeout(timer);
      }
      // What is known now; an answer still on its way is remembered for the next question, not added to this one.
      return new Map(out);
    },
  };
}
