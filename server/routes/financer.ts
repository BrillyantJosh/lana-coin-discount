/**
 * /api/financer — a financer settles their own purchases (owner, 8 Oct 2026).
 *
 *   GET  /me                → { hexId, isFinancer, lanaDiscountWallet, walletCheck }
 *        Who Direct.Fund says the signer is, the Lana.Discount wallet they chose
 *        there, and whether the Registrar would let it pay (fail closed).
 *
 *   GET  /batches           → { batches: [...] }
 *        Their lana_discount batches on Direct.Fund, each with what we have
 *        here: confirmed or not, by whom, and where its LANA legs stand;
 *        `held` when the administrator decides it (never canConfirm then).
 *        A batch they confirmed counts only the legs of purchases they own
 *        here; the rest of its purchases, owned by nobody here, are
 *        ld.purchases.unclaimed (ld.unclaimedRefs, the first 50) — of them
 *        ld.purchases.retakeable a repeat confirmation could take — apart
 *        from those whose every leg here is cancelled or failed
 *        (ld.purchases.cancelled: finished, nobody's to send). `resendStopped`:
 *        its call to the brain stopped and a repeat brings it back.
 *        `canConfirmAgain` offers that repeat only while it changes something.
 *
 *   POST /batches/confirm   { batchRefs: string[] } → { results: [{batchRef, ok, code?, error?, skippedRefs?, skippedPaymentIds?}] }
 *        Confirm internal batches already paid on Direct.Fund; from then on the
 *        signer sends those purchases' LANA. Rules in lib/financer/confirm.ts.
 *        403 NOT_FINANCER when Direct.Fund does not know the signer as a
 *        financer; only the signer's own batches are read from Direct.Fund.
 *
 *   GET  /sendable          → the signer's legs that may go now, by purchase,
 *        with their wallet's balance and what it lacks.
 *   POST /sends/prepare     { orderIds } → the coins (each with the raw
 *        transaction that made it), the legs merged per wallet, the server's
 *        clock: everything the browser signs from. Reserves nothing.
 *   POST /sends             { orderIds, rawTx } → the send, recorded with its
 *        legs 'sending' and only then broadcast. The same rawTx again answers
 *        with the send as it stands (an answer that did not come).
 *   GET  /sends             → the signer's sends, newest first.
 *        The send machine is lib/financer/sends.ts; the key never comes here —
 *        the browser signs (src/lib/financer/payoutKey.ts).
 *
 * Every route is signed (requireSigner, NIP-98) and answers only about the
 * signer. Direct.Fund is read FRESH on every call (lib/financer/dfClient.ts):
 * these answers decide whose money moves, and a cached one can be minutes old.
 */
import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getDbHandle } from '../db/index.js';
import { requireSigner } from '../lib/financer/requireSigner.js';
import {
  fetchBatchByRef, fetchFinancer, fetchFinancerBatches, dfHttpStatus, isBatchRef,
  type DfClientOptions, type DfFinancerBatch,
} from '../lib/financer/dfClient.js';
import { checkFinancerWallet, type FinancerWalletCheck } from '../lib/financer/registrarWallet.js';
import { confirmFinancerBatches, heldBatches } from '../lib/financer/confirm.js';
import { fiatReceivedToRearm } from '../lib/financer/brainOutbox.js';
import { defaultSends, foreignInvestorSql, noteUnownedMismatch, type Sends, type SendRefusal } from '../lib/financer/sends.js';

export { requireSigner };

export interface FinancerRouterDeps {
  walletCheckBaseUrl: string;
  db?: () => Database.Database;
  /** Direct.Fund peer calls; defaults to DIRECT_FUND_URL with FUND_PEER_KEY. */
  df?: DfClientOptions;
  /** The Registrar's check (check.lanapays.us); injectable for tests. */
  walletFetch?: typeof fetch;
  now?: () => number;
  /** The send machine; defaults to the one this process sends with (lib/financer/sends.ts defaultSends). */
  sends?: Sends;
}

/** Most batches one confirm request may carry. A financer with many budgets has many batches. */
export const MAX_CONFIRM_BATCHES = 100;
/** Most unclaimed purchases one batch lists by reference (ld.unclaimedRefs); the count is whole. */
export const MAX_UNCLAIMED_REFS = 50;

function dfRefusal(res: Response, err: unknown) {
  const status = dfHttpStatus(err);
  console.warn(`[financer] Direct.Fund not asked: ${(err as any)?.message || err}`);
  return res.status(status).json({
    error: 'Direct.Fund could not be asked right now. Nothing was changed; try again shortly.',
    code: 'DF_UNAVAILABLE',
  });
}

interface LegStats { total: number; pending: number; authorized: number; sending: number; sent: number; cancelled: number }

export function createFinancerRouter(deps: FinancerRouterDeps): Router {
  const router = Router();
  const dbOf = deps.db ?? getDbHandle;
  const df = deps.df ?? {};

  router.get('/me', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    try {
      const f = await fetchFinancer(hex, df);
      const walletCheck: FinancerWalletCheck = f.lanaDiscountWallet
        ? await checkFinancerWallet(f.lanaDiscountWallet, hex, { checkBaseUrl: deps.walletCheckBaseUrl, fetch: deps.walletFetch })
        : { ok: false, reason: 'NO_WALLET' };
      return res.json({
        hexId: hex,
        isFinancer: f.isInvestor,
        lanaDiscountWallet: f.lanaDiscountWallet,
        lanaDiscountWalletSetAt: f.lanaDiscountWalletSetAt,
        walletCheck,
      });
    } catch (err) {
      return dfRefusal(res, err);
    }
  });

  router.get('/batches', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    let batches: DfFinancerBatch[];
    try {
      batches = await fetchFinancerBatches(hex, df);
    } catch (err) {
      return dfRefusal(res, err);
    }
    const db = dbOf();
    const held = heldBatches();
    const local = db.prepare('SELECT batch_ref, status, settled_by, investor_hex, received_at FROM incoming_batches WHERE batch_ref = ?');
    const owners = db.prepare('SELECT settled_by, owner_hex FROM purchase_settlement WHERE transaction_ref = ?');
    // The purchase has a live investor leg naming somebody other than the signer (lib/financer/sends.ts).
    const foreign = db.prepare(`SELECT ${foreignInvestorSql('?', '?')} AS f`);
    const legs = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'pending' AND brain_authorized = 1 THEN 1 ELSE 0 END) AS authorized,
        SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status IN ('cancelled', 'failed') THEN 1 ELSE 0 END) AS cancelled
      FROM brain_lana_orders WHERE transaction_ref = ?
    `);
    const out = batches.map(b => {
      const row = local.get(b.batchRef) as any;
      const confirmedByMe = row?.settled_by === 'financer' && String(row.investor_hex).toLowerCase() === hex;
      const refs = [...new Set(b.transactionRefs)];
      // Who settles each of its purchases here: 'financer' (you), 'treasury',
      // 'other' (another financer) or nobody yet (unclaimed). Nobody's purchase
      // whose every leg here is cancelled or failed is finished, not unclaimed
      // (cancelled; the 'finished' rule of brainOutbox.stillWaiting). An
      // unclaimed one a repeat confirmation could take (retakeable) still has a
      // leg here neither cancelled nor failed, and no live investor leg naming
      // somebody else — that one the repeat refuses OWNER_MISMATCH (recheck of
      // 9. 10. 2026, M2/M5); of a batch you confirmed, it is noted for the
      // administrator (sends.ownerMismatchPurchases).
      let treasury = 0;
      let other = 0;
      let cancelled = 0;
      let retakeable = 0;
      const mineRefs: string[] = [];
      const unclaimedRefs: string[] = [];
      const foreignRefs: string[] = [];
      for (const ref of refs) {
        const o = owners.get(ref) as { settled_by: string; owner_hex: string } | undefined;
        if (!o) {
          const s = legs.get(ref) as { total: number | null; cancelled: number | null };
          const total = s.total || 0;
          const dead = s.cancelled || 0;
          if (total > 0 && dead === total) {
            cancelled++;
            continue;
          }
          unclaimedRefs.push(ref);
          if ((foreign.get(ref, hex) as { f: number }).f === 1) foreignRefs.push(ref);
          else if (total > dead) retakeable++;
        } else if (o.settled_by === 'treasury') treasury++;
        else if (String(o.owner_hex).toLowerCase() === hex) mineRefs.push(ref);
        else other++;
      }
      if (confirmedByMe && foreignRefs.length > 0) noteUnownedMismatch(hex, foreignRefs);
      // Where its LANA stands. Once you confirmed the batch, only YOUR
      // purchases count: one Direct.Fund did not count at your confirmation
      // (left out, owned by nobody here) waits for no approval of yours, and
      // counted in, it would show the batch waiting for that approval for
      // good (review N7). It is reported apart, as unclaimed.
      const stats: LegStats = { total: 0, pending: 0, authorized: 0, sending: 0, sent: 0, cancelled: 0 };
      for (const ref of confirmedByMe ? mineRefs : refs) {
        const s = legs.get(ref) as Record<keyof LegStats, number | null>;
        for (const k of Object.keys(stats) as Array<keyof LegStats>) stats[k] += s[k] || 0;
      }
      const settledBy: 'financer' | 'treasury' | null = confirmedByMe ? 'financer'
        : (row?.settled_by === 'treasury' || treasury > 0 || (row && !row.settled_by && row.status !== 'incoming')) ? 'treasury'
        : null;
      // Waiting for the administrator's decision (lib/financer/confirm.ts heldBatches); a confirm is refused BATCH_HELD.
      const isHeld = held.has(b.batchRef);
      // A repeat confirmation takes in what Direct.Fund counts now and you did
      // not own yet, and brings back the batch's fiat-received if it stopped
      // while a purchase of it still waits for approval (lib/financer/confirm.ts,
      // brainOutbox.queueFiatReceived). Offered only while one of those can happen;
      // resendStopped says the second apart (M7), so the page can say why.
      const repeatable = confirmedByMe && b.status === 'paid' && !isHeld;
      const resendStopped = repeatable && fiatReceivedToRearm(db, b.batchRef).length > 0;
      return {
        ...b,
        ld: {
          confirmed: confirmedByMe,
          settledBy,
          status: row?.status ?? null,
          receivedAt: row?.received_at ?? null,
          purchases: { total: refs.length, mine: mineRefs.length, treasury, other, unclaimed: unclaimedRefs.length, retakeable, cancelled },
          unclaimedRefs: unclaimedRefs.slice(0, MAX_UNCLAIMED_REFS),
          legs: stats,
        },
        held: isHeld,
        // Paid on Direct.Fund, not yet confirmed here, nobody else's, and not held.
        canConfirm: b.status === 'paid' && !confirmedByMe && settledBy === null && other === 0 && !isHeld,
        canConfirmAgain: repeatable && (retakeable > 0 || resendStopped),
        resendStopped,
      };
    });
    return res.json({ batches: out });
  });

  router.post('/batches/confirm', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    // Only the references are read. A batch is built from Direct.Fund's answer,
    // never from anything else a body may carry.
    const raw = (req.body || {}).batchRefs;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: 'batchRefs must be a non-empty list of batch references.', code: 'EMPTY_BATCH_REFS' });
    }
    if (raw.length > MAX_CONFIRM_BATCHES) {
      return res.status(400).json({ error: `At most ${MAX_CONFIRM_BATCHES} batches per request.`, code: 'TOO_MANY_BATCHES' });
    }
    if (!raw.every(isBatchRef)) {
      return res.status(400).json({ error: 'Every batch reference must be letters, digits, - or _ (at most 64).', code: 'BAD_BATCH_REF' });
    }
    const batchRefs = [...new Set(raw as string[])];
    // Every LD→DF call comes from one container and shares one rate-limit
    // allowance on Direct.Fund, so a signed request costs Direct.Fund calls
    // only as far as it is a financer's own (review C9). Any key can sign:
    // first one call to learn whether the signer is a financer at all, then
    // their own batch list, and a batch is read only if it is on that list —
    // 100 made-up references cost two calls, not a hundred.
    let ownBatchRefs: Set<string>;
    try {
      const f = await fetchFinancer(hex, df);
      if (!f.isInvestor) {
        return res.status(403).json({ error: 'Direct.Fund does not know this key as a financer.', code: 'NOT_FINANCER' });
      }
      ownBatchRefs = new Set((await fetchFinancerBatches(hex, df)).map(b => b.batchRef));
    } catch (err) {
      return dfRefusal(res, err);
    }
    const results = await confirmFinancerBatches(dbOf(), hex, batchRefs, {
      fetchBatch: ref => fetchBatchByRef(ref, df),
      ownBatchRefs,
      nowMs: deps.now,
    });
    const okRefs = results.filter(r => r.ok && !r.alreadyConfirmed).map(r => r.batchRef);
    if (okRefs.length) console.log(`[financer] ${hex.slice(0, 12)}… confirmed ${okRefs.length} batch(es): ${okRefs.join(', ')}`);
    for (const r of results) {
      if (!r.ok) console.warn(`[financer] ${hex.slice(0, 12)}… confirm ${r.batchRef} refused: ${r.code}`);
      if (r.skippedRefs?.length) console.warn(`[financer] ${hex.slice(0, 12)}… confirm ${r.batchRef}: left out, Direct.Fund no longer counts them: ${r.skippedRefs.join(', ')}`);
    }
    return res.json({ results });
  });

  // ─── sending the LANA (lib/financer/sends.ts) ──────────────────────────────

  const sendsOf = (): Sends => deps.sends ?? defaultSends();
  const refuse = (res: Response, r: SendRefusal) => {
    const { ok: _ok, status, ...body } = r;
    return res.status(status).json(body);
  };

  router.get('/sendable', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    try {
      return res.json(await sendsOf().sendable(hex));
    } catch (err: any) {
      console.error(`[financer] sendable for ${hex.slice(0, 12)}… failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'Your legs could not be read right now.', code: 'SENDABLE_FAILED' });
    }
  });

  router.post('/sends/prepare', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    try {
      const r = await sendsOf().prepare(hex, (req.body || {}).orderIds);
      if (r.ok === false) {
        if (r.status >= 500) console.warn(`[financer] ${hex.slice(0, 12)}… prepare refused: ${r.code}`);
        return refuse(res, r);
      }
      return res.json(r.body);
    } catch (err: any) {
      console.error(`[financer] prepare for ${hex.slice(0, 12)}… failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'The send could not be prepared right now.', code: 'PREPARE_FAILED' });
    }
  });

  router.post('/sends', async (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    // Thrown after the send was stored is still a stored send: the browser repeats the SAME bytes on a 5xx
    // (src/lib/financer/payoutView.ts announceInDoubt) and is then answered with it as it stands.
    try {
      const r = await sendsOf().announce(hex, req.body);
      if (r.ok === false) {
        console.warn(`[financer] ${hex.slice(0, 12)}… send refused: ${r.code}`);
        return refuse(res, r);
      }
      return res.json({ send: r.send, already: r.already });
    } catch (err: any) {
      console.error(`[financer] announce for ${hex.slice(0, 12)}… failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'The send could not be recorded right now; send the same signed transaction again.', code: 'ANNOUNCE_FAILED' });
    }
  });

  router.get('/sends', (req: Request, res: Response) => {
    const hex = requireSigner(req, res);
    if (!hex) return;
    return res.json({ sends: sendsOf().list(hex) });
  });

  return router;
}
