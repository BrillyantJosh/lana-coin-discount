/**
 * The one clock every screen reads an offer's window on.
 *
 * These four helpers lived privately inside SubmitOffer.tsx, and
 * `parseSqliteUtc` was additionally duplicated character-for-character in
 * Dashboard.tsx. Two copies of a clock is how two screens end up disagreeing
 * about when the same offer lapses, so they live here once and both pages
 * import them. The formatters moved unchanged; `useCountdown`'s body was
 * rewritten from a fixed one-second setInterval to a self-rescheduling
 * setTimeout whose rate follows what is on screen, and that is the one
 * behaviour change in the move.
 *
 * There is deliberately no user-facing prose here. 'd', 'h' and 'm' are units,
 * not sentences — anything that reads as copy belongs in src/copy.ts, where the
 * vocabulary test can see it.
 */
import { useEffect, useState } from 'react';

/**
 * SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC. `new Date()` reads that shape as
 * LOCAL time, which would put a 30-minute countdown hours out for anyone east
 * or west of the server — so the zone is made explicit before parsing.
 */
export function parseSqliteUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The locale every date on this clock is written in.
 *
 * Pinned rather than the reader's own, which is a quirk — but it is the app's
 * existing quirk (RecentPayouts and PendingVerification pin the same one), and
 * the alternative was worse: `formatDate` was pinned and `formatMoment` was
 * not, so the first card to print both showed "Offer stands until Sep 17 05:24
 * PM" four lines above "We settle by 17. 09. 2026" — an American time beside a
 * Slovenian date on one card. One constant, so the two cannot drift apart
 * again, and one place to revisit when the app picks a single answer.
 */
const CLOCK_LOCALE = 'sl-SI';

/** A calendar day — the shape /dashboard has always printed settlement dates in. */
export const formatDate = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  return d ? d.toLocaleDateString(CLOCK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
};

/**
 * An offer the machine made stands 30 minutes; one a person decided stands 8
 * days. So the moment needs its date once it is not today — "expires at 14:20"
 * with no day is worse than useless on a week-long offer.
 */
export const formatMoment = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  if (!d) return '—';
  const time = d.toLocaleTimeString(CLOCK_LOCALE, { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  // Numeric, not `month: 'short'`. A pinned locale plus an abbreviated month
  // prints a Slovenian WORD inside English copy — "17. sep 21:40" — and the one
  // card built to be read at a glance should not be the place a reader meets a
  // language they did not choose. Digits belong to nobody.
  return sameDay ? time : `${d.toLocaleDateString(CLOCK_LOCALE, { day: '2-digit', month: '2-digit' })} ${time}`;
};

/**
 * The same clock has to read sensibly at eight days and at eight seconds. Minutes
 * and seconds alone would print "11520:00" for a week — a number nobody reads as
 * time — so the unit follows the size of what is left.
 *
 * Every branch floors, so the figure under-states what is left rather than
 * over-stating it.
 */
export const formatLeft = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 86400) {
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    return `${d}d ${h}h`;
  }
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * The same figure, never finer than a minute until the last minute.
 *
 * /offer is a page someone is mid-transaction on: they asked for a price
 * thirty seconds ago and the seconds are the thing. /dashboard is a page
 * someone LANDS on, and a number twitching at them there is pressure nobody
 * asked for — the more so because an automatic offer stands thirty minutes, so
 * mm:ss would be the permanent state of the common card rather than its last
 * moments. Above a minute this reads in minutes; inside the final minute the
 * seconds come back, because there they are genuinely the story.
 */
export const formatLeftToMinute = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  // Over an hour formatLeft already stops at the minute ("7d 4h", "3h 05m").
  if (total >= 3600 || total < 60) return formatLeft(ms);
  return `${Math.floor(total / 60)}m`;
};

/** Below this, `formatLeft` prints seconds and the tick has to keep up. */
const SECONDS_MATTER_BELOW_MS = 3_600_000;

/**
 * Ticks so an offer window is visibly running out.
 *
 * The rate follows the finest unit that can be on screen. Under an hour
 * `formatLeft` prints mm:ss, so it ticks every second, exactly as it always
 * did on the offer page. Above an hour the finest unit `formatLeft` prints is
 * the minute — "3h 05m" between an hour and a day, "7d 4h" above that — so a
 * minute is as often as the value can possibly change, and re-rendering every
 * second for it is both waste and a number twitching on a week-long window,
 * which is its own quiet form of pressure. Once the window has closed the
 * timer stops: `msLeft` stays negative and `expired` stays true, so nothing
 * downstream can un-lapse.
 *
 * The signature and the returned shape are the ones SubmitOffer's accept gate
 * has always read.
 */
export function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const target = parseSqliteUtc(until);
    if (!target) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const msLeft = target.getTime() - Date.now();
      if (msLeft <= 0) return;
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, msLeft > SECONDS_MATTER_BELOW_MS ? 60_000 : 1_000);
    };
    schedule();
    return () => { if (timer) clearTimeout(timer); };
  }, [until]);
  const target = parseSqliteUtc(until);
  if (!target) return { msLeft: null as number | null, expired: false };
  const msLeft = target.getTime() - now;
  return { msLeft, expired: msLeft <= 0 };
}
