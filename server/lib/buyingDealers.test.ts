// @vitest-environment node
/**
 * GET /api/buying-dealers: WHICH FIRMS, FROM WHERE, AND WHAT A SILENCE DOES.
 *
 *   the source   relays and reliable people come from the stored KIND 38888
 *                only when it is the system parameters event and its signature
 *                verifies — never from the `relays` column, never from a seed
 *                row or a forged one;
 *   the firms    BEF dealers whose own profile says "buys": a seller-only firm,
 *                a retired one and a stranger's are not named; each link is
 *                built on the verified host;
 *   the memory   a good read is kept ten minutes; an older one is answered at
 *                once while one read runs behind it; one older than twenty
 *                minutes waits for that read; a read that decides nothing
 *                keeps the last good list and says it is stale; with no good
 *                read ever, the answer is "unknown" with no firm; the shared
 *                reader reads by itself, without a visitor;
 *   a silence    a firm whose own site, or the relays, did not answer once is
 *                still named — for an hour at most — and a real refusal takes
 *                it off at once.
 *
 * Nothing here reaches a relay or a website.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { makeKey, signEvent, type TestKey } from './roundMandateTestKit';
import {
  BEF_DIRECTORY_URL, HOLD_UNCONFIRMED_MS, KEEP_FRESH_TICK_MS, MAX_ANSWER_AGE_MS, RETRY_AFTER_FAILURE_MS,
  buyersOf, createBuyingDealersReader, removedBySilence, type BuyingDealersAnswer, type BuyingDealersReaderDeps,
} from './buyingDealers';
import { parseVerified38888, verifiedKind38888 } from './befDealers/systemParams';
import {
  DEALER_REFRESH_INTERVAL_MS, MAX_HOSTS_PER_RUN, type DealerRead, type DealerFilter, type ListedDealer,
} from './befDealers/dealers';
import { SYSTEM_PARAMETERS_PUBKEY } from './publishedRoundTerms';
import {
  dealerContent, dealerEvent, fakeRelays, fakeSites, newIdentity, NOW_MS, NOW_S, type SiteReply,
} from './befDealers/dealerTestKit';
import type { NostrEvent } from './nostr';

/** Stands in for the Lana Core Authority: the reader is told to trust this key instead (opts.author). */
const authority: TestKey = makeKey();

function params38888(opts: { reliable?: string[]; relays?: string[]; content?: Record<string, unknown>; d?: string; kind?: number } = {}): NostrEvent {
  const tags: string[][] = [['d', opts.d ?? 'main']];
  for (const r of opts.relays ?? ['wss://relay.one.test', 'wss://relay.two.test']) tags.push(['relay', r]);
  for (const hex of opts.reliable ?? []) tags.push(['reliable_person', hex, 'Someone']);
  return signEvent(authority, { kind: opts.kind ?? 38888, created_at: NOW_S - 86_400, tags, content: JSON.stringify(opts.content ?? {}) });
}

function paramsDb(raw: string | null, relaysColumn = '["wss://relay.from-the-column.test"]'): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kind_38888 (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, relays TEXT NOT NULL, raw_event TEXT NOT NULL)');
  if (raw !== null) db.prepare('INSERT INTO kind_38888 (id, created_at, relays, raw_event) VALUES (?, ?, ?, ?)').run('main', NOW_S, relaysColumn, raw);
  return db;
}

/* ── the source ───────────────────────────────────────────────────────────── */

describe('the stored KIND 38888, verified', () => {
  it('relays and reliable people come from the signed event itself — wss only, each once, nothing added', () => {
    const reliable = 'A'.repeat(64);
    const event = params38888({
      reliable: [` ${reliable} `, reliable.toLowerCase(), 'not-a-key', 'b'.repeat(64)],
      relays: ['wss://relay.one.test/', 'wss://relay.one.test', 'ws://in-the-clear.test', 'wss://user:pw@relay.test', 'wss://relay.two.test'],
    });
    const v = parseVerified38888(JSON.stringify(event), authority.pub)!;
    expect(v.eventId).toBe(event.id);
    expect(v.relays).toEqual(['wss://relay.one.test', 'wss://relay.two.test']);
    expect([...v.reliable]).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('the content stands in only where the tags say nothing', () => {
    const event = signEvent(authority, {
      kind: 38888, created_at: NOW_S, tags: [['d', 'main']],
      content: JSON.stringify({ relays: ['wss://from-content.test', 42], reliable_people: [{ hex: 'C'.repeat(64) }, { hex: 'x' }] }),
    });
    const v = parseVerified38888(JSON.stringify(event), authority.pub)!;
    expect(v.relays).toEqual(['wss://from-content.test']);
    expect([...v.reliable]).toEqual(['c'.repeat(64)]);
  });

  it('a seed row, a forged or altered event, another author, another d or kind — all unknown', () => {
    const good = params38888({ reliable: ['a'.repeat(64)] });
    expect(parseVerified38888(JSON.stringify(good), authority.pub)).not.toBeNull();
    // The boot seed in db/index.ts.
    expect(parseVerified38888(JSON.stringify({ ...good, sig: 'local_seed' }), authority.pub)).toBeNull();
    // One reliable person more, written into a real event.
    const altered = { ...good, tags: [...good.tags, ['reliable_person', 'f'.repeat(64)]] };
    expect(parseVerified38888(JSON.stringify(altered), authority.pub)).toBeNull();
    // Correctly signed — by somebody else.
    expect(parseVerified38888(JSON.stringify(signEvent(makeKey(), { ...good, tags: good.tags })), authority.pub)).toBeNull();
    expect(parseVerified38888(JSON.stringify(good))).toBeNull(); // the real authority is not this test key
    expect(parseVerified38888(JSON.stringify(params38888({ d: 'other' })), authority.pub)).toBeNull();
    expect(parseVerified38888(JSON.stringify(params38888({ kind: 30972 })), authority.pub)).toBeNull();
    expect(parseVerified38888('not json', authority.pub)).toBeNull();
  });

  it('pins the real authority by default', () => {
    expect(SYSTEM_PARAMETERS_PUBKEY).toBe('9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3');
  });

  it('never reads the relays column, and never throws on a table without the raw event', () => {
    const event = params38888({ reliable: ['a'.repeat(64)] });
    const v = verifiedKind38888(paramsDb(JSON.stringify(event)), { author: authority.pub })!;
    expect(v.relays).toEqual(['wss://relay.one.test', 'wss://relay.two.test']);
    expect(v.relays).not.toContain('wss://relay.from-the-column.test');
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE kind_38888 (id TEXT PRIMARY KEY, created_at INTEGER, relays TEXT)');
    expect(verifiedKind38888(bare, { author: authority.pub })).toBeNull();
    expect(verifiedKind38888(paramsDb(null), { author: authority.pub })).toBeNull();
  });
});

/* ── the firms ────────────────────────────────────────────────────────────── */

describe('the firms that buy LANA', () => {
  const krog = newIdentity();
  const ravena = newIdentity();
  const sellerOnly = newIdentity();
  const retired = newIdentity();
  const stranger = newIdentity();
  const reliable = [krog.hex, ravena.hex, sellerOnly.hex, retired.hex];

  const events = [
    dealerEvent(krog, 'krog-menjave', dealerContent({ host: 'krogmenjave.test', name: 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.' })),
    dealerEvent(ravena, 'ravena-plus', dealerContent({ host: 'ravenaplus.test', name: 'Ravena Plus d.o.o.' })),
    dealerEvent(sellerOnly, 'only-sells', dealerContent({ host: 'onlysells.test', name: 'Only Sells d.o.o.', roles: ['sells'] })),
    dealerEvent(retired, 'gone', dealerContent({ host: 'gone.test', name: 'Gone d.o.o.', status: 'retired' })),
    dealerEvent(stranger, 'stranger', dealerContent({ host: 'stranger.test', name: 'Stranger Buys d.o.o.', roles: ['buys'] })),
  ];
  const sites: Record<string, SiteReply> = {
    'krogmenjave.test': { dealers: { 'krog-menjave': { admins: [krog.hex] } } },
    'ravenaplus.test': { dealers: { 'ravena-plus': { admins: [ravena.hex] } } },
    'onlysells.test': { dealers: { 'only-sells': { admins: [sellerOnly.hex] } } },
    'gone.test': { dealers: { gone: { admins: [retired.hex] } } },
    'stranger.test': { dealers: { stranger: { admins: [stranger.hex] } } },
  };

  const readerOn = (db: Database.Database, asked: { relays: string[][]; filters: DealerFilter[] }) => {
    const relays = fakeRelays(events, 2, 2, true);
    const files = fakeSites(sites);
    return createBuyingDealersReader({
      db: () => db,
      author: authority.pub,
      now: () => NOW_MS,
      reader: {
        fetchEvents: async (r, f) => { asked.relays.push(r); asked.filters.push(f); return relays.source(r, f); },
        fetchWellKnown: files.lookup,
      },
    });
  };

  it('names Krog menjave and Ravena Plus — not a firm that only sells, a retired one, or a stranger', async () => {
    const asked = { relays: [] as string[][], filters: [] as DealerFilter[] };
    const reader = readerOn(paramsDb(JSON.stringify(params38888({ reliable }))), asked);
    const answer = await reader.get();
    expect(answer.status).toBe('read');
    expect(answer.readAt).toBe(new Date(NOW_MS).toISOString());
    expect(answer.directoryUrl).toBe(BEF_DIRECTORY_URL);
    expect(answer.buyers).toEqual([
      {
        slug: 'krog-menjave', name: 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.', host: 'krogmenjave.test',
        website: 'https://krogmenjave.test/', registerUrl: 'https://krogmenjave.test/prijava',
        sellUrl: 'https://krogmenjave.test/ko-kreacija/prodaj', eventId: events[0].id, signedAt: new Date((NOW_S - 3600) * 1000).toISOString(),
      },
      {
        slug: 'ravena-plus', name: 'Ravena Plus d.o.o.', host: 'ravenaplus.test',
        website: 'https://ravenaplus.test/', registerUrl: 'https://ravenaplus.test/prijava',
        sellUrl: 'https://ravenaplus.test/ko-kreacija/prodaj', eventId: events[1].id, signedAt: new Date((NOW_S - 3600) * 1000).toISOString(),
      },
    ]);
    // The relays asked are the event's, never the column's.
    expect(asked.relays.every(r => JSON.stringify(r) === JSON.stringify(['wss://relay.one.test', 'wss://relay.two.test']))).toBe(true);
    // No admin key, signer, bank account or owner goes out.
    const text = JSON.stringify(answer);
    for (const secret of [krog.hex, ravena.hex, 'e'.repeat(64), 'SI56191000000123438', 'npub']) expect(text).not.toContain(secret);
  });

  it('a seed row asks no relay and names no firm', async () => {
    const asked = { relays: [] as string[][], filters: [] as DealerFilter[] };
    const seed = { ...params38888({ reliable }), sig: 'local_seed' };
    const answer = await readerOn(paramsDb(JSON.stringify(seed)), asked).get();
    expect(answer).toMatchObject({ status: 'unknown', readAt: null, buyers: [] });
    expect(asked.relays).toEqual([]);
  });

  it('buyersOf keeps only "buys", in name order, links on the host', () => {
    const d = (name: string, host: string, roles: ('sells' | 'buys')[]): ListedDealer => ({
      host, slug: host.split('.')[0], name, website: `https://${host}/o-nas`, roles, admins: [], eventId: 'x', pubkey: 'y', signedAt: NOW_S, contentVersion: '1.1.0',
    });
    const out = buyersOf([d('zeta', 'z.test', ['buys']), d('Alpha', 'a.test', ['sells', 'buys']), d('Beta', 'b.test', ['sells'])]);
    expect(out.map(b => b.name)).toEqual(['Alpha', 'zeta']);
    expect(out[0].website).toBe('https://a.test/');
  });
});

/* ── the memory ───────────────────────────────────────────────────────────── */

describe('what is kept, and for how long', () => {
  const listed = (name: string, host: string, admins = ['a'.repeat(64)]): ListedDealer => ({
    host, slug: host.split('.')[0], name, website: `https://${host}/`, roles: ['sells', 'buys'], admins, eventId: '1'.repeat(64), pubkey: admins[0], signedAt: NOW_S, contentVersion: '1.1.0',
  });
  const good = (...dealers: ListedDealer[]): DealerRead => ({ read: true, listed: dealers, removed: [], notListed: [], relays: { asked: 2, answered: 2 } });
  const silence = (removed: string[] = []): DealerRead => ({
    read: false, skipped: 'the relays did not answer', reason: 'the relays did not answer', removed: removed.map(dealer => ({ dealer, reason: 'gone' })),
  });

  let clock = NOW_MS;
  let reads = 0;
  let next: () => Promise<DealerRead>;
  const reader = (extra: Partial<BuyingDealersReaderDeps> = {}) => createBuyingDealersReader({
    db: () => paramsDb(null),
    now: () => clock,
    read: async () => { reads++; return next(); },
    ...extra,
  });
  beforeEach(() => { clock = NOW_MS; reads = 0; });

  it('a good read is answered as it is for ten minutes, with no second read', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    expect((await r.get()).buyers.map(b => b.name)).toEqual(['Krog']);
    clock += DEALER_REFRESH_INTERVAL_MS - 1;
    const again = await r.get();
    expect(again.status).toBe('read');
    expect(reads).toBe(1);
  });

  it('an older one is answered at once, stale, while exactly one read runs behind it', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    await r.get();
    let release!: () => void;
    next = () => new Promise<DealerRead>(resolve => { release = () => resolve(good(listed('Krog', 'krog.test'), listed('Ravena', 'ravena.test'))); });
    clock += DEALER_REFRESH_INTERVAL_MS;
    const [a, b] = await Promise.all([r.get(), r.get()]);
    expect([a.status, b.status]).toEqual(['stale', 'stale']);
    expect(a.buyers.map(x => x.name)).toEqual(['Krog']);
    expect(reads).toBe(2);
    release();
    await r.refresh();
    const after = await r.get();
    expect(after.status).toBe('read');
    expect(after.buyers.map(x => x.name)).toEqual(['Krog', 'Ravena']);
  });

  it('never read: waits at most maxWaitMs for the first read, then answers unknown with no firm', async () => {
    next = () => new Promise<DealerRead>(() => { /* a read that never ends */ });
    const r = reader();
    const started = Date.now();
    const answer = await r.get({ maxWaitMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer).toEqual<BuyingDealersAnswer>({ status: 'unknown', readAt: null, staleSince: null, directoryUrl: BEF_DIRECTORY_URL, buyers: [] });
    // A refusal never waits at all.
    expect(r.peek().status).toBe('unknown');
    expect(reads).toBe(1);
  });

  it('a read that decides nothing keeps the last good list, says since when — and drops only a dealer the KIND 38888 no longer backs', async () => {
    next = async () => good(listed('Krog', 'krog.test'), listed('Ravena', 'ravena.test'));
    const r = reader();
    await r.get();
    clock += DEALER_REFRESH_INTERVAL_MS;
    next = async () => silence(['ravena.test/ravena']);
    await r.refresh();
    const answer = r.peek();
    expect(answer.status).toBe('stale');
    expect(answer.staleSince).toBe(new Date(clock).toISOString());
    expect(answer.readAt).toBe(new Date(NOW_MS).toISOString());
    expect(answer.buyers.map(b => b.name)).toEqual(['Krog']);
    // …and does not try again for a minute.
    const before = reads;
    clock += RETRY_AFTER_FAILURE_MS - 1;
    r.peek();
    expect(reads).toBe(before);
    clock += 1;
    r.peek();
    expect(reads).toBe(before + 1);
  });

  it('a good read that lists nobody is an answer: no firm, status read', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    await r.get();
    clock += DEALER_REFRESH_INTERVAL_MS;
    next = async () => good();
    await r.refresh();
    expect(r.peek()).toMatchObject({ status: 'read', buyers: [] });
  });

  it('a read that throws is a silence, not a crash', async () => {
    next = async () => { throw new Error('boom'); };
    const r = reader();
    const answer = await r.get();
    expect(answer.status).toBe('unknown');
  });

  it('a read that throws before its first await does not block every read after it', async () => {
    // A settled promise left in `inFlight` made due() false for good: no read
    // ever again, and the answer frozen as it was.
    const r = reader({ read: () => { reads++; throw new Error('the database handle is closed'); } });
    expect((await r.get({ maxWaitMs: 50 })).status).toBe('unknown');
    expect(reads).toBe(1);
    clock += RETRY_AFTER_FAILURE_MS;
    await r.get({ maxWaitMs: 50 });
    expect(reads).toBe(2);
  });
});

/* ── how old an answer may be ─────────────────────────────────────────────── */

describe('an answer is never older than a read cycle or two', () => {
  const listed = (name: string, host: string): ListedDealer => ({
    host, slug: host.split('.')[0], name, website: `https://${host}/`, roles: ['sells', 'buys'], admins: ['a'.repeat(64)],
    eventId: '1'.repeat(64), pubkey: 'a'.repeat(64), signedAt: NOW_S, contentVersion: '1.1.0',
  });
  const good = (...dealers: ListedDealer[]): DealerRead => ({ read: true, listed: dealers, removed: [], notListed: [], relays: { asked: 2, answered: 2 } });
  const silence: DealerRead = { read: false, skipped: 'the relays did not answer', reason: 'the relays did not answer', removed: [] };
  const later = <T,>(value: T, ms = 20) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

  let clock = NOW_MS;
  let reads = 0;
  let next: () => Promise<DealerRead>;
  const reader = (extra: Partial<BuyingDealersReaderDeps> = {}) => createBuyingDealersReader({
    db: () => paramsDb(null),
    now: () => clock,
    read: async () => { reads++; return next(); },
    ...extra,
  });
  beforeEach(() => { clock = NOW_MS; reads = 0; });

  it('an answer more than twenty minutes old is not served as it is when a read can finish within the wait', async () => {
    expect(MAX_ANSWER_AGE_MS).toBe(2 * DEALER_REFRESH_INTERVAL_MS);
    next = async () => good(listed('Krog', 'krog.test'), listed('Ravena', 'ravena.test'));
    const r = reader();
    await r.get();
    // Three hours of nobody. Meanwhile Ravena has retired.
    clock += 3 * 60 * 60 * 1000;
    next = () => later(good(listed('Krog', 'krog.test')));
    const answer = await r.get({ maxWaitMs: 5_000 });
    expect(answer.status).toBe('read');
    expect(answer.readAt).toBe(new Date(clock).toISOString());
    expect(answer.buyers.map(b => b.name)).toEqual(['Krog']);
  });

  it('…and is still answered, stale, when that read does not finish within the wait', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    await r.get();
    clock += MAX_ANSWER_AGE_MS;
    next = () => new Promise<DealerRead>(() => { /* never */ });
    const started = Date.now();
    const answer = await r.get({ maxWaitMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer).toMatchObject({ status: 'stale', buyers: [{ name: 'Krog' }] });
  });

  it('after a failed read nobody waits for the next one: the stale answer comes at once', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    await r.get();
    clock += DEALER_REFRESH_INTERVAL_MS;
    next = async () => silence;
    await r.refresh();
    clock += MAX_ANSWER_AGE_MS;
    next = () => new Promise<DealerRead>(() => { /* the relays are still silent */ });
    const started = Date.now();
    const answer = await r.get({ maxWaitMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answer.status).toBe('stale');
    expect(reads).toBe(3);
  });

  it('a refusal never waits, however old the answer', async () => {
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader();
    await r.get();
    clock += 3 * 60 * 60 * 1000;
    next = () => new Promise<DealerRead>(() => { /* never */ });
    expect(r.peek().status).toBe('stale');
  });

  it('keepFresh reads by itself every ten minutes from first use — no visitor needed', async () => {
    const ticks: { ms: number; tick: () => void }[] = [];
    next = async () => good(listed('Krog', 'krog.test'), listed('Ravena', 'ravena.test'));
    const r = reader({ keepFresh: true, every: (ms, tick) => { ticks.push({ ms, tick }); } });
    // Nothing is scheduled by creating it — a test that imports a route starts no timer.
    expect(ticks).toHaveLength(0);
    await r.get();
    r.peek();
    expect(ticks.map(t => t.ms)).toEqual([KEEP_FRESH_TICK_MS]);
    // A tick before a read is due reads nothing.
    clock += DEALER_REFRESH_INTERVAL_MS - 1;
    ticks[0].tick();
    expect(reads).toBe(1);
    // Ravena retires; ten minutes on, the tick reads — nobody has asked.
    next = async () => good(listed('Krog', 'krog.test'));
    clock += 1;
    ticks[0].tick();
    expect(reads).toBe(2);
    await r.refresh();
    expect(r.peek()).toMatchObject({ status: 'read', buyers: [{ name: 'Krog' }] });
  });

  it('without keepFresh nothing is scheduled', async () => {
    const ticks: number[] = [];
    next = async () => good(listed('Krog', 'krog.test'));
    const r = reader({ every: (ms) => { ticks.push(ms); } });
    await r.get();
    r.peek();
    expect(ticks).toEqual([]);
  });
});

/* ── a silence ────────────────────────────────────────────────────────────── */

/**
 * Real reads (readDealers, BEF's rule, unchanged) against relays and sites in
 * memory: what a site that does not answer once, or a relay that misses a
 * profile, does to the firms named — and what a real refusal does.
 */
describe('a firm whose site or relays are silent once is still named', () => {
  const krog = newIdentity();
  const ravena = newIdentity();
  const KROG = 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.';
  const RAVENA = 'Ravena Plus d.o.o.';
  const krogEvent = dealerEvent(krog, 'krog-menjave', dealerContent({ host: 'krogmenjave.test', name: KROG }));
  const ravenaEvent = dealerEvent(ravena, 'ravena-plus', dealerContent({ host: 'ravenaplus.test', name: RAVENA }));
  const ravenaRetired = dealerEvent(ravena, 'ravena-plus', dealerContent({ host: 'ravenaplus.test', name: RAVENA, status: 'retired' }), { at: NOW_S - 60 });
  const ravenaSite: SiteReply = { dealers: { 'ravena-plus': { admins: [ravena.hex] } } };

  let clock = NOW_MS;
  let events: NostrEvent[];
  let sites: Record<string, SiteReply>;
  let db: Database.Database;
  const setReliable = (hexes: string[]) => {
    db.prepare('UPDATE kind_38888 SET raw_event = ? WHERE id = ?').run(JSON.stringify(params38888({ reliable: hexes })), 'main');
  };
  const make = () => createBuyingDealersReader({
    db: () => db,
    author: authority.pub,
    now: () => clock,
    reader: {
      fetchEvents: async (r, f) => fakeRelays(events, 2, 2).source(r, f),
      fetchWellKnown: async (host) => fakeSites(sites).lookup(host),
    },
  });
  const names = (a: BuyingDealersAnswer) => a.buyers.map(b => b.name);
  /** One read cycle later. */
  const cycle = async (r: ReturnType<typeof make>) => {
    clock += DEALER_REFRESH_INTERVAL_MS;
    await r.refresh();
    return r.peek();
  };

  beforeEach(() => {
    clock = NOW_MS;
    events = [krogEvent, ravenaEvent];
    sites = {
      'krogmenjave.test': { dealers: { 'krog-menjave': { admins: [krog.hex] } } },
      'ravenaplus.test': ravenaSite,
    };
    db = paramsDb(JSON.stringify(params38888({ reliable: [krog.hex, ravena.hex] })));
  });

  const bothNamed = async () => {
    const r = make();
    const first = await r.get();
    expect(first.status).toBe('read');
    expect(names(first)).toEqual([KROG, RAVENA]);
    return r;
  };

  it('a site timeout does not turn two firms into one — and the next good answer says "read" again', async () => {
    const r = await bothNamed();
    sites['ravenaplus.test'] = { down: 'timed out after 8000 ms' };
    const silent = await cycle(r);
    expect(names(silent)).toEqual([KROG, RAVENA]);
    expect(silent.status).toBe('stale');
    expect(silent.staleSince).toBe(new Date(clock).toISOString());
    expect(silent.readAt).toBe(new Date(clock).toISOString());
    // The link is the one the last good read built, on the verified host.
    expect(silent.buyers[1].registerUrl).toBe('https://ravenaplus.test/prijava');

    sites['ravenaplus.test'] = ravenaSite;
    const back = await cycle(r);
    expect(back).toMatchObject({ status: 'read', staleSince: null });
    expect(names(back)).toEqual([KROG, RAVENA]);
  });

  it('a relay that misses the profile once does not either', async () => {
    const r = await bothNamed();
    events = [krogEvent];
    const silent = await cycle(r);
    expect(names(silent)).toEqual([KROG, RAVENA]);
    expect(silent.status).toBe('stale');
  });

  it('kept for an hour at most: a site silent that long is taken off, as BEF Explorer does at once', async () => {
    const r = await bothNamed();
    sites['ravenaplus.test'] = { down: 'unreachable (ECONNREFUSED)' };
    const since = clock + DEALER_REFRESH_INTERVAL_MS;
    let answer = await cycle(r);
    while (clock + DEALER_REFRESH_INTERVAL_MS - since < HOLD_UNCONFIRMED_MS) {
      answer = await cycle(r);
      expect(names(answer)).toEqual([KROG, RAVENA]);
      expect(answer.staleSince).toBe(new Date(since).toISOString());
    }
    answer = await cycle(r);
    expect(clock - since).toBe(HOLD_UNCONFIRMED_MS);
    expect(names(answer)).toEqual([KROG]);
    expect(answer).toMatchObject({ status: 'read', staleSince: null });
    // And when the site answers again, the firm is back on the next read.
    sites['ravenaplus.test'] = ravenaSite;
    expect(names(await cycle(r))).toEqual([KROG, RAVENA]);
  });

  it('a real refusal takes it off at once: retired', async () => {
    const r = await bothNamed();
    events = [krogEvent, ravenaEvent, ravenaRetired];
    const answer = await cycle(r);
    expect(names(answer)).toEqual([KROG]);
    expect(answer.status).toBe('read');
  });

  it('a real refusal takes it off at once: its own site no longer lists it', async () => {
    const r = await bothNamed();
    sites['ravenaplus.test'] = { dealers: {} };
    expect(names(await cycle(r))).toEqual([KROG]);
  });

  it('a silent site is no shelter for a firm the KIND 38888 no longer backs', async () => {
    const r = await bothNamed();
    sites['ravenaplus.test'] = { down: 'timed out after 8000 ms' };
    setReliable([krog.hex]);
    expect(names(await cycle(r))).toEqual([KROG]);
  });

  it('removedBySilence knows exactly the three silences, for that dealer only', () => {
    const d = { host: 'ravenaplus.test', slug: 'ravena-plus' };
    const line = (reason: string, dealer = 'ravenaplus.test/ravena-plus') => ({ dealer, reason });
    expect(removedBySilence(line('ravenaplus.test did not answer: timed out after 8000 ms'), d)).toBe(true);
    expect(removedBySilence(line(`ravenaplus.test was not asked in this run (more than ${MAX_HOSTS_PER_RUN} sites)`), d)).toBe(true);
    expect(removedBySilence(line('no valid profile signed by a key ravenaplus.test lists for "ravena-plus" came back from the relays'), d)).toBe(true);
    for (const refusal of [
      'its own profile says it is retired',
      'ravenaplus.test does not list "ravena-plus" in its dealer file',
      'none of the admins ravenaplus.test lists for "ravena-plus" is a reliable person in KIND 38888',
      'ravenaplus.test no longer lists the key that signed its profile',
      'its newest profile names another website (elsewhere.test)',
      'its profile does not say whether it buys or sells LANA (content.version 1.0.0, no roles)',
      'KIND 38888 names no reliable person',
      'none of the admins its site listed is a reliable person in KIND 38888 any more',
    ]) expect(removedBySilence(line(refusal), d)).toBe(false);
    // Another dealer's silence, or another host's, is not this one's.
    expect(removedBySilence(line('ravenaplus.test did not answer: x', 'krogmenjave.test/krog-menjave'), d)).toBe(false);
    expect(removedBySilence(line('krogmenjave.test did not answer: x'), d)).toBe(false);
  });
});

/* ── the copies ───────────────────────────────────────────────────────────── */

/**
 * Three files are BEF Explorer's own, byte for byte (bef-explorer a7d3702), and
 * wellKnown.ts differs from its original in the user-agent line only. A change
 * to any of them is a change to the dealer rule: make it in bef-explorer first,
 * copy it here, and update the hash in the same commit.
 */
describe('the files copied from BEF Explorer', () => {
  const sha = (rel: string) => createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'befDealers', rel))).digest('hex');
  it('are the copies they claim to be', () => {
    expect(sha('bankSchemes.ts')).toBe('25f6993f075bf37be1b70fcffd0e95284aec6d8f8d8ee4a3e259659c95865488');
    expect(sha('lanaAddress.ts')).toBe('f709b6a06475413d4dfcaf4179328e3bf7726b410b40633504a9e26afeea9b02');
    expect(sha('dealerShape.ts')).toBe('dc2d861f28076f02d65b8f85cc427e616017bc1857ca4c4587c3bc6e825184f7');
    // bef-explorer's is c5669bb3…c229; the one line that differs names this site, not BEF Explorer, to the dealer's server.
    expect(sha('wellKnown.ts')).toBe('c6be9beccd395a84592562df5dd3538dfebaf4d96c637394be4994b480e87289');
    expect(fs.readFileSync(path.join(__dirname, 'befDealers', 'wellKnown.ts'), 'utf8')).toContain("'user-agent': 'lana.discount KIND 30972 reader'");
  });
});
