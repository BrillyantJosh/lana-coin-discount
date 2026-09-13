/**
 * MERGING A WALLET'S PIECES, SO ITS LANA CAN BE TRANSFERRED — the rules the
 * server applies before it signs anything.
 *
 * One transfer can spend at most 20 of a wallet's pieces (UTXOs). A seller
 * whose wallet holds more was told "Consolidate them with Registrar" and sent
 * away from lana.discount to do it. The owner, 13 Sept 2026: "V kolikor rabi
 * uporabnik prvo konsolidirat račun, naredi možnost konsolidacije kar na
 * Lana.discount … skopiraj rešitev iz MejmoSeFajn."
 *
 * WHAT IS COPIED, AND WHAT IS NOT. The planning — which pieces go together, and
 * never a batch that cannot pay its fee — is MejmoSeFajn's, unchanged, in
 * consolidationPlan.ts. Its server route trusted three things this one does
 * not, each of which has already cost somebody time elsewhere in the fleet:
 *
 *   the VALUES the page sends. MejmoSeFajn priced the transaction from the
 *     coin values in the request body. Here the page names the pieces only;
 *     their values come from the chain, so a stale or hand-made request can at
 *     worst be refused, never price its own fee.
 *
 *   that a listed piece is UNSPENT. electrum's listunspent is confirmed-only:
 *     after a merge is broadcast it keeps offering the pieces that merge has
 *     already spent, until a block confirms it. The registrar's consolidation
 *     was refused 33 times in a row for exactly that (29 Aug 2026, see
 *     ops_electrum_listunspent_confirmed_only). get_balance.unconfirmed is the
 *     only signal that sees a spend in flight.
 *
 *   that nothing else is MOVING. The registrar's answer to the above is to
 *     refuse whenever anything at all is unconfirmed. That is safe, and it
 *     would make a seller with 45 pieces wait a block between the first and
 *     the second merge. So the server remembers the merges IT broadcast
 *     (wallet_consolidations), and lets a further merge through when — and
 *     only when — those merges account for the whole of the unconfirmed
 *     figure to the lanoshi and the new merge touches none of their pieces.
 *     Any other unconfirmed movement, or a balance that cannot be read, is a
 *     refusal with a wait, exactly as on the registrar.
 *
 * Pure: chain readings and stored rows in, a verdict out. No electrum, no
 * database, no key — the route (routes/consolidation.ts) does the I/O.
 */
import { consolidationFee, MAX_INPUTS, MIN_INPUTS, MIN_NET } from './consolidationPlan.js';
import { BACKING_TOLERANCE_LANOSHIS } from './acquisitionBacking.js';

export const WALLET_CONSOLIDATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS wallet_consolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id TEXT NOT NULL,
    hex_id TEXT,
    txid TEXT NOT NULL UNIQUE,
    -- [{"tx_hash":…,"tx_pos":…,"value":…}] — the pieces this merge spent, with
    -- the values the CHAIN gave for them at signing time.
    inputs_json TEXT NOT NULL,
    input_count INTEGER NOT NULL,
    total_lanoshis INTEGER NOT NULL,
    fee_lanoshis INTEGER NOT NULL,
    net_lanoshis INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_consolidations_wallet ON wallet_consolidations(wallet_id, created_at);
`;

/**
 * How long a merge this server broadcast is still considered possibly in
 * flight. Blocks come every few minutes; this is only the outer bound on how
 * far back the table is read, never a reason on its own to hold a piece.
 */
export const PENDING_WINDOW_HOURS = 6;

/**
 * How long a merge just broadcast is held to be on its way even while the
 * balance shows nothing unconfirmed — electrum can take a moment to see it.
 */
export const JUST_SENT_SECONDS = 15 * 60;

export interface ChainUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export interface Outpoint {
  tx_hash: string;
  tx_pos: number;
}

export interface RecordedConsolidation {
  txid: string;
  inputs: ChainUtxo[] | Array<{ tx_hash: string; tx_pos: number; value: number }>;
  inputCount: number;
  totalLanoshis: number;
  feeLanoshis: number;
  netLanoshis: number;
  /** Unix seconds. */
  createdAt: number;
}

export type InFlight =
  /** Nothing unconfirmed in this wallet. */
  | 'none'
  /**
   * Only merges this server broadcast: they explain every lanoshi of the
   * unconfirmed figure, or one was sent minutes ago and nothing shows yet.
   */
  | 'ours'
  /** Something else is moving — or ours do not add up. Wait for a block. */
  | 'other'
  /** The balance could not be read, so nobody can say. */
  | 'unknown';

export interface WalletAssessment {
  /** Confirmed pieces no merge of ours is spending: what can be merged now. */
  available: ChainUtxo[];
  /** Pieces still waiting for their own confirmation (height ≤ 0). */
  confirming: ChainUtxo[];
  /** Merges of ours that are still on their way. */
  pending: RecordedConsolidation[];
  inFlight: InFlight;
  /** Every piece a pending merge of ours has spent, as "txhash:pos". */
  busy: Set<string>;
}

export const outpointKey = (u: Outpoint): string => `${String(u.tx_hash).toLowerCase()}:${Number(u.tx_pos)}`;

/**
 * Where this wallet stands. `unconfirmedLanoshis` is get_balance.unconfirmed,
 * or null when it could not be read.
 *
 * A merge of ours counts as still on its way while all three hold: it is
 * recent; its own output (vout 0 — a merge has exactly one) is not yet listed
 * as confirmed; and at least one piece it spent is still listed, which is what
 * a confirmed-only listunspent shows for a spend in flight.
 *
 * With NOTHING unconfirmed, only a merge from the last few minutes still
 * counts. Right after a broadcast the balance may simply not show it yet, and
 * offering its pieces again then would be the double press all over; but a
 * merge that has shown nothing unconfirmed for longer than that either
 * confirmed or never went in, and holding its pieces back for hours would only
 * hide coins that are really there.
 *
 * For one wallet, a merge moves its pieces back to itself, so the only change
 * it makes to the balance is its fee: get_balance.unconfirmed reads −fee. The
 * merges of ours explain the figure when their fees sum to exactly its
 * negative. If electrum reports it any other way, that simply fails to match
 * and the wallet reads 'other' — a wait, never a double spend.
 */
export function assessWallet(input: {
  chain: ChainUtxo[];
  unconfirmedLanoshis: number | null;
  recorded: RecordedConsolidation[];
  nowSeconds: number;
}): WalletAssessment {
  const chain = (input.chain || []).filter(u => u && typeof u.tx_hash === 'string' && Number.isFinite(u.value));
  const listed = new Set(chain.map(outpointKey));
  const confirmedTx = new Set(chain.filter(u => u.height > 0).map(u => String(u.tx_hash).toLowerCase()));
  const unconfirmed = input.unconfirmedLanoshis;

  const readable = unconfirmed !== null && Number.isFinite(unconfirmed);
  const candidates = (input.recorded || []).filter(r =>
    input.nowSeconds - r.createdAt <= PENDING_WINDOW_HOURS * 3600 &&
    !confirmedTx.has(String(r.txid).toLowerCase()) &&
    r.inputs.some(i => listed.has(outpointKey(i))) &&
    (!readable || unconfirmed !== 0 || input.nowSeconds - r.createdAt <= JUST_SENT_SECONDS));

  const busy = new Set(candidates.flatMap(r => r.inputs.map(outpointKey)));

  let inFlight: InFlight;
  if (!readable) inFlight = 'unknown';
  else if (unconfirmed === 0) inFlight = candidates.length > 0 ? 'ours' : 'none';
  else if (candidates.length > 0 && unconfirmed === -candidates.reduce((s, r) => s + r.feeLanoshis, 0)) inFlight = 'ours';
  else inFlight = 'other';

  return {
    available: chain.filter(u => u.height > 0 && !busy.has(outpointKey(u))),
    confirming: chain.filter(u => !(u.height > 0)),
    pending: candidates,
    inFlight,
    busy,
  };
}

export type ConsolidationDecision =
  | {
      ok: true;
      /** The pieces to spend, with the values the CHAIN gave — never the request's. */
      inputs: ChainUtxo[];
      totalLanoshis: number;
      feeLanoshis: number;
      netLanoshis: number;
    }
  | { ok: false; httpStatus: number; code: string; error: string };

const refuse = (httpStatus: number, code: string, error: string): ConsolidationDecision => ({ ok: false, httpStatus, code, error });

/**
 * HOW MUCH NETWORK FEE THIS WALLET CAN STILL SPEND ON CONSOLIDATING, while it
 * backs open offers — or null when nothing is promised out of it.
 *
 * A transfer is refused when the wallet holds more than
 * BACKING_TOLERANCE_LANOSHIS less than it promised (acquisitionBacking.ts, and
 * the sweep floor in transaction.ts reads the same constant). Fees spent on
 * consolidating come straight off the balance, so they may spend down to that
 * line and not a lanoshi past it. `balanceLanoshis` is get_balance's confirmed
 * plus unconfirmed, which already carries the fees of merges on their way.
 * An unreadable balance with an offer open leaves no room at all.
 */
export function feeRoomLanoshis(balanceLanoshis: number | null, committedLanoshis: number): number | null {
  if (!(committedLanoshis > 0)) return null;
  if (balanceLanoshis === null || !Number.isFinite(balanceLanoshis)) return 0;
  return Math.max(0, balanceLanoshis + BACKING_TOLERANCE_LANOSHIS - committedLanoshis);
}

/**
 * THE GATE BEFORE ANYTHING IS SIGNED: the wallet must be on the signed wallet
 * list of the account asking, and no freeze a sale would meet may stand.
 *
 * The first half is what MejmoSeFajn did not need and this route does: its
 * freeze check resolved from the address alone, while the freeze reading here
 * takes an account, and an account named in a request body is only a claim. A
 * key holder naming someone else's account would have been judged against a
 * list the wallet is not on — which reads as "no freeze here" (review, 13 Sept
 * 2026). So the wallet has to be on that account's own list first, the rule the
 * mandate path already applies (WALLET_NOT_OWNED), and an unreadable list is a
 * wait, never a pass.
 */
export function walletGateVerdict(input: {
  address: string;
  listedWallets: Array<{ walletId?: string }> | null;
  freeze: { blocked: boolean; code?: string; reason?: string };
}): { blocked: false } | { blocked: true; httpStatus: number; code: string; reason: string } {
  const listed = input.listedWallets || [];
  if (listed.length === 0) {
    return { blocked: true, httpStatus: 503, code: 'WALLET_OWNERSHIP_UNVERIFIABLE', reason: 'The wallet list of your account could not be read right now, so nothing was sent. Please try again shortly.' };
  }
  const own = listed.some(w => String(w.walletId || '').trim().toLowerCase() === input.address.trim().toLowerCase());
  if (!own) {
    return { blocked: true, httpStatus: 403, code: 'WALLET_NOT_OWNED', reason: 'This wallet is not on the signed wallet list of your account, so it cannot be consolidated here.' };
  }
  if (input.freeze.blocked) {
    return { blocked: true, httpStatus: 403, code: input.freeze.code || 'WALLET_FROZEN', reason: input.freeze.reason || 'This wallet is frozen.' };
  }
  return { blocked: false };
}

const lanaText = (lanoshis: number) => (lanoshis / 100_000_000).toFixed(8);

/**
 * May these pieces be merged now? The request names pieces by outpoint only;
 * anything it says about their value is ignored.
 */
export function decideConsolidation(
  requested: unknown,
  wallet: WalletAssessment,
  opts: { feeRoomLanoshis?: number | null } = {},
): ConsolidationDecision {
  if (!Array.isArray(requested)) return refuse(400, 'INVALID_INPUTS', 'Name the pieces to merge.');
  const outpoints: Outpoint[] = [];
  for (const r of requested) {
    const hash = String((r as any)?.tx_hash ?? '');
    const pos = (r as any)?.tx_pos;
    if (!/^[0-9a-fA-F]{64}$/.test(hash) || !Number.isInteger(pos) || pos < 0) {
      return refuse(400, 'INVALID_INPUTS', 'One of the pieces named is not a valid transaction output.');
    }
    outpoints.push({ tx_hash: hash, tx_pos: pos });
  }

  // A merge of ONE piece spends a fee to produce one piece: it removes nothing.
  if (outpoints.length < MIN_INPUTS) {
    return refuse(400, 'TOO_FEW_PIECES', `A merge needs at least ${MIN_INPUTS} pieces — merging one piece into one removes nothing and only costs a fee.`);
  }
  if (outpoints.length > MAX_INPUTS) {
    return refuse(400, 'TOO_MANY_PIECES', `One merge can carry at most ${MAX_INPUTS} pieces.`);
  }
  const keys = outpoints.map(outpointKey);
  if (new Set(keys).size !== keys.length) {
    return refuse(400, 'DUPLICATE_PIECES', 'The same piece is named twice.');
  }

  // Asked before the in-flight test, because it is the more exact answer: this
  // is the double press, or a page that has not yet heard about its own merge.
  if (keys.some(k => wallet.busy.has(k))) {
    return refuse(409, 'PIECES_ALREADY_MERGING', 'These pieces are already being merged by a transaction that has not confirmed yet. Nothing was sent again.');
  }

  if (wallet.inFlight === 'unknown') {
    return refuse(503, 'WALLET_UNREADABLE', 'The wallet could not be read right now, so nothing was sent. Please try again in a moment.');
  }
  if (wallet.inFlight === 'other') {
    return refuse(409, 'WALLET_HAS_PENDING_TRANSACTION', 'A transaction in this wallet is still waiting for the network to confirm it. Merging can start once it has — usually within a few minutes. Nothing was sent.');
  }

  const available = new Map(wallet.available.map(u => [outpointKey(u), u]));
  const inputs: ChainUtxo[] = [];
  for (const k of keys) {
    const u = available.get(k);
    if (!u) {
      return refuse(409, 'PIECES_NOT_SPENDABLE', 'Some of these pieces are no longer in the wallet, or have not been confirmed yet. Check the wallet again for an up-to-date list. Nothing was sent.');
    }
    inputs.push(u);
  }

  const totalLanoshis = inputs.reduce((s, u) => s + u.value, 0);
  const feeLanoshis = consolidationFee(inputs.length);
  const netLanoshis = totalLanoshis - feeLanoshis;
  if (netLanoshis < MIN_NET) {
    return refuse(422, 'MERGE_CANNOT_PAY_FEE', `These pieces hold ${lanaText(totalLanoshis)} LANA, less than the ${lanaText(feeLanoshis)} LANA network fee to merge them. Nothing was sent.`);
  }
  const room = opts.feeRoomLanoshis;
  if (room !== null && room !== undefined && feeLanoshis > room) {
    return refuse(409, 'MERGE_WOULD_UNDERCUT_OFFER', `This consolidation's network fee of ${lanaText(feeLanoshis)} LANA would leave the wallet short of what your open offer from it covers, and the transfer would then be refused. Nothing was sent.`);
  }
  return { ok: true, inputs, totalLanoshis, feeLanoshis, netLanoshis };
}

/**
 * What a broadcast answered. electrum resolves — it does not throw — with the
 * node's refusal as its result, and a python-2 server hands `-22` back as a
 * repr string. Only a 64-hex id is a transaction.
 */
export function broadcastOutcome(result: unknown): { ok: true; txid: string } | { ok: false; rejected: boolean; raw: string } {
  const raw = typeof result === 'string' ? result.trim() : JSON.stringify(result ?? null);
  if (typeof result === 'string' && /^[0-9a-fA-F]{64}$/.test(raw)) return { ok: true, txid: raw.toLowerCase() };
  return { ok: false, rejected: /TX rejected|-22/.test(raw), raw };
}

/** A stored row as the assessment wants it. */
export function rowToRecorded(row: any): RecordedConsolidation {
  let inputs: RecordedConsolidation['inputs'] = [];
  try {
    const parsed = JSON.parse(String(row.inputs_json || '[]'));
    if (Array.isArray(parsed)) inputs = parsed;
  } catch { /* an unreadable row holds nothing back */ }
  const created = Date.parse(String(row.created_at || '').replace(' ', 'T') + 'Z');
  return {
    txid: String(row.txid),
    inputs,
    inputCount: Number(row.input_count) || inputs.length,
    totalLanoshis: Number(row.total_lanoshis) || 0,
    feeLanoshis: Number(row.fee_lanoshis) || 0,
    netLanoshis: Number(row.net_lanoshis) || 0,
    createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
  };
}
