// @vitest-environment node
/**
 * WHAT A PERSON HAS TO LOOK AT REACHES /api/heartbeat-status.
 *
 * Review N8: a fiat-received the brain takes is never given up (C6/C7) — so one
 * that can never finish was posted hourly for good, and the counts that said
 * so (outboxHealth.waitingOver7d) never left the server. Review N5: a
 * financer's purchase whose investor leg the brain moved to another investor
 * is sent by nobody, and nothing said so. These pin the fields the admin page
 * reads (src/pages/AdminIncomingPayments.tsx), from the real outbox.
 *
 * Recheck of 9 Oct 2026 (M4): /api/heartbeat-status needs no login, so it
 * carries counts only; which calls and which purchases (batch and purchase
 * references) go to the signed GET /api/admin/brain-callbacks (financerAdminLists).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createMandateTestDb } from '../roundMandateTestKit';
import { enqueue, outboxHealth, runOutbox, GAVE_UP, OUTBOX_GIVE_UP_MS } from './brainOutbox';
import { financerHeartbeatFields, financerAdminLists } from './heartbeatStatus';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const SENDS = { inFlight: 2, stuck: 1, stuckTxids: ['ab'.repeat(32)] };

describe('financerHeartbeatFields', () => {
  it('carries the calls waiting for approval over 7 days, the given-up ones and the sends — as counts; their keys only on the admin list', async () => {
    const db = createMandateTestDb();
    db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate, status, brain_authorized)
                VALUES ('a', 'T1', 'caretaker_commission', 'L', 'h', 1, 1, 'EUR', 1, 'pending', 0)`).run();
    enqueue(db, 'fiat-received', 'fiat-received:B1', { batch_ref: 'B1', transaction_refs: ['T1', 'T-NO-LEG'] }, { nowMs: T0 });
    enqueue(db, 'lana-sent', 'lana-sent:x', { transaction_refs: ['T9'], tx_hash: 'cd'.repeat(32), order_ids: ['o9'] }, { nowMs: T0 });
    db.prepare("UPDATE brain_callback_outbox SET last_error = ? WHERE dedupe_key = 'lana-sent:x'").run(GAVE_UP);
    // 30 days of 2xx: the brain takes it, nothing of it is ever approved.
    const now = T0 + 30 * 24 * 60 * 60 * 1000;
    await runOutbox(db, { fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch, now: () => now, callbackUrl: 'http://brain.test', callbackKey: 'k' });

    const f = financerHeartbeatFields(outboxHealth(db, now), SENDS);
    expect(f).toEqual({
      brainCallbacksOpen: 1,
      brainCallbacksGaveUp: 1,
      brainCallbacksWaitingOver7d: 1,
      lanaSendsInFlight: 2,
      lanaSendsStuck: 1,
      lanaSendsStuckTxids: ['ab'.repeat(32)],
      ownerMismatchPurchases: 0,
    });
    expect(financerAdminLists(outboxHealth(db, now), SENDS)).toEqual({
      gaveUpKeys: ['lana-sent:x'],
      waitingOver7dKeys: ['fiat-received:B1'],
      ownerMismatchRefs: [],
    });
    // Not before 7 days.
    expect(financerHeartbeatFields(outboxHealth(db, T0 + OUTBOX_GIVE_UP_MS - 60_000), SENDS).brainCallbacksWaitingOver7d).toBe(0);
  });

  it("passes on the financer purchases that now name another investor — the count on the heartbeat, the references on the admin list — and reads them defensively", () => {
    const health = outboxHealth(createMandateTestDb(), T0);
    const both = { ...SENDS, ownerMismatchPurchases: 2, ownerMismatchRefs: ['TX-1', 'TX-2'] };
    expect(financerHeartbeatFields(health, both)).toMatchObject({ ownerMismatchPurchases: 2 });
    expect(financerAdminLists(health, both)).toMatchObject({ ownerMismatchRefs: ['TX-1', 'TX-2'] });
    // sendsHealth without them (yet), or with something else in their place: 0 and [], never a crash.
    expect(financerHeartbeatFields(health, SENDS)).toMatchObject({ ownerMismatchPurchases: 0 });
    expect(financerAdminLists(health, SENDS)).toMatchObject({ ownerMismatchRefs: [] });
    const odd = { ...SENDS, ownerMismatchPurchases: 'x', ownerMismatchRefs: [7, 'TX-3', null] };
    expect(financerHeartbeatFields(health, odd)).toMatchObject({ ownerMismatchPurchases: 0 });
    expect(financerAdminLists(health, odd)).toMatchObject({ ownerMismatchRefs: ['TX-3'] });
  });

  it('the public heartbeat names no brain call, no batch and no purchase — counts and on-chain txids only (M4)', async () => {
    const db = createMandateTestDb();
    enqueue(db, 'fiat-received', 'fiat-received:B-SECRET', { batch_ref: 'B-SECRET', transaction_refs: ['T-SECRET'] }, { nowMs: T0 });
    db.prepare("UPDATE brain_callback_outbox SET last_error = ? WHERE dedupe_key = 'fiat-received:B-SECRET'").run(GAVE_UP);
    const f = financerHeartbeatFields(outboxHealth(db, T0), { ...SENDS, ownerMismatchPurchases: 1, ownerMismatchRefs: ['T-MISMATCH'] });
    expect(f).toMatchObject({ brainCallbacksGaveUp: 1, ownerMismatchPurchases: 1 });
    const text = JSON.stringify(f);
    for (const secret of ['B-SECRET', 'T-SECRET', 'T-MISMATCH']) expect(text).not.toContain(secret);
    // Every list on it is a list of txids.
    for (const v of Object.values(f)) if (Array.isArray(v)) for (const x of v) expect(x).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is what server/index.ts answers on /api/heartbeat-status', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');
    const start = src.indexOf("app.get('/api/heartbeat-status'");
    expect(start).toBeGreaterThan(-1);
    const route = src.slice(start, src.indexOf('\n});', start));
    expect(route).toContain('const callbacks = outboxHealth(db);');
    expect(route).toContain('const sends = sendsHealth(db);');
    expect(route).toContain('...financerHeartbeatFields(callbacks, sends),');
  });
});
