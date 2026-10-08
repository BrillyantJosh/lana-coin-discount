/**
 * THE TWO CALLS WE OWE THE BRAIN, KEPT UNTIL IT HAS THEM.
 *
 *   POST {BRAIN_CALLBACK_URL}/api/callbacks/fiat-received  {batch_ref, transaction_refs}
 *   POST {BRAIN_CALLBACK_URL}/api/callbacks/lana-sent      {transaction_refs, tx_hash, order_ids}
 *   header x-callback-key: BRAIN_CALLBACK_KEY
 *
 * Both used to be fire-and-forget: one fetch, a log line on failure, and
 * nothing else. A lost lana-sent cost little — the brain's heartbeat polls GET
 * /api/brain/lana-order/:id and fills the hash. A lost fiat-received cost the
 * purchase: the brain only authorises a purchase's LANA after it, so its legs
 * stayed unauthorised and nothing ever sent them.
 *
 * Now the call is a row, written in the same transaction as the decision it
 * reports, and the heartbeat (server/index.ts, every beat) posts what is due:
 *   - 2xx on lana-sent → done.
 *   - 2xx on fiat-received → done only once every purchase it names has a leg
 *     here and EVERY pending leg of them is brain_authorized. The brain
 *     advances only purchases that are already DirectPaid — which needs every
 *     fiat order of the purchase paid, the merchant's bank payout in another
 *     Direct.Fund batch included — and authorises on its 10th beat, so a 2xx
 *     that came too early changes nothing there; we post again every 5
 *     minutes, and after 7 days every hour, for as long as it takes. A row the
 *     brain accepts is never given up: its last chance would otherwise be the
 *     day the merchant's payout happened to be 8 days late (review C6).
 *   - anything else, a timeout, no connection → back off 1, 2, 4 … 30 minutes.
 *   - 7 days of that (counted from the brain's last 2xx, else from the queueing)
 *     and a row stops: last_error 'GAVE_UP', loud in the log and in
 *     /api/heartbeat-status. A person has to look.
 *   - a repeat confirmation of the batch (the financer's, or the treasury's
 *     "received") brings its fiat-received back while a purchase of it still
 *     waits for approval here (queueFiatReceived) — the way out of GAVE_UP
 *     that needs no hand edit of the database. The administrator's
 *     »Re-send to brain« (rearmCallback) does it for any one row, a financer's
 *     batch or a lana-sent included.
 *
 * transaction_refs is ALWAYS a non-empty array of strings: the brain reads a
 * missing or non-array list as "every DirectPaid purchase", so enqueue throws
 * rather than store one. The body is stored as the exact JSON posted, key order
 * included, and posted byte for byte on every attempt.
 */
import type Database from 'better-sqlite3';

export type OutboxKind = 'fiat-received' | 'lana-sent';

export interface FiatReceivedBody { batch_ref: string; transaction_refs: string[] }
export interface LanaSentBody { transaction_refs: string[]; tx_hash: string; order_ids: string[] }

export const GAVE_UP = 'GAVE_UP';
/** What last_error starts with while the brain takes a fiat-received whose purchases are not all approved yet. */
export const WAITING_AUTH = 'WAITING_AUTH';
/** How long a failing row is retried before it is handed to a person. */
export const OUTBOX_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a fiat-received the brain accepted is posted again until the legs are authorised. */
export const OUTBOX_AUTH_RECHECK_MS = 5 * 60 * 1000;
/** … and once it has waited 7 days: slower, never stopped. */
export const OUTBOX_LONG_WAIT_RECHECK_MS = 60 * 60 * 1000;
export const OUTBOX_MAX_BACKOFF_MS = 30 * 60 * 1000;
export const OUTBOX_TIMEOUT_MS = 15_000;
/** Rows posted per run; the rest wait for the next beat. */
export const OUTBOX_BATCH = 25;

/** SQLite's datetime('now') shape, so stored times compare as strings. */
export function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseSqlTime(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

/** 1, 2, 4, 8, 16, 30, 30 … minutes after the n-th failed attempt (n ≥ 1). */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(OUTBOX_MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(n - 1, 10));
}

function nonEmptyStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== '');
}

/** The purchases a stored fiat-received names (enqueue checked them). */
function refsOf(bodyJson: string): string[] {
  try {
    const refs = JSON.parse(bodyJson).transaction_refs;
    return nonEmptyStrings(refs) ? refs : [];
  } catch {
    return [];
  }
}

/** Throws when a body could advance the wrong purchases at the brain, or none. */
export function assertOutboxBody(kind: OutboxKind, body: unknown): void {
  const b = body as any;
  if (!b || typeof b !== 'object') throw new Error(`brain outbox: ${kind} body must be an object`);
  if (!nonEmptyStrings(b.transaction_refs)) throw new Error(`brain outbox: ${kind} transaction_refs must be a non-empty array of strings`);
  if (kind === 'fiat-received') {
    if (typeof b.batch_ref !== 'string' || !b.batch_ref.trim()) throw new Error('brain outbox: fiat-received needs a batch_ref');
  } else if (kind === 'lana-sent') {
    if (typeof b.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(b.tx_hash)) throw new Error('brain outbox: lana-sent needs a 64-hex tx_hash');
    if (!nonEmptyStrings(b.order_ids)) throw new Error('brain outbox: lana-sent order_ids must be a non-empty array of strings');
  } else {
    throw new Error(`brain outbox: unknown kind ${String(kind)}`);
  }
}

/**
 * Queue a callback. INSERT OR IGNORE on dedupe_key: the same decision reported
 * twice is one row. Returns true when a row was added. Safe inside the caller's
 * transaction — and meant to be called there, so the call exists exactly when
 * the decision it reports does.
 */
export function enqueue(db: Database.Database, kind: 'fiat-received', dedupeKey: string, body: FiatReceivedBody, opts?: { nowMs?: number }): boolean;
export function enqueue(db: Database.Database, kind: 'lana-sent', dedupeKey: string, body: LanaSentBody, opts?: { nowMs?: number }): boolean;
export function enqueue(db: Database.Database, kind: OutboxKind, dedupeKey: string, body: FiatReceivedBody | LanaSentBody, opts: { nowMs?: number } = {}): boolean {
  assertOutboxBody(kind, body);
  if (!dedupeKey || !dedupeKey.trim()) throw new Error('brain outbox: dedupe key required');
  const now = sqlTime(opts.nowMs ?? Date.now());
  return db.prepare(`
    INSERT OR IGNORE INTO brain_callback_outbox (kind, dedupe_key, body_json, next_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(kind, dedupeKey, JSON.stringify(body), now, now).changes === 1;
}

export interface FiatReceivedQueued {
  /** The batch's first fiat-received was queued now. */
  queued: boolean;
  /** Rows of this batch brought back from GAVE_UP or done (a purchase of theirs still waits for approval). */
  rearmed: string[];
  /** Purchases no fiat-received of this batch named yet, queued now in a row of their own. */
  added: string[];
}

/**
 * The fiat-received a confirmation of a batch owes the brain — the financer's
 * on /financer and the treasury's "received" alike. Call it inside the
 * confirmation's own transaction.
 *
 * The first confirmation queues 'fiat-received:<batch>'. A repeat one is how a
 * person brings the call back when it is not finished (review C6/C11): every
 * row of the batch that GAVE UP, or was closed while a purchase it names still
 * waits for approval here, is posted again from now on with a fresh 7 days.
 * A row still alive is left alone. And a purchase the earlier rows never named
 * (one Direct.Fund did not count at the first confirmation and counts now) gets
 * a row of its own, 'fiat-received:<batch>:<n>', naming only the new purchases
 * — a stored row is never rewritten, because the heartbeat may be posting it
 * at this very moment.
 */
export function queueFiatReceived(db: Database.Database, batchRef: string, refs: string[], opts: { nowMs?: number } = {}): FiatReceivedQueued {
  // ':' separates a batch's follow-up rows; a reference carrying one would read as another batch's.
  if (typeof batchRef !== 'string' || batchRef.includes(':')) throw new Error(`brain outbox: not a batch reference: ${String(batchRef)}`);
  const key = `fiat-received:${batchRef}`;
  const body: FiatReceivedBody = { batch_ref: batchRef, transaction_refs: refs };
  if (enqueue(db, 'fiat-received', key, body, opts)) return { queued: true, rearmed: [], added: [] };

  const now = sqlTime(opts.nowMs ?? Date.now());
  const rows = batchFiatRows(db, batchRef);

  const rearm = db.prepare(`
    UPDATE brain_callback_outbox SET done_at = NULL, last_error = NULL, next_at = ?, created_at = ?, accepted_at = NULL
    WHERE id = ? AND (done_at IS NOT NULL OR last_error = ?)
  `);
  const rearmed: string[] = [];
  const named = new Set<string>();
  for (const row of rows) {
    for (const r of refsOf(row.body_json)) named.add(r);
    if (!wantsRearm(db, row)) continue;
    if (rearm.run(now, now, row.id, GAVE_UP).changes === 1) rearmed.push(row.dedupe_key);
  }

  const added = [...new Set(refs)].filter(r => !named.has(r));
  if (added.length > 0) {
    const nextKey = `${key}:${rows.length + 1}`;
    if (!enqueue(db, 'fiat-received', nextKey, { batch_ref: batchRef, transaction_refs: added }, opts)) {
      throw new Error(`brain outbox: ${nextKey} already exists`); // rolls the confirmation back
    }
  }
  return { queued: false, rearmed, added };
}

interface FiatRow { id: number; dedupe_key: string; body_json: string; done_at: string | null; last_error: string | null }

/** Every fiat-received row of a batch: 'fiat-received:<batch>' and its follow-ups 'fiat-received:<batch>:<n>'. */
function batchFiatRows(db: Database.Database, batchRef: string): FiatRow[] {
  const key = `fiat-received:${batchRef}`;
  return db.prepare(`
    SELECT id, dedupe_key, body_json, done_at, last_error FROM brain_callback_outbox
    WHERE kind = 'fiat-received' AND (dedupe_key = ? OR substr(dedupe_key, 1, ?) = ?)
    ORDER BY id
  `).all(key, key.length + 1, `${key}:`) as FiatRow[];
}

/**
 * Would a repeat confirmation bring this row back? Only one that GAVE UP, or
 * was closed, while a purchase it names still waits for approval here. A row
 * still alive keeps its own next post and its own 7 days; a finished one has
 * nothing left for the brain to do.
 */
function wantsRearm(db: Database.Database, row: FiatRow): boolean {
  if (row.done_at === null && row.last_error !== GAVE_UP) return false; // still alive
  const w = stillWaiting(db, refsOf(row.body_json));
  return w.legs + w.purchases > 0;
}

/**
 * The fiat-received rows of a batch a repeat confirmation would bring back
 * (queueFiatReceived) — what GET /api/financer/batches offers »Confirm again«
 * for (review N7/N9). The same rule as the repeat itself, so the button shows
 * only while pressing it changes something.
 */
export function fiatReceivedToRearm(db: Database.Database, batchRef: string): string[] {
  if (typeof batchRef !== 'string' || batchRef.includes(':')) return [];
  return batchFiatRows(db, batchRef).filter(row => wantsRearm(db, row)).map(row => row.dedupe_key);
}

export type RearmResult =
  | { ok: true; dedupeKey: string; kind: OutboxKind; reopened: boolean; was: string | null }
  | { ok: false; status: 404 | 409; code: 'UNKNOWN_CALLBACK' | 'NOTHING_TO_REARM'; error: string };

/**
 * An administrator brings one brain call back by hand (POST
 * /api/admin/brain-callbacks/rearm, review N9): a row that GAVE UP — after a
 * week of a wrong callback key, say — or one still waiting or retrying, is
 * posted again from now on with a fresh 7 days. A delivered row is reopened
 * only when it is a fiat-received and a purchase it names still waits for
 * approval here (stillWaiting); otherwise there is nothing to bring back (409).
 * The body is never touched, and nothing else is: no batch, no owner, no leg.
 * One immediate transaction, so a confirmation's re-arm and this one never
 * interleave.
 */
export function rearmCallback(db: Database.Database, dedupeKey: string, opts: { nowMs?: number } = {}): RearmResult {
  const now = sqlTime(opts.nowMs ?? Date.now());
  return db.transaction((): RearmResult => {
    const row = db.prepare('SELECT id, kind, dedupe_key, body_json, done_at, last_error FROM brain_callback_outbox WHERE dedupe_key = ?')
      .get(dedupeKey) as (FiatRow & { kind: OutboxKind }) | undefined;
    if (!row) return { ok: false, status: 404, code: 'UNKNOWN_CALLBACK', error: 'No brain call with this key.' };
    if (row.done_at !== null) {
      const w = row.kind === 'fiat-received' ? stillWaiting(db, refsOf(row.body_json)) : { legs: 0, purchases: 0 };
      if (w.legs + w.purchases === 0) {
        return { ok: false, status: 409, code: 'NOTHING_TO_REARM', error: 'The brain already has this call, and nothing of it waits for approval here.' };
      }
    }
    db.prepare(`
      UPDATE brain_callback_outbox SET done_at = NULL, last_error = NULL, next_at = ?, created_at = ?, accepted_at = NULL
      WHERE id = ?
    `).run(now, now, row.id);
    return { ok: true, dedupeKey: row.dedupe_key, kind: row.kind, reopened: row.done_at !== null, was: row.last_error };
  }).immediate();
}

export interface OutboxRunOptions {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
  callbackUrl: string | undefined;
  callbackKey: string | undefined;
  timeoutMs?: number;
  limit?: number;
}

export interface OutboxRunResult {
  posted: number;
  done: number;
  /** fiat-received the brain took, whose legs are not all authorised yet. */
  waiting: number;
  failed: number;
  gaveUp: number;
  /** Set when nothing was attempted. */
  skipped?: 'NO_URL' | 'BUSY';
}

/**
 * What still keeps a fiat-received open: pending legs of its purchases the
 * brain has not authorised yet, and purchases with no leg here at all. A
 * purchase whose legs are all still in doubt at the brain (LD answered 429, or
 * was restarting, when it was bought) has no row here yet; were it read as
 * finished, the call would be closed before that purchase was DirectPaid and
 * nothing would ever post it again (review C7). A purchase whose legs are all
 * cancelled or failed is finished.
 */
export function stillWaiting(db: Database.Database, refs: string[]): { legs: number; purchases: number } {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return { legs: 0, purchases: 0 };
  const ph = unique.map(() => '?').join(',');
  const legs = (db.prepare(`
    SELECT COUNT(*) AS c FROM brain_lana_orders
    WHERE transaction_ref IN (${ph}) AND status = 'pending' AND COALESCE(brain_authorized, 0) != 1
  `).get(...unique) as { c: number }).c;
  const known = (db.prepare(`
    SELECT COUNT(DISTINCT transaction_ref) AS c FROM brain_lana_orders WHERE transaction_ref IN (${ph})
  `).get(...unique) as { c: number }).c;
  return { legs, purchases: unique.length - known };
}

function waitingText(w: { legs: number; purchases: number }): string {
  const parts = [];
  if (w.legs > 0) parts.push(`${w.legs} leg(s) not authorised yet`);
  if (w.purchases > 0) parts.push(`${w.purchases} purchase(s) with no leg here yet`);
  return `${WAITING_AUTH}: ${parts.join(', ')}`;
}

let running = false;

/**
 * Post every due row once. One run at a time per process. When the brain
 * cannot be reached at all (timeout, refused connection) the run stops there:
 * the other rows are not charged an attempt for an outage that is not theirs.
 */
export async function runOutbox(db: Database.Database, opts: OutboxRunOptions): Promise<OutboxRunResult> {
  const result: OutboxRunResult = { posted: 0, done: 0, waiting: 0, failed: 0, gaveUp: 0 };
  const base = String(opts.callbackUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ...result, skipped: 'NO_URL' };
  if (running) return { ...result, skipped: 'BUSY' };
  running = true;
  try {
    const doFetch = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    const timeoutMs = opts.timeoutMs ?? OUTBOX_TIMEOUT_MS;
    const rows = db.prepare(`
      SELECT * FROM brain_callback_outbox
      WHERE done_at IS NULL AND COALESCE(last_error, '') != ?
        AND next_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(GAVE_UP, sqlTime(now()), opts.limit ?? OUTBOX_BATCH) as Array<{
      id: number; kind: OutboxKind; dedupe_key: string; body_json: string; attempts: number; created_at: string; accepted_at: string | null;
    }>;

    const markDone = db.prepare("UPDATE brain_callback_outbox SET attempts = attempts + 1, done_at = ?, last_error = NULL, accepted_at = ? WHERE id = ? AND done_at IS NULL");
    const markRetry = db.prepare('UPDATE brain_callback_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ? AND done_at IS NULL');
    const markWaiting = db.prepare('UPDATE brain_callback_outbox SET attempts = attempts + 1, next_at = ?, last_error = ?, accepted_at = ? WHERE id = ? AND done_at IS NULL');
    // Only the row as it was read: one re-armed while its post was on the wire
    // (a repeat confirmation, the admin's »Re-send to brain«) has a fresh 7 days
    // and must not be given up on the old ones.
    const markGaveUp = db.prepare('UPDATE brain_callback_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND done_at IS NULL AND created_at = ?');

    for (const row of rows) {
      const t = now();
      // Failures give up after 7 days without a 2xx; a row the brain took
      // counts from that answer, so a short outage late in a long wait for
      // approval does not end it.
      const tooOld = t - parseSqlTime(row.accepted_at || row.created_at) >= OUTBOX_GIVE_UP_MS;
      const retry = (delayMs: number, why: string) => {
        if (tooOld && markGaveUp.run(GAVE_UP, row.id, row.created_at).changes === 1) {
          result.gaveUp++;
          console.error(`[lana-discount] Brain callback ${row.kind} ${row.dedupe_key} GAVE UP after 7 days without a 2xx (last: ${why}) — needs a person`);
        } else {
          markRetry.run(sqlTime(t + delayMs), why.slice(0, 500), row.id);
        }
      };

      let res: Response;
      try {
        res = await doFetch(`${base}/api/callbacks/${row.kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-key': opts.callbackKey || '' },
          body: row.body_json,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err: any) {
        // No answer at all: the brain is down or unreachable, not this row's
        // fault. Charge this row, leave the others for the next beat.
        result.failed++;
        retry(backoffMs(row.attempts + 1), `NO_ANSWER: ${err?.name === 'TimeoutError' ? 'timeout' : (err?.message || String(err))}`);
        console.warn(`[lana-discount] Brain callback ${row.kind} ${row.dedupe_key}: no answer (${err?.message || err}) — stopping this run`);
        break;
      }
      result.posted++;

      if (!res.ok) {
        result.failed++;
        retry(backoffMs(row.attempts + 1), `HTTP ${res.status}`);
        console.warn(`[lana-discount] Brain callback ${row.kind} ${row.dedupe_key}: HTTP ${res.status}`);
        continue;
      }

      if (row.kind === 'fiat-received') {
        const waiting = stillWaiting(db, refsOf(row.body_json));
        if (waiting.legs + waiting.purchases > 0) {
          // The brain took it; the purchases are not all approved yet. Never
          // given up — only slowed down once it has waited 7 days. Posting
          // again is harmless: the brain moves only the named purchases that
          // are DirectPaid and not cancelled.
          result.waiting++;
          const longWait = t - parseSqlTime(row.created_at) >= OUTBOX_GIVE_UP_MS;
          const why = waitingText(waiting);
          markWaiting.run(sqlTime(t + (longWait ? OUTBOX_LONG_WAIT_RECHECK_MS : OUTBOX_AUTH_RECHECK_MS)), why.slice(0, 500), sqlTime(t), row.id);
          if (longWait) console.warn(`[lana-discount] Brain callback ${row.kind} ${row.dedupe_key}: taken, still not approved after 7 days (${why}) — posted again hourly`);
          continue;
        }
      }
      markDone.run(sqlTime(t), sqlTime(t), row.id);
      result.done++;
      console.log(`[lana-discount] Brain callback ${row.kind} ${row.dedupe_key}: delivered`);
    }
    return result;
  } finally {
    running = false;
  }
}

export interface OutboxHealth {
  /** Not delivered yet (still retrying). */
  open: number;
  /** Stopped after 7 days without a 2xx; a person has to look. */
  gaveUp: number;
  gaveUpKeys: string[];
  /**
   * fiat-received the brain took, queued more than 7 days ago, whose purchases
   * are still not all approved here. Never given up (posted hourly), so they
   * are counted apart: a payout to a merchant that is very late, a purchase the
   * brain never released a leg of, or one cancelled before any leg came.
   */
  waitingOver7d: number;
  waitingOver7dKeys: string[];
}

export function outboxHealth(db: Database.Database, nowMs: number = Date.now()): OutboxHealth {
  const open = (db.prepare("SELECT COUNT(*) AS c FROM brain_callback_outbox WHERE done_at IS NULL AND COALESCE(last_error, '') != ?").get(GAVE_UP) as { c: number }).c;
  const gave = db.prepare('SELECT dedupe_key FROM brain_callback_outbox WHERE done_at IS NULL AND last_error = ? ORDER BY id').all(GAVE_UP) as Array<{ dedupe_key: string }>;
  const waiting = db.prepare(`
    SELECT dedupe_key FROM brain_callback_outbox
    WHERE kind = 'fiat-received' AND done_at IS NULL AND COALESCE(last_error, '') != ?
      AND accepted_at IS NOT NULL AND created_at <= ?
    ORDER BY id
  `).all(GAVE_UP, sqlTime(nowMs - OUTBOX_GIVE_UP_MS)) as Array<{ dedupe_key: string }>;
  return {
    open, gaveUp: gave.length, gaveUpKeys: gave.map(g => g.dedupe_key),
    waitingOver7d: waiting.length, waitingOver7dKeys: waiting.map(w => w.dedupe_key),
  };
}

/** Where the brain listens, from the same env the old fire-and-forget calls read. */
export function brainCallbackTarget(env: NodeJS.ProcessEnv = process.env): { callbackUrl: string | undefined; callbackKey: string | undefined } {
  return {
    callbackUrl: env.BRAIN_CALLBACK_URL || env.BRAIN_API_URL,
    callbackKey: env.BRAIN_CALLBACK_KEY || env.LANA_DISCOUNT_API_KEY,
  };
}
