/**
 * GET /api/admin/financers-overview — WHAT EACH FINANCER STILL HAS TO DO (owner, 12 Oct 2026).
 *
 * Since 9 Oct 2026 every financer settles their own purchases on /financer: pays the internal batch on Direct.Fund,
 * confirms it here, waits for the brain's approval, then signs and sends the LANA from their own Lana.Discount wallet.
 * This route lays that path out per financer, so the owner sees at a glance who is stuck where:
 *
 *   1. toPayOnDf        Direct.Fund batches still open or closed (no "I Have Paid" yet).
 *   2. toConfirm        paid on Direct.Fund, not confirmed here (no incoming_batches row, and purchases of it nobody owns).
 *   3. waitingApproval  their purchases confirmed here whose legs the brain has not approved yet (or no leg has come);
 *                       with what Direct.Fund still has unpaid for them (waitingOn), as /financer words it.
 *   4. toSend           approved, pending, in no send: what they must sign and send NOW.
 *   5. onTheWay         their signed sends not in a block yet (lana_sends announced / mempool).
 * And per financer: open legs whose investor leg names them but nobody owns yet (unowned), the last confirmed send.
 * At the top: every open leg nobody owns.
 *
 * Who is listed is read from the data, never written down: the investor of every open leg, every owner of a
 * financer-settled purchase, every financer who has sent. Direct.Fund is then asked about each (fetchFinancer,
 * fetchFinancerBatches, and fetchFinancerUnpaidParts when something waits for approval) — fresh, as everything in
 * lib/financer/dfClient.ts. A Direct.Fund that does not answer costs only stages 1–2 of that financer
 * (dfUnavailable): the page always opens with what this database knows. Read-only: nothing here writes.
 *
 * LANA are lanoshis, as decimal strings, per currency of the purchase (the currency its legs carry; '?' when a leg
 * carries none a person could read). Purchases of the treasury (settled_by 'treasury') are not a financer's work and
 * are not counted here; /admin/incoming-payments shows them.
 */
import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getDbHandle } from '../db/index.js';
import { requireAdmin } from '../lib/adminAuth.js';
import {
  fetchFinancer, fetchFinancerBatches, fetchFinancerUnpaidParts, isUnpaidRef, currencyCode,
  MAX_UNPAID_REFS, MAX_UNPAID_REFS_CHARS,
  type DfClientOptions, type DfFinancer, type DfFinancerBatch, type DfUnpaidPart,
} from '../lib/financer/dfClient.js';
import { heldBatches } from '../lib/financer/confirm.js';
import { foreignInvestorSql } from '../lib/financer/sends.js';

export interface AdminFinancersDeps {
  db?: () => Database.Database;
  /** Direct.Fund peer calls; defaults to DIRECT_FUND_URL with FUND_PEER_KEY. */
  df?: DfClientOptions;
  now?: () => number;
}

/** Lanoshis per currency, as decimal strings. */
export type LanaByCurrency = Record<string, string>;

export interface StageTotals {
  purchases: number;
  legs: number;
  lana: LanaByCurrency;
  /** The oldest moment the stage counts from (batch created / paid, leg created, send recorded); null when empty. */
  oldestAt: string | null;
}

export interface OverviewBatch {
  batchRef: string;
  status: string;
  currency: string;
  totalAmount: number;
  /** Purchases of the batch this stage counts (for toConfirm: those nobody owns here yet). */
  purchases: number;
  createdAt: string | null;
  closedAt: string | null;
  paidAt: string | null;
  /** Waiting for the administrator's decision (lib/financer/confirm.ts heldBatches); /financer refuses to confirm it. */
  held: boolean;
}

export type WaitingPart = Pick<DfUnpaidPart, 'batchRef' | 'batchStatus' | 'orderType' | 'destinationType' | 'amount' | 'currency' | 'transactionRef'>;

export interface OverviewSend {
  txid: string;
  state: string;
  walletId: string;
  legs: number;
  lanoshis: string;
  since: string;
}

export interface FinancerOverview {
  hex: string;
  /** From this database's users (KIND 0 as last seen at sign-in); null when unknown — the page shows a short hex. */
  name: string | null;
  /** Direct.Fund's isFinancer; null when it could not be asked. */
  isFinancer: boolean | null;
  dfUnavailable: boolean;
  /** Direct.Fund's Lana.Discount wallet per currency; null when it could not be asked. */
  wallets: Record<string, string> | null;
  stages: {
    toPayOnDf: (StageTotals & { batches: OverviewBatch[] }) | null;
    toConfirm: (StageTotals & { batches: OverviewBatch[] }) | null;
    waitingApproval: StageTotals & {
      /** Confirmed purchases no leg of which has come from the brain yet (counted in purchases). */
      withoutLegs: number;
      /** What Direct.Fund does not have as paid yet for them; [] all paid; null not asked or no answer. */
      waitingOn: WaitingPart[] | null;
      /** Some of them were not asked about (one call carries at most MAX_UNPAID_REFS). */
      waitingOnPartial: boolean;
    };
    toSend: StageTotals & {
      /** Distinct wallets the legs pay. */
      wallets: number;
      /** The longest any of them has waited since the brain approved it. */
      oldestApprovedAt: string | null;
      /** Their purchases whose investor leg now names somebody else: nothing sends them until a person looks (not counted above). */
      ownerMismatch: number;
    };
    onTheWay: StageTotals & { sends: OverviewSend[] };
  };
  unowned: StageTotals;
  lastConfirmedSend: { txid: string; at: string | null } | null;
}

export interface FinancersOverview {
  generatedAt: string;
  /** Direct.Fund could not be asked about at least one financer (their stages 1–2 are null). */
  dfUnavailable: boolean;
  financers: FinancerOverview[];
  /** Every open (pending) leg whose purchase nobody owns yet; withoutFinancer: those with no investor leg naming one. */
  unowned: StageTotals & { withoutFinancer: StageTotals };
}

const HEX_RE = /^[0-9a-f]{64}$/;
/** Most sends listed per financer under onTheWay; the totals count them all. */
export const SENDS_LISTED = 20;

interface LegRow {
  id: string;
  ref: string | null;
  currency: string | null;
  lana: bigint;
  created_at: string | null;
  authorized_at?: string | null;
  to_wallet?: string | null;
}

const earlier = (a: string | null, b: string | null | undefined): string | null => {
  if (!b) return a;
  if (!a) return b;
  return b < a ? b : a;
};

/** Leg rows → purchases, legs, lanoshis per currency, the oldest created_at. */
function totalsOf(rows: readonly LegRow[]): StageTotals {
  const sums = new Map<string, bigint>();
  const refs = new Set<string>();
  let oldestAt: string | null = null;
  for (const r of rows) {
    const c = currencyCode(r.currency) ?? '?';
    sums.set(c, (sums.get(c) ?? 0n) + BigInt(r.lana));
    if (r.ref) refs.add(r.ref);
    oldestAt = earlier(oldestAt, r.created_at);
  }
  const lana: LanaByCurrency = {};
  for (const c of [...sums.keys()].sort()) lana[c] = String(sums.get(c));
  return { purchases: refs.size, legs: rows.length, lana, oldestAt };
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Display names this database knows (users, from sign-in). Defensive: a database without the table names nobody. */
function namesOf(db: Database.Database, hexes: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (hexes.length === 0 || !tableExists(db, 'users')) return out;
  try {
    const stmt = db.prepare('SELECT display_name, full_name FROM users WHERE LOWER(nostr_hex_id) = ?');
    for (const h of hexes) {
      const r = stmt.get(h) as { display_name: string | null; full_name: string | null } | undefined;
      const name = (r?.display_name || r?.full_name || '').trim();
      if (name) out.set(h, name);
    }
  } catch { /* a name is a nicety; the hex stands on its own */ }
  return out;
}

/** Who to list: the investor of every open leg, every owner of a financer-settled purchase, every financer who sent. */
export function financerCandidates(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT LOWER(to_hex) AS h FROM brain_lana_orders WHERE order_type = 'investor_lana' AND status IN ('pending', 'sending')
    UNION SELECT LOWER(owner_hex) FROM purchase_settlement WHERE settled_by = 'financer'
    UNION SELECT LOWER(owner_hex) FROM lana_sends WHERE sender = 'financer' AND owner_hex IS NOT NULL
  `).all() as Array<{ h: string | null }>;
  return [...new Set(rows.map(r => String(r.h ?? '').trim()).filter(h => HEX_RE.test(h)))].sort();
}

/** The parts of the local overview that need no Direct.Fund. Exported for tests. */
export function localOverview(db: Database.Database, hex: string) {
  const legsOf = (sql: string, ...args: unknown[]) => db.prepare(sql).safeIntegers(true).all(...args).map((r: any) => ({
    ...r,
    lana: BigInt(r.lana ?? 0),
  })) as LegRow[];

  const owned = `JOIN purchase_settlement ps ON ps.transaction_ref = blo.transaction_ref AND ps.settled_by = 'financer' AND LOWER(ps.owner_hex) = ?`;
  const foreign = foreignInvestorSql('blo.transaction_ref', '?');

  // 3. Confirmed, not approved yet.
  const waitingLegs = legsOf(`
    SELECT blo.id, blo.transaction_ref AS ref, blo.currency, blo.lana_amount AS lana, blo.created_at
    FROM brain_lana_orders blo ${owned}
    WHERE blo.status = 'pending' AND COALESCE(blo.brain_authorized, 0) = 0
    ORDER BY blo.created_at, blo.id
  `, hex);
  // Confirmed purchases no leg of which is here yet: /financer counts them as waiting too.
  const withoutLegs = db.prepare(`
    SELECT ps.transaction_ref AS ref, ps.created_at FROM purchase_settlement ps
    WHERE ps.settled_by = 'financer' AND LOWER(ps.owner_hex) = ?
      AND NOT EXISTS (SELECT 1 FROM brain_lana_orders b WHERE b.transaction_ref = ps.transaction_ref)
    ORDER BY ps.created_at, ps.transaction_ref
  `).all(hex) as Array<{ ref: string; created_at: string | null }>;
  const waitingTotals = totalsOf(waitingLegs);
  let waitingOldest = waitingTotals.oldestAt;
  for (const w of withoutLegs) waitingOldest = earlier(waitingOldest, w.created_at);
  // Oldest first, as the page reads them, and as the unpaid-parts question is cut.
  const waitingRefs: Array<{ ref: string; at: string }> = [];
  {
    const seen = new Set<string>();
    for (const l of waitingLegs) if (l.ref && !seen.has(l.ref)) { seen.add(l.ref); waitingRefs.push({ ref: l.ref, at: l.created_at ?? '' }); }
    for (const w of withoutLegs) if (!seen.has(w.ref)) { seen.add(w.ref); waitingRefs.push({ ref: w.ref, at: w.created_at ?? '' }); }
    waitingRefs.sort((a, b) => a.at.localeCompare(b.at));
  }

  // 4. Approved, to send now — exactly what /financer's sendable offers (lib/financer/sends.ts sendableLegsOf).
  const sendLegs = legsOf(`
    SELECT blo.id, blo.transaction_ref AS ref, blo.currency, blo.lana_amount AS lana, blo.created_at,
           blo.brain_authorized_at AS authorized_at, blo.to_wallet
    FROM brain_lana_orders blo ${owned}
    WHERE blo.status = 'pending' AND blo.brain_authorized = 1 AND blo.send_txid IS NULL AND NOT ${foreign}
    ORDER BY blo.created_at, blo.id
  `, hex, hex);
  const mismatch = db.prepare(`
    SELECT COUNT(DISTINCT blo.transaction_ref) AS n FROM brain_lana_orders blo ${owned}
    WHERE blo.status = 'pending' AND ${foreign}
  `).get(hex, hex) as { n: number };
  let oldestApprovedAt: string | null = null;
  for (const l of sendLegs) oldestApprovedAt = earlier(oldestApprovedAt, l.authorized_at ?? l.created_at);

  // 5. On the way: their signed sends not in a block yet.
  const sendRows = db.prepare(`
    SELECT txid, state, wallet_id, order_ids_json, paying_lanoshis, created_at FROM lana_sends
    WHERE sender = 'financer' AND LOWER(owner_hex) = ? AND state IN ('announced', 'mempool')
    ORDER BY created_at, txid
  `).safeIntegers(true).all(hex) as Array<{ txid: string; state: string; wallet_id: string; order_ids_json: string; paying_lanoshis: bigint; created_at: string }>;
  const flyingLegs = sendRows.length === 0 ? [] : legsOf(`
    SELECT blo.id, blo.transaction_ref AS ref, blo.currency, blo.lana_amount AS lana, s.created_at
    FROM brain_lana_orders blo JOIN lana_sends s ON s.txid = blo.send_txid
    WHERE s.sender = 'financer' AND LOWER(s.owner_hex) = ? AND s.state IN ('announced', 'mempool')
  `, hex);
  const flyingTotals = totalsOf(flyingLegs);
  const sends: OverviewSend[] = sendRows.map(s => {
    let legs = 0;
    try { const ids = JSON.parse(s.order_ids_json); legs = Array.isArray(ids) ? ids.length : 0; } catch { legs = 0; }
    return { txid: s.txid, state: s.state, walletId: s.wallet_id, legs, lanoshis: String(s.paying_lanoshis), since: s.created_at };
  });
  const onTheWay = {
    ...flyingTotals,
    // A send is counted by its own record: the legs on it may have been released back already.
    legs: Math.max(flyingTotals.legs, sends.reduce((n, s) => n + s.legs, 0)),
    oldestAt: sends[0]?.since ?? flyingTotals.oldestAt,
    sends: sends.slice(0, SENDS_LISTED),
  };

  // Open legs whose investor leg names them, of purchases nobody owns yet.
  const unownedLegs = legsOf(`
    SELECT blo.id, blo.transaction_ref AS ref, blo.currency, blo.lana_amount AS lana, blo.created_at
    FROM brain_lana_orders blo
    WHERE blo.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM purchase_settlement ps WHERE ps.transaction_ref = blo.transaction_ref)
      AND EXISTS (SELECT 1 FROM brain_lana_orders x WHERE x.transaction_ref = blo.transaction_ref AND x.order_type = 'investor_lana'
                    AND x.status NOT IN ('cancelled', 'failed') AND LOWER(x.to_hex) = ?)
    ORDER BY blo.created_at, blo.id
  `, hex);

  const last = db.prepare(`
    SELECT txid, COALESCE(confirmed_at, updated_at) AS at FROM lana_sends
    WHERE sender = 'financer' AND LOWER(owner_hex) = ? AND state = 'confirmed'
    ORDER BY COALESCE(confirmed_at, updated_at) DESC, txid DESC LIMIT 1
  `).get(hex) as { txid: string; at: string | null } | undefined;

  return {
    waitingApproval: {
      ...waitingTotals,
      purchases: waitingTotals.purchases + withoutLegs.length,
      oldestAt: waitingOldest,
      withoutLegs: withoutLegs.length,
      waitingOn: null as WaitingPart[] | null,
      waitingOnPartial: false,
    },
    waitingRefs: waitingRefs.map(w => w.ref),
    toSend: {
      ...totalsOf(sendLegs),
      wallets: new Set(sendLegs.map(l => l.to_wallet).filter(Boolean)).size,
      oldestApprovedAt,
      ownerMismatch: Number(mismatch?.n ?? 0),
    },
    onTheWay,
    unowned: totalsOf(unownedLegs),
    lastConfirmedSend: last ? { txid: last.txid, at: last.at } : null,
  };
}

/** Every open leg nobody owns, and of them those with no investor leg naming a financer. Exported for tests. */
export function unownedOverview(db: Database.Database): FinancersOverview['unowned'] {
  const rows = db.prepare(`
    SELECT blo.id, blo.transaction_ref AS ref, blo.currency, blo.lana_amount AS lana, blo.created_at,
      EXISTS (SELECT 1 FROM brain_lana_orders x WHERE x.transaction_ref = blo.transaction_ref AND x.order_type = 'investor_lana'
                AND x.status NOT IN ('cancelled', 'failed') AND length(x.to_hex) = 64) AS named
    FROM brain_lana_orders blo
    WHERE blo.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM purchase_settlement ps WHERE ps.transaction_ref = blo.transaction_ref)
    ORDER BY blo.created_at, blo.id
  `).safeIntegers(true).all().map((r: any) => ({ ...r, lana: BigInt(r.lana ?? 0), named: Number(r.named) })) as Array<LegRow & { named: number }>;
  return { ...totalsOf(rows), withoutFinancer: totalsOf(rows.filter(r => !r.named)) };
}

/** Which purchases one unpaid-parts call asks about, oldest first, within its limits. Exported for tests. */
export function unpaidQuestion(refs: readonly string[]): { asked: string[]; partial: boolean } {
  const asked: string[] = [];
  let chars = 0;
  for (const r of refs) {
    if (!isUnpaidRef(r)) continue;
    const extra = encodeURIComponent(r).length + 1;
    if (asked.length + 1 > MAX_UNPAID_REFS || chars + extra > MAX_UNPAID_REFS_CHARS) break;
    asked.push(r);
    chars += extra;
  }
  return { asked, partial: asked.length < refs.length };
}

/** Stages 1 and 2 from Direct.Fund's batch list and what this database has. Exported for tests. */
export function dfStages(db: Database.Database, batches: readonly DfFinancerBatch[], held: ReadonlySet<string>) {
  const local = db.prepare('SELECT 1 FROM incoming_batches WHERE batch_ref = ?');
  const owner = db.prepare('SELECT 1 FROM purchase_settlement WHERE transaction_ref = ?');
  const legCounts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('cancelled', 'failed') THEN 1 ELSE 0 END) AS dead
    FROM brain_lana_orders WHERE transaction_ref = ?
  `);
  const pendingLegs = db.prepare(`
    SELECT id, transaction_ref AS ref, currency, lana_amount AS lana, created_at FROM brain_lana_orders
    WHERE transaction_ref = ? AND status = 'pending'
  `).safeIntegers(true);

  const stage = (list: Array<{ b: DfFinancerBatch; refs: string[]; at: string | null }>) => {
    const legs: LegRow[] = [];
    const refs = new Set<string>();
    let oldestAt: string | null = null;
    for (const { refs: rs, at } of list) {
      oldestAt = earlier(oldestAt, at);
      for (const ref of rs) {
        refs.add(ref);
        for (const r of pendingLegs.all(ref) as any[]) legs.push({ ...r, lana: BigInt(r.lana ?? 0) });
      }
    }
    const t = totalsOf(legs);
    return {
      ...t,
      purchases: refs.size,
      oldestAt,
      batches: list.map(({ b, refs: rs }): OverviewBatch => ({
        batchRef: b.batchRef, status: b.status, currency: b.currency, totalAmount: b.totalAmount, purchases: rs.length,
        createdAt: b.createdAt, closedAt: b.closedAt, paidAt: b.paidAt, held: held.has(b.batchRef),
      })),
    };
  };

  const toPay: Array<{ b: DfFinancerBatch; refs: string[]; at: string | null }> = [];
  const toConfirm: Array<{ b: DfFinancerBatch; refs: string[]; at: string | null }> = [];
  for (const b of batches) {
    const refs = [...new Set(b.transactionRefs)];
    if (b.status === 'open' || b.status === 'closed') {
      toPay.push({ b, refs, at: b.createdAt });
    } else if (b.status === 'paid') {
      if (local.get(b.batchRef)) continue; // confirmed here (by the financer, or received by the treasury)
      // Its purchases nobody owns here yet, apart from those whose every leg is cancelled or failed (finished).
      const open = refs.filter(ref => {
        if (owner.get(ref)) return false;
        const c = legCounts.get(ref) as { total: number; dead: number | null };
        return !(c.total > 0 && (c.dead || 0) === c.total);
      });
      if (open.length > 0) toConfirm.push({ b, refs: open, at: b.paidAt ?? b.createdAt });
    }
  }
  return { toPayOnDf: stage(toPay), toConfirm: stage(toConfirm) };
}

/** The whole overview. Never throws for Direct.Fund: an unanswered call is a flag. Exported for tests. */
export async function financersOverview(db: Database.Database, df: DfClientOptions, nowMs = Date.now()): Promise<FinancersOverview> {
  const hexes = financerCandidates(db);
  const names = namesOf(db, hexes);
  const held = heldBatches();
  const financers = await Promise.all(hexes.map(async (hex): Promise<FinancerOverview> => {
    const local = localOverview(db, hex);
    let f: DfFinancer | null = null;
    let batches: DfFinancerBatch[] | null = null;
    try {
      [f, batches] = await Promise.all([fetchFinancer(hex, df), fetchFinancerBatches(hex, df)]);
    } catch (err) {
      console.warn(`[admin-financers] Direct.Fund not asked about ${hex.slice(0, 12)}…: ${(err as any)?.message || err}`);
      f = null;
      batches = null;
    }
    const waitingApproval = { ...local.waitingApproval };
    if (local.waitingRefs.length > 0) {
      const { asked, partial } = unpaidQuestion(local.waitingRefs);
      if (asked.length > 0) {
        try {
          const parts = await fetchFinancerUnpaidParts(hex, asked, df);
          waitingApproval.waitingOn = parts.map(p => ({
            batchRef: p.batchRef, batchStatus: p.batchStatus, orderType: p.orderType, destinationType: p.destinationType,
            amount: p.amount, currency: p.currency, transactionRef: p.transactionRef,
          }));
          waitingApproval.waitingOnPartial = partial;
        } catch (err) {
          console.warn(`[admin-financers] unpaid parts of ${hex.slice(0, 12)}… not read: ${(err as any)?.message || err}`);
        }
      }
    }
    const dfOk = f !== null && batches !== null;
    const staged = dfOk ? dfStages(db, batches as DfFinancerBatch[], held) : null;
    return {
      hex,
      name: names.get(hex) ?? null,
      isFinancer: f ? f.isFinancer : null,
      dfUnavailable: !dfOk,
      wallets: f ? { ...f.wallets } : null,
      stages: {
        toPayOnDf: staged?.toPayOnDf ?? null,
        toConfirm: staged?.toConfirm ?? null,
        waitingApproval,
        toSend: local.toSend,
        onTheWay: local.onTheWay,
      },
      unowned: local.unowned,
      lastConfirmedSend: local.lastConfirmedSend,
    };
  }));
  return {
    generatedAt: new Date(nowMs).toISOString(),
    dfUnavailable: financers.some(f => f.dfUnavailable),
    financers,
    unowned: unownedOverview(db),
  };
}

export function createAdminFinancersRouter(deps: AdminFinancersDeps = {}): Router {
  const router = Router();
  const dbOf = deps.db ?? getDbHandle;
  const df = deps.df ?? {};
  router.get('/financers-overview', async (req: Request, res: Response) => {
    const adminHex = requireAdmin(req, res);
    if (!adminHex) return;
    try {
      return res.json(await financersOverview(dbOf(), df, deps.now ? deps.now() : Date.now()));
    } catch (err: any) {
      console.error(`[admin-financers] overview failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'The financers overview could not be read right now.', code: 'OVERVIEW_FAILED' });
    }
  });
  return router;
}

