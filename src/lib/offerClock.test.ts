/**
 * THE CLOCK TWO SCREENS NOW SHARE.
 *
 * `parseSqliteUtc`, `formatMoment` and `formatLeft` moved here out of
 * SubmitOffer.tsx unchanged, and `useCountdown` moved with one deliberate
 * change to how often it ticks. That hook feeds the `lapsed` flag which gates
 * the accept button on the page where a private key is typed, so its contract
 * is pinned here rather than trusted: a window that has closed reads as closed,
 * a window that has not does not, and a timestamp with no zone on it is read as
 * UTC — which is where SQLite writes it — and never as local time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseSqliteUtc, formatLeft, formatLeftToMinute, useCountdown } from './offerClock';

const sqliteUtc = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

afterEach(() => { vi.useRealTimers(); });

describe('reading what the database wrote', () => {
  it('takes a bare SQLite timestamp as UTC, not as this machine\'s local time', () => {
    expect(parseSqliteUtc('2026-09-17 21:40:00')!.toISOString()).toBe('2026-09-17T21:40:00.000Z');
  });

  it('leaves an explicit instant alone, and refuses nonsense', () => {
    expect(parseSqliteUtc('2026-09-17T21:40:00Z')!.toISOString()).toBe('2026-09-17T21:40:00.000Z');
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc('not a date')).toBeNull();
  });
});

describe('the same clock at eight days and at eight seconds', () => {
  it('reads as days and hours over a day', () => {
    expect(formatLeft(7 * 86400_000 + 4 * 3600_000)).toBe('7d 4h');
  });

  it('reads as hours and minutes over an hour', () => {
    expect(formatLeft(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
  });

  it('reads as minutes and seconds below that', () => {
    expect(formatLeft(4 * 60_000 + 31_000)).toBe('4:31');
  });

  it('floors rather than rounds up — it may under-state what is left, never over-state it', () => {
    expect(formatLeft(86400_000 - 1)).toBe('23h 59m');
    expect(formatLeft(-5000)).toBe('0:00');
  });
});

describe('the window this offer stands in', () => {
  it('says nothing at all when there is no deadline', () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current.msLeft).toBeNull();
    expect(result.current.expired).toBe(false);
  });

  it('a window still open is not lapsed', () => {
    const until = sqliteUtc(7 * 86400_000);
    const { result } = renderHook(() => useCountdown(until));
    expect(result.current.expired).toBe(false);
    expect(result.current.msLeft).toBeGreaterThan(0);
  });

  it('a window already closed is lapsed on the first render, before any tick', () => {
    const until = sqliteUtc(-60_000);
    const { result } = renderHook(() => useCountdown(until));
    expect(result.current.expired).toBe(true);
    expect(result.current.msLeft).toBeLessThan(0);
  });

  it('ticks every second while seconds are what is on screen', () => {
    vi.useFakeTimers();
    // The deadline is read ONCE, as it is on a real page: recomputing it per
    // render would move the finish line with the clock and hide any drift.
    const until = sqliteUtc(120_000);
    const { result } = renderHook(() => useCountdown(until));
    const before = result.current.msLeft!;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(before - result.current.msLeft!).toBeGreaterThanOrEqual(1000);
  });

  it('and lapses on its own once the window passes under someone reading it', () => {
    vi.useFakeTimers();
    const until = sqliteUtc(2000);
    const { result } = renderHook(() => useCountdown(until));
    expect(result.current.expired).toBe(false);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.expired).toBe(true);
  });

  it('clears its timer on unmount — a card removed from the page stops ticking', () => {
    vi.useFakeTimers();
    const until = sqliteUtc(120_000);
    const { result, unmount } = renderHook(() => useCountdown(until));
    act(() => { vi.advanceTimersByTime(1000); });
    const ticking = result.current.msLeft!;
    unmount();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.msLeft).toBe(ticking);
  });

  it('and stops scheduling once the window has closed, rather than counting into the past', () => {
    vi.useFakeTimers();
    const until = sqliteUtc(2000);
    const { result } = renderHook(() => useCountdown(until));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.expired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const settled = result.current.msLeft!;
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(result.current.msLeft).toBe(settled);
  });

  it('on a week-long window it does not re-render every second at a person', () => {
    // The displayed value changes once an hour up there. A number twitching on
    // an eight-day deadline is manufactured urgency, and this product does not
    // do that.
    vi.useFakeTimers();
    const until = sqliteUtc(7 * 86400_000);
    const { result } = renderHook(() => useCountdown(until));
    const first = result.current.msLeft!;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.msLeft).toBe(first);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.msLeft).toBeLessThan(first);
  });
});

/**
 * THE DASHBOARD IS NOT THE OFFER PAGE.
 *
 * /offer is where somebody is mid-transaction and the seconds are the thing.
 * /dashboard is where they land, and an automatic offer stands thirty minutes
 * — so mm:ss there is not the last moments of a window, it is the whole of it,
 * ticking at a person who came to read.
 */
describe('the same figure, read from a page you land on', () => {
  it('leaves the long shapes exactly as they are', () => {
    expect(formatLeftToMinute(7 * 86400_000 + 4 * 3600_000)).toBe('7d 4h');
    expect(formatLeftToMinute(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
  });

  it('reads in whole minutes where formatLeft would count seconds', () => {
    expect(formatLeft(28 * 60_000 + 59_000)).toBe('28:59');
    expect(formatLeftToMinute(28 * 60_000 + 59_000)).toBe('28m');
    expect(formatLeftToMinute(60_000)).toBe('1m');
  });

  it('but gives the seconds back for the final minute', () => {
    expect(formatLeftToMinute(45_000)).toBe('0:45');
    expect(formatLeftToMinute(0)).toBe('0:00');
  });
});
