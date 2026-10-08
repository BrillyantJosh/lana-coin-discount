/**
 * A dealer's own word on who may sign its profile: the file
 * https://<host>/.well-known/bef-dealer.json (KIND 30972, NIP-05 style) —
 * {"dealers": {"<slug>": {"admins": [<64 hex>, …], "name": "…"}}}.
 *
 * BEF Explorer is a directory: it has no one domain it trusts, so it asks the
 * host a profile itself names as its website (./dealers.ts). Asking a host a
 * stranger named is the risk this module carries, and it is held small:
 *
 *   - https only, port 443, one fixed path; nothing a profile says goes into
 *     the request but the host name, and that must be a plain DNS name;
 *   - the name must resolve to public addresses only (publicLookup): a
 *     profile naming a host that points into a private network gets nothing
 *     asked there — checked in the lookup the connection itself uses, so a
 *     name cannot answer "public" to the check and "private" to the connect;
 *   - a redirect is followed only to the same host over https, and at most a
 *     few times; to anywhere else it is no answer;
 *   - a time limit, a size limit, no cookies, nothing sent but the request.
 *
 * WHAT COUNTS AS AN ANSWER. Only a 200 whose body is a well-formed dealer file.
 * Then what it lists is the site's word, also when it no longer lists a key or a
 * slug. Anything else — a timeout, a refused or private address, an error page,
 * a redirect elsewhere, a page that is not the file (a site's catch-all answers
 * 200 with its home page) — says nothing, and nothing of that site is listed
 * this time (fail-closed: kinds.json 30972 directory_reader_profile (2)).
 *
 * Which hosts are asked at all is not a stranger's choice: only a host that a
 * reliable person's own signed profile names, or one listed last time
 * (./dealers.ts).
 */
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

export const WELL_KNOWN_PATH = '/.well-known/bef-dealer.json';
/** A host name only: no scheme, port, path, user, trailing dot — and no IP address (the last label is letters). */
export const HOST_PATTERN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const WELL_KNOWN_TIMEOUT_MS = 8000;
/** The file lists slugs and keys: a few hundred bytes. Anything near this is not that file. */
export const WELL_KNOWN_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

/* ── the file ─────────────────────────────────────────────────────────────── */

export interface WellKnownDealer {
  d: string;
  /** 64 lowercase hex, each once, in the file's order. */
  admins: string[];
}

export interface WellKnownRead {
  /** False when the file is not {"dealers": {…}} at all. */
  ok: boolean;
  dealers: WellKnownDealer[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A parsed dealer file, as the reference reads it (befDealers.ts parseWellKnown):
 * a key that is not 64 lowercase hex names nobody and is skipped, a slug that
 * breaks the slug rule is skipped, a dealer with no admins list has no admin.
 */
export function parseWellKnown(raw: unknown): WellKnownRead {
  if (!isPlainObject(raw) || !isPlainObject(raw.dealers)) return { ok: false, dealers: [] };
  const dealers: WellKnownDealer[] = [];
  for (const [slug, entry] of Object.entries(raw.dealers)) {
    if (!SLUG_PATTERN.test(slug)) continue;
    const admins: string[] = [];
    if (isPlainObject(entry) && Array.isArray(entry.admins)) {
      for (const a of entry.admins) if (typeof a === 'string' && HEX64.test(a) && !admins.includes(a)) admins.push(a);
    }
    dealers.push({ d: slug, admins });
  }
  return { ok: true, dealers };
}

/** The keys a dealer file allows to sign for `d` (none when it does not list d). */
export function adminsFor(read: WellKnownRead, d: string): string[] {
  return read.dealers.find((x) => x.d === d)?.admins ?? [];
}

/**
 * The host of a profile's website, when it is one BEF Explorer may ask; else
 * null. https on the default port only (URL drops an explicit :443): the file
 * is asked on port 443, and a website on another port names no host there —
 * as in the reference (befDealers.ts websiteHost) and directory_reader_profile (1).
 */
export function websiteHost(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== 'https:') return null;
    if (url.port !== '') return null;
    const host = url.hostname.toLowerCase();
    return HOST_PATTERN.test(host) ? host : null;
  } catch {
    return null;
  }
}

/* ── asking the host ──────────────────────────────────────────────────────── */

export type WellKnownAnswer =
  | { answered: true; read: WellKnownRead }
  | { answered: false; reason: string };

export interface HttpReply {
  status: number;
  /** The Location header of a redirect. */
  location: string | null;
  /** The body of a 200 (null for anything else). */
  body: Buffer | null;
  /** The body went past the size limit and was cut off. */
  tooLarge: boolean;
}

/** One GET, never following a redirect itself. Injectable so the tests reach no host. */
export type HttpGet = (url: string) => Promise<HttpReply>;

/** Ask `host` for its dealer file: an answer only when the file came back well formed. Never throws. */
export async function fetchWellKnown(host: string, get: HttpGet = httpsGet): Promise<WellKnownAnswer> {
  if (!HOST_PATTERN.test(host)) return { answered: false, reason: 'not a host name' };
  let url = `https://${host}${WELL_KNOWN_PATH}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let reply: HttpReply;
    try {
      reply = await get(url);
    } catch (err: any) {
      return { answered: false, reason: `unreachable (${String(err?.code || err?.message || err).slice(0, 60)})` };
    }
    if (reply.status >= 300 && reply.status < 400) {
      let next: URL;
      try {
        next = new URL(reply.location ?? '', url);
      } catch {
        return { answered: false, reason: 'redirect without a valid address' };
      }
      // Only to the same host, over https, on its own port. Anywhere else is
      // another site speaking, and another site cannot vouch for this one.
      if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== host || next.port !== '' || next.username || next.password) {
        return { answered: false, reason: `redirects to another host (${next.protocol}//${next.host})`.slice(0, 120) };
      }
      url = next.href;
      continue;
    }
    if (reply.status !== 200) return { answered: false, reason: `HTTP ${reply.status}` };
    if (reply.tooLarge) return { answered: false, reason: `larger than ${WELL_KNOWN_MAX_BYTES} bytes` };
    let json: unknown;
    try {
      json = JSON.parse((reply.body ?? Buffer.alloc(0)).toString('utf8'));
    } catch {
      return { answered: false, reason: 'not JSON' };
    }
    const read = parseWellKnown(json);
    if (!read.ok) return { answered: false, reason: 'not a dealer file' };
    return { answered: true, read };
  }
  return { answered: false, reason: 'too many redirects' };
}

/* ── only public addresses ────────────────────────────────────────────────── */

const PRIVATE_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  PRIVATE_V4.addSubnet(net, prefix, 'ipv4');
}
const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addAddress('::', 'ipv6');
PRIVATE_V6.addAddress('::1', 'ipv6');
for (const [net, prefix] of [
  ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  PRIVATE_V6.addSubnet(net, prefix, 'ipv6');
}

/** True only for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE_V4.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is that IPv4 address.
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    return isIP(v4) === 4 && !PRIVATE_V4.check(v4, 'ipv4');
  }
  return !PRIVATE_V6.check(lower, 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * dns.lookup that refuses a name with any non-public address. Given to the
 * request as its `lookup`, so the address checked is the address connected to.
 */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = (addresses ?? []) as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const refused: NodeJS.ErrnoException = new Error(`${hostname} does not resolve to public addresses only`);
      refused.code = 'ENOTPUBLIC';
      return callback(refused, '');
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** What httpsGet may be handed instead of the real network — only the tests do. */
export interface HttpsGetOptions {
  timeoutMs?: number;
  maxBytes?: number;
  request?: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
  lookup?: RequestOptions['lookup'];
  /** The scheme of the request — https always, except a test's local server. */
  protocol?: 'https:' | 'http:';
  port?: number;
}

/** One GET over https: no redirect followed, no cookie sent, cut off at the size and time limits. */
export function httpsGet(url: string, opts: HttpsGetOptions = {}): Promise<HttpReply> {
  const timeoutMs = opts.timeoutMs ?? WELL_KNOWN_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? WELL_KNOWN_MAX_BYTES;
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = (opts.request ?? httpsRequest)(
      {
        protocol: opts.protocol ?? 'https:',
        hostname: target.hostname,
        port: opts.port ?? 443,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'lana.discount KIND 30972 reader' },
        lookup: opts.lookup ?? publicLookup,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (status !== 200) {
          res.resume();
          done(() => resolve({ status, location, body: null, tooLarge: false }));
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            done(() => resolve({ status, location, body: null, tooLarge: true }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(() => resolve({ status, location, body: Buffer.concat(chunks), tooLarge: false })));
        res.on('error', (err) => done(() => reject(err)));
      },
    );
    const timer = setTimeout(() => {
      done(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.destroy();
    }, timeoutMs);
    req.on('error', (err) => done(() => reject(err)));
    req.end();
  });
}
