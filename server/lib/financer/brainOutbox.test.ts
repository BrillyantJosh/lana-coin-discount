// @vitest-environment node
/**
 * THE BRAIN GETS ITS CALLS, OR A PERSON HEARS ABOUT IT.
 *
 * fiat-received and lana-sent used to be one fetch each, forgotten on failure.
 * A lost fiat-received left a purchase unauthorised for good. These tests pin
 * the outbox that replaced them: the exact body, byte for byte; a non-empty
 * list of transaction refs, always (the brain reads anything else as "every
 * DirectPaid purchase"); retries with backoff; a fiat-received kept alive until
 * every purchase it names has legs here and every pending one is authorised —
 * hourly after 7 days, never given up while the brain takes it; one row per
 * decision; after 7 days without a 2xx a loud stop instead of silence; and a
 * repeat confirmation as the way back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createMandateTestDb } from '../roundMandateTestKit';
import {
  enqueue, runOutbox, outboxHealth, backoffMs, sqlTime, GAVE_UP, stillWaiting, queueFiatReceived,
  fiatReceivedToRearm, rearmCallback,
  OUTBOX_AUTH_RECHECK_MS, OUTBOX_GIVE_UP_MS, OUTBOX_LONG_WAIT_RECHECK_MS,
} from './brainOutbox';

let db: Database.Database;
const T0 = Date.parse('2026-10-08T12:00:00Z');
let clock = T0;
const now = () => clock;
const MIN = 60_000;

interface Call { url: string; body: string; key: string | null }
let calls: Call[];
let answer: (call: Call) => Promise<Response> | Response;
const fakeFetch = (async (url: any, init: any) => {
  const call = { url: String(url), body: String(init.body), key: (init.headers as any)['x-callback-key'] ?? null };
  calls.push(call);
  return answer(call);
}) as typeof fetch;
const ok = () => new Response('{"ok":true}', { status: 200 });

const run = (over: Partial<Parameters<typeof runOutbox>[1]> = {}) =>
  runOutbox(db, { fetch: fakeFetch, now, callbackUrl: 'http://brain.test/', callbackKey: 'cb-key', ...over });
const row = (key: string) => db.prepare('SELECT * FROM brain_callback_outbox WHERE dedupe_key = ?').get(key) as any;
const leg = (id: string, ref: string, o: { status?: string; auth?: 0 | 1 } = {}) =>
  db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized)
              VALUES (?, ?, 'investor_lana', 'L', 'h', 1, 1, 'EUR', 1, ?, ?)`).run(id, ref, o.status ?? 'pending', o.auth ?? 0);

const LANA_SENT = { transaction_refs: ['T1', 'T2'], tx_hash: 'ab'.repeat(32), order_ids: ['o1', 'o2', 'o3'] };

beforeEach(() => {
  db = createMandateTestDb();
  clock = T0;
  calls = [];
  answer = ok;
});

describe('enqueue', () => {
  it('stores the exact body the old call sent, key order included, and posts it byte for byte', async () => {
    expect(enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock })).toBe(true);
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://brain.test/api/callbacks/lana-sent');
    expect(calls[0].key).toBe('cb-key');
    expect(calls[0].body).toBe('{"transaction_refs":["T1","T2"],"tx_hash":"' + 'ab'.repeat(32) + '","order_ids":["o1","o2","o3"]}');
  });

  it('one decision is one row: the same key twice adds nothing', () => {
    expect(enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] })).toBe(true);
    expect(enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1', 'T2'] })).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM brain_callback_outbox').get() as any).c).toBe(1);
  });

  it('refuses a body whose transaction_refs is not a non-empty array of strings — the brain would advance every DirectPaid purchase', () => {
    const bad: unknown[] = [undefined, null, 'T1', [], [''], ['T1', 7], {}];
    for (const refs of bad) {
      expect(() => enqueue(db, 'fiat-received', `k${String(refs)}`, { batch_ref: 'B1', transaction_refs: refs as any })).toThrow(/transaction_refs/);
      expect(() => enqueue(db, 'lana-sent', `l${String(refs)}`, { ...LANA_SENT, transaction_refs: refs as any })).toThrow(/transaction_refs/);
    }
    expect(() => enqueue(db, 'lana-sent', 'x', { ...LANA_SENT, order_ids: [] })).toThrow(/order_ids/);
    expect(() => enqueue(db, 'lana-sent', 'x', { ...LANA_SENT, tx_hash: 'nothex' })).toThrow(/tx_hash/);
    expect(() => enqueue(db, 'fiat-received', 'x', { batch_ref: '', transaction_refs: ['T1'] })).toThrow(/batch_ref/);
    expect((db.prepare('SELECT COUNT(*) c FROM brain_callback_outbox').get() as any).c).toBe(0);
  });
});

describe('runOutbox', () => {
  it('lana-sent: a 2xx is done, and is never posted again', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    expect(await run()).toMatchObject({ posted: 1, done: 1 });
    expect(row('lana-sent:x').done_at).toBe(sqlTime(clock));
    clock += 60 * MIN;
    await run();
    expect(calls).toHaveLength(1);
  });

  it('a refusal backs off 1, 2, 4 … 30 minutes and is not posted before its time', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    answer = () => new Response('no', { status: 503 });
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      await run();
      const r = row('lana-sent:x');
      expect(r.last_error).toBe('HTTP 503');
      const next = Date.parse(r.next_at.replace(' ', 'T') + 'Z');
      gaps.push((next - clock) / MIN);
      // Not before it is due …
      clock = next - 1000;
      const before = calls.length;
      await run();
      expect(calls.length).toBe(before);
      // … and posted again once it is.
      clock = next;
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect(backoffMs(1)).toBe(MIN);
    expect(backoffMs(40)).toBe(30 * MIN);
  });

  it('fiat-received: a 2xx is not enough — posted again every 5 minutes until every pending leg is authorised', async () => {
    leg('a', 'T1', { auth: 0 });
    leg('b', 'T1', { auth: 0 });
    leg('c', 'T2', { auth: 1 });
    leg('d', 'T2', { status: 'cancelled', auth: 0 }); // a cancelled leg never holds it open
    leg('e', 'T9', { auth: 0 });                      // not in this call
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1', 'T2'] }, { nowMs: clock });

    expect(await run()).toMatchObject({ posted: 1, waiting: 1, done: 0 });
    expect(row('fiat-received:B1').done_at).toBeNull();
    expect(row('fiat-received:B1').last_error).toMatch(/^WAITING_AUTH: 2 leg/);
    expect(row('fiat-received:B1').next_at).toBe(sqlTime(clock + OUTBOX_AUTH_RECHECK_MS));

    // The brain authorises one of the two; still waiting, still posted.
    clock += OUTBOX_AUTH_RECHECK_MS;
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE id = 'a'").run();
    expect(await run()).toMatchObject({ posted: 1, waiting: 1 });

    // Both authorised: the next post closes it.
    clock += OUTBOX_AUTH_RECHECK_MS;
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE id = 'b'").run();
    expect(await run()).toMatchObject({ posted: 1, done: 1 });
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.body === '{"batch_ref":"B1","transaction_refs":["T1","T2"]}')).toBe(true);
  });

  it('after 7 days without a 2xx it gives up loudly, and a given-up row is never posted again', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    answer = () => new Response('', { status: 500 });

    clock = T0 + OUTBOX_GIVE_UP_MS - MIN;
    await run();
    expect(row('lana-sent:x').last_error).toBe('HTTP 500');

    clock = T0 + OUTBOX_GIVE_UP_MS + 31 * MIN;
    const r = await run();
    expect(r.gaveUp).toBe(1);
    expect(row('lana-sent:x').last_error).toBe(GAVE_UP);
    expect(outboxHealth(db, clock)).toEqual({ open: 0, gaveUp: 1, gaveUpKeys: ['lana-sent:x'], waitingOver7d: 0, waitingOver7dKeys: [] });

    const before = calls.length;
    clock += 24 * 60 * MIN;
    await run();
    expect(calls.length).toBe(before);
  });

  // Review C6/C11/C19: the brain answers 200 {advanced:0} until EVERY fiat
  // order of the purchase is paid — the merchant's bank payout, in another
  // Direct.Fund batch, included. A financer who pays that 8 days after
  // confirming must still get the LANA approved; the old code gave up on day 7
  // and nothing ever posted the call again.
  it('a fiat-received the brain takes is never given up: after 7 days it is posted hourly, and counted for the admin', async () => {
    leg('a', 'T1', { auth: 0 });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: clock });
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    answer = c => (c.url.endsWith('lana-sent') ? new Response('', { status: 500 }) : ok());

    clock = T0 + OUTBOX_GIVE_UP_MS - MIN;
    await run();
    expect(row('fiat-received:B1').last_error).toMatch(/^WAITING_AUTH/);
    expect(row('fiat-received:B1').next_at).toBe(sqlTime(clock + OUTBOX_AUTH_RECHECK_MS));
    expect(outboxHealth(db, clock).waitingOver7d).toBe(0);

    clock = T0 + OUTBOX_GIVE_UP_MS + 31 * MIN;
    const r = await run();
    expect(r).toMatchObject({ gaveUp: 1, waiting: 1 }); // only the lana-sent the brain refused for 7 days
    expect(row('fiat-received:B1').last_error).toBe('WAITING_AUTH: 1 leg(s) not authorised yet');
    expect(row('fiat-received:B1').next_at).toBe(sqlTime(clock + OUTBOX_LONG_WAIT_RECHECK_MS));
    expect(row('lana-sent:x').last_error).toBe(GAVE_UP);
    expect(outboxHealth(db, clock)).toEqual({
      open: 1, gaveUp: 1, gaveUpKeys: ['lana-sent:x'], waitingOver7d: 1, waitingOver7dKeys: ['fiat-received:B1'],
    });

    // Not before the hour …
    clock += OUTBOX_LONG_WAIT_RECHECK_MS - MIN;
    let before = calls.length;
    await run();
    expect(calls.length).toBe(before);
    // … then again, and again, for as long as it takes.
    for (let h = 0; h < 3; h++) {
      clock += 2 * MIN + (h ? OUTBOX_LONG_WAIT_RECHECK_MS : 0);
      before = calls.length;
      await run();
      expect(calls.length).toBe(before + 1);
    }
    // Day 8: the merchant is paid, the brain approves — the next post closes it.
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE id = 'a'").run();
    clock += OUTBOX_LONG_WAIT_RECHECK_MS;
    expect(await run()).toMatchObject({ done: 1 });
    expect(outboxHealth(db, clock)).toMatchObject({ open: 0, waitingOver7d: 0 });
  });

  it('a brain outage late in a long wait does not end a row the brain was taking; 7 days with no 2xx does', async () => {
    leg('a', 'T1', { auth: 0 });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: clock });
    clock = T0 + 8 * 24 * 60 * MIN;
    await run(); // day 8: taken, still waiting
    expect(row('fiat-received:B1').last_error).toMatch(/^WAITING_AUTH/);

    answer = () => new Response('', { status: 502 }); // the brain restarts
    clock += OUTBOX_LONG_WAIT_RECHECK_MS;
    expect(await run()).toMatchObject({ failed: 1, gaveUp: 0 });
    expect(row('fiat-received:B1').last_error).toBe('HTTP 502');
    expect(outboxHealth(db, clock).waitingOver7d).toBe(1); // still shown as a long wait

    answer = ok;
    clock += 30 * MIN;
    expect(await run()).toMatchObject({ waiting: 1, gaveUp: 0 });

    // Then a week of nothing but errors since that last 2xx: a person has to look.
    const lastOk = clock;
    answer = () => new Response('', { status: 401 });
    for (clock += OUTBOX_LONG_WAIT_RECHECK_MS; clock < lastOk + OUTBOX_GIVE_UP_MS; clock += 30 * MIN) await run();
    expect(row('fiat-received:B1').last_error).toBe('HTTP 401');
    clock = lastOk + OUTBOX_GIVE_UP_MS + 30 * MIN;
    expect(await run()).toMatchObject({ gaveUp: 1 });
    expect(row('fiat-received:B1').last_error).toBe(GAVE_UP);
  });

  // Review C7: a purchase whose legs were all in doubt at the brain when it was
  // bought (LD answered 429, or was restarting) has no row here yet. Read as
  // finished, the call closed before that purchase was DirectPaid, and nothing
  // ever posted it again.
  it('a purchase of the batch with no leg here yet keeps the call open; one whose legs are all cancelled does not', async () => {
    leg('a', 'TA', { auth: 1 });
    leg('x', 'TX', { status: 'cancelled' });
    leg('y', 'TX', { status: 'failed' });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['TA', 'TB', 'TX'] }, { nowMs: clock });

    expect(await run()).toMatchObject({ posted: 1, waiting: 1, done: 0 });
    expect(row('fiat-received:B1').last_error).toBe('WAITING_AUTH: 1 purchase(s) with no leg here yet');

    // The brain's retry gets TB's legs accepted later; still unauthorised — still posted.
    leg('b1', 'TB', { auth: 0 });
    leg('b2', 'TB', { auth: 0 });
    clock += OUTBOX_AUTH_RECHECK_MS;
    expect(await run()).toMatchObject({ posted: 1, waiting: 1 });
    expect(row('fiat-received:B1').last_error).toBe('WAITING_AUTH: 2 leg(s) not authorised yet');

    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE transaction_ref = 'TB'").run();
    clock += OUTBOX_AUTH_RECHECK_MS;
    expect(await run()).toMatchObject({ posted: 1, done: 1 });
    expect(stillWaiting(db, ['TA', 'TB', 'TX'])).toEqual({ legs: 0, purchases: 0 });
  });

  it('a brain that does not answer stops the run: the rows behind it are not charged an attempt', async () => {
    for (const k of ['a', 'b', 'c']) enqueue(db, 'lana-sent', `lana-sent:${k}`, LANA_SENT, { nowMs: clock });
    answer = () => { throw new TypeError('fetch failed'); };
    const r = await run();
    expect(r).toMatchObject({ posted: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(row('lana-sent:a').attempts).toBe(1);
    expect(row('lana-sent:a').last_error).toMatch(/^NO_ANSWER/);
    expect(row('lana-sent:b').attempts).toBe(0);
    expect(row('lana-sent:c').attempts).toBe(0);
  });

  it('no callback URL: nothing is posted and nothing is charged', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    expect(await run({ callbackUrl: '' })).toMatchObject({ skipped: 'NO_URL', posted: 0 });
    expect(calls).toHaveLength(0);
    expect(row('lana-sent:x').attempts).toBe(0);
  });

  it('one run at a time: a second run while the first waits on the brain does nothing', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    let release!: () => void;
    answer = () => new Promise<Response>(r => { release = () => r(ok()); });
    const first = run();
    await new Promise(r => setTimeout(r, 10));
    expect(await run()).toMatchObject({ skipped: 'BUSY' });
    release();
    expect(await first).toMatchObject({ done: 1 });
    expect(calls).toHaveLength(1);
  });
});

// Review C6/C11: a repeat confirmation of a batch — the financer's on
// /financer, the treasury's "received" — is the way back for its
// fiat-received, so no recovery needs a hand edit of the production database.
describe('queueFiatReceived (a confirmation, and a repeat of it)', () => {
  const body = (key: string) => JSON.parse(row(key).body_json);

  it('the first confirmation queues the batch\'s call, exactly as enqueue did', () => {
    expect(queueFiatReceived(db, 'B1', ['T1', 'T2'], { nowMs: clock })).toEqual({ queued: true, rearmed: [], added: [] });
    expect(row('fiat-received:B1').body_json).toBe('{"batch_ref":"B1","transaction_refs":["T1","T2"]}');
  });

  it('a repeat brings back a row that GAVE UP while a purchase of it still waits for approval, with a fresh 7 days', async () => {
    leg('a', 'T1', { auth: 0 });
    queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock });
    answer = () => new Response('', { status: 401 }); // e.g. a wrong callback key for a week
    for (clock = T0; clock <= T0 + OUTBOX_GIVE_UP_MS + 30 * MIN; clock += 30 * MIN) await run();
    expect(row('fiat-received:B1').last_error).toBe(GAVE_UP);

    clock += 24 * 60 * MIN;
    expect(queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock })).toEqual({ queued: false, rearmed: ['fiat-received:B1'], added: [] });
    expect(row('fiat-received:B1')).toMatchObject({ done_at: null, last_error: null, next_at: sqlTime(clock), created_at: sqlTime(clock), accepted_at: null });

    answer = ok;
    expect(await run()).toMatchObject({ posted: 1, waiting: 1 });
    db.prepare("UPDATE brain_lana_orders SET brain_authorized = 1 WHERE id = 'a'").run();
    clock += OUTBOX_AUTH_RECHECK_MS;
    expect(await run()).toMatchObject({ done: 1 });
  });

  it('a repeat reopens a closed row only while something of it still waits; a live row and a finished one are left alone', async () => {
    leg('a', 'T1', { auth: 1 });
    queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock });
    await run();
    expect(row('fiat-received:B1').done_at).toBe(sqlTime(clock));

    // Finished: nothing for the brain to do, nothing reopened.
    clock += MIN;
    expect(queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock }).rearmed).toEqual([]);
    expect(row('fiat-received:B1').done_at).not.toBeNull();

    // A leg of it the brain has not approved shows up here after the call closed: a repeat reopens it.
    leg('late', 'T1', { auth: 0 });
    expect(queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock }).rearmed).toEqual(['fiat-received:B1']);
    expect(row('fiat-received:B1').done_at).toBeNull();

    // Alive (waiting, or retrying): untouched — its next post and its 7 days stand.
    await run();
    const alive = row('fiat-received:B1');
    expect(alive.last_error).toMatch(/^WAITING_AUTH/);
    clock += MIN;
    expect(queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock }).rearmed).toEqual([]);
    expect(row('fiat-received:B1')).toEqual(alive);
  });

  it('a purchase the batch\'s calls never named gets a row of its own; the stored ones are never rewritten', async () => {
    leg('a', 'T1', { auth: 1 });
    queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock });
    const first = row('fiat-received:B1');
    // Direct.Fund did not count T2 at the first confirmation (a stale order), and counts it now.
    expect(queueFiatReceived(db, 'B1', ['T1', 'T2'], { nowMs: clock })).toEqual({ queued: false, rearmed: [], added: ['T2'] });
    expect(row('fiat-received:B1')).toEqual(first);
    expect(body('fiat-received:B1:2')).toEqual({ batch_ref: 'B1', transaction_refs: ['T2'] });
    // Once named, never again.
    expect(queueFiatReceived(db, 'B1', ['T1', 'T2'], { nowMs: clock }).added).toEqual([]);
    expect(queueFiatReceived(db, 'B1', ['T2', 'T3'], { nowMs: clock }).added).toEqual(['T3']);
    expect(body('fiat-received:B1:3')).toEqual({ batch_ref: 'B1', transaction_refs: ['T3'] });
    // Another batch whose reference starts the same is another family of rows.
    expect(queueFiatReceived(db, 'B10', ['T9'], { nowMs: clock }).queued).toBe(true);
    expect(queueFiatReceived(db, 'B10', ['T9', 'T1'], { nowMs: clock }).added).toEqual(['T1']);
    expect(body('fiat-received:B10:2')).toEqual({ batch_ref: 'B10', transaction_refs: ['T1'] });
    expect((db.prepare('SELECT COUNT(*) c FROM brain_callback_outbox').get() as any).c).toBe(5);
    // ':' separates the follow-up rows, so it can never be part of a batch reference here.
    expect(() => queueFiatReceived(db, 'B1:2', ['T9'], { nowMs: clock })).toThrow(/batch/);

    await run();
    expect(calls.map(c => c.body)).toEqual([
      '{"batch_ref":"B1","transaction_refs":["T1"]}',
      '{"batch_ref":"B1","transaction_refs":["T2"]}',
      '{"batch_ref":"B1","transaction_refs":["T3"]}',
      '{"batch_ref":"B10","transaction_refs":["T9"]}',
      '{"batch_ref":"B10","transaction_refs":["T1"]}',
    ]);
  });
});

// Review N7/N9: what GET /api/financer/batches offers »Confirm again« for —
// exactly the rows a repeat confirmation would bring back, so the button never
// shows when pressing it would change nothing.
describe('fiatReceivedToRearm', () => {
  it('names the rows of the batch that stopped, or closed, while a purchase of them still waits — and no others', async () => {
    leg('a', 'T1', { auth: 0 });
    leg('b', 'T2', { auth: 1 });
    queueFiatReceived(db, 'B1', ['T1'], { nowMs: clock });
    queueFiatReceived(db, 'B1', ['T1', 'T2'], { nowMs: clock }); // fiat-received:B1:2 names T2
    queueFiatReceived(db, 'B10', ['T1'], { nowMs: clock });     // another batch, same prefix
    expect(fiatReceivedToRearm(db, 'B1')).toEqual([]); // all alive: they post by themselves

    db.prepare('UPDATE brain_callback_outbox SET last_error = ?').run(GAVE_UP);
    // B1:2 gave up too, but T2 is approved: nothing left for the brain there.
    expect(fiatReceivedToRearm(db, 'B1')).toEqual(['fiat-received:B1']);
    expect(fiatReceivedToRearm(db, 'B10')).toEqual(['fiat-received:B10']);
    expect(fiatReceivedToRearm(db, 'B9')).toEqual([]);
    expect(fiatReceivedToRearm(db, 'B1:2')).toEqual([]);

    // Closed while T1 still waits (a leg came after the call was done): offered too, as the repeat reopens it.
    db.prepare("UPDATE brain_callback_outbox SET last_error = NULL, done_at = '2026-10-08 12:00:00' WHERE dedupe_key = 'fiat-received:B1'").run();
    expect(fiatReceivedToRearm(db, 'B1')).toEqual(['fiat-received:B1']);
    expect(queueFiatReceived(db, 'B1', ['T1', 'T2'], { nowMs: clock }).rearmed).toEqual(['fiat-received:B1']);
    expect(fiatReceivedToRearm(db, 'B1')).toEqual([]);
  });
});

// Review N9: a GAVE_UP row on a financer's batch had no way back in the UI —
// the treasury's "received" is refused OWNER_CONFLICT there, and the financer's
// page offered nothing on a confirmed batch. The admin's »Re-send to brain«.
describe('rearmCallback (the admin\'s »Re-send to brain«)', () => {
  const giveUp = async (key: string) => {
    answer = () => new Response('', { status: 401 }); // e.g. a wrong callback key for a week
    for (; row(key).last_error !== GAVE_UP; clock += 30 * MIN) await run();
    answer = ok;
  };

  it('a row that GAVE UP is posted again from now on, with a fresh 7 days, and its body untouched', async () => {
    leg('a', 'T1', { auth: 0 });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: clock });
    await giveUp('fiat-received:B1');
    const before = row('fiat-received:B1');
    clock += 24 * 60 * MIN;

    expect(rearmCallback(db, 'fiat-received:B1', { nowMs: clock })).toEqual({ ok: true, dedupeKey: 'fiat-received:B1', kind: 'fiat-received', reopened: false, was: GAVE_UP });
    expect(row('fiat-received:B1')).toMatchObject({
      done_at: null, last_error: null, next_at: sqlTime(clock), created_at: sqlTime(clock), accepted_at: null,
      body_json: before.body_json, attempts: before.attempts,
    });
    expect(outboxHealth(db, clock)).toMatchObject({ gaveUp: 0, open: 1 });

    const posted = calls.length;
    expect(await run()).toMatchObject({ posted: 1, waiting: 1 });
    expect(calls.length).toBe(posted + 1);
    expect(calls.at(-1)!.body).toBe('{"batch_ref":"B1","transaction_refs":["T1"]}');
  });

  it('a lana-sent that GAVE UP comes back too; a delivered one has nothing to bring back (409)', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    await giveUp('lana-sent:x');
    expect(rearmCallback(db, 'lana-sent:x', { nowMs: clock })).toMatchObject({ ok: true, kind: 'lana-sent', reopened: false });
    expect(await run()).toMatchObject({ done: 1 });
    expect(rearmCallback(db, 'lana-sent:x', { nowMs: clock })).toMatchObject({ ok: false, status: 409, code: 'NOTHING_TO_REARM' });
    expect(row('lana-sent:x').done_at).toBe(sqlTime(clock));
  });

  it('a delivered fiat-received is reopened only while a purchase it names still waits for approval here', async () => {
    leg('a', 'T1', { auth: 1 });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: clock });
    await run();
    const done = row('fiat-received:B1');
    expect(done.done_at).not.toBeNull();
    expect(rearmCallback(db, 'fiat-received:B1', { nowMs: clock })).toMatchObject({ ok: false, status: 409, code: 'NOTHING_TO_REARM' });
    expect(row('fiat-received:B1')).toEqual(done);

    leg('late', 'T1', { auth: 0 });
    expect(rearmCallback(db, 'fiat-received:B1', { nowMs: clock })).toEqual({ ok: true, dedupeKey: 'fiat-received:B1', kind: 'fiat-received', reopened: true, was: null });
    expect(row('fiat-received:B1').done_at).toBeNull();
  });

  it('a row waiting for approval for over 7 days is brought back to the 5-minute cadence', async () => {
    leg('a', 'T1', { auth: 0 });
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1'] }, { nowMs: clock });
    clock = T0 + OUTBOX_GIVE_UP_MS + MIN;
    await run();
    expect(row('fiat-received:B1').next_at).toBe(sqlTime(clock + OUTBOX_LONG_WAIT_RECHECK_MS));
    expect(outboxHealth(db, clock).waitingOver7d).toBe(1);

    expect(rearmCallback(db, 'fiat-received:B1', { nowMs: clock })).toMatchObject({ ok: true, reopened: false, was: 'WAITING_AUTH: 1 leg(s) not authorised yet' });
    expect(outboxHealth(db, clock).waitingOver7d).toBe(0);
    await run();
    expect(row('fiat-received:B1').next_at).toBe(sqlTime(clock + OUTBOX_AUTH_RECHECK_MS));
  });

  it('an unknown key is 404 and changes nothing', () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    const before = row('lana-sent:x');
    expect(rearmCallback(db, 'lana-sent:y', { nowMs: clock })).toMatchObject({ ok: false, status: 404, code: 'UNKNOWN_CALLBACK' });
    expect(row('lana-sent:x')).toEqual(before);
  });

  it('a row brought back while its last failing post is on the wire is not given up on its old 7 days', async () => {
    enqueue(db, 'lana-sent', 'lana-sent:x', LANA_SENT, { nowMs: clock });
    answer = () => new Response('', { status: 401 });
    clock = T0 + OUTBOX_GIVE_UP_MS - MIN;
    await run();
    clock = T0 + OUTBOX_GIVE_UP_MS + 31 * MIN;
    // The post that would have given it up; the admin presses »Re-send to brain« before its answer comes.
    answer = () => {
      expect(rearmCallback(db, 'lana-sent:x', { nowMs: clock })).toMatchObject({ ok: true });
      return new Response('', { status: 401 });
    };
    expect(await run()).toMatchObject({ failed: 1, gaveUp: 0 });
    expect(row('lana-sent:x')).toMatchObject({ done_at: null, last_error: 'HTTP 401', created_at: sqlTime(clock) });
    expect(outboxHealth(db, clock).gaveUp).toBe(0);
  });
});
