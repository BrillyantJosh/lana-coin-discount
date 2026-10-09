/**
 * CONFIRMING A BATCH ON LANA.DISCOUNT — who will send its purchases' LANA.
 *
 * Two doors, one bookkeeping:
 *
 *   FINANCER (POST /api/financer/batches/confirm). Their "Lana Discount" share
 *   is internal — they pay themselves — so there is no bank statement for an
 *   operator to look at. They confirm the batch on Direct.Fund as before
 *   ("I Have Paid This Batch"), then here, signed with their key, and from then
 *   on they send every leg of those purchases from their own Lana.Discount
 *   wallet. Owner, 8 Oct 2026.
 *
 *   TREASURY (admin PUT /api/admin/incoming-batches/:ref/status 'received',
 *   with treasuryReceived:true). The old door, now only for money that REALLY
 *   arrived on the treasury's own bank account; the treasury then sends.
 *
 * Either way the batch is built HERE from Direct.Fund's own answer, read fresh
 * (lib/financer/dfClient.ts) — never from the request body, never from the
 * admin page's two-minute cache — and the decision is written in ONE immediate
 * transaction: the incoming batch, purchase_settlement for every purchase, the
 * batch link on the legs, and the fiat-received call to the brain (outbox).
 * The ownership checks against our own tables run INSIDE that transaction, so
 * two confirmations racing each other cannot both win.
 *
 * Ownership is per purchase and is never rewritten: a purchase the treasury
 * settles cannot be confirmed by a financer, one financer's purchase cannot be
 * confirmed by another, and a repeat by the same owner changes nothing (200)
 * — except that it brings back the batch's fiat-received if that call is not
 * finished, and takes in a purchase Direct.Fund did not count the first time
 * and counts now (brainOutbox.queueFiatReceived).
 */
import type Database from 'better-sqlite3';
import { DfError, isBatchRef, type DfBatchByRef, type DfBatchPayment } from './dfClient.js';
import { queueFiatReceived } from './brainOutbox.js';

export type ConfirmCode =
  | 'BAD_BATCH_REF'
  | 'DF_UNAVAILABLE'
  | 'BATCH_NOT_FOUND'
  | 'NOT_YOUR_BATCH'
  | 'BATCH_HELD'
  | 'NOT_LANA_DISCOUNT'
  | 'BATCH_NOT_PAID'
  | 'NO_PAYMENTS'
  | 'PAYMENT_NOT_YOURS'
  | 'PAYMENT_NOT_CONFIRMED'
  | 'PAYMENT_WITHOUT_REF'
  | 'OWNER_CONFLICT'
  | 'OWNER_MISMATCH'
  | 'NO_TRANSACTIONS';

export interface ConfirmResult {
  batchRef: string;
  ok: boolean;
  code?: ConfirmCode;
  error?: string;
  /** True when this owner had already confirmed it; nothing changed. */
  alreadyConfirmed?: boolean;
  /** The purchases this batch settles, from Direct.Fund. */
  transactionRefs?: string[];
  /**
   * Set only when Direct.Fund lists payments of this batch it no longer counts
   * (cancelled, or superseded by a reallocation): their purchases, and the
   * payment ids, left out of this confirmation and owned by nobody here. A
   * repeat confirmation takes them in once Direct.Fund counts them again.
   */
  skippedRefs?: string[];
  skippedPaymentIds?: number[];
}

type Verdict =
  | { ok: true; refs: string[]; skippedRefs: string[]; skippedPaymentIds: number[] }
  | { ok: false; code: ConfirmCode; error: string; skippedRefs?: string[]; skippedPaymentIds?: number[] };

const lc = (s: string | null | undefined) => String(s || '').trim().toLowerCase();
const LANA_DISCOUNT = 'lana_discount';

/**
 * Batches a financer may not confirm until the administrator decides them
 * (review C12/C16/C23). 2026002293 (4af96237, 243.89 EUR) was closed while
 * Direct.Fund still showed the treasury's bank account and "transfer the total
 * in a single bank transfer": the money may be on the treasury's account
 * already. Whoever confirmed first would own it — the financer, who would then
 * pay its LANA from their own wallet while the euros sit with the treasury.
 * The treasury's own door (recordTreasuryReceived) is NOT held: that is how
 * the administrator decides it when the bank shows the money.
 *
 * The owner decided it on 9 Oct 2026: the treasury account it might have
 * reached belonged to that same financer anyway, so 2026002293 is settled by
 * the financer like any other batch, and nothing is held by default any more.
 * The mechanism stays for the next such case.
 *
 * FINANCER_HELD_BATCHES, comma separated, replaces the list when it is set —
 * set it empty ('') to hold nothing. It is the process environment, so a
 * change takes a restart of lana.discount.
 */
export const DEFAULT_HELD_BATCHES = '';

export function heldBatches(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(String(env.FINANCER_HELD_BATCHES ?? DEFAULT_HELD_BATCHES).split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Pure: may `signerHex` confirm this batch, as Direct.Fund has it now? Every
 * payment Direct.Fund still counts must pass, or nothing of the batch is taken
 * — a batch is one transfer on Direct.Fund and is settled whole here too.
 *
 * A payment Direct.Fund no longer counts (live false: cancelled, or superseded
 * when the brain moved the purchase to another financer) is left out, as the
 * treasury's door leaves it out — before any other check of it. Such a payment
 * claims nothing: whose it says it is, its destination and whether it was
 * confirmed are all about an order that no longer stands. Refusing the batch
 * over it would hold every other purchase in the batch — dozens, for an open
 * collecting batch — for one stale order no route can clear (review C14). Its
 * purchase simply stays without an owner; neither financer gets it here.
 * Every payment that IS counted keeps every check.
 */
export function judgeFinancerBatch(df: DfBatchByRef, signerHex: string, held: ReadonlySet<string> = heldBatches()): Verdict {
  const me = lc(signerHex);
  const b = df.batch;
  if (!me || lc(b.investorHex) !== me) {
    return { ok: false, code: 'NOT_YOUR_BATCH', error: 'This batch belongs to another financer on Direct.Fund.' };
  }
  if (held.has(b.batchRef)) {
    return { ok: false, code: 'BATCH_HELD', error: 'This batch was closed while Direct.Fund still showed the treasury bank account; the administrator decides it. Please contact us.' };
  }
  if (b.destinationType !== LANA_DISCOUNT) {
    return { ok: false, code: 'NOT_LANA_DISCOUNT', error: 'This batch is not a Lana Discount batch — it is paid to its recipients by bank, not settled here.' };
  }
  if (b.status !== 'paid') {
    return { ok: false, code: 'BATCH_NOT_PAID', error: 'Confirm this batch on Direct.Fund first ("I Have Paid This Batch"), then here.' };
  }
  if (df.payments.length === 0) {
    return { ok: false, code: 'NO_PAYMENTS', error: 'Direct.Fund lists no payments in this batch.' };
  }
  const refs = new Set<string>();
  const skipped = new Set<string>();
  const skippedPaymentIds: number[] = [];
  for (const p of df.payments) {
    if (!p.live) {
      if (Number.isFinite(p.ppId)) skippedPaymentIds.push(p.ppId);
      if (p.transactionRef) skipped.add(p.transactionRef);
      continue;
    }
    const which = `payment ${Number.isFinite(p.ppId) ? p.ppId : '?'}`;
    if (lc(p.investorHex) !== me) return { ok: false, code: 'PAYMENT_NOT_YOURS', error: `${which} belongs to another financer on Direct.Fund.` };
    if (p.destinationType !== LANA_DISCOUNT) return { ok: false, code: 'NOT_LANA_DISCOUNT', error: `${which} is not a Lana Discount payment.` };
    if (!p.confirmed) return { ok: false, code: 'PAYMENT_NOT_CONFIRMED', error: `${which} is not confirmed on Direct.Fund yet.` };
    if (!p.transactionRef) return { ok: false, code: 'PAYMENT_WITHOUT_REF', error: `${which} names no purchase.` };
    refs.add(p.transactionRef);
  }
  // A purchase with a counted payment as well (the stale order and its
  // replacement in one batch) is not left out.
  const skippedRefs = [...skipped].filter(r => !refs.has(r));
  if (refs.size === 0) {
    return { ok: false, code: 'NO_TRANSACTIONS', error: 'Direct.Fund counts no purchase in this batch any more (every payment in it was cancelled or moved). Ask the administrator.', skippedRefs, skippedPaymentIds };
  }
  return { ok: true, refs: [...refs], skippedRefs, skippedPaymentIds };
}

interface SettlementRow { transaction_ref: string; owner_hex: string; settled_by: 'treasury' | 'financer' }

function settlementOf(db: Database.Database, ref: string): SettlementRow | undefined {
  return db.prepare('SELECT transaction_ref, owner_hex, settled_by FROM purchase_settlement WHERE transaction_ref = ?').get(ref) as SettlementRow | undefined;
}

function batchRow(db: Database.Database, batchRef: string): any {
  return db.prepare('SELECT * FROM incoming_batches WHERE batch_ref = ?').get(batchRef);
}

const finite = (n: number, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/** A new incoming batch and its payments, from Direct.Fund's answer. */
function insertBatch(db: Database.Database, df: DfBatchByRef, investorHex: string, settledBy: 'treasury' | 'financer', receivedAt: string): void {
  const b = df.batch;
  const sum = df.payments.reduce((s, p) => s + finite(p.amount), 0);
  const id = db.prepare(`
    INSERT INTO incoming_batches (batch_ref, investor_hex, total_amount, currency, payment_count, status, received_at, settled_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?)
  `).run(b.batchRef, investorHex, finite(b.totalAmount, sum), b.currency || '', df.payments.length, receivedAt, settledBy, receivedAt).lastInsertRowid;
  insertPayments(db, Number(id), df.payments);
}

function insertPayments(db: Database.Database, batchId: number, payments: DfBatchPayment[]): void {
  const put = db.prepare(`
    INSERT INTO incoming_batch_payments (batch_id, pp_id, order_type, amount_fiat, currency, recipient_wallet, shop_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of payments) {
    put.run(batchId, finite(p.ppId), p.orderType, finite(p.amount), p.currency || '', p.recipientWallet, p.shopName);
  }
}

/** Link the purchases' legs to this batch where nothing claimed them yet (batchSettlement.ts reads the link). */
function linkLegs(db: Database.Database, batchRef: string, refs: string[]): number {
  const link = db.prepare('UPDATE brain_lana_orders SET batch_ref = ? WHERE transaction_ref = ? AND batch_ref IS NULL');
  let n = 0;
  for (const ref of refs) n += link.run(batchRef, ref).changes;
  return n;
}

const nowSql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * The financer's confirmation, after judgeFinancerBatch said yes: the checks
 * against our own tables and every write, in ONE immediate transaction.
 */
export function recordFinancerConfirm(db: Database.Database, df: DfBatchByRef, signerHex: string, opts: { nowMs?: number; held?: ReadonlySet<string> } = {}): ConfirmResult {
  const batchRef = df.batch.batchRef;
  const verdict = judgeFinancerBatch(df, signerHex, opts.held);
  if (verdict.ok === false) {
    return { batchRef, ok: false, code: verdict.code, error: verdict.error, ...skippedOf(verdict.skippedRefs ?? [], verdict.skippedPaymentIds ?? []) };
  }
  const me = lc(signerHex);
  const refs = verdict.refs;
  const skipped = skippedOf(verdict.skippedRefs, verdict.skippedPaymentIds);
  const now = nowSql(opts.nowMs ?? Date.now());

  return db.transaction((): ConfirmResult => {
    const existing = batchRow(db, batchRef);
    let already = false;
    if (existing) {
      const mine = existing.settled_by === 'financer' && lc(existing.investor_hex) === me;
      // A batch nobody has confirmed yet ('incoming', no owner) may still be
      // taken; one the treasury confirmed, or another financer, may not.
      const unclaimed = !existing.settled_by && existing.status === 'incoming';
      if (!mine && !unclaimed) {
        return { batchRef, ok: false, code: 'OWNER_CONFLICT', error: existing.settled_by === 'financer'
          ? 'Another financer has already confirmed this batch.'
          : 'The treasury has already confirmed this batch as received on its own account; it sends this LANA.' };
      }
      already = mine;
    }

    for (const ref of refs) {
      const ps = settlementOf(db, ref);
      if (ps && (ps.settled_by !== 'financer' || lc(ps.owner_hex) !== me)) {
        return { batchRef, ok: false, code: 'OWNER_CONFLICT', error: ps.settled_by === 'treasury'
          ? `Purchase ${ref} is settled by the treasury.`
          : `Purchase ${ref} is already settled by another financer.` };
      }
      if (!ps) {
        // Nobody owns it, yet LANA of it has already left (the treasury sent it
        // before this existed). An owner given now would be an owner given after
        // a leg left 'pending' — never.
        const gone = db.prepare("SELECT COUNT(*) AS c FROM brain_lana_orders WHERE transaction_ref = ? AND status IN ('sending', 'sent')").get(ref) as { c: number };
        if (gone.c > 0) {
          return { batchRef, ok: false, code: 'OWNER_CONFLICT', error: `LANA of purchase ${ref} has already been sent by the treasury.` };
        }
      }
      // The LANA bought for the financer goes to THEIR budget wallet; a purchase
      // whose investor leg names somebody else (moved to another financer after
      // Direct.Fund batched it) is not theirs to settle.
      const foreign = db.prepare(`
        SELECT to_hex FROM brain_lana_orders
        WHERE transaction_ref = ? AND order_type = 'investor_lana' AND status NOT IN ('cancelled', 'failed')
          AND LOWER(to_hex) != ?
        LIMIT 1
      `).get(ref, me) as { to_hex: string } | undefined;
      if (foreign) {
        return { batchRef, ok: false, code: 'OWNER_MISMATCH', error: `Purchase ${ref} pays its LANA to another financer here; it cannot be settled by you.` };
      }
    }

    if (!existing) {
      insertBatch(db, df, me, 'financer', now);
    } else if (!already) {
      db.prepare(`
        UPDATE incoming_batches
           SET status = 'received', received_at = ?, settled_by = 'financer', investor_hex = ?,
               total_amount = ?, currency = ?, payment_count = ?, updated_at = ?
         WHERE id = ?
      `).run(now, me, finite(df.batch.totalAmount, existing.total_amount), df.batch.currency || existing.currency, df.payments.length, now, existing.id);
      const hasPayments = db.prepare('SELECT 1 FROM incoming_batch_payments WHERE batch_id = ? LIMIT 1').get(existing.id);
      if (!hasPayments) insertPayments(db, existing.id, df.payments);
    }

    const put = db.prepare(`
      INSERT OR IGNORE INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by, created_at)
      VALUES (?, ?, 'financer', ?, ?, ?)
    `);
    for (const ref of refs) put.run(ref, me, batchRef, me, now);
    linkLegs(db, batchRef, refs);
    const call = queueFiatReceived(db, batchRef, refs, { nowMs: opts.nowMs });
    if (call.rearmed.length || call.added.length) {
      console.log(`[lana-discount] Financer confirm of ${batchRef} again: fiat-received re-armed ${call.rearmed.join(', ') || '-'}; new purchase(s) ${call.added.join(', ') || '-'}`);
    }
    return { batchRef, ok: true, alreadyConfirmed: already, transactionRefs: refs, ...skipped };
  }).immediate();
}

/** The skipped purchases and payments of a verdict, as answer fields — only when there are any. */
function skippedOf(refs: string[], paymentIds: number[]): Pick<ConfirmResult, 'skippedRefs' | 'skippedPaymentIds'> {
  return refs.length || paymentIds.length ? { skippedRefs: refs, skippedPaymentIds: paymentIds } : {};
}

export interface ConfirmDeps {
  /** A FRESH read of Direct.Fund's batch (dfClient.fetchBatchByRef). */
  fetchBatch: (batchRef: string) => Promise<DfBatchByRef>;
  /**
   * The signer's own Lana Discount batches on Direct.Fund (dfClient
   * fetchFinancerBatches). When given, a reference not in it is answered
   * NOT_YOUR_BATCH without asking Direct.Fund about it: every LD→DF call shares
   * one rate-limit allowance, and a made-up list of references must not spend
   * it for everyone (review C9).
   */
  ownBatchRefs?: ReadonlySet<string>;
  nowMs?: () => number;
  /** The hold list (heldBatches()); injectable for tests. */
  held?: ReadonlySet<string>;
}

/** The financer's request, batch by batch. One batch failing never stops the others. */
export async function confirmFinancerBatches(db: Database.Database, signerHex: string, batchRefs: string[], deps: ConfirmDeps): Promise<ConfirmResult[]> {
  const out: ConfirmResult[] = [];
  for (const batchRef of batchRefs) {
    if (!isBatchRef(batchRef)) {
      out.push({ batchRef: String(batchRef), ok: false, code: 'BAD_BATCH_REF', error: 'Not a batch reference.' });
      continue;
    }
    if (deps.ownBatchRefs && !deps.ownBatchRefs.has(batchRef)) {
      out.push({ batchRef, ok: false, code: 'NOT_YOUR_BATCH', error: 'Direct.Fund lists no Lana Discount batch of yours with this reference.' });
      continue;
    }
    let df: DfBatchByRef;
    try {
      df = await deps.fetchBatch(batchRef);
    } catch (err) {
      out.push(err instanceof DfError && err.code === 'DF_NOT_FOUND'
        ? { batchRef, ok: false, code: 'BATCH_NOT_FOUND', error: 'Direct.Fund has no batch with this reference.' }
        : { batchRef, ok: false, code: 'DF_UNAVAILABLE', error: 'Direct.Fund could not be asked about this batch right now. Nothing was changed; try again shortly.' });
      continue;
    }
    try {
      out.push(recordFinancerConfirm(db, df, signerHex, { nowMs: deps.nowMs?.(), held: deps.held }));
    } catch (err: any) {
      console.error(`[lana-discount] Financer confirm of ${batchRef} failed:`, err?.message || err);
      out.push({ batchRef, ok: false, code: 'DF_UNAVAILABLE', error: 'The batch could not be recorded. Nothing was changed; try again shortly.' });
    }
  }
  return out;
}

// ─── the treasury's door ──────────────────────────────────────────────────

export type TreasuryConfirmResult =
  | { ok: true; transactionRefs: string[]; created: boolean }
  | { ok: false; httpStatus: number; code: 'OWNER_CONFLICT' | 'NO_TRANSACTIONS'; error: string; refs?: string[] };

/**
 * "The money arrived on the treasury's bank account": the batch, its
 * purchases and the brain call, written as the treasury's — from Direct.Fund's
 * fresh answer, in one immediate transaction. Refused if any purchase is a
 * financer's, or the batch was confirmed by one. Payments Direct.Fund no longer
 * counts (cancelled, moved) and payments that name no purchase are left out,
 * as the old route left out those without a reference. Not subject to the
 * financer hold list (heldBatches): a held batch is decided here.
 */
export function recordTreasuryReceived(db: Database.Database, df: DfBatchByRef, adminHex: string, opts: { nowMs?: number; notes?: string | null } = {}): TreasuryConfirmResult {
  const batchRef = df.batch.batchRef;
  const counted = df.payments.filter(p => p.live && p.transactionRef);
  const ownerOf = new Map<string, string>();
  for (const p of counted) if (!ownerOf.has(p.transactionRef!)) ownerOf.set(p.transactionRef!, lc(p.investorHex) || lc(df.batch.investorHex));
  const refs = [...ownerOf.keys()];
  if (refs.length === 0) {
    return { ok: false, httpStatus: 409, code: 'NO_TRANSACTIONS', error: 'Direct.Fund lists no live purchase in this batch — nothing to confirm. (Is Direct.Fund up to date?)' };
  }
  const now = nowSql(opts.nowMs ?? Date.now());

  return db.transaction((): TreasuryConfirmResult => {
    const existing = batchRow(db, batchRef);
    if (existing?.settled_by === 'financer') {
      return { ok: false, httpStatus: 409, code: 'OWNER_CONFLICT', error: 'Its financer has already confirmed this batch; they send this LANA from their own wallet.' };
    }
    const theirs = refs.filter(ref => settlementOf(db, ref)?.settled_by === 'financer');
    if (theirs.length > 0) {
      return { ok: false, httpStatus: 409, code: 'OWNER_CONFLICT', error: `${theirs.length} purchase(s) of this batch are settled by their financer — nothing was changed.`, refs: theirs };
    }

    if (!existing) {
      insertBatch(db, df, lc(df.batch.investorHex), 'treasury', now);
    } else {
      db.prepare(`
        UPDATE incoming_batches SET status = 'received', received_at = ?, settled_by = 'treasury', updated_at = ?
         WHERE id = ?
      `).run(now, now, existing.id);
      const hasPayments = db.prepare('SELECT 1 FROM incoming_batch_payments WHERE batch_id = ? LIMIT 1').get(existing.id);
      if (!hasPayments) insertPayments(db, existing.id, df.payments);
    }
    if (opts.notes) db.prepare('UPDATE incoming_batches SET notes = ? WHERE batch_ref = ?').run(opts.notes, batchRef);

    const put = db.prepare(`
      INSERT OR IGNORE INTO purchase_settlement (transaction_ref, owner_hex, settled_by, batch_ref, confirmed_by, created_at)
      VALUES (?, ?, 'treasury', ?, ?, ?)
    `);
    for (const ref of refs) put.run(ref, ownerOf.get(ref) || '', batchRef, adminHex, now);
    const linked = linkLegs(db, batchRef, refs);
    if (linked > 0) console.log(`[lana-discount] Backfilled batch_ref=${batchRef} on ${linked} brain_lana_orders`);
    // A repeat "received" also brings back an unfinished fiat-received (and
    // reports a purchase Direct.Fund counts only now) — see queueFiatReceived.
    const call = queueFiatReceived(db, batchRef, refs, { nowMs: opts.nowMs });
    if (call.rearmed.length || call.added.length) {
      console.log(`[lana-discount] Treasury "received" of ${batchRef} again: fiat-received re-armed ${call.rearmed.join(', ') || '-'}; new purchase(s) ${call.added.join(', ') || '-'}`);
    }
    return { ok: true, transactionRefs: refs, created: !existing };
  }).immediate();
}

/**
 * May the operator tick 'lana_bought' / 'lana_sent' (or reset to 'incoming')
 * on this batch? Only one the treasury settles: none of its purchases a
 * financer's, and every purchase of it that still has a leg to send the
 * treasury's own. 'lana_bought' releases legs to the auto-sender, so a batch
 * whose purchases are not the treasury's must never reach it.
 */
export function treasuryMayTick(db: Database.Database, batchRef: string): { ok: true } | { ok: false; httpStatus: number; code: string; error: string } {
  const batch = batchRow(db, batchRef);
  if (!batch) return { ok: false, httpStatus: 409, code: 'BATCH_NOT_RECEIVED', error: 'Confirm this batch as received first.' };
  if (batch.settled_by === 'financer') {
    return { ok: false, httpStatus: 409, code: 'OWNER_CONFLICT', error: 'Its financer settles this batch; the treasury does not tick it.' };
  }
  const rows = db.prepare(`
    SELECT blo.transaction_ref AS ref, ps.settled_by,
           SUM(CASE WHEN blo.status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS open
    FROM brain_lana_orders blo
    LEFT JOIN purchase_settlement ps ON ps.transaction_ref = blo.transaction_ref
    WHERE blo.batch_ref = ?
    GROUP BY blo.transaction_ref, ps.settled_by
  `).all(batchRef) as Array<{ ref: string | null; settled_by: string | null; open: number }>;
  if (rows.some(r => r.settled_by === 'financer')) {
    return { ok: false, httpStatus: 409, code: 'OWNER_CONFLICT', error: 'A purchase of this batch is settled by its financer.' };
  }
  const unowned = rows.filter(r => r.open > 0 && r.settled_by !== 'treasury');
  if (unowned.length > 0) {
    return { ok: false, httpStatus: 409, code: 'NOT_TREASURY', error: `${unowned.length} purchase(s) of this batch with LANA still to send are not the treasury's — confirm the batch as received on the treasury account first.` };
  }
  return { ok: true };
}
