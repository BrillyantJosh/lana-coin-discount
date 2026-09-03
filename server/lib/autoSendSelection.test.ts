// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { selectWholeGroups, groupByPurchase } from './autoSendSelection.js';

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
