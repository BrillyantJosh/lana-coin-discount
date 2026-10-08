/**
 * THE FIRMS THAT NOW BUY LANA — what GET /api/buying-dealers answers, and what
 * every closed sale route names in its refusal (./sellingClosed.ts).
 *
 * On 8 Oct 2026 Brilly closed selling LANA on lana.discount: "napiši da sta
 * odkup Lan prevzela firme Krog Menjave ali Ravena Plus (beri iz Relayjev in
 * naj se uporabniki pri enem od podjetji registrirajo)". The firms are not
 * typed in here. They are the BEF dealers whose own signed KIND 30972 profile
 * says they buy LANA (content.roles includes "buys"), admitted by exactly the
 * rule BEF Explorer lists its companies by (./befDealers/dealers.ts), read
 * from the relays the verified stored KIND 38888 publishes.
 *
 * MEMORY ONLY. No table, no write: one answer is kept in this process, the
 * last GOOD read.
 *
 *   fresh    a good read under DEALER_REFRESH_INTERVAL_MS old (10 minutes) is
 *            answered as it is;
 *   stale    an older one is answered at once, and one read starts behind it
 *            (never two at a time, and after a failed read not again for
 *            RETRY_AFTER_FAILURE_MS);
 *   too old  one older than MAX_ANSWER_AGE_MS (20 minutes) is not served as it
 *            is: GET /api/buying-dealers waits for the read behind it, at most
 *            `maxWaitMs`, exactly as on a cold start — unless the read before
 *            it failed, when waiting would only delay the same stale answer;
 *   cold     with no good read yet, a caller may wait for the read in flight
 *            up to `maxWaitMs`, and is otherwise answered "unknown" with no
 *            firm at all.
 *
 * Freshness does not wait for a visitor. BEF Explorer reads on its heartbeat;
 * here the process-wide reader (./buyingDealersShared.ts, `keepFresh`) checks
 * every KEEP_FRESH_TICK_MS from the first time it is asked, and reads when a
 * read is due — so a refusal on a closed sale route, which never waits, names
 * firms at most one read cycle old while the relays answer.
 *
 * A read that reached no relay, or found no verified KIND 38888, decides
 * nothing: the last good answer stays, marked stale since then — except a
 * dealer none of whose admins is a reliable person in the stored KIND 38888
 * any more, which goes (the BEF rule). A read that did answer replaces the
 * answer, an empty list included — with ONE difference from BEF Explorer's
 * directory. There a site that does not answer lists nothing that time; here
 * the number of firms picks the sentence ("register with this company"), so a
 * firm missing for one slow answer would be a false statement on every page
 * and in every refusal. A dealer the last good read listed, taken off ONLY
 * because its own site did not answer or no relay returned its profile, and
 * still backed by a reliable person in the KIND 38888, is kept from that read
 * — the answer marked stale since then — for at most HOLD_UNCONFIRMED_MS (an
 * hour). Every real refusal still takes it off at once: retired, not in its
 * site's file, no reliable admin, another website, no roles. The rule in
 * ./befDealers/dealers.ts is not touched; removedBySilence() reads its
 * sentences, and buyingDealers.test.ts fails if one of them changes.
 *
 * Closing sales does NOT depend on this. Every sale route refuses whatever it
 * answers; when it says "unknown" the page still says selling here is closed
 * and points at BEF Explorer's list of companies.
 */
import type Database from 'better-sqlite3';
import {
  DEALER_REFRESH_INTERVAL_MS, MAX_HOSTS_PER_RUN, readDealers,
  type DealerLine, type DealerRead, type DealerReaderDeps, type HeldDealer, type ListedDealer,
} from './befDealers/dealers.js';
import { verifiedKind38888, type Verified38888 } from './befDealers/systemParams.js';

/** Where the companies are listed when no firm can be named here. A real route of BEF Explorer (src/App.tsx `/companies`). */
export const BEF_DIRECTORY_URL = 'https://befexplorer.com/companies';
/**
 * The two pages a dealer's own site serves a seller. They are paths of the
 * dealer software both firms run (krog-menjave src/App.tsx: `/prijava`,
 * `/ko-kreacija/*`), not fields of KIND 30972 — the profile carries only the
 * website. Built on the verified host, always https; nothing from a profile's
 * text is put in a link.
 */
export const DEALER_SIGN_IN_PATH = '/prijava';
export const DEALER_SELL_PATH = '/ko-kreacija/prodaj';
/** After a read that decided nothing, the next one waits at least this long. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** How long GET /api/buying-dealers waits for a first read before answering "unknown". */
export const COLD_WAIT_MS = 12_000;
/** An answer older than this is not served as it is while a read that may replace it is running (two read cycles). */
export const MAX_ANSWER_AGE_MS = 2 * DEALER_REFRESH_INTERVAL_MS;
/** How long a listed dealer outlasts its own site's silence, or the relays', before it is taken off. */
export const HOLD_UNCONFIRMED_MS = 60 * 60 * 1000;
/** With `keepFresh`, how often the reader checks whether a read is due. */
export const KEEP_FRESH_TICK_MS = 60_000;

export interface BuyingDealer {
  slug: string;
  /** content.name of its newest valid profile, as the firm wrote it. */
  name: string;
  host: string;
  website: string;
  /** Registration and sign-in at the firm. */
  registerUrl: string;
  /** The firm's own page for selling LANA to it. */
  sellUrl: string;
  /** The KIND 30972 event the facts come from. */
  eventId: string;
  /** When that profile was signed (ISO). */
  signedAt: string;
}

export interface BuyingDealersAnswer {
  /** read: a good read under ten minutes old · stale: an older one, or one a later read could not confirm · unknown: no good read yet. */
  status: 'read' | 'stale' | 'unknown';
  /** When the answer was read (ISO), null while unknown. */
  readAt: string | null;
  /** Set while the latest read could not confirm the answer: since when (ISO). */
  staleSince: string | null;
  directoryUrl: string;
  buyers: BuyingDealer[];
}

interface Held {
  listed: ListedDealer[];
  readAt: number;
  staleSince: number | null;
  /** Dealers kept from an earlier read that the latest good read could not confirm: `host/slug` → since when (ms). */
  unconfirmed: Map<string, number>;
}

export interface BuyingDealersReaderDeps {
  db: () => Database.Database;
  /** Relays and dealer sites; the tests stand in for both. */
  reader?: DealerReaderDeps;
  /** Overridable only so a test can sign its own KIND 38888. */
  author?: string;
  /** Milliseconds. */
  now?: () => number;
  /** The read itself, replaceable whole by a test that only cares about the cache. */
  read?: (params: Verified38888 | null, held: HeldDealer[]) => Promise<DealerRead>;
  /**
   * Read when a read is due without waiting for a visitor: from the first
   * peek() or get(), every KEEP_FRESH_TICK_MS. Off unless asked for — the
   * process-wide reader asks; a test never starts a timer by importing a route.
   */
  keepFresh?: boolean;
  /** How the keep-fresh tick is scheduled (default: an unref'd setInterval); a test stands in for it. */
  every?: (ms: number, tick: () => void) => void;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const keyOf = (d: Pick<ListedDealer, 'host' | 'slug'>) => `${d.host}/${d.slug}`;

/**
 * Whether a read took a held dealer off only because something did not answer
 * — its own site, or the relays for its profile — rather than by a refusal.
 * Matched against the exact sentences ./befDealers/dealers.ts (step d) writes
 * for those three cases and no other; every other reason is a refusal.
 */
export function removedBySilence(line: DealerLine, dealer: Pick<ListedDealer, 'host' | 'slug'>): boolean {
  const { host, slug } = dealer;
  if (line.dealer !== keyOf(dealer)) return false;
  return line.reason.startsWith(`${host} did not answer: `) ||
    line.reason === `${host} was not asked in this run (more than ${MAX_HOSTS_PER_RUN} sites)` ||
    line.reason === `no valid profile signed by a key ${host} lists for "${slug}" came back from the relays`;
}

/** The firms in a list of listed dealers that buy LANA, as the page shows them. */
export function buyersOf(listed: ListedDealer[]): BuyingDealer[] {
  return listed
    .filter((d) => d.roles.includes('buys'))
    .sort(
      (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.host.localeCompare(b.host) || a.slug.localeCompare(b.slug),
    )
    .map((d) => ({
      slug: d.slug,
      name: d.name,
      host: d.host,
      website: `https://${d.host}/`,
      registerUrl: `https://${d.host}${DEALER_SIGN_IN_PATH}`,
      sellUrl: `https://${d.host}${DEALER_SELL_PATH}`,
      eventId: d.eventId,
      signedAt: new Date(d.signedAt * 1000).toISOString(),
    }));
}

export function createBuyingDealersReader(deps: BuyingDealersReaderDeps) {
  const now = deps.now ?? (() => Date.now());
  const read = deps.read ?? ((params: Verified38888 | null, held: HeldDealer[]) =>
    readDealers(params, held, { now, ...deps.reader }));

  let last: Held | null = null;
  let inFlight: Promise<void> | null = null;
  let lastAttemptAt = -Infinity;
  let lastAttemptFailed = false;

  const answer = (): BuyingDealersAnswer => {
    if (!last) return { status: 'unknown', readAt: null, staleSince: null, directoryUrl: BEF_DIRECTORY_URL, buyers: [] };
    const fresh = last.staleSince === null && now() - last.readAt < DEALER_REFRESH_INTERVAL_MS;
    return {
      status: fresh ? 'read' : 'stale',
      readAt: iso(last.readAt),
      staleSince: iso(last.staleSince),
      directoryUrl: BEF_DIRECTORY_URL,
      buyers: buyersOf(last.listed),
    };
  };

  const due = () => {
    if (inFlight) return false;
    if (lastAttemptFailed && now() - lastAttemptAt < RETRY_AFTER_FAILURE_MS) return false;
    if (!last) return true;
    return now() - last.readAt >= DEALER_REFRESH_INTERVAL_MS;
  };

  /**
   * After a good read: the dealers it listed, plus each held one it took off
   * only for a silence, still backed by a reliable person, and silent for
   * less than HOLD_UNCONFIRMED_MS.
   */
  const settle = (result: Extract<DealerRead, { read: true }>, params: Verified38888 | null, at: number): Held => {
    const listed = [...result.listed];
    const listedNow = new Set(listed.map(keyOf));
    const unconfirmed = new Map<string, number>();
    for (const r of result.removed) {
      const before = last?.listed.find((d) => keyOf(d) === r.dealer) ?? null;
      const since = last?.unconfirmed.get(r.dealer) ?? at;
      const backed = !!params && !!before && before.admins.some((a) => params.reliable.has(a));
      if (before && !listedNow.has(r.dealer) && backed && removedBySilence(r, before) && at - since < HOLD_UNCONFIRMED_MS) {
        listed.push(before);
        unconfirmed.set(r.dealer, since);
        console.warn(`[buying-dealers] ${r.dealer} kept from an earlier read, unconfirmed since ${iso(since)}: ${r.reason}`);
      } else {
        console.log(`[buying-dealers] ${r.dealer} no longer listed: ${r.reason}`);
      }
    }
    const staleSince = unconfirmed.size > 0 ? Math.min(...unconfirmed.values()) : null;
    return { listed, readAt: at, staleSince, unconfirmed };
  };

  const readOnce = async (): Promise<void> => {
    try {
      const params = verifiedKind38888(deps.db(), { author: deps.author });
      const held: HeldDealer[] = (last?.listed ?? []).map((d) => ({ host: d.host, slug: d.slug, pubkey: d.pubkey, admins: d.admins }));
      const result = await read(params, held);
      if (result.read) {
        last = settle(result, params, now());
        lastAttemptFailed = false;
      } else {
        lastAttemptFailed = true;
        if (last) {
          const gone = new Set(result.removed.map((r) => r.dealer));
          last = {
            listed: last.listed.filter((d) => !gone.has(keyOf(d))),
            readAt: last.readAt,
            staleSince: last.staleSince ?? now(),
            unconfirmed: new Map([...last.unconfirmed].filter(([dealer]) => !gone.has(dealer))),
          };
        }
        console.warn(`[buying-dealers] no read: ${(result as Extract<DealerRead, { read: false }>).skipped}`);
      }
    } catch (err) {
      lastAttemptFailed = true;
      if (last && last.staleSince === null) last = { ...last, staleSince: now() };
      console.warn('[buying-dealers] read failed:', (err as Error)?.message || err);
    }
  };

  /**
   * One read, never two at a time. Never rejects. `inFlight` is cleared in a
   * `.finally` that always runs after it is set — a read failing before its
   * first await must not leave a settled promise in it, which would block
   * every read after it.
   */
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    lastAttemptAt = now();
    const running: Promise<void> = readOnce().finally(() => {
      if (inFlight === running) inFlight = null;
    });
    inFlight = running;
    return running;
  };

  let ticking = false;
  const keepFresh = () => {
    if (!deps.keepFresh || ticking) return;
    ticking = true;
    const every = deps.every ?? ((ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      timer.unref?.();
    });
    every(KEEP_FRESH_TICK_MS, () => {
      if (due()) void refresh();
    });
  };

  return {
    /**
     * The answer now, without waiting. Starts a read behind it when one is
     * due — what a refusal on a closed sale route uses: it must never wait on
     * a relay.
     */
    peek(): BuyingDealersAnswer {
      keepFresh();
      if (due()) void refresh();
      return answer();
    },
    /**
     * The answer, waiting up to `maxWaitMs` for the read in flight when there
     * has never been a good one, or when the one held is older than
     * MAX_ANSWER_AGE_MS and the read before this one did not fail.
     */
    async get(opts: { maxWaitMs?: number } = {}): Promise<BuyingDealersAnswer> {
      const maxWaitMs = opts.maxWaitMs ?? COLD_WAIT_MS;
      keepFresh();
      const mustWait = !last || (now() - last.readAt >= MAX_ANSWER_AGE_MS && !lastAttemptFailed);
      if (due()) void refresh();
      if (mustWait && inFlight && maxWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      return answer();
    },
    /** Read now and wait for it (tests; never called on a request path). */
    refresh,
  };
}

export type BuyingDealersReader = ReturnType<typeof createBuyingDealersReader>;
