/**
 * THE DEALERS WHO BUY LANA — read from Nostr exactly as BEF Explorer reads its
 * directory, so lana.discount never names a firm BEF Explorer would not list.
 *
 * A PORT of bef-explorer/server/lib/dealers.ts (a7d3702). The rule is theirs,
 * word for word (kinds.json 30972 directory_reader_profile, Brilly 5 Oct
 * 2026): a dealer is listed when
 *
 *   1. its profile is signed by a key its OWN website lists for that slug in
 *      https://<host>/.well-known/bef-dealer.json (./wellKnown.ts asks it, and
 *      only it), the host taken from the profile's website, and
 *   2. at least one admin that host lists for the slug is a reliable person in
 *      the signed KIND 38888 (reliable_person) AND that reliable person has
 *      signed a profile of the slug naming that host — any version, not only
 *      the newest. A site can write anyone's key into its file; the signature
 *      is the consent;
 *
 * and its newest valid profile (newest created_at, a tie to the lowest id,
 * nothing more than 15 minutes ahead) is active and states its roles.
 *
 * HOW IT IS READ, unchanged: (a) the profiles the reliable people signed; (b)
 * the dealer file of each host one of THOSE names (and each host listed last
 * time) — no stranger chooses which sites are asked; (c) every version of
 * those dealers by the keys their sites list; (d) each (host, slug) decided
 * anew. A site that does not answer lists nothing that time, and neither does
 * a profile no relay returned. Only a read no relay answered — or with no
 * verified KIND 38888 — decides nothing.
 *
 * WHAT CHANGED IN THE PORT, and only this:
 *
 *   - refreshDealers(db) became readDealers(params, held): no database. BEF
 *     Explorer keeps a mirror table; lana.discount keeps the last good answer
 *     in memory (../buyingDealers.ts) and hands its dealers back in as `held`,
 *     where BEF read `SELECT … FROM bef_dealers WHERE listed = 1`. Each
 *     `write.run` became a push onto `listed`; each `unlist`/`markStale` a line
 *     in the answer. The decision in step d is the original, refusal reasons
 *     and all.
 *   - The KIND 38888 comes in verified (./systemParams.ts): its relays and its
 *     reliable people are read from the signed event itself, never from a
 *     column.
 *   - What is kept of a listed dealer is its public facts only: name, website,
 *     roles, the keys its site lists, which event and when. No bank account,
 *     owner, director, telephone, registration number or wallet.
 *
 * Which of the listed dealers BUY is the caller's question (../buyingDealers.ts):
 * the held list keeps every listed dealer, because a seller-only firm today
 * may state "buys" tomorrow, and BEF's rule asks a held host again first.
 */
import { bareEvent, queryRelays, verifyBareEvent, type NostrEvent } from './relayRead.ts';
import { checkDealerShape, CONTENT_MAX_BYTES, DEALER_KIND, FUTURE_TOLERANCE_S, type DealerProfile, type DealerRole } from './dealerShape.ts';
import { adminsFor, fetchWellKnown, websiteHost, type WellKnownAnswer } from './wellKnown.ts';
import type { Verified38888 } from './systemParams.ts';

/** How often the dealers are read again — the heartbeat's own cadence. */
export const DEALER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** One page of one relay. Relays answer at most 500 events to a REQ, whatever the limit asks. */
const PAGE_LIMIT = 500;
/** Pages asked of one relay at most per query (and per group of keys). */
const MAX_PAGES = 10;
/** Keys asked in one REQ at most; a longer list is asked in groups. */
const AUTHORS_PER_REQ = 100;
/** A frame whose tags are longer than this cannot be a profile anyone writes: it is not kept. */
const TAGS_MAX_CHARS = 64 * 1024;
const RELAY_TIMEOUT_MS = 10_000;
/** Sites asked per run at most — only hosts a reliable person's own profile names, and hosts listed last time. */
export const MAX_HOSTS_PER_RUN = 50;
/**
 * Sites asked at once. A host name is resolved on libuv's thread pool (4
 * threads), which also compresses responses and reads static files: two
 * lanes leave the others free while a slow name server keeps one waiting.
 */
const HOST_CONCURRENCY = 2;
/** Profiles not listed that one run reports at most. */
const MAX_REPORTED = 50;
const HEX64 = /^[0-9a-f]{64}$/;

/* ── reading the relays ───────────────────────────────────────────────────── */

export interface DealerEventsAnswer {
  /** Every KIND 30972 frame the relays sent — NOT verified yet. */
  events: NostrEvent[];
  relaysAsked: number;
  /** Relays that finished the first page of every group of keys (EOSE): only from these is "nothing" a real answer. */
  relaysAnswered: number;
}

/** What is asked: the profiles of these keys, of these slugs only when given. */
export interface DealerFilter {
  authors: string[];
  d?: string[];
}

export type DealerEventSource = (relays: string[], filter: DealerFilter) => Promise<DealerEventsAnswer>;

/**
 * Every KIND 30972 of the given keys (and slugs) each relay holds, page by page.
 * `until` is inclusive, so a page repeats the last second of the one before;
 * repeats are dropped, and a page that brought nothing new steps one second
 * further back rather than ending the paging — a relay may cap a page below
 * the limit asked, and a run of events in one second must not hide the older
 * ones. Signatures are checked later, and only where one can matter: a Schnorr
 * check blocks every request while it runs.
 */
export async function fetchDealerEvents(relays: string[], filter: DealerFilter, timeoutMs = RELAY_TIMEOUT_MS): Promise<DealerEventsAnswer> {
  const groups: string[][] = [];
  for (let i = 0; i < filter.authors.length; i += AUTHORS_PER_REQ) groups.push(filter.authors.slice(i, i + AUTHORS_PER_REQ));
  const perRelay = await Promise.all(
    relays.map(async (url) => {
      const events: NostrEvent[] = [];
      const seen = new Set<string>();
      let answered = groups.length > 0;
      for (const authors of groups) {
        let until: number | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          // Every frame moves the paging on, also one that is not kept: a page
          // of frames too large to be a profile must not end it.
          let frames = 0;
          let oldest = Infinity;
          const accept = (raw: unknown): NostrEvent | null => {
            const event = bareEvent(raw);
            if (!event) return null;
            frames++;
            oldest = Math.min(oldest, event.created_at);
            if (event.kind !== DEALER_KIND) return null;
            // Nothing larger than a valid profile can be is held: the content
            // rule would refuse it after the paging anyway.
            if (Buffer.byteLength(event.content, 'utf8') > CONTENT_MAX_BYTES || JSON.stringify(event.tags).length > TAGS_MAX_CHARS) return null;
            return event;
          };
          const query: Record<string, unknown> = { kinds: [DEALER_KIND], authors, limit: PAGE_LIMIT };
          if (filter.d) query['#d'] = filter.d;
          if (until !== undefined) query.until = until;
          const result = await queryRelays([url], query, accept, timeoutMs);
          if (result.relaysCompleted === 0) {
            if (page === 0) answered = false;
            break;
          }
          if (frames === 0) break;
          let added = 0;
          for (const event of result.events) {
            const key = `${event.id}:${event.sig}`;
            if (seen.has(key)) continue;
            seen.add(key);
            events.push(event);
            added++;
          }
          until = added === 0 ? oldest - 1 : oldest;
        }
      }
      return { events, answered };
    }),
  );
  return {
    events: perRelay.flatMap((r) => r.events),
    relaysAsked: relays.length,
    relaysAnswered: perRelay.filter((r) => r.answered).length,
  };
}

/* ── what one read decides ────────────────────────────────────────────────── */

/** A dealer as it is listed: the public facts of its own signed profile. */
export interface ListedDealer {
  host: string;
  slug: string;
  name: string;
  website: string;
  roles: DealerRole[];
  /** The keys its site lists for its slug — held so the next read can ask its versions and judge it without a site answer. */
  admins: string[];
  eventId: string;
  /** Who signed the newest profile (one of `admins`). */
  pubkey: string;
  /** When its profile was signed (the event's created_at, unix seconds). */
  signedAt: number;
  contentVersion: string;
}

/** A dealer the last good read listed, handed back in — what BEF read from its mirror table. */
export type HeldDealer = Pick<ListedDealer, 'host' | 'slug' | 'pubkey' | 'admins'>;

export interface DealerLine {
  dealer: string;
  reason: string;
}

export type DealerRead =
  | {
      /** A real answer: `listed` is every dealer listed now — an empty list included. */
      read: true;
      listed: ListedDealer[];
      /** Held dealers this read took off, and why. */
      removed: DealerLine[];
      /** Profiles seen that are not listed, and why. */
      notListed: DealerLine[];
      relays: { asked: number; answered: number };
    }
  | {
      /** No read: nothing was decided. The held dealers stand, except `removed`. */
      read: false;
      skipped: string;
      reason: string;
      /** Held dealers none of whose admins is a reliable person in the stored KIND 38888 any more — they go now. */
      removed: DealerLine[];
    };

export interface DealerReaderDeps {
  fetchEvents?: DealerEventSource;
  fetchWellKnown?: (host: string) => Promise<WellKnownAnswer>;
  /** Milliseconds; injectable so the tests can move the clock. */
  now?: () => number;
}

interface Shaped {
  event: NostrEvent;
  profile: DealerProfile;
  host: string | null;
}

const newerThan = (a: { id: string; created_at: number }, b: { id: string; created_at: number }) =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Read every dealer once — bef-explorer refreshDealers, without the database.
 * `params` is the verified stored KIND 38888 (null when there is none), `held`
 * the dealers the last good read listed. Never throws for a relay or a site.
 */
export async function readDealers(
  params: Verified38888 | null,
  heldDealers: HeldDealer[],
  deps: DealerReaderDeps = {},
): Promise<DealerRead> {
  const nowMs = deps.now?.() ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const keyOf = (host: string, slug: string) => `${host}/${slug}`;
  const held = new Map<string, HeldDealer>();
  for (const row of heldDealers) held.set(keyOf(row.host, row.slug), row);

  const removed: DealerLine[] = [];
  const notListed: DealerLine[] = [];
  const listed: ListedDealer[] = [];
  const relaysSeen = { asked: 0, answered: 0 };
  const done = (): DealerRead => {
    // One line per dealer, and not a flood.
    const once = new Map(notListed.map((n) => [n.dealer, n]));
    return {
      read: true,
      listed: listed.sort(
        (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.host.localeCompare(b.host) || a.slug.localeCompare(b.slug),
      ),
      removed,
      notListed: [...once.values()].slice(0, MAX_REPORTED),
      relays: relaysSeen,
    };
  };
  // A run that could read nothing is no read: it decides nothing, and what the
  // last read listed stays — except that the stored KIND 38888 is a signed
  // answer of its own: a dealer none of whose admins is reliable in it any
  // more goes now.
  const reliable = new Set(params ? [...params.reliable].filter((hex) => HEX64.test(hex)) : []);
  const noRead = (skipped: string, reason: string): DealerRead => {
    const gone: DealerLine[] = [];
    for (const row of held.values()) {
      if (params && !row.admins.some((a) => reliable.has(a))) {
        gone.push({ dealer: keyOf(row.host, row.slug), reason: 'none of the admins its site listed is a reliable person in KIND 38888 any more' });
      }
    }
    return { read: false, skipped, reason, removed: gone };
  };

  // Without system parameters there is no relay list and no reliable list.
  if (!params) return noRead('no KIND 38888 is stored yet', 'no system parameters (KIND 38888) stored');
  const relays = params.relays;

  // A signed KIND 38888 that names no reliable person is an answer: nobody can
  // be listed.
  if (reliable.size === 0) {
    for (const row of held.values()) removed.push({ dealer: keyOf(row.host, row.slug), reason: 'KIND 38888 names no reliable person' });
    return done();
  }

  const source = deps.fetchEvents ?? ((r: string[], f: DealerFilter) => fetchDealerEvents(r, f));
  const ask = async (filter: DealerFilter): Promise<DealerEventsAnswer> => {
    try {
      return await source(relays, filter);
    } catch {
      return { events: [], relaysAsked: relays.length, relaysAnswered: 0 }; // read as silence
    }
  };

  // The shape of every event (cheap), exact repeats dropped. A forgery that
  // reuses a real event's id is a different object and blocks nothing.
  const shaped: Shaped[] = [];
  const seen = new Set<string>();
  const take = (events: NostrEvent[]) => {
    for (const raw of events) {
      const event = bareEvent(raw);
      if (!event || event.kind !== DEALER_KIND) continue;
      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);
      if (event.created_at > nowSec + FUTURE_TOLERANCE_S) continue;
      const shape = checkDealerShape(event);
      if (!shape.ok) continue;
      shaped.push({ event, profile: shape.profile, host: websiteHost(shape.profile.website) });
    }
  };
  const verified = new Map<NostrEvent, boolean>();
  const isVerified = (event: NostrEvent) => {
    let ok = verified.get(event);
    if (ok === undefined) {
      ok = verifyBareEvent(event);
      verified.set(event, ok);
    }
    return ok;
  };

  // a. The profiles the reliable people signed themselves.
  const first = await ask({ authors: [...reliable] });
  relaysSeen.asked = first.relaysAsked;
  relaysSeen.answered = first.relaysAnswered;
  if (first.relaysAnswered === 0) return noRead('the relays did not answer', 'the relays did not answer');
  take(first.events);

  // Candidates: every dealer listed last time, and the (host, slug) each valid
  // profile a reliable person really signed names — no other can be listed.
  const candidates = new Map<string, { host: string; slug: string }>();
  for (const row of held.values()) candidates.set(keyOf(row.host, row.slug), { host: row.host, slug: row.slug });
  const newestFor = new Map<string, number>();
  for (const s of shaped) {
    if (!reliable.has(s.event.pubkey) || !isVerified(s.event)) continue;
    if (!s.host) {
      notListed.push({ dealer: `(no website)/${s.profile.d}`, reason: 'its profile names no https website on the default port, so no site can vouch for it' });
      continue;
    }
    candidates.set(keyOf(s.host, s.profile.d), { host: s.host, slug: s.profile.d });
    newestFor.set(s.host, Math.max(newestFor.get(s.host) ?? 0, s.event.created_at));
  }

  // b. Ask each host once: the hosts of the dealers listed last time first,
  //    then the newest profile a reliable person signed.
  const heldHosts = new Set([...held.values()].map((r) => r.host));
  const hosts = [...new Set([...candidates.values()].map((c) => c.host))].sort((a, b) => {
    const rank = (h: string) => (heldHosts.has(h) ? 0 : 1);
    return rank(a) - rank(b) || (newestFor.get(b) ?? 0) - (newestFor.get(a) ?? 0) || a.localeCompare(b);
  });
  const asked = hosts.slice(0, MAX_HOSTS_PER_RUN);
  const answers = new Map<string, WellKnownAnswer>();
  const fetchFile = deps.fetchWellKnown ?? ((host: string) => fetchWellKnown(host));
  await eachLimited(asked, HOST_CONCURRENCY, async (host) => {
    let reply: WellKnownAnswer;
    try {
      reply = await fetchFile(host);
    } catch (err) {
      reply = { answered: false, reason: String((err as Error)?.message || err).slice(0, 80) };
    }
    answers.set(host, reply);
  });

  // c. Every version of those dealers by the keys their sites list — only for
  //    a dealer that a reliable person its site lists could vouch for.
  const versionAuthors = new Set<string>();
  const versionSlugs = new Set<string>();
  for (const { host, slug } of candidates.values()) {
    const site = answers.get(host);
    if (!site?.answered) continue;
    const admins = adminsFor(site.read, slug);
    if (!admins.some((a) => reliable.has(a))) continue;
    for (const a of admins) versionAuthors.add(a);
    versionSlugs.add(slug);
  }
  if (versionAuthors.size > 0) {
    const second = await ask({ authors: [...versionAuthors], d: [...versionSlugs] });
    relaysSeen.answered = Math.min(relaysSeen.answered, second.relaysAnswered);
    if (second.relaysAnswered === 0) return noRead('the relays did not answer', 'the relays did not answer');
    take(second.events);
  }

  // d. Decide each one, anew.
  for (const { host, slug } of candidates.values()) {
    const dealer = keyOf(host, slug);
    const row = held.get(dealer) ?? null;
    const refuse = (reason: string) => {
      if (row) removed.push({ dealer, reason });
      else notListed.push({ dealer, reason });
    };

    // A site that cannot be read lists nothing this time.
    const site = answers.get(host);
    if (!site || !site.answered) {
      // (The cast stands in for the narrowing BEF's strict tsconfig does; this repo's server config has strictNullChecks off.)
      refuse(site ? `${host} did not answer: ${(site as Extract<WellKnownAnswer, { answered: false }>).reason}` : `${host} was not asked in this run (more than ${MAX_HOSTS_PER_RUN} sites)`);
      continue;
    }
    const admins = adminsFor(site.read, slug);
    if (admins.length === 0) {
      refuse(`${host} does not list "${slug}" in its dealer file`);
      continue;
    }
    // (Its versions were not asked for then: nobody it lists could vouch for it.)
    const reliableAdmins = admins.filter((a) => reliable.has(a));
    if (reliableAdmins.length === 0) {
      refuse(`none of the admins ${host} lists for "${slug}" is a reliable person in KIND 38888`);
      continue;
    }
    // Valid versions of a key the site lists, newest first, each checked.
    const versions = shaped
      .filter((s) => s.profile.d === slug && admins.includes(s.event.pubkey))
      .sort((a, b) => (newerThan(a.event, b.event) ? -1 : newerThan(b.event, a.event) ? 1 : 0))
      .filter((s) => isVerified(s.event));
    const winner = versions[0] ?? null;
    if (!winner) {
      refuse(
        row && !admins.includes(row.pubkey)
          ? `${host} no longer lists the key that signed its profile`
          : `no valid profile signed by a key ${host} lists for "${slug}" came back from the relays`,
      );
      continue;
    }
    if (winner.host !== host) {
      refuse(`its newest profile names another website (${winner.host ?? 'none'})`);
      continue;
    }
    if (!versions.some((s) => reliableAdmins.includes(s.event.pubkey) && s.host === host)) {
      refuse(
        `no reliable person ${host} lists for "${slug}" has signed a profile of it naming ${host} — a site can name anyone; only that person's own signature counts`,
      );
      continue;
    }
    const p = winner.profile;
    if (p.status === 'retired') {
      refuse('its own profile says it is retired');
      continue;
    }
    if (!p.roles) {
      refuse('its profile does not say whether it buys or sells LANA (content.version 1.0.0, no roles)');
      continue;
    }
    listed.push({
      host,
      slug,
      name: p.name,
      website: p.website,
      roles: [...p.roles],
      admins,
      eventId: winner.event.id,
      pubkey: winner.event.pubkey,
      signedAt: winner.event.created_at,
      contentVersion: p.version,
    });
  }
  return done();
}
