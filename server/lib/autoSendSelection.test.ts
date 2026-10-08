// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { selectWholeGroups, groupByPurchase, readAutoSendWindow, heartbeatLegCounts } from './autoSendSelection.js';
import { createMandateTestDb } from './roundMandateTestKit.js';
import { migrateFinancerSchema, TREASURY_MIGRATION_SETTING_KEY } from '../db/financerSchema.js';

const leg = (ref: string, n: number, amt = 1) => ({ id: `${ref}-${n}`, transaction_ref: ref, lana_amount: amt });
const purchase = (ref: string, legs = 4) => Array.from({ length: legs }, (_, i) => leg(ref, i));
const refsOf = (sel: { groups: { transaction_ref: string | null }[][] }) => sel.groups.map(g => g[0].transaction_ref);

describe('selectWholeGroups', () => {
  it('never splits a purchase at the cap — the one that does not fit waits whole', () => {
    // 24 purchases × 4 legs = 96 rows fit; the 25th would need rows 97-100 → fits exactly;
    // the 26th would need 101-104 → must wait entirely.
    const rows = Array.from({ length: 26 }, (_, i) => purchase(`p${i}`)).flat();
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: false });
    expect(sel.orders).toHaveLength(100);
    expect(refsOf(sel)).toHaveLength(25);
    expect(sel.orders.some(o => o.transaction_ref === 'p25')).toBe(false);
  });

  it('the exact incident shape: 25 purchases of 4 legs plus 3 more rows → 100 rows, 25 whole purchases', () => {
    const rows = [...Array.from({ length: 25 }, (_, i) => purchase(`p${i}`)).flat(), ...purchase('p25', 3)];
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: false });
    expect(sel.orders).toHaveLength(100);
    expect(sel.orders.filter(o => o.transaction_ref === 'p25')).toHaveLength(0);
  });

  it('a purchase whose legs straddle the cap goes out whole in the NEXT run, not in halves', () => {
    // 99 single-leg purchases then one 4-leg purchase: rows 100-103.
    const rows = [...Array.from({ length: 99 }, (_, i) => purchase(`s${i}`, 1)).flat(), ...purchase('big4')];
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: false });
    expect(sel.orders).toHaveLength(99);
    expect(sel.orders.some(o => o.transaction_ref === 'big4')).toBe(false);
  });

  it('drops the last group of a truncated window, because it may be cut in the middle', () => {
    const rows = [...purchase('a'), ...purchase('b'), ...purchase('c', 2)]; // c looks complete but the window ended
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: true });
    expect(refsOf(sel)).toEqual(['a', 'b']);
    expect(sel.droppedTail).toBe('c');
  });

  it('holds back EVERY purchase touching the cut second, not only the last-started one', () => {
    // Two purchases created in the same second interleave (A1,B1,A2,B2); the
    // window ends after B2. Both may have more legs past the window.
    const at = (ref: string, n: number, ts: string) => ({ ...leg(ref, n), created_at: ts });
    const rows = [
      at('early', 0, '2026-09-01 10:00:00'), at('early', 1, '2026-09-01 10:00:00'),
      at('A', 0, '2026-09-01 10:00:05'), at('B', 0, '2026-09-01 10:00:05'),
      at('A', 1, '2026-09-01 10:00:05'), at('B', 1, '2026-09-01 10:00:05'),
    ];
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: true });
    expect(refsOf(sel)).toEqual(['early']);
    expect(sel.droppedTail).toBe('A,B');
  });

  it('a purchase that started in the cut second but whose first leg came earlier is still held', () => {
    const at = (ref: string, n: number, ts: string) => ({ ...leg(ref, n), created_at: ts });
    const rows = [at('X', 0, '2026-09-01 10:00:04'), at('X', 1, '2026-09-01 10:00:05'), at('Y', 0, '2026-09-01 10:00:05')];
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: true });
    expect(sel.orders).toEqual([]);
  });

  it('does not drop the last group when the window was not truncated', () => {
    const rows = [...purchase('a'), ...purchase('b', 2)];
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: false });
    expect(refsOf(sel)).toEqual(['a', 'b']);
    expect(sel.droppedTail).toBeNull();
  });

  it('keeps arrival order: a later small purchase does not jump ahead of one that did not fit', () => {
    const rows = [...purchase('a', 3), ...purchase('b', 3), ...purchase('c', 1)];
    const sel = selectWholeGroups(rows, { maxOutputs: 4, windowTruncated: false });
    expect(refsOf(sel)).toEqual(['a']);
  });

  it('a purchase bigger than the cap goes alone when first in line, and is deferred otherwise', () => {
    const huge = purchase('huge', 7);
    const first = selectWholeGroups([...huge, ...purchase('a', 2)], { maxOutputs: 5, windowTruncated: false });
    expect(refsOf(first)).toEqual(['huge']);
    expect(first.orders).toHaveLength(7);
    const later = selectWholeGroups([...purchase('a', 2), ...huge, ...purchase('b', 2)], { maxOutputs: 5, windowTruncated: false });
    expect(refsOf(later)).toEqual(['a', 'b']);
    expect(later.deferredOversized).toEqual(['huge']);
  });

  it('an order without a transaction_ref is its own group', () => {
    const rows = [{ id: 'lone', transaction_ref: null, lana_amount: 1 }, ...purchase('a', 2)];
    expect(groupByPurchase(rows).map(g => g.length)).toEqual([1, 2]);
    const sel = selectWholeGroups(rows, { maxOutputs: 100, windowTruncated: false });
    expect(sel.orders).toHaveLength(3);
  });

  it('empty input selects nothing and reports nothing dropped', () => {
    const sel = selectWholeGroups([], { maxOutputs: 100, windowTruncated: true });
    expect(sel.orders).toEqual([]);
    expect(sel.droppedTail).toBeNull();
  });
});

// ─── whose legs the treasury sends (8 Oct 2026) ────────────────────────────
//
// The auto-sender's SQL and the heartbeat badge's counts, run against the
// production DDL (roundMandateTestKit → db/financerSchema.ts). A financer pays
// the legs of the purchases they confirmed; a purchase nobody has confirmed is
// sent by nobody. Remove TREASURY_LEG_JOIN and the first two tests fail — the
// lana_bought branch included, which reaches a leg the brain never authorised.

describe('readAutoSendWindow / heartbeatLegCounts', () => {
  let db: Database.Database;
  let n = 0;
  const batch = (ref: string, status: string) =>
    db.prepare("INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, status) VALUES (?, 'f', 0, 'EUR', ?)").run(ref, status);
  const owner = (ref: string, settledBy: 'treasury' | 'financer') =>
    db.prepare("INSERT INTO purchase_settlement (transaction_ref, owner_hex, settled_by, confirmed_by) VALUES (?, 'f', ?, 'test')").run(ref, settledBy);
  const leg = (ref: string, o: { auth?: 0 | 1; batch?: string | null; status?: string; amount?: number; sendTxid?: string } = {}) => {
    const id = `L${++n}`;
    db.prepare(`INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate,
                status, brain_authorized, batch_ref, send_txid, created_at)
                VALUES (?, ?, 'investor_lana', 'L', 'h', ?, 1, 'EUR', 1, ?, ?, ?, ?, ?)`)
      .run(id, ref, o.amount ?? 100, o.status ?? 'pending', o.auth ?? 0, o.batch ?? null, o.sendTxid ?? null, `2026-10-08 10:00:${String(n).padStart(2, '0')}`);
    return id;
  };
  const window = () => readAutoSendWindow<any>(db, 1000).map(r => r.id);

  beforeEach(() => {
    db = createMandateTestDb();
    n = 0;
  });

  it("sends the treasury's authorised legs and never a financer's, authorised or bought", () => {
    owner('T-OURS', 'treasury');
    owner('T-THEIRS', 'financer');
    const ours = leg('T-OURS', { auth: 1 });
    leg('T-THEIRS', { auth: 1 });
    batch('B-THEIRS', 'lana_bought');
    leg('T-THEIRS', { batch: 'B-THEIRS' });
    expect(window()).toEqual([ours]);
  });

  it('a purchase nobody has confirmed is sent by nobody — on the lana_bought branch too', () => {
    batch('B1', 'lana_bought');
    leg('T-NOBODY', { auth: 1 });
    leg('T-NOBODY-2', { batch: 'B1' });
    expect(window()).toEqual([]);
    owner('T-NOBODY-2', 'treasury');
    expect(window()).toHaveLength(1);
  });

  it('the money gate still holds for the treasury: an unauthorised leg of an unbought batch waits', () => {
    batch('B1', 'received');
    owner('T1', 'treasury');
    leg('T1', { batch: 'B1' });
    expect(window()).toEqual([]);
  });

  it("never a leg that is 'sending', nor one still carrying a signed send", () => {
    owner('T1', 'treasury');
    leg('T1', { auth: 1, status: 'sending', sendTxid: 'aa'.repeat(32) });
    leg('T1', { auth: 1, sendTxid: 'bb'.repeat(32) });
    expect(window()).toEqual([]);
  });

  it('a late leg of a confirmed purchase is covered by the same owner row', () => {
    owner('T1', 'treasury');
    leg('T1', { auth: 1 });
    const late = leg('T1', { auth: 1 }); // a caretaker leg released later
    expect(window()).toContain(late);
  });

  // Review C5/C10, brain README 8(c): a purchase the treasury paid under the
  // old flow (its legs 'sent', its batch 'lana_sent', no owner row) gets a late
  // leg after the deploy — the brain releases a held caretaker leg, POSTs it
  // and authorises it again. The same owner must still pay it. Without the
  // migration's owner row it joins nothing, and nobody can ever send it.
  it('a late leg of a purchase the treasury sent before the deploy is still sent by the treasury', () => {
    // The database as it stood before the deploy: the one-off migration not yet run.
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(TREASURY_MIGRATION_SETTING_KEY);
    batch('B-OLD', 'lana_sent');
    leg('T-OLD', { auth: 1, status: 'sent', batch: 'B-OLD' });
    leg('T-OLD', { auth: 1, status: 'sent', batch: 'B-OLD' });
    leg('T-OLD-2', { auth: 1, status: 'sent' }); // sent before batches were linked
    migrateFinancerSchema(db); // the deploy's first boot

    const late = leg('T-OLD', { auth: 1, batch: 'B-OLD' });  // LD copies batch_ref from a sibling leg
    const late2 = leg('T-OLD-2', { auth: 1 });
    expect(window()).toEqual([late, late2]);
    expect(heartbeatLegCounts(db).sendable.orders).toBe(2);
    // A restart does not run the migration again — and does not need to.
    migrateFinancerSchema(db);
    expect(window()).toEqual([late, late2]);
  });

  it('the badge counts each kind apart, and they add up to the pending total', () => {
    batch('B1', 'lana_bought');
    owner('T-OURS', 'treasury');
    owner('T-STUCK', 'treasury');
    owner('T-THEIRS', 'financer');
    leg('T-OURS', { auth: 1, amount: 1 });
    leg('T-OURS', { batch: 'B1', amount: 2 });          // lana_bought branch
    leg('T-STUCK', { amount: 4 });                      // treasury's, never released
    leg('T-THEIRS', { auth: 1, amount: 8 });
    leg('T-NOBODY', { auth: 1, amount: 16 });
    leg('T-OURS', { status: 'sending', amount: 32 });
    leg('T-OURS', { status: 'sent', amount: 64 });
    const c = heartbeatLegCounts(db);
    expect(c.sendable).toEqual({ orders: 2, lanoshis: 3 });
    expect(c.stranded).toEqual({ orders: 1, lanoshis: 4 });
    expect(c.financer).toEqual({ orders: 1, lanoshis: 8 });
    expect(c.unowned).toEqual({ orders: 1, lanoshis: 16 });
    expect(c.sending).toEqual({ orders: 1, lanoshis: 32 });
    expect(c.pending).toEqual({ orders: 5, lanoshis: 31 });
  });
});
