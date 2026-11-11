/**
 * WHAT WENT OUT FOR EACH PURCHASE — the read behind POST /api/peer/fund/purchase-sends (routes/fundPeer.ts), for
 * direct.lana.fund's accounting (11 Nov 2026).
 *
 * Direct.Fund holds the money side of a purchase; the LANA side is here. For each purchase asked about — the brain's
 * transaction id, which is brain_lana_orders.transaction_ref — this answers:
 *   - settlement: who settles it (purchase_settlement) — 'treasury' (the Lana.Discount account) or 'financer', the
 *     owner, the batch it was confirmed with, when. null: nobody has confirmed it here, and nobody sends its legs;
 *   - legs: every LANA leg of it the brain posted (brain_lana_orders), whatever became of it — pending, sending, sent,
 *     cancelled, failed — exactly as stored, but for a customer_cashback leg's to_hex and to_wallet: null, the
 *     customer's key and wallet are not given out (review of 11 Nov 2026; the brain's POST /api/fund/financer-purchases
 *     blanks the same two, and Direct.Fund's accounting books no leg by them);
 * and, under `sends`, every send this database recorded (lana_sends) that a leg names by send_txid or tx_hash: who
 * sent it, from which wallet and that wallet's key (key_wallets, below), what it paid out in all and its fee, where it
 * stands on the chain.
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
 * ONE KEY, TWO WALLETS. A private key has two LANA addresses: one from its 65-byte uncompressed public key, one from
 * its 33-byte compressed key. The treasury sends from either — the uncompressed one while it lists coins, else the
 * compressed one (lib/treasuryAutoSend.ts, the manual send in routes/api.ts) — and wallet_id is the one it used. The
 * registrar may know only one of them, and Direct.Fund books a treasury send whose wallet is registered to nobody as a
 * LANA loan from an unknown owner (review of 11 Nov 2026). So every send also names key_wallets: wallet_id first, then
 * both addresses of each key that signed one of its inputs, read from its recorded signed bytes, each once. Whose LANA
 * a send paid is asked of the registrar for each of them.
 *
 * Read-only, the three tables read in one read transaction (one snapshot). Never the signed bytes (raw_tx: read only
 * for key_wallets), the coins spent (inputs_json), the legs a send carried (order_ids_json) or a leg's must-spend
 * outpoints; no bank data (none of these tables holds any).
 */
import type Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { decodeTx, parseP2pkhScriptSig } from '../../shared/lana-tx/codec.js';
import { addressOfPublicKey } from '../../shared/lana-tx/address.js';
import { bytesToHex } from '../../shared/lana-tx/bytes.js';
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
  /** null for a customer_cashback leg: the customer's key is not given out. */
  to_hex: string | null;
  /** null for a customer_cashback leg: the customer's wallet is not given out. */
  to_wallet: string | null;
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
  /** The address it spent from. */
  wallet_id: string;
  /**
   * wallet_id, then both addresses (uncompressed, compressed) of each key that signed one of its inputs, each once:
   * normally wallet_id and its key's other address (ONE KEY, TWO WALLETS above). Only wallet_id when the signed bytes
   * name no public key that reads.
   */
  key_wallets: string[];
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
 * key_wallets of one send (ONE KEY, TWO WALLETS above): wallet_id, then both addresses of each public key its inputs
 * reveal. An input without one (a pay-to-public-key coin is unlocked by a signature alone) adds nothing; bytes that do
 * not decode, or a key that is no point on the curve, leave wallet_id alone. `forms` keeps each key's two addresses for
 * the rest of one read: every input of every treasury send is one key to work out.
 */
function keyWalletsOf(rawTx: string, walletId: string, forms: Map<string, string[]>): string[] {
  const out = new Set<string>([walletId]);
  let inputs: Array<{ scriptSigHex: string }>;
  try {
    inputs = decodeTx(rawTx).inputs;
  } catch {
    return [...out];
  }
  for (const input of inputs) {
    const sig = parseP2pkhScriptSig(input.scriptSigHex);
    if (!sig) continue;
    const key = bytesToHex(sig.publicKey);
    let both = forms.get(key);
    if (!both) {
      try {
        const point = secp256k1.Point.fromBytes(sig.publicKey);
        both = [addressOfPublicKey(point.toBytes(false)), addressOfPublicKey(point.toBytes(true))];
      } catch {
        both = [];
      }
      forms.set(key, both);
    }
    for (const address of both) out.add(address);
  }
  return [...out];
}

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
      // The cashback leg's key and wallet are the customer's: blanked here, in the SELECT.
      const legs = db.prepare(`
        SELECT id, transaction_ref, order_type,
               CASE WHEN order_type = 'customer_cashback' THEN NULL ELSE to_hex END AS to_hex,
               CASE WHEN order_type = 'customer_cashback' THEN NULL ELSE to_wallet END AS to_wallet,
               lana_amount, fiat_value, currency, exchange_rate, status, tx_hash, send_txid, completed_at
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
    const forms = new Map<string, string[]>();
    for (const part of chunks([...txids])) {
      const rows = db.prepare(`
        SELECT txid, sender, owner_hex, wallet_id, raw_tx, paying_lanoshis, fee_lanoshis, state, last_outcome, block_height,
               confirmed_at, created_at
        FROM lana_sends WHERE txid IN (${marks(part.length)})
      `).all(...part) as Array<Omit<PurchaseSend, 'chain_txid' | 'key_wallets'> & { txid: string; raw_tx: string; last_outcome: string | null }>;
      for (const { txid, raw_tx, last_outcome, ...s } of rows) {
        sends.set(txid, {
          ...s,
          key_wallets: keyWalletsOf(raw_tx, s.wallet_id, forms),
          chain_txid: s.state === 'confirmed' ? (copyTxidOf({ state: s.state, last_outcome }) ?? txid) : null,
        });
      }
    }
    return { checked_at: new Date(nowMs).toISOString(), purchases: Object.fromEntries(purchases), sends: Object.fromEntries(sends) };
  });
  return read();
}
