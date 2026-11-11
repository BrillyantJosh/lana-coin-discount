/**
 * WHAT WENT OUT FOR EACH PURCHASE — the read behind POST /api/peer/fund/purchase-sends (routes/fundPeer.ts), for
 * direct.lana.fund's accounting (11 Nov 2026).
 *
 * Direct.Fund holds the money side of a purchase; the LANA side is here. For each purchase asked about — the brain's
 * transaction id, which is brain_lana_orders.transaction_ref — this answers:
 *   - settlement: who settles it (purchase_settlement) — 'treasury' (the Lana.Discount account) or 'financer', the
 *     owner, the batch it was confirmed with, when. null: nobody has confirmed it here, and nobody sends its legs;
 *   - legs: every LANA leg of it the brain posted (brain_lana_orders), whatever became of it — pending, sending, sent,
 *     cancelled, failed — exactly as stored;
 * and, under `sends`, every send this database recorded (lana_sends) that a leg names by send_txid or tx_hash: who
 * sent it, from which wallet, what it paid out in all and its fee, where it stands on the chain.
 * A purchase this database has never heard of is answered too: { settlement: null, legs: [] }.
 *
 * ONE ID ON BOTH SIDES. brain_lana_orders.id IS the brain's lana_orders.id: the brain posts its own row's id as
 * order_id (lana-brain server/lib/lanaDispatch.ts toRequest and server/lib/caretakerHold.ts, both order_id: lo.id) and
 * POST /api/brain/lana-order stores order_id as the id (routes/api.ts). transaction_ref is the brain's
 * transactions.id (tx_ref: lo.transaction_id). A leg here and a leg in the brain are the same row by id.
 *
 * A LEG'S TWO HASHES (lib/financer/sends.ts):
 *   - send_txid: the send that carries it, or carried it into a block. Set while the leg is 'sending', kept once it
 *     is 'sent'; cleared when that send was released (proven unable to move the money) and the leg is 'pending' again.
 *   - tx_hash: the transaction in the block that paid it, set when the leg is 'sent'. Normally its send's own txid.
 *     When a COPY of the send was mined instead — the same coins, outputs, nTime and locktime under other signatures,
 *     which anyone relaying it can make on this 2013-era chain — tx_hash is the copy's id, send_txid stays the
 *     recorded send's, and that send reads 'confirmed' with chain_txid = the copy's id. The copy is no row of its own.
 *   - Legs the treasury's old auto-send paid before lana_sends existed (October 2026) have a tx_hash and no
 *     send_txid, and no send here: nothing of those sends was recorded but the hash.
 *
 * A send can carry the legs of other purchases too: paying_lanoshis and fee_lanoshis are the whole send's.
 * Lanoshis (1 LANA = 100,000,000) as integers; times as stored, UTC 'YYYY-MM-DD HH:MM:SS'.
 *
 * Read-only, the three tables read in one read transaction (one snapshot). Never the signed bytes (raw_tx), the coins
 * spent (inputs_json), the legs a send carried (order_ids_json) or a leg's must-spend outpoints; no bank data (none of
 * these tables holds any).
 */
import type Database from 'better-sqlite3';
import { copyTxidOf } from './sends.js';

/** Most purchases one request may name. */
export const MAX_TX_REFS = 500;
/**
 * A purchase id: printable ASCII without spaces, 1–64 characters. The brain's are UUIDs (36). 500 of the longest
 * still fit the 50 kb every JSON body is held to (lib/jsonBodies.ts).
 */
const TX_REF_RE = /^[\x21-\x7e]{1,64}$/;
/** Ids per IN (…) list. */
const IN_CHUNK = 500;

export interface PurchaseSettlement {
  settled_by: 'treasury' | 'financer';
  /** The financer's hex; for the treasury, the financer of its batch, or '' where the one-off migration knew none. */
  owner_hex: string;
  batch_ref: string | null;
  /**
   * When the row was written: the confirmation. For a purchase the one-off migration gave the treasury
   * (db/financerSchema.ts backfillTreasurySettlements, Oct 2026), the day that migration ran.
   */
  created_at: string;
}

export interface PurchaseLeg {
  id: string;
  order_type: string;
  to_hex: string;
  to_wallet: string;
  lana_amount: number;
  fiat_value: number;
  currency: string;
  exchange_rate: number;
  status: string;
  tx_hash: string | null;
  send_txid: string | null;
  completed_at: string | null;
}

export interface PurchaseSend {
  sender: 'treasury' | 'financer';
  /** The financer who signed it; null for the treasury's. */
  owner_hex: string | null;
  wallet_id: string;
  /** What it paid to the legs' wallets, all of them (the change back to wallet_id not counted). */
  paying_lanoshis: number;
  fee_lanoshis: number;
  state: 'announced' | 'mempool' | 'confirmed' | 'released';
  block_height: number | null;
  confirmed_at: string | null;
  created_at: string;
  /**
   * Confirmed: the id the block holds this payment under — its own txid, or a copy's (above), which its legs'
   * tx_hash then carries too. null while it is not confirmed.
   */
  chain_txid: string | null;
}

export interface PurchaseSendsAnswer {
  checked_at: string;
  purchases: Record<string, { settlement: PurchaseSettlement | null; legs: PurchaseLeg[] }>;
  sends: Record<string, PurchaseSend>;
}

export type TxRefsRequest = { ok: true; refs: string[] } | { ok: false; error: string };

/** The body { tx_refs: string[1..500] }, each a purchase id; the refs once each, in the order asked. */
export function parsePurchaseSendsRequest(body: unknown): TxRefsRequest {
  const refs = body && typeof body === 'object' && !Array.isArray(body) ? (body as { tx_refs?: unknown }).tx_refs : undefined;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_TX_REFS) {
    return { ok: false, error: `tx_refs must be an array of 1 to ${MAX_TX_REFS} purchase ids` };
  }
  const bad = refs.findIndex(r => typeof r !== 'string' || !TX_REF_RE.test(r));
  if (bad >= 0) {
    return { ok: false, error: `tx_refs[${bad}] is not a purchase id (1 to 64 printable characters, no spaces)` };
  }
  return { ok: true, refs: [...new Set(refs as string[])] };
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

const marks = (n: number) => Array(n).fill('?').join(',');

/**
 * The purchases `refs` (parsePurchaseSendsRequest) and the sends their legs name. Reads only. Keyed through Maps and
 * Object.fromEntries, so a ref such as "__proto__" is a key like any other.
 */
export function readPurchaseSends(db: Database.Database, refs: string[], nowMs = Date.now()): PurchaseSendsAnswer {
  const read = db.transaction((): PurchaseSendsAnswer => {
    const purchases = new Map<string, { settlement: PurchaseSettlement | null; legs: PurchaseLeg[] }>();
    for (const ref of refs) purchases.set(ref, { settlement: null, legs: [] });

    for (const part of chunks(refs)) {
      const settled = db.prepare(`
        SELECT transaction_ref, settled_by, owner_hex, batch_ref, created_at
        FROM purchase_settlement WHERE transaction_ref IN (${marks(part.length)})
      `).all(...part) as Array<PurchaseSettlement & { transaction_ref: string }>;
      for (const { transaction_ref, ...s } of settled) {
        const p = purchases.get(transaction_ref);
        if (p) p.settlement = s;
      }
      const legs = db.prepare(`
        SELECT id, transaction_ref, order_type, to_hex, to_wallet, lana_amount, fiat_value, currency, exchange_rate,
               status, tx_hash, send_txid, completed_at
        FROM brain_lana_orders WHERE transaction_ref IN (${marks(part.length)})
        ORDER BY created_at, rowid
      `).all(...part) as Array<PurchaseLeg & { transaction_ref: string }>;
      for (const { transaction_ref, ...leg } of legs) purchases.get(transaction_ref)?.legs.push(leg);
    }

    // Every id a leg names: the send that carries or carried it, and the transaction that paid it when that differs.
    const txids = new Set<string>();
    for (const p of purchases.values()) {
      for (const l of p.legs) {
        if (l.send_txid) txids.add(l.send_txid);
        if (l.tx_hash) txids.add(l.tx_hash);
      }
    }
    const sends = new Map<string, PurchaseSend>();
    for (const part of chunks([...txids])) {
      const rows = db.prepare(`
        SELECT txid, sender, owner_hex, wallet_id, paying_lanoshis, fee_lanoshis, state, last_outcome, block_height,
               confirmed_at, created_at
        FROM lana_sends WHERE txid IN (${marks(part.length)})
      `).all(...part) as Array<Omit<PurchaseSend, 'chain_txid'> & { txid: string; last_outcome: string | null }>;
      for (const { txid, last_outcome, ...s } of rows) {
        sends.set(txid, { ...s, chain_txid: s.state === 'confirmed' ? (copyTxidOf({ state: s.state, last_outcome }) ?? txid) : null });
      }
    }
    return { checked_at: new Date(nowMs).toISOString(), purchases: Object.fromEntries(purchases), sends: Object.fromEntries(sends) };
  });
  return read();
}
