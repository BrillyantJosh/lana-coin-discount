/**
 * SENDING A PURCHASE'S LANA — the financer's own sends (signed in their
 * browser) and the treasury's (auto-send, manual send) — recorded BEFORE they
 * are broadcast, and finished by one round once the chain has them.
 *
 * Owner, 8 Oct 2026: "Podpis v brskalniku. Financer podpiše z WIF svoje
 * Lana.Discount denarnice. Ključ nikoli ne pride do nas; strežnik transakcijo
 * samo odda in preveri na verigi." And: "Financer plača vse, tudi vračilo
 * kupcu." A financer pays every leg of the purchases they confirmed on
 * /financer — the purchase, the caretaker, the commissions, the customer's
 * cashback and their own budget's investor_lana — from their own Lana.Discount
 * wallet. Krog Menjave's server/lib/payouts.ts (origin/main a46f618) is the
 * template: the same checks at announce, the same broadcast, the same round.
 *
 * ONE LEG, ONE SENDER, ONE TRANSACTION THAT CAN CONFIRM. Until now the treasury
 * marked its legs 'sent' the moment a broadcast answered with a txid, and when
 * the answer did not come in time — while the network HAD taken the
 * transaction (13 Sept 2026: a slow yes cut off after 8 s) — the legs stayed
 * 'pending' and the next cycle built a NEW transaction with other coins for
 * the same recipients. Both could confirm. So now, for both senders:
 *   1. the signed bytes are checked and RECORDED first (lana_sends, state
 *      'announced'), each of their legs moved 'pending' → 'sending' with the
 *      txid, in ONE immediate database transaction where every leg's UPDATE
 *      must change exactly one row — a leg cancelled, redirected or taken by
 *      another send meanwhile rolls the whole send back, and nothing is sent;
 *   2. only then broadcast, to every Electrum server at once (payoutChain.ts);
 *   3. a 'sending' leg is never picked again by anybody: no selection reads it,
 *      and the brain's cancel, redirect and fix-wallet refuse it (409);
 *   4. the round (every heartbeat) finishes it from the CHAIN, never from a
 *      broadcast's answer: the two-server merkle proof (chainPayment.ts) —
 *      legs 'sent' with the hash, lana-sent to the brain through the outbox
 *      with exactly the legs this transaction paid, then the batches it
 *      finished are closed. Not confirmed yet: the SAME bytes again, after 2,
 *      4, 8 … 30 minutes, for a day. A leg is 'sent' when it is in a block, not
 *      when a server said "yes".
 *
 * RELEASE — the only way a leg goes back to 'pending' — needs proof that this
 * transaction did not and will not move the money:
 *   - 'input_spent': no server holds it (every one said so, or every one that
 *     answered while the rest were silent), the wallet's history does not hold
 *     it, and a coin it spends is gone from the wallet's confirmed coins —
 *     spent by ANOTHER transaction: found in the wallet's history, proven in a
 *     block by the two-server proof, and no copy of this one (below). It can
 *     never confirm;
 *   - 'refused': every server refused it in words and then every one said it
 *     does not know it (payoutChain.ts "final") — at its very first broadcast,
 *     or REFUSALS_TO_RELEASE times in a row after that (Krog Menjave's rule:
 *     released on one refusal while a server was silent, it confirmed later).
 *     A final refusal is strong, not certain: a node nobody asked may still
 *     hold the bytes. So every leg it carried gets must_spend_json — the
 *     outpoints the NEXT send of that leg must spend at least one of. Two sends
 *     spending one coin can never both confirm. A leg released again keeps
 *     only the outpoints the new send shares with the old set (never empty),
 *     so every later send conflicts with EVERY earlier one, not just the last.
 *     The requirement lapses once one of those outpoints is spent by another
 *     transaction proven in a block that is no copy of those sends (none of
 *     them can confirm then) — a coinstake of the desktop wallet included —
 *     and a lapse once proven is cleared from the leg, never proven again; a
 *     refused send that turns up on the chain after all — itself or a copy —
 *     is still watched for a week and booked, never paid a second time
 *     unseen. The set belongs to the wallet whose coins it names (the refused
 *     send's): sent from another wallet, those legs wait
 *     (MUST_SPEND_OTHER_WALLET; the treasury's auto-sender defers just them)
 *     until the coins are spent there or the send comes from that wallet
 *     again — a send from another wallet shares no coin with the refused one,
 *     and both could confirm.
 * A COPY IS THE SAME PAYMENT (review of 8 Oct 2026). The LANA node is a
 * 2013-era client, from before the low-S and minimal-push rules: anyone who
 * relays a send can flip S to N−S in a signature, or push it another way, with
 * no key — another txid for the very same coins, outputs, nTime and locktime.
 * If the copy is mined, the send's own id is in no block and its coins read as
 * "spent by another transaction"; released then, its legs would go out a
 * second time. So a send whose coins a copy spent is booked under the COPY's
 * id once the copy is proven in a block (legs 'sent' with its hash, lana-sent
 * with its hash), and never released; its own bytes are not sent again while
 * the copy waits in a mempool.
 * Anything else stays as it is: a send unconfirmed after a day that nothing
 * proves dead — its coins unspent, or who spent them unknown or unproven — is
 * flagged for a person (heartbeat-status), never released.
 *
 * ONE SEND PER WALLET AT A TIME, the financer's. A prepare is refused while
 * anything out of the wallet waits to confirm (its unconfirmed balance is not 0,
 * or a send of it is announced/mempool): listunspent keeps listing a coin an
 * unconfirmed transaction already spends (the Lana8Wonder double cash-out,
 * 12 Sept 2026). The treasury's wallet is shared with other services, so its
 * own rule stays: coins spent by its own sends on their way are left out.
 *
 * ONE WALLET PER CURRENCY (owner, 9 Oct 2026). A financer chooses a Lana.Discount
 * wallet on Direct.Fund for each currency of their budgets (EUR, GBP …), and a
 * purchase's LANA go from the wallet of ITS currency — the currency of its legs
 * here (purchaseCurrencySql; a purchase whose legs carry none, or not one and
 * the same, is sent from no wallet: CURRENCY_UNKNOWN). One send carries
 * purchases of one currency (MIXED_CURRENCY), from Direct.Fund's wallet for it
 * (dfClient.ts walletFor; none chosen: NO_WALLET), and every check below runs
 * against that wallet: a GBP purchase is never announced from the EUR wallet.
 * The round keeps sending each send from its own recorded wallet.
 *
 * WHAT IS CHECKED AT A FINANCER'S ANNOUNCE, before anything is stored:
 *   - the bytes are one transaction, its id computed here; the same id again
 *     answers with the send as it stands (a double click, a lost answer);
 *   - the legs as the database holds them NOW: the signer's, authorised,
 *     pending, in no other send, whole purchases; their amounts and wallets
 *     are the allocations (a redirect between prepare and announce is caught);
 *     no purchase whose investor leg now pays ANOTHER financer (a brain
 *     redirect after the confirm: OWNER_MISMATCH — never sendable here);
 *   - one currency for all of its purchases, and the wallet Direct.Fund names
 *     for it, again at the Registrar (registered, Lana.Discount, this
 *     financer's, not frozen — registrarWallet.ts);
 *   - every coin it spends is a confirmed coin of that wallet now, read from
 *     its own previous transaction fetched and re-hashed here;
 *   - checkPayoutTx (shared/lana-tx/payout.ts), the very rule the browser
 *     signed by, with LEG_LANOSHI_STEP (the brain's legs are whole lanoshis):
 *     outputs exactly the legs merged per wallet, then at most one change back;
 *     ≤ 20 inputs, ≤ 98 wallets, every output ≥ 500,000 lanoshis, the fleet's
 *     fee, nTime from the server's clock, every input signed by the wallet;
 *   - a leg's must_spend_json, when it still binds.
 * Before every broadcast again the Registrar is asked again: a financer's send
 * that waited hours must not go from a wallet frozen or re-typed meanwhile.
 *
 * NOTHING PERSONAL, NO KEY. lana_sends holds the signed transaction (public the
 * moment it is sent), the wallet, the legs' ids and the financer's hex.
 */
import type Database from 'better-sqlite3';
import { decodeTx, encodeTxHex, outpointKey, txidOfRaw, type LanaTx } from '../../shared/lana-tx/codec.js';
import { prevoutFromRawTx, type Prevout } from '../../shared/lana-tx/shape.js';
import { checkPayoutTx, MAX_TX_BYTES, payoutMaxFee, planPayout } from '../../shared/lana-tx/payout.js';
import { INPUT_FEE_LANOSHIS, verifiedCoins, type Coin, type ListedCoin } from '../../shared/lana-tx/select.js';
import { DUST_LANOSHIS, feeFor, MAX_INPUTS } from '../../shared/lana-tx/fee.js';
import { LEG_LANOSHI_STEP, MAX_PAY_OUTPUTS, type Allocation } from '../../shared/lana-tx/payments.js';
import { addressOfScript, hash160ToAddress, p2pkHash160 } from '../../shared/lana-tx/address.js';
import { createPayoutChain, type BroadcastOutcome, type PayoutChain, type WalletState } from './payoutChain.js';
import { createPaymentReader, type PaymentReader } from './chainPayment.js';
import { electrumServersFrom } from './electrumSession.js';
import { enqueue, sqlTime } from './brainOutbox.js';
import { currencyCode, fetchFinancer, dfHttpStatus, type DfClientOptions, type DfFinancer } from './dfClient.js';
import { checkFinancerWallet, type FinancerWalletCheck } from './registrarWallet.js';
import { settleBatchesWithSentLana } from '../batchSettlement.js';
import { tryAcquireSendLock, releaseSendLock } from '../sendLock.js';
import { getDbHandle, getElectrumServersFromDb } from '../../db/index.js';

/** Sent again after 2, 4, 8 … minutes, at most every 30, and for at most a day. */
export const REBROADCAST_FIRST_S = 120;
export const REBROADCAST_MAX_S = 30 * 60;
export const REBROADCAST_FOR_S = 24 * 60 * 60;
/** A final refusal this many times in a row (after the first broadcast): it is in no mempool anyone can see. */
export const REFUSALS_TO_RELEASE = 5;
/** A send refused and released is still looked for on the chain this long, at most this often. */
export const WATCH_RELEASED_FOR_S = 7 * 24 * 60 * 60;
const WATCH_RELEASED_EVERY_S = 10 * 60;
/** A send older than a day is looked at this often (it is no longer sent again). */
const STUCK_EVERY_S = 10 * 60;
/** Legs one prepare or announce may name. 98 wallets × a few purchases each. */
export const MAX_ORDER_IDS = 400;
/** Coins worth spending listed for the browser at most, largest first (20 is the most one send spends). */
export const MAX_COINS_LISTED = 40;
/** The newest sends listed. */
export const SENDS_LISTED = 50;

/** The history looked through, at most, for what spent a coin of a send — newest first; beyond it: "not known". */
export const MAX_SPENDER_LOOKUPS = 1000;
/**
 * Confirmations a transaction that spent a coin of ours needs before it is proof — before a send is released on it
 * ('input_spent') or a must-spend set lapses (recheck of 9. 10. 2026, M1). A coinstake is the one spender that does
 * not come back when its block is orphaned: it vanishes and the coin is unspent again — on a 1-confirmation proof a
 * lapse was final, a set no longer bound, and the refused send could still confirm beside the new one. Below it the
 * call is judged as still binding and nothing is stored.
 */
export const MIN_SPENDER_DEPTH = 10;
/** History entries read per round trip while looking. */
const SPENDER_CHUNK = 120;
/** Transactions whose spent coins are kept in memory (a transaction never changes); past it, read again. */
const MAX_SPENDS_KEPT = 50_000;

export const STUCK_OUTCOME = 'STUCK';
/** A send confirmed under the id of a copy of it (other signatures): last_outcome starts so, the copy's id follows. */
export const COPY_OUTCOME = 'confirmed as copy ';
const FINAL_REFUSAL = /^refused-final#(\d+)/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const TXID = /^[0-9a-f]{64}$/;

export type SendState = 'announced' | 'mempool' | 'confirmed' | 'released';
export type Sender = 'treasury' | 'financer';

interface SendRow {
  txid: string;
  sender: Sender;
  owner_hex: string | null;
  wallet_id: string;
  raw_tx: string;
  order_ids_json: string;
  inputs_json: string;
  paying_lanoshis: number;
  fee_lanoshis: number;
  state: SendState;
  broadcasts: number;
  next_broadcast_at: string | null;
  last_outcome: string | null;
  release_reason: string | null;
  block_height: number | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegRow {
  id: string;
  transaction_ref: string | null;
  order_type: string;
  to_wallet: string;
  to_hex: string;
  lana_amount: number;
  status: string;
  brain_authorized: number | null;
  send_txid: string | null;
  must_spend_json: string | null;
  batch_ref: string | null;
  created_at: string | null;
  /** The currency of the leg's PURCHASE (purchaseCurrencySql) — read with the legs a send may carry; null: not known. */
  purchase_currency?: string | null;
}

/** One send as the pages and the admin see it. Lanoshis as decimal text. */
export interface SendView {
  txid: string;
  sender: Sender;
  state: SendState;
  wallet: string;
  orderIds: string[];
  transactionRefs: string[];
  payingLanoshis: string;
  feeLanoshis: string;
  broadcasts: number;
  lastOutcome: string | null;
  nextBroadcastAt: string | null;
  releaseReason: string | null;
  blockHeight: number | null;
  confirmedAt: string | null;
  createdAt: string;
  /** Unconfirmed for more than a day and nothing proves it cannot confirm: a person has to look. */
  stuck: boolean;
  /**
   * The transaction on the chain that paid its legs: its own id — or, confirmed as a copy of it (the same payment
   * under other signatures), the copy's. The one to link to an explorer.
   */
  chainTxid: string;
}

export interface SendableLeg {
  orderId: string;
  orderType: string;
  toWallet: string;
  toHex: string;
  lanoshis: string;
  /** A send of this leg was refused earlier: the next one must spend one of its coins. */
  mustSpend: boolean;
}

export interface SendablePurchase {
  transactionRef: string;
  batchRef: string | null;
  legs: SendableLeg[];
  lanoshis: string;
  /** Distinct wallets its legs pay. */
  wallets: number;
  /** Sent on its own, a wallet of it would get less than 0.005 LANA: it waits for another purchase to that wallet. */
  belowDustAlone: boolean;
}

export interface SendableAnswer {
  /** The currency these purchases are in, and whose wallet is read; null: the financer has none yet (nothing to send). */
  currency: string | null;
  /** The financer's wallet for that currency, as Direct.Fund names it now. */
  wallet: string | null;
  /** Why there is no wallet to read: none chosen on Direct.Fund (for this currency), or Direct.Fund could not be asked. */
  walletProblem: 'NO_WALLET' | 'DF_UNAVAILABLE' | null;
  balance: { confirmed: string; unconfirmed: string } | null;
  purchases: SendablePurchase[];
  totalLanoshis: string;
  legCount: number;
  wallets: number;
  /** The least the wallet lacks to send ALL of them in one go (one coin, no change); 0 when the balance may cover it. */
  shortfallLanoshis: string;
  /** This financer's sends from that wallet still on their way. */
  inFlight: SendView[];
  /** maxLegs: the legs one prepare or announce may name (MAX_ORDER_IDS) — more is refused BAD_ORDER_IDS. */
  limits: { maxWallets: number; maxLegs: number; maxInputs: number; dustLanoshis: string; stepLanoshis: string };
}

export interface PreparedAllocationOut {
  wallet: string;
  lanoshis: string;
  orderIds: string[];
}

export interface PrepareAnswer {
  /** The currency of these purchases: the send goes from the financer's wallet for it. */
  currency: string;
  wallet: string;
  /** The server's clock, seconds UTC — the send's nTime (src/lib/financer/payoutView.ts serverNowSec). */
  nowSec: number;
  balance: { confirmed: string; unconfirmed: string };
  coins: { txid: string; vout: number; value: string; height: number; rawTx: string }[];
  skipped: { count: number; value: string };
  unlisted: { count: number; value: string };
  allocations: PreparedAllocationOut[];
  legs: (SendableLeg & { transactionRef: string })[];
  payingLanoshis: string;
  /** The highest fee a send to these wallets may pay (lanoshis): 20 inputs, change, a remainder under dust. */
  maxFee: string;
  /** Outpoints ("txid:vout") the send must spend at least one of, per earlier refused send; [] when none binds. */
  mustSpend: string[][];
  limits: SendableAnswer['limits'];
}

/** A refusal: an HTTP status, a code the page words (src/copy.ts), English for the log, and what it is about. */
export interface SendRefusal {
  ok: false;
  status: number;
  code: string;
  error: string;
  [extra: string]: unknown;
}
export type SendOutcome<T extends object> = ({ ok: true } & T) | SendRefusal;

const refusal = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): SendRefusal => ({ ok: false, status, code, error, ...extra });

/** Thrown inside a database transaction: everything it wrote is undone. */
class Refused extends Error {
  constructor(readonly refusal: SendRefusal) {
    super(refusal.error);
  }
}

export interface SendsDeps {
  db: Database.Database;
  /** The wallets' coins, raw transactions, and the network. */
  chain: PayoutChain;
  /** The two-server proof that a transaction is in a block. */
  payments: PaymentReader;
  /** Direct.Fund's word on a financer, FRESH (dfClient.ts fetchFinancer). */
  financer: (hex: string) => Promise<DfFinancer>;
  /** The Registrar's strict check of a financer's wallet (registrarWallet.ts), fail closed. */
  checkWallet: (walletId: string, ownerHex: string) => Promise<FinancerWalletCheck>;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  log?: (line: string) => void;
  /** Batches whose legs all left, closed (batchSettlement.ts) — after every confirmation. */
  settle?: () => void;
}

export interface TreasuryRecord {
  rawTx: string;
  /** The treasury address the inputs spend (BUYBACK_WIF's). */
  wallet: string;
  orders: ReadonlyArray<{ id: string; to_wallet: string; lana_amount: number }>;
  feeLanoshis: number;
}

export interface TreasuryCoinRules {
  /** "txid:vout" of the treasury's own sends on their way: never selected again. */
  inFlight: Set<string>;
  /** Coins that MUST be among the inputs (one per still-binding must_spend set). */
  forced: string[];
  /** Legs that must wait: a refused send of theirs is on the chain after all (mempool or block), itself or a copy. */
  blockedOrderIds: string[];
  /**
   * Legs that wait this cycle, their must_spend as it is: every coin their set offers is on the caller's `avoid` list
   * (the -22 blacklist), or in a treasury send on its way, or no confirmed coin now — or their set binds in the OTHER
   * treasury address (the refused send went out of it). Only with `avoid` given — without it, such a set is refused
   * (MUST_SPEND_UNMET, MUST_SPEND_OTHER_WALLET).
   */
  deferredOrderIds: string[];
}

export interface RoundResult {
  confirmed: string[];
  released: string[];
  sent: string[];
  held: string[];
  stuck: string[];
  lateConfirmed: string[];
  skipped?: 'BUSY';
  treasurySkipped?: boolean;
}

export interface Sends {
  /**
   * The signer's purchases of one currency that may go now, against the wallet of that currency. Without a currency:
   * the one their purchases to send or on their way are in — in more than one, refused CURRENCY_REQUIRED (with them).
   */
  sendable(owner: string, currency?: unknown): Promise<SendOutcome<{ body: SendableAnswer }>>;
  prepare(owner: string, orderIds: unknown): Promise<SendOutcome<{ body: PrepareAnswer }>>;
  announce(owner: string, body: unknown): Promise<SendOutcome<{ send: SendView; already: boolean }>>;
  list(owner: string): SendView[];
  view(txid: string): SendView | null;
  /**
   * The treasury's coin rules for this selection: its sends' coins on their way, and must-spend. `avoid`: coins not to
   * force (the auto-sender's -22 blacklist) — given, a set it leaves nothing of, or one binding in the other treasury
   * address, defers its legs (deferredOrderIds) instead of refusing the whole selection.
   */
  treasuryCoinRules(wallet: string, orders: ReadonlyArray<{ id: string; must_spend_json?: string | null }>, avoid?: ReadonlySet<string>): Promise<{ ok: true; rules: TreasuryCoinRules } | SendRefusal>;
  /** A treasury transaction signed by buildSignedTx, recorded with its legs 'sending' — or refused, nothing written. */
  recordTreasurySend(r: TreasuryRecord): Promise<{ ok: true; txid: string } | SendRefusal>;
  /** Broadcast a recorded send now and keep what the network said. */
  broadcastRecorded(txid: string): Promise<BroadcastOutcome | null>;
  /** One round over every send on its way. Never throws. */
  round(): Promise<RoundResult>;
}

// ─── small readers ────────────────────────────────────────────────────────

const parseSqlTime = (s: string | null | undefined): number => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : Number.NaN);
const jsonList = (s: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const lanoshisOf = (leg: Pick<LegRow, 'lana_amount'>): bigint => {
  const v = Number(leg.lana_amount);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`leg amount ${String(leg.lana_amount)} is not a positive whole number of lanoshis`);
  return BigInt(v);
};
const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** The canonical order of legs: the same in prepare, in announce and in what the browser signs. */
const LEG_ORDER = 'ORDER BY blo.created_at, blo.transaction_ref, blo.id';

/**
 * The allocations of these legs, merged per wallet where that wallet first appears — the order and the sums
 * shared/lana-tx/payments.ts paymentsOf gives the outputs, so what the browser signs from the merged list and what
 * the server checks from the legs are the same outputs.
 */
export function mergedAllocations(legs: ReadonlyArray<Pick<LegRow, 'id' | 'to_wallet' | 'lana_amount'>>): PreparedAllocationOut[] {
  const by = new Map<string, { lanoshis: bigint; orderIds: string[] }>();
  for (const l of legs) {
    const a = by.get(l.to_wallet);
    if (a) {
      a.lanoshis += lanoshisOf(l);
      a.orderIds.push(l.id);
    } else by.set(l.to_wallet, { lanoshis: lanoshisOf(l), orderIds: [l.id] });
  }
  return [...by].map(([wallet, a]) => ({ wallet, lanoshis: a.lanoshis.toString(), orderIds: a.orderIds }));
}

const perLegAllocations = (legs: ReadonlyArray<Pick<LegRow, 'to_wallet' | 'lana_amount'>>): Allocation[] => legs.map(l => ({ address: l.to_wallet, lanoshis: lanoshisOf(l) }));

/** "txid:vout" of every input of a raw transaction. */
export function inputsOf(raw: string): string[] {
  return decodeTx(raw).inputs.map(i => outpointKey(i.prevTxid, i.vout));
}

/**
 * The outpoints the next send of a leg must spend, after a send spending `inputs` was refused and released: what it
 * shares with the leg's earlier set (so it conflicts with every earlier send too), or, with nothing shared or no
 * earlier set, all of `inputs`.
 */
export function nextMustSpend(earlier: string | null, inputs: readonly string[]): string[] {
  const before = jsonList(earlier);
  const shared = before.filter(o => inputs.includes(o));
  return shared.length > 0 ? shared : [...inputs];
}

/**
 * A transaction with every signature script blanked: what its signatures cover. Two transactions alike so are the same
 * payment — the same version, nTime, coins and sequences, outputs and locktime — whatever their ids: what anyone can
 * change in a relayed transaction without a key (S → N−S, another push of the same signature) is what is blanked here.
 */
export function unsignedFormOf(raw: string): string {
  const tx = decodeTx(raw);
  return encodeTxHex({ ...tx, inputs: tx.inputs.map(i => ({ ...i, scriptSigHex: '' })) });
}

/** Is `raw` the payment `of` is, under other signatures (or the very same bytes)? Either unreadable: no. */
export function isCopyOf(raw: string, of: string): boolean {
  try {
    return unsignedFormOf(raw) === unsignedFormOf(of);
  } catch {
    return false;
  }
}

const confirmedKeys = (state: Pick<WalletState, 'unspent'>): Set<string> => new Set(state.unspent.filter(c => c.height > 0).map(c => outpointKey(c.txid, c.vout)));

/** What only the chain can say about the refused sends of some legs — read by the caller, async (mustSpendNow). */
export interface MustSpendFacts {
  /** The wallet the new send goes out of — the one `state` is of. Absent: every set is judged against `state`. */
  wallet?: string;
  /** Every OTHER wallet a refused send of these legs spent from, read now. */
  states?: ReadonlyMap<string, Pick<WalletState, 'unspent' | 'history'>>;
  /** A released send's id → a copy of it (the same payment under other signatures) its wallet's history holds. */
  copies?: ReadonlyMap<string, string>;
  /** Outpoints spent by a transaction proven in a block that is no copy of the refused sends that spent them. */
  spentByOther?: ReadonlySet<string>;
}

export interface MustSpendJudgement {
  binding: string[][];
  blockedOrderIds: string[];
  live: string[];
  /** Sets still binding in ANOTHER wallet than the one sent from (facts.wallet): no send from this one meets them. */
  foreign: Array<{ wallet: string; set: string[] }>;
}

/**
 * What the must_spend of these legs asks now. Each set belongs to the wallet whose coins it names — the wallet of the
 * refused sends it guards — and is judged against THAT wallet's coins and history (facts.states), never only the one
 * sent from now:
 *   - a refused send of theirs that its wallet's history holds (mempool or block), itself or a copy of it
 *     (facts.copies), is LIVE: those legs wait — if it confirms, the round books it;
 *   - a set with an outpoint spent by a transaction proven in a block that is no copy of those sends
 *     (facts.spentByOther) has LAPSED: every send it guarded is dead (each spends that outpoint);
 *   - a set whose outpoint went in a COPY of one of those sends: that send is in a block under another id — LIVE;
 *   - any other set BINDS — all its coins unspent, or one gone and who spent it not known (never lapsed without
 *     proof): a new send must spend ≥ 1 of it. Binding in another wallet than facts.wallet: FOREIGN — no send from
 *     this wallet can meet it.
 * Without facts (a test's), every set is judged against `state` and a gone coin lapses nothing.
 */
export function judgeMustSpend(
  db: Database.Database,
  legs: ReadonlyArray<Pick<LegRow, 'id' | 'must_spend_json'>>,
  state: Pick<WalletState, 'unspent' | 'history'>,
  sinceSql: string,
  facts: MustSpendFacts = {},
): MustSpendJudgement {
  const ids = new Set(legs.map(l => l.id));
  const released = (db.prepare(`
    SELECT txid, wallet_id, order_ids_json, inputs_json, created_at FROM lana_sends
    WHERE state = 'released' AND release_reason = 'refused' ORDER BY created_at, rowid
  `).all() as Array<{ txid: string; wallet_id: string; order_ids_json: string; inputs_json: string; created_at: string }>)
    .filter(r => jsonList(r.order_ids_json).some(id => ids.has(id)));
  const stateOf = (wallet: string) => (facts.wallet === undefined || wallet === facts.wallet ? state : facts.states?.get(wallet) ?? null);
  const live: string[] = [];
  const blocked = new Set<string>();
  const block = (txid: string, orderIds: readonly string[]) => {
    if (!live.includes(txid)) live.push(txid);
    for (const id of orderIds) if (ids.has(id)) blocked.add(id);
  };
  for (const r of released) {
    if (!(String(r.created_at) > sinceSql)) continue;
    // Its own wallet's history — not the wallet sent from now — holds it, or a copy: it may confirm. Unread: it may.
    const st = stateOf(r.wallet_id);
    if (facts.copies?.has(r.txid) || !st || st.history.has(r.txid)) block(r.txid, jsonList(r.order_ids_json));
  }
  const sets = new Map<string, { set: string[]; legIds: string[] }>();
  for (const l of legs) {
    if (blocked.has(l.id) || !l.must_spend_json) continue;
    const set = jsonList(l.must_spend_json);
    if (set.length === 0) continue;
    const key = [...set].sort().join(',');
    const known = sets.get(key);
    if (known) known.legIds.push(l.id);
    else sets.set(key, { set, legIds: [l.id] });
  }
  const binding: string[][] = [];
  const foreign: MustSpendJudgement['foreign'] = [];
  for (const { set, legIds } of sets.values()) {
    // The refused sends this set guards: each spent every coin of it, so all from one wallet — the set's.
    const guarded = released.filter(r => jsonList(r.order_ids_json).some(id => legIds.includes(id)) && set.every(o => jsonList(r.inputs_json).includes(o)));
    const home = guarded[0]?.wallet_id ?? facts.wallet;
    const st = home === undefined ? state : stateOf(home);
    const listed = st ? confirmedKeys(st) : new Set<string>();
    const gone = set.filter(o => !listed.has(o));
    if (gone.length) {
      if (gone.some(o => facts.spentByOther?.has(o))) continue;
      const copied = guarded.find(r => facts.copies?.has(r.txid));
      if (copied) {
        block(copied.txid, legIds);
        continue;
      }
    }
    if (home !== undefined && facts.wallet !== undefined && home !== facts.wallet) foreign.push({ wallet: home, set });
    else binding.push(set);
  }
  return { binding, blockedOrderIds: [...blocked], live, foreign };
}

/** Does a send spending `inputs` meet every binding set? The sets it misses. */
export function unmetMustSpend(binding: readonly string[][], inputs: readonly string[]): string[][] {
  const spent = new Set(inputs);
  return binding.filter(set => !set.some(o => spent.has(o)));
}

/**
 * A recipient of the transaction that the two-server proof is asked about: the wallet of its first output that pays
 * anything and reads — a P2PKH output, or a pay-to-public-key one (<public key> OP_CHECKSIG: the address of that key,
 * as the servers list it; the proof sums both, chainPayment.ts lanoshisPaidToKey). For our own sends the first output;
 * for another transaction — a co-tenant's, or a coinstake of the LANA desktop wallet (an empty first output, then the
 * staker's public key) — the first that reads. Recheck of 9. 10. 2026: read as P2PKH only, a coinstake that spent a
 * coin of a send had no wallet to ask, so it was never proven — the send it killed stayed 'sending' for good, and a
 * must-spend set it lapsed bound for good.
 */
export function proofWalletOf(raw: string): string | null {
  try {
    for (const out of decodeTx(raw).outputs) {
      if (out.value <= 0n) continue;
      const wallet = addressOfScript(out.scriptPubKeyHex);
      if (wallet) return wallet;
      const key = p2pkHash160(out.scriptPubKeyHex);
      if (key) return hash160ToAddress(key);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The purchase `ref` (an SQL expression) has a live investor_lana leg — neither cancelled nor failed — that pays
 * somebody other than `owner` (an SQL expression, lower case): the brain moved it to another financer.
 */
export const foreignInvestorSql = (ref: string, owner: string): string => `EXISTS (SELECT 1 FROM brain_lana_orders x
    WHERE x.transaction_ref = ${ref} AND x.order_type = 'investor_lana' AND x.status NOT IN ('cancelled', 'failed')
      AND LOWER(x.to_hex) != ${owner})`;

/**
 * The currency of the purchase `ref` (an SQL expression): the one its legs carry, upper case — NULL when a leg carries
 * none, or they do not all carry the same (owner, 9 Oct 2026: a purchase's LANA go from the financer's wallet of its
 * currency). Read with currencyCode: anything but three letters is no currency either.
 */
export const purchaseCurrencySql = (ref: string): string => `(SELECT CASE
      WHEN COUNT(c.currency) = COUNT(*) AND COUNT(DISTINCT UPPER(TRIM(c.currency))) = 1 THEN MAX(UPPER(TRIM(c.currency)))
    END FROM brain_lana_orders c WHERE c.transaction_ref = ${ref})`;

/**
 * The currencies of a financer's purchases with a leg still to send or on its way (pending — approved or not — or
 * sending), sorted; and those purchases whose currency is not known (purchaseCurrencySql), which no wallet sends.
 * Owned here (purchase_settlement), as sendable reads them.
 */
export function financerCurrencies(db: Database.Database, owner: string): { currencies: string[]; unknownRefs: string[] } {
  const rows = db.prepare(`
    SELECT ps.transaction_ref AS ref, ${purchaseCurrencySql('ps.transaction_ref')} AS currency FROM purchase_settlement ps
    WHERE ps.settled_by = 'financer' AND ps.owner_hex = ?
      AND EXISTS (SELECT 1 FROM brain_lana_orders p WHERE p.transaction_ref = ps.transaction_ref AND p.status IN ('pending', 'sending'))
    ORDER BY ps.created_at, ps.transaction_ref
  `).all(lc(owner)) as Array<{ ref: string; currency: string | null }>;
  const currencies = new Set<string>();
  const unknownRefs: string[] = [];
  for (const r of rows) {
    const c = currencyCode(r.currency);
    if (c) currencies.add(c);
    else unknownRefs.push(r.ref);
  }
  return { currencies: [...currencies].sort(), unknownRefs };
}

/**
 * A purchase whose live investor leg pays somebody other than the signer — the brain moved it to another financer
 * after this one confirmed (a reallocation's redirect, which this side never refuses: the brain contract) — is not
 * the signer's to send: they would pay another financer's LANA from their own wallet. As confirm.ts refuses it at the
 * confirm. One `?`: the signer.
 */
const FOREIGN_INVESTOR = foreignInvestorSql('blo.transaction_ref', '?');

/** The purchase's currency, read with each leg (purchase_currency). */
const PURCHASE_CURRENCY = `${purchaseCurrencySql('blo.transaction_ref')} AS purchase_currency`;

/**
 * The signer's legs that may go now: theirs, authorised, pending, in no send — oldest purchase first — each with its
 * purchase's currency (purchase_currency).
 */
function sendableLegsOf(db: Database.Database, owner: string, refs?: string[]): LegRow[] {
  const refFilter = refs ? `AND blo.transaction_ref IN (${refs.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT blo.*, ${PURCHASE_CURRENCY} FROM brain_lana_orders blo
    JOIN purchase_settlement ps ON ps.transaction_ref = blo.transaction_ref AND ps.settled_by = 'financer' AND ps.owner_hex = ?
    WHERE blo.status = 'pending' AND blo.brain_authorized = 1 AND blo.send_txid IS NULL
      AND NOT ${FOREIGN_INVESTOR}
    ${refFilter}
    ${LEG_ORDER}
  `).all(owner, owner, ...(refs ?? [])) as LegRow[];
}

/**
 * The currency a request that names none is about: a page from before wallets per currency, which knows ONE wallet.
 * It is the one currency of the owner's purchases that may go now (sendableLegsOf) or are on their way in a send of
 * theirs. In more than one, `currencies` holds them all (GET /sendable refuses CURRENCY_REQUIRED with them) and
 * `currency` the first. In none, the first of the currencies they have a wallet for on Direct.Fund
 * (`dfWalletCurrencies`, asked only then) or a purchase still to send in (financerCurrencies); null when there is none.
 * GET /sendable and /me's single wallet both answer by it, so an old page shows the very wallet it then sends from.
 */
export async function legacyCurrency(
  db: Database.Database,
  owner: string,
  dfWalletCurrencies: () => Promise<readonly string[]>,
): Promise<{ currency: string | null; currencies: string[] }> {
  const flying = db.prepare(`
    SELECT DISTINCT ${PURCHASE_CURRENCY} FROM brain_lana_orders blo
    JOIN lana_sends s ON s.txid = blo.send_txid AND s.sender = 'financer' AND s.owner_hex = ? AND s.state IN ('announced', 'mempool')
    WHERE blo.status = 'sending'
  `).all(owner) as Array<{ purchase_currency: string | null }>;
  const seen = [...new Set([...sendableLegsOf(db, owner), ...flying].map(l => currencyCode(l.purchase_currency)).filter((c): c is string => !!c))].sort();
  if (seen.length) return { currency: seen[0], currencies: seen };
  const theirs = new Set([...await dfWalletCurrencies(), ...financerCurrencies(db, owner).currencies]);
  return { currency: [...theirs].sort()[0] ?? null, currencies: [] };
}

const backoffS = (broadcasts: number): number => Math.min(REBROADCAST_MAX_S, REBROADCAST_FIRST_S * 2 ** Math.max(0, Math.min(10, broadcasts - 1)));

function outcomeText(o: BroadcastOutcome): string {
  switch (o.kind) {
    case 'accepted':
      return `accepted by ${o.server}`;
    case 'known':
      return `known to ${o.server} (${o.detail})`.slice(0, 300);
    case 'refused':
      return `refused${o.final ? ' (final)' : ''}: ${o.detail}`.slice(0, 300);
    default:
      return `unknown: ${o.detail}`.slice(0, 300);
  }
}

/** Sends whose broadcast is running in this process right now: the round leaves them alone. Process-local. */
const broadcasting = new Set<string>();
/** The round runs once at a time in this process (the 'financer-round' lock). */
let roundRunning = false;

// ─── the machine ──────────────────────────────────────────────────────────

export function createSends(deps: SendsDeps): Sends {
  const { db, chain, payments } = deps;
  const now = deps.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const nowSql = () => sqlTime(now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const settle = deps.settle ?? (() => {
    for (const b of settleBatchesWithSentLana(db)) {
      log(`[lana-discount] Batch ${b.batchRef} → lana_sent (from '${b.from}', all ${b.orders} LANA orders sent, tx ${b.txHash || 'unknown'})`);
    }
  });
  const short = (txid: string) => `${txid.slice(0, 12)}…`;
  /** When each released or stuck send was last looked at (seconds). */
  const lookedAt = new Map<string, number>();

  const rowOf = (txid: string): SendRow | undefined => db.prepare('SELECT * FROM lana_sends WHERE txid = ?').get(txid) as SendRow | undefined;

  const refsOf = (orderIds: string[]): string[] => {
    if (orderIds.length === 0) return [];
    const rows = db.prepare(`SELECT DISTINCT transaction_ref FROM brain_lana_orders WHERE id IN (${orderIds.map(() => '?').join(',')}) AND transaction_ref IS NOT NULL AND transaction_ref != ''`).all(...orderIds) as Array<{ transaction_ref: string }>;
    return rows.map(r => r.transaction_ref).sort();
  };

  /** The copy a send was confirmed as (finish), from its last_outcome; null for one confirmed under its own id. */
  const copyTxidOf = (row: SendRow): string | null => {
    const outcome = row.state === 'confirmed' ? String(row.last_outcome ?? '') : '';
    const id = outcome.startsWith(COPY_OUTCOME) ? outcome.slice(COPY_OUTCOME.length, COPY_OUTCOME.length + 64) : '';
    return TXID.test(id) ? id : null;
  };

  const viewOf = (row: SendRow): SendView => {
    const orderIds = jsonList(row.order_ids_json);
    const open = row.state === 'announced' || row.state === 'mempool';
    return {
      txid: row.txid,
      sender: row.sender,
      state: row.state,
      wallet: row.wallet_id,
      orderIds,
      transactionRefs: refsOf(orderIds),
      payingLanoshis: String(row.paying_lanoshis),
      feeLanoshis: String(row.fee_lanoshis),
      broadcasts: row.broadcasts,
      lastOutcome: row.last_outcome,
      nextBroadcastAt: row.next_broadcast_at,
      releaseReason: row.release_reason,
      blockHeight: row.block_height,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      stuck: open && now() - parseSqlTime(row.created_at) > REBROADCAST_FOR_S * 1000,
      chainTxid: copyTxidOf(row) ?? row.txid,
    };
  };

  /** The outpoints spent by this wallet's sends on their way. */
  const inFlightOf = (wallet: string): Map<string, string> => {
    const out = new Map<string, string>();
    const rows = db.prepare("SELECT txid, inputs_json FROM lana_sends WHERE wallet_id = ? AND state IN ('announced', 'mempool')").all(wallet) as Array<{ txid: string; inputs_json: string }>;
    for (const r of rows) for (const key of jsonList(r.inputs_json)) out.set(key, r.txid);
    return out;
  };

  /** The signer's legs that may go now (sendableLegsOf). */
  const sendableLegs = (owner: string, refs?: string[]): LegRow[] => sendableLegsOf(db, owner, refs);

  /**
   * The legs a request names, as the database holds them now — every one the signer's to send, and whole purchases.
   * A leg named twice, a leg of somebody else, one cancelled, sent or in another send: refused, with the ids. A
   * purchase whose investor leg now pays another financer: refused (OWNER_MISMATCH), with the ids named of it.
   */
  const legsOfRequest = (owner: string, raw: unknown): { ok: true; legs: LegRow[] } | SendRefusal => {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ORDER_IDS || !raw.every(x => typeof x === 'string' && x.trim() !== '' && x.length <= 128)) {
      return refusal(400, 'BAD_ORDER_IDS', `orderIds must be a list of 1–${MAX_ORDER_IDS} leg ids.`);
    }
    const ids = raw as string[];
    if (new Set(ids).size !== ids.length) return refusal(400, 'BAD_ORDER_IDS', 'A leg is named twice.');
    const rows = db.prepare(`
      SELECT blo.*, ps.owner_hex AS ps_owner, ps.settled_by AS ps_settled_by, ${FOREIGN_INVESTOR} AS foreign_investor, ${PURCHASE_CURRENCY}
      FROM brain_lana_orders blo
      LEFT JOIN purchase_settlement ps ON ps.transaction_ref = blo.transaction_ref
      WHERE blo.id IN (${ids.map(() => '?').join(',')})
      ${LEG_ORDER}
    `).all(owner, ...ids) as Array<LegRow & { ps_owner: string | null; ps_settled_by: string | null; foreign_investor: number }>;
    const ok = rows.filter(r => r.status === 'pending' && r.brain_authorized === 1 && !r.send_txid && r.ps_settled_by === 'financer' && lc(r.ps_owner) === owner);
    if (ok.length !== ids.length) {
      const good = new Set(ok.map(r => r.id));
      return refusal(409, 'NOT_SENDABLE', 'Some of these legs are not yours to send now (not authorised yet, cancelled, already sent or on their way, or another financer\'s). Reload and choose again.', {
        orderIds: ids.filter(id => !good.has(id)),
      });
    }
    const moved = ok.filter(r => r.foreign_investor === 1);
    if (moved.length) {
      const refs = [...new Set(moved.map(r => r.transaction_ref))];
      console.error(`[lana-discount] financer ${owner.slice(0, 8)}… asked to send purchase(s) ${refs.join(', ')} whose investor leg now pays another financer (moved after the confirm) — refused; needs an administrator`);
      return refusal(409, 'OWNER_MISMATCH', 'The LANA of a purchase you chose now goes to another financer\'s budget (it was moved to them after you confirmed it), so it is not yours to send. An administrator has to settle it.', {
        orderIds: moved.map(r => r.id),
      });
    }
    // Whole purchases: every leg of each purchase that may go now goes in this send.
    const refs = [...new Set(ok.map(r => r.transaction_ref as string))];
    const named = new Set(ids);
    const missing = sendableLegs(owner, refs).filter(l => !named.has(l.id)).map(l => l.id);
    if (missing.length) {
      return refusal(409, 'PARTIAL_PURCHASE', 'A purchase is sent whole: every leg of it that may go now goes in the same send.', { orderIds: missing });
    }
    return { ok: true, legs: ok.map(({ ps_owner: _o, ps_settled_by: _s, foreign_investor: _f, ...leg }) => leg as LegRow) };
  };

  /**
   * The one currency of the purchases these legs belong to (purchase_currency, read by legsOfRequest) — or why they
   * cannot go in one send: a purchase whose currency is not known goes from no wallet (CURRENCY_UNKNOWN); purchases of
   * two currencies go from two wallets, in two sends (MIXED_CURRENCY).
   */
  const currencyOfLegs = (legs: readonly LegRow[]): { ok: true; currency: string } | SendRefusal => {
    const unknown = legs.filter(l => !currencyCode(l.purchase_currency));
    if (unknown.length) {
      return refusal(409, 'CURRENCY_UNKNOWN', 'The currency of a purchase you chose is not known (its legs carry none, or not one and the same), so there is no wallet to send it from. An administrator has to look at it.', {
        orderIds: unknown.map(l => l.id),
        transactionRefs: [...new Set(unknown.map(l => l.transaction_ref))],
      });
    }
    const currencies = [...new Set(legs.map(l => currencyCode(l.purchase_currency) as string))].sort();
    if (currencies.length !== 1) {
      return refusal(409, 'MIXED_CURRENCY', 'These purchases are in more than one currency. Each currency is sent from its own wallet, in a send of its own.', { currencies });
    }
    return { ok: true, currency: currencies[0] };
  };

  /** The financer's wallet for this currency as Direct.Fund names it now, judged at the Registrar now — or why not. */
  const readyWallet = async (owner: string, currency: string): Promise<{ ok: true; wallet: string } | SendRefusal> => {
    let f: DfFinancer;
    try {
      f = await deps.financer(owner);
    } catch (err) {
      return refusal(dfHttpStatus(err), 'DF_UNAVAILABLE', 'Direct.Fund could not be asked which wallet you send from. Nothing was changed; try again shortly.');
    }
    const wallet = f.walletFor(currency);
    if (!wallet) return refusal(409, 'NO_WALLET', `Choose your Lana.Discount wallet for ${currency} on Direct.Fund first.`, { currency });
    const check = await deps.checkWallet(wallet, owner);
    if (check.ok !== true) {
      const reason = check.reason || 'REGISTRAR_UNKNOWN';
      return refusal(reason === 'REGISTRAR_UNKNOWN' ? 503 : 409, 'WALLET_REFUSED', `The Registrar does not allow sending from ${wallet} now (${reason}).`, {
        reason,
        wallet,
        currency,
        ...(check.walletType ? { walletType: check.walletType } : {}),
        ...(check.freezeReason ? { freezeReason: check.freezeReason } : {}),
      });
    }
    return { ok: true, wallet };
  };

  const inFlightRefusal = (wallet: string): SendRefusal | null => {
    const busy = db.prepare("SELECT txid FROM lana_sends WHERE wallet_id = ? AND state IN ('announced', 'mempool') ORDER BY created_at LIMIT 1").get(wallet) as { txid: string } | undefined;
    return busy ? refusal(409, 'SEND_IN_FLIGHT', 'A send from this wallet is still on its way; the next one can be prepared once it is confirmed.', { txid: busy.txid }) : null;
  };

  const watchSince = () => sqlTime(now() - WATCH_RELEASED_FOR_S * 1000);

  // ── who spent a coin of ours: read from the wallet's history ──

  /** The coins each transaction of a history spends ("txid:vout"), by its id: a transaction never changes. Process-local. */
  const spendsOfTx = new Map<string, string[]>();
  /** Transactions the two-server proof showed in a block (txid → height). Process-local. */
  const provenSpenders = new Map<string, number>();

  interface Spender { txid: string; height: number; raw: string; spends: string[] }

  /**
   * The transactions of a wallet's history (but `except`) that spend any of `outpoints`, with their height and bytes:
   * every one in the mempool, and in a block — newest first, no lower than the block that paid the coins — until each
   * outpoint of `inBlockFor` has its spender in a block (a coin is spent in one block only), or MAX_SPENDER_LOOKUPS
   * entries have been looked at. A transaction no server sends is skipped: only what was read is ever a reason.
   */
  const spendersIn = async (history: ReadonlyMap<string, number>, outpoints: ReadonlySet<string>, inBlockFor: ReadonlySet<string>, except: ReadonlySet<string>): Promise<Spender[]> => {
    if (outpoints.size === 0) return [];
    const paidAt = [...inBlockFor].map(o => history.get(o.slice(0, o.indexOf(':'))) ?? 0);
    const floor = paidAt.length > 0 && paidAt.every(h => h > 0) ? Math.min(...paidAt) : 1;
    const pool = [...history]
      .filter(([id, h]) => !except.has(id) && (h <= 0 || (inBlockFor.size > 0 && h >= floor)))
      .sort((a, b) => (a[1] > 0 ? 1 : 0) - (b[1] > 0 ? 1 : 0) || b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_SPENDER_LOOKUPS);
    const found: Spender[] = [];
    const settled = new Set<string>();
    for (let at = 0; at < pool.length; at += SPENDER_CHUNK) {
      const part = pool.slice(at, at + SPENDER_CHUNK);
      if (part[0][1] > 0 && [...inBlockFor].every(o => settled.has(o))) break;
      const unread = part.map(([id]) => id).filter(id => !spendsOfTx.has(id));
      const raws = unread.length ? await chain.rawTxs(unread) : new Map<string, string>();
      if (spendsOfTx.size + raws.size > MAX_SPENDS_KEPT) spendsOfTx.clear();
      for (const [id, raw] of raws) {
        try {
          spendsOfTx.set(id, inputsOf(raw));
        } catch {
          // Not a transaction: never a reason.
        }
      }
      const hits = part.filter(([id]) => (spendsOfTx.get(id) ?? []).some(o => outpoints.has(o)));
      const need = hits.map(([id]) => id).filter(id => !raws.has(id));
      const more = need.length ? await chain.rawTxs(need) : new Map<string, string>();
      for (const [id, height] of hits) {
        const raw = raws.get(id) ?? more.get(id);
        const spends = spendsOfTx.get(id);
        if (!raw || !spends) continue;
        found.push({ txid: id, height, raw, spends });
        if (height > 0) for (const o of spends) if (inBlockFor.has(o)) settled.add(o);
      }
    }
    return found;
  };

  /**
   * Is this transaction in a block by the two-server proof (asked with a wallet it pays), at least MIN_SPENDER_DEPTH
   * deep? Never on one server's history; shallower, not yet — and not kept, so it is asked again.
   */
  const provenInBlock = async (x: { txid: string; raw: string }): Promise<boolean> => {
    if (provenSpenders.has(x.txid)) return true;
    const payee = proofWalletOf(x.raw);
    if (!payee) return false;
    const read = await payments.read(x.txid, payee);
    if (read.state !== 'confirmed' || !(read.confirmations >= MIN_SPENDER_DEPTH)) return false;
    if (provenSpenders.size > 10_000) provenSpenders.clear();
    provenSpenders.set(x.txid, read.height);
    return true;
  };

  /**
   * judgeMustSpend for these legs going out of `wallet` (read now as `state`), with what only the chain can say, read
   * here: every OTHER wallet a refused send of theirs spent from (unreadable: CHAIN_UNKNOWN, nothing judged); which of
   * those sends a copy of it is in its wallet's history; which of their coins went in a transaction proven in a block
   * that is no copy. No refused send among them: nothing more is read.
   */
  const mustSpendNow = async (
    legs: ReadonlyArray<Pick<LegRow, 'id' | 'must_spend_json'>>,
    wallet: string,
    state: Pick<WalletState, 'unspent' | 'history'>,
  ): Promise<{ ok: true; must: MustSpendJudgement } | SendRefusal> => {
    const ids = new Set(legs.map(l => l.id));
    const rows = (db.prepare("SELECT * FROM lana_sends WHERE state = 'released' AND release_reason = 'refused' ORDER BY created_at, rowid").all() as SendRow[])
      .filter(r => jsonList(r.order_ids_json).some(id => ids.has(id)));
    const states = new Map<string, Pick<WalletState, 'unspent' | 'history'>>();
    const copies = new Map<string, string>();
    const spentByOther = new Set<string>();
    const byWallet = new Map<string, SendRow[]>();
    for (const r of rows) byWallet.set(r.wallet_id, [...(byWallet.get(r.wallet_id) ?? []), r]);
    for (const [w, sent] of byWallet) {
      let st = state;
      if (w !== wallet) {
        const read = await chain.state(w);
        if (!read) return refusal(503, 'CHAIN_UNKNOWN', 'The wallet an earlier refused send of these legs went out of could not be read; try again shortly.', { wallet: w });
        states.set(w, read);
        st = read;
      }
      const listed = confirmedKeys(st);
      const inputs = new Set(sent.flatMap(r => jsonList(r.inputs_json)));
      const gone = new Set([...inputs].filter(o => !listed.has(o)));
      for (const x of await spendersIn(st.history, inputs, gone, new Set(sent.map(r => r.txid)))) {
        const copyOf = sent.find(r => isCopyOf(x.raw, r.raw_tx));
        if (copyOf) {
          if (!copies.has(copyOf.txid) || x.height > 0) copies.set(copyOf.txid, x.txid);
          continue;
        }
        const hit = x.spends.filter(o => gone.has(o));
        if (x.height > 0 && hit.length && await provenInBlock(x)) for (const o of hit) spentByOther.add(o);
      }
    }
    const must = judgeMustSpend(db, legs, state, watchSince(), { wallet, states, copies, spentByOther });
    keepLapsed(legs, must, spentByOther);
    return { ok: true, must };
  };

  /**
   * A lapse proven now is KEPT: the set of each leg it lapsed is cleared, so it never has to be proven again (recheck of
   * 9. 10. 2026: the spender is found only among the MAX_SPENDER_LOOKUPS newest history entries of a busy wallet, and
   * past them the set bound again for good). Only a leg judged as it is now — pending, in no send, its set exactly
   * the one judged, no refused send of it live — and only on proof: a coin of its set spent by a transaction proven in a
   * block that is no copy of the sends it guarded (every one of them, and every copy, spends that coin: none can
   * confirm). A refused send of it that turns up in a block anyway is still booked by watchReleased.
   */
  const keepLapsed = (legs: ReadonlyArray<Pick<LegRow, 'id' | 'must_spend_json'>>, must: MustSpendJudgement, spentByOther: ReadonlySet<string>): void => {
    if (spentByOther.size === 0) return;
    const blocked = new Set(must.blockedOrderIds);
    const lapsed = legs.filter(l => l.must_spend_json && !blocked.has(l.id) && jsonList(l.must_spend_json).some(o => spentByOther.has(o)));
    if (lapsed.length === 0) return;
    let cleared = 0;
    db.transaction(() => {
      const clear = db.prepare("UPDATE brain_lana_orders SET must_spend_json = NULL WHERE id = ? AND must_spend_json = ? AND status = 'pending' AND send_txid IS NULL");
      for (const l of lapsed) cleared += clear.run(l.id, l.must_spend_json).changes;
    }).immediate();
    if (cleared > 0) log(`[lana-discount] must-spend lapsed for ${cleared} leg(s): a coin of their refused send went in another transaction proven in a block — cleared, never asked again`);
  };

  /** Sets still binding in the wallet an earlier refused send went out of: nothing sent from this one can meet them. */
  const otherWalletRefusal = (foreign: MustSpendJudgement['foreign']): SendRefusal => {
    const wallet = foreign[0].wallet;
    return refusal(409, 'MUST_SPEND_OTHER_WALLET', `These legs were in a send from ${wallet} that was refused; their next send must spend one of its coins, and those coins are still in that wallet. Send them from that wallet again, or first move those coins out of it.`, {
      wallet,
      mustSpend: foreign.filter(f => f.wallet === wallet).map(f => f.set),
    });
  };

  // ── what happened to a send, kept ──

  /**
   * Release a send: its legs back to 'pending', in the caller's transaction. 'refused' gives each leg the outpoints
   * its next send must spend; 'input_spent' leaves a leg's earlier set as it was (this send can never confirm, but an
   * earlier refused one might).
   */
  const releaseInTxn = (row: SendRow, reason: 'refused' | 'input_spent', outcome: string): number => {
    const at = nowSql();
    const changed = db.prepare(`
      UPDATE lana_sends SET state = 'released', release_reason = ?, last_outcome = ?, next_broadcast_at = NULL, updated_at = ?
      WHERE txid = ? AND state IN ('announced', 'mempool')
    `).run(reason, outcome.slice(0, 300), at, row.txid).changes;
    if (changed !== 1) return 0;
    const legs = db.prepare("SELECT id, must_spend_json FROM brain_lana_orders WHERE send_txid = ? AND status = 'sending'").all(row.txid) as Array<{ id: string; must_spend_json: string | null }>;
    const inputs = jsonList(row.inputs_json);
    const back = db.prepare("UPDATE brain_lana_orders SET status = 'pending', send_txid = NULL, must_spend_json = ? WHERE id = ? AND send_txid = ? AND status = 'sending'");
    for (const l of legs) {
      const must = reason === 'refused' ? JSON.stringify(nextMustSpend(l.must_spend_json, inputs)) : l.must_spend_json;
      back.run(must, l.id, row.txid);
    }
    return legs.length;
  };

  /** Keep what a broadcast said: in the mempool, released (a final refusal that counts), or in doubt. */
  const applyBroadcast = (txid: string, outcome: BroadcastOutcome): void => {
    let released = 0;
    db.transaction(() => {
      const row = rowOf(txid);
      if (!row || (row.state !== 'announced' && row.state !== 'mempool')) return;
      const at = nowSql();
      const broadcasts = row.broadcasts + 1;
      const next = sqlTime(now() + backoffS(broadcasts) * 1000);
      if (outcome.kind === 'accepted' || outcome.kind === 'known') {
        db.prepare("UPDATE lana_sends SET state = 'mempool', broadcasts = ?, last_outcome = ?, next_broadcast_at = ?, updated_at = ? WHERE txid = ?").run(broadcasts, outcomeText(outcome), next, at, txid);
        return;
      }
      if (outcome.kind === 'refused' && outcome.final) {
        const refusals = (Number(FINAL_REFUSAL.exec(row.last_outcome ?? '')?.[1]) || 0) + 1;
        // Refused finally at its very first broadcast: it never went. Once it had gone out (or an answer did not
        // come), only REFUSALS_TO_RELEASE final refusals in a row end it.
        if (row.broadcasts === 0 || refusals >= REFUSALS_TO_RELEASE) {
          db.prepare('UPDATE lana_sends SET broadcasts = ? WHERE txid = ?').run(broadcasts, txid);
          released = releaseInTxn(row, 'refused', `refused-final#${refusals}: ${outcome.detail}`);
          return;
        }
        db.prepare('UPDATE lana_sends SET broadcasts = ?, last_outcome = ?, next_broadcast_at = ?, updated_at = ? WHERE txid = ?')
          .run(broadcasts, `refused-final#${refusals}: ${outcome.detail}`.slice(0, 300), next, at, txid);
        return;
      }
      db.prepare('UPDATE lana_sends SET broadcasts = ?, last_outcome = ?, next_broadcast_at = ?, updated_at = ? WHERE txid = ?').run(broadcasts, outcomeText(outcome), next, at, txid);
    }).immediate();
    if (released > 0) log(`[lana-discount] send ${short(txid)} refused by every server and held by none: released, ${released} leg(s) back to pending (their next send must spend one of its coins)`);
  };

  /** Broadcast the recorded bytes — never other bytes — and keep the answer. */
  const broadcastRow = async (row: SendRow): Promise<BroadcastOutcome | null> => {
    if (broadcasting.has(row.txid)) return null;
    broadcasting.add(row.txid);
    try {
      let outcome: BroadcastOutcome;
      try {
        outcome = await chain.broadcast(row.raw_tx, row.txid);
      } catch (err) {
        outcome = { kind: 'unknown', detail: String((err as Error)?.message ?? err).slice(0, 200) };
      }
      applyBroadcast(row.txid, outcome);
      log(`[lana-discount] send ${short(row.txid)} (${row.sender}) broadcast #${row.broadcasts + 1}: ${outcomeText(outcome)}`);
      return outcome;
    } finally {
      broadcasting.delete(row.txid);
    }
  };

  /**
   * Confirmed: the legs it carries are 'sent', lana-sent is owed to the brain, and the batches it finished close.
   * `paidBy`: the transaction in the block — the send's own id, or a copy of it (other signatures), whose id the legs'
   * tx_hash and lana-sent then carry: it is the one on the chain. The legs' send_txid stays the recorded send's.
   */
  const finish = (row: SendRow, height: number, late = false, paidBy = row.txid): string[] => {
    const at = nowSql();
    const ids = jsonList(row.order_ids_json);
    const asCopy = paidBy !== row.txid;
    const note = asCopy ? `${COPY_OUTCOME}${paidBy}${late ? ', after it was released' : ''}` : late ? 'confirmed after it was released' : null;
    let flipped: Array<{ id: string; transaction_ref: string | null }> = [];
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE lana_sends SET state = 'confirmed', block_height = ?, confirmed_at = ?, next_broadcast_at = NULL, updated_at = ?,
          last_outcome = COALESCE(?, last_outcome)
        WHERE txid = ? AND state IN (${late ? "'released'" : "'announced', 'mempool'"})
      `).run(height, at, at, note, row.txid).changes;
      if (changed !== 1) return;
      const legs = (ids.length ? db.prepare(`SELECT id, transaction_ref, status, send_txid, tx_hash FROM brain_lana_orders WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []) as Array<{
        id: string; transaction_ref: string | null; status: string; send_txid: string | null; tx_hash: string | null;
      }>;
      const toSent = db.prepare("UPDATE brain_lana_orders SET status = 'sent', tx_hash = ?, send_txid = ?, completed_at = ?, must_spend_json = NULL WHERE id = ? AND status = ?");
      for (const l of legs) {
        // Ours: 'sending' in this send. After a release that confirmed anyway: 'pending' again, or 'sending' in a newer
        // send — which spends a coin of this one (must_spend) and so can never confirm now.
        const mine = l.status === 'sending' && l.send_txid === row.txid;
        const reclaim = late && ((l.status === 'pending' && !l.send_txid) || (l.status === 'sending' && l.send_txid !== row.txid));
        if (mine || reclaim) {
          if (toSent.run(paidBy, row.txid, at, l.id, l.status).changes === 1) flipped.push(l);
        } else {
          console.error(`[lana-discount] send ${short(row.txid)} confirmed and paid leg ${l.id} (${l.transaction_ref}), which is ${l.status}${l.tx_hash ? ` with ${l.tx_hash}` : ''} — needs a person`);
        }
      }
      // In the order the send carried them: exactly the legs this transaction paid and that are now 'sent'.
      const order = new Map(ids.map((id, i) => [id, i]));
      flipped = flipped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const refs = [...new Set(flipped.map(l => l.transaction_ref).filter((r): r is string => !!r))];
      if (flipped.length > 0 && refs.length > 0) {
        enqueue(db, 'lana-sent', `lana-sent:${paidBy}`, { transaction_refs: refs, tx_hash: paidBy, order_ids: flipped.map(l => String(l.id)) }, { nowMs: now() });
      } else if (flipped.length > 0) {
        console.error(`[lana-discount] send ${short(row.txid)}: ${flipped.length} leg(s) sent without a transaction_ref — lana-sent cannot name them`);
      }
    }).immediate();
    if (flipped.length > 0) {
      log(`[lana-discount] send ${short(row.txid)} (${row.sender}) confirmed at height ${height}${asCopy ? ` as its copy ${short(paidBy)} (other signatures)` : ''}${late ? ' AFTER it was released' : ''}: ${flipped.length} leg(s) sent`);
      try {
        settle();
      } catch (err: any) {
        console.error('[lana-discount] Batch settlement error:', err?.message || err);
      }
    }
    return flipped.map(l => l.id);
  };

  /**
   * What happened to a send no server holds, read from its wallet — its coins and who spent them:
   *   'copy' — a copy of it (the same payment under other signatures) spends its coins, in a block (preferred) or in
   *     the mempool: booked under the copy's id once the copy is proven, never released;
   *   'spent' — a transaction proven in a block, and no copy, spent a coin of it: it can never confirm, nor any copy;
   *   null — nothing proven: the wallet's history holds it, no coin of it is gone, or who spent one is not found, not
   *     readable, or not proven in a block. Nothing is released on that.
   */
  type SendFate = { kind: 'copy'; txid: string; height: number } | { kind: 'spent'; gone: string[]; by: string } | null;
  const fateOf = async (row: SendRow): Promise<SendFate> => {
    const state = await chain.state(row.wallet_id);
    if (!state || state.history.has(row.txid)) return null;
    const listed = confirmedKeys(state);
    const inputs = jsonList(row.inputs_json);
    const gone = inputs.filter(key => !listed.has(key));
    const found = await spendersIn(state.history, new Set(inputs), new Set(gone), new Set([row.txid]));
    const copies = found.filter(x => isCopyOf(x.raw, row.raw_tx));
    const copyInBlock = copies.find(x => x.height > 0);
    if (copyInBlock) return { kind: 'copy', txid: copyInBlock.txid, height: copyInBlock.height };
    for (const x of found) {
      if (x.height <= 0 || copies.includes(x)) continue;
      const hit = x.spends.filter(o => gone.includes(o));
      if (hit.length && await provenInBlock(x)) return { kind: 'spent', gone: hit, by: x.txid };
    }
    return copies[0] ? { kind: 'copy', txid: copies[0].txid, height: copies[0].height } : null;
  };

  /** A copy of a released send in a block, from its wallet's history (a copy in a block spent its coins): its id. */
  const copyInBlockOf = async (row: SendRow): Promise<string | null> => {
    const state = await chain.state(row.wallet_id);
    if (!state) return null;
    const listed = confirmedKeys(state);
    const gone = jsonList(row.inputs_json).filter(key => !listed.has(key));
    if (gone.length === 0) return null;
    const found = await spendersIn(state.history, new Set(gone), new Set(gone), new Set([row.txid]));
    return found.find(x => x.height > 0 && isCopyOf(x.raw, row.raw_tx))?.txid ?? null;
  };

  /** One send on its way: confirmed, released with proof, held, sent again, or left alone. */
  const step = async (row: SendRow, result: RoundResult): Promise<void> => {
    if (broadcasting.has(row.txid)) return;
    const at = nowSec();
    const age = at - Math.floor(parseSqlTime(row.created_at) / 1000);
    const old = age > REBROADCAST_FOR_S;
    if (old) {
      // No longer sent again; looked at now and then for the proof either way.
      if (at - (lookedAt.get(row.txid) ?? 0) < STUCK_EVERY_S) return;
      lookedAt.set(row.txid, at);
    }
    const proofWallet = proofWalletOf(row.raw_tx);
    const read = proofWallet ? await payments.read(row.txid, proofWallet) : { state: 'unknown' as const };
    if (read.state === 'confirmed') {
      finish(row, read.height);
      result.confirmed.push(row.txid);
      return;
    }
    // No server holds it — every one said so, or every one that answered while the rest were silent (one listed server
    // down for days, Sept 2026): what happened to its coins decides, never the silence.
    // NOT CLOSED (C3/N3, recheck of 9. 10. 2026) — operational: KIND 38888 lists three names on TWO machines
    // (electrum1 = electrum3 = 193.164.140.162, electrum2 = .59). While one machine is unreachable, the other alone
    // can prove nothing (chainPayment.ts: a second MACHINE must hold the block), so neither this send nor the spender
    // of its coin is proven: it waits, goes STUCK after a day (no longer sent again — one that fell out of the mempools
    // meanwhile stays STUCK after the outage too), and no send at all confirms until the second machine is back. Never
    // released on one machine's word; a third independent Electrum machine in KIND 38888 is what closes it.
    if (read.state === 'not_found' || (read.state === 'unknown' && read.notFoundByAllReachable === true)) {
      const fate = await fateOf(row);
      if (fate?.kind === 'copy') {
        const copyRead = proofWallet ? await payments.read(fate.txid, proofWallet) : { state: 'unknown' as const };
        if (copyRead.state === 'confirmed') {
          finish(row, copyRead.height, false, fate.txid);
          result.confirmed.push(row.txid);
          return;
        }
        // Not proven in a block yet: it waits — and its own bytes are not sent again beside it (refused for the copy,
        // they would count toward a release).
        const why = `copy ${fate.txid} on the chain (${fate.height > 0 ? `height ${fate.height}` : 'mempool'}): booked under its id once proven`;
        if (row.last_outcome !== why) {
          db.prepare("UPDATE lana_sends SET last_outcome = ?, updated_at = ? WHERE txid = ? AND state IN ('announced', 'mempool')").run(why, nowSql(), row.txid);
          log(`[lana-discount] send ${short(row.txid)} (${row.sender}): ${why}`);
        }
        (old ? result.stuck : result.held).push(row.txid);
        return;
      }
      if (fate?.kind === 'spent') {
        let legs = 0;
        db.transaction(() => {
          legs = releaseInTxn(row, 'input_spent', `spent elsewhere: ${fate.gone.join(', ')} by ${fate.by}`);
        }).immediate();
        log(`[lana-discount] send ${short(row.txid)} (${row.sender}) can never confirm — a coin it spends went in another transaction (${short(fate.by)}, in a block, no copy of it): released, ${legs} leg(s) back to pending`);
        result.released.push(row.txid);
        return;
      }
    }
    if (old) {
      if (!String(row.last_outcome ?? '').startsWith(STUCK_OUTCOME)) {
        db.prepare("UPDATE lana_sends SET last_outcome = ?, updated_at = ? WHERE txid = ? AND state IN ('announced', 'mempool')")
          .run(`${STUCK_OUTCOME}: unconfirmed for a day, and nothing proves it cannot confirm — not released without proof; needs a person`, nowSql(), row.txid);
        console.error(`[lana-discount] send ${short(row.txid)} (${row.sender}) unconfirmed for a day and not proven dead — kept, not sent again; needs a person`);
      }
      result.stuck.push(row.txid);
      return;
    }
    const due = row.broadcasts === 0 || !row.next_broadcast_at || parseSqlTime(row.next_broadcast_at) <= now();
    if (!due) return;
    // The Registrar asked again first: hours may have passed since the announce asked it.
    if (row.sender === 'financer') {
      const check = await deps.checkWallet(row.wallet_id, row.owner_hex ?? '');
      if (check.ok !== true) {
        const why = `held: ${check.reason || 'REGISTRAR_UNKNOWN'}${check.freezeReason ? ` (${check.freezeReason})` : ''}`;
        db.prepare("UPDATE lana_sends SET last_outcome = ?, next_broadcast_at = ?, updated_at = ? WHERE txid = ? AND state IN ('announced', 'mempool')")
          .run(why, sqlTime(now() + REBROADCAST_FIRST_S * 1000), nowSql(), row.txid);
        if (row.last_outcome !== why) log(`[lana-discount] send ${short(row.txid)} held, not sent again: ${why}`);
        result.held.push(row.txid);
        return;
      }
    }
    await broadcastRow(row);
    result.sent.push(row.txid);
  };

  /**
   * A send released as refused that turns up in a block after all — itself, or a copy of it under other signatures —
   * is booked (under the id in the block), its legs never paid again unseen.
   */
  const watchReleased = async (row: SendRow, result: RoundResult): Promise<void> => {
    const at = nowSec();
    if (at - (lookedAt.get(row.txid) ?? 0) < WATCH_RELEASED_EVERY_S) return;
    lookedAt.set(row.txid, at);
    const proofWallet = proofWalletOf(row.raw_tx);
    if (!proofWallet) return;
    const read = await payments.read(row.txid, proofWallet);
    if (read.state === 'confirmed') {
      console.error(`[lana-discount] send ${short(row.txid)} was released as refused, but it confirmed at height ${read.height} — booking its legs`);
      finish(row, read.height, true);
      result.lateConfirmed.push(row.txid);
      return;
    }
    const copy = await copyInBlockOf(row);
    if (!copy) return;
    const copyRead = await payments.read(copy, proofWallet);
    if (copyRead.state !== 'confirmed') return;
    console.error(`[lana-discount] send ${short(row.txid)} was released as refused, but a copy of it (${short(copy)}, other signatures) confirmed at height ${copyRead.height} — booking its legs under that id`);
    finish(row, copyRead.height, true, copy);
    result.lateConfirmed.push(row.txid);
  };

  const sends: Sends = {
    async sendable(owner, currencyIn) {
      let currency: string | null = null;
      if (currencyIn !== undefined && currencyIn !== null && currencyIn !== '') {
        currency = currencyCode(currencyIn);
        if (!currency) return refusal(400, 'BAD_CURRENCY', 'currency must be a three-letter code (EUR, GBP, USD …).');
      }
      const mine = sendableLegs(owner);
      // Direct.Fund asked once, when needed; null: it could not be asked.
      let asked: Promise<DfFinancer | null> | null = null;
      const financerNow = () => (asked ??= deps.financer(owner).catch(() => null));
      if (!currency) {
        // Not named (a page from before wallets per currency): the one currency of what is to send or on its way — or,
        // with nothing, the first of theirs. /me's single wallet is that currency's (legacyCurrency).
        const meant = await legacyCurrency(db, owner, async () => Object.keys((await financerNow())?.wallets ?? {}));
        if (meant.currencies.length > 1) {
          return refusal(400, 'CURRENCY_REQUIRED', 'Your purchases are in more than one currency, each sent from its own wallet: ask for one of them.', { currencies: meant.currencies });
        }
        currency = meant.currency;
      }
      // A purchase whose currency is not known is sent from no wallet: in no currency's list (CURRENCY_UNKNOWN).
      const legs = currency === null ? [] : mine.filter(l => currencyCode(l.purchase_currency) === currency);
      const byRef = new Map<string, LegRow[]>();
      for (const l of legs) {
        const ref = l.transaction_ref as string;
        const g = byRef.get(ref);
        if (g) g.push(l);
        else byRef.set(ref, [l]);
      }
      const purchases: SendablePurchase[] = [...byRef].map(([ref, ls]) => {
        const merged = mergedAllocations(ls);
        return {
          transactionRef: ref,
          batchRef: ls.find(l => l.batch_ref)?.batch_ref ?? null,
          legs: ls.map(l => ({ orderId: l.id, orderType: l.order_type, toWallet: l.to_wallet, toHex: l.to_hex, lanoshis: String(l.lana_amount), mustSpend: !!l.must_spend_json })),
          lanoshis: ls.reduce((s, l) => s + lanoshisOf(l), 0n).toString(),
          wallets: merged.length,
          belowDustAlone: merged.some(a => BigInt(a.lanoshis) < DUST_LANOSHIS),
        };
      });
      const all = mergedAllocations(legs);
      const total = legs.reduce((s, l) => s + lanoshisOf(l), 0n);
      // The wallet of this currency. A Direct.Fund before wallets per currency names one for every currency — and for
      // none known (walletFor(null)).
      const f = await financerNow();
      const wallet = f ? f.walletFor(currency) : null;
      const walletProblem: SendableAnswer['walletProblem'] = !f ? 'DF_UNAVAILABLE' : !wallet ? 'NO_WALLET' : null;
      let balance: SendableAnswer['balance'] = null;
      if (wallet) {
        const state = await chain.state(wallet).catch(() => null);
        if (state) balance = { confirmed: state.balance.confirmed.toString(), unconfirmed: state.balance.unconfirmed.toString() };
      }
      const confirmed = balance ? BigInt(balance.confirmed) : 0n;
      const missing = all.length ? total + feeFor(1, all.length) - confirmed : 0n;
      // The sends on their way from THIS wallet: the next send of it waits for them (SEND_IN_FLIGHT).
      const inFlight = wallet
        ? (db.prepare("SELECT * FROM lana_sends WHERE sender = 'financer' AND owner_hex = ? AND wallet_id = ? AND state IN ('announced', 'mempool') ORDER BY created_at DESC").all(owner, wallet) as SendRow[]).map(viewOf)
        : [];
      return {
        ok: true,
        body: {
          currency,
          wallet,
          walletProblem,
          balance,
          purchases,
          totalLanoshis: total.toString(),
          legCount: legs.length,
          wallets: all.length,
          shortfallLanoshis: (missing > 0n ? missing : 0n).toString(),
          inFlight,
          limits: LIMITS,
        },
      };
    },

    async prepare(owner, orderIds) {
      const req = legsOfRequest(owner, orderIds);
      if (req.ok === false) return req;
      const legs = req.legs;
      const cur = currencyOfLegs(legs);
      if (cur.ok === false) return cur;
      const currency = cur.currency;
      const ready = await readyWallet(owner, currency);
      if (ready.ok === false) return ready;
      const wallet = ready.wallet;
      const own = legs.filter(l => l.to_wallet === wallet).map(l => l.id);
      if (own.length) return refusal(409, 'PAYS_OWN_WALLET', 'A leg pays the very wallet it would be sent from; Direct.Fund must name another budget wallet.', { orderIds: own });
      const busy = inFlightRefusal(wallet);
      if (busy) return busy;
      const state = await chain.state(wallet);
      if (!state) return refusal(503, 'CHAIN_UNKNOWN', 'The LANA network could not be read right now; try again shortly.');
      // Something out of the wallet waits to confirm: its coins are not what they seem until it does.
      if (state.balance.unconfirmed !== 0n) {
        return refusal(409, 'WALLET_UNCONFIRMED', 'A payment into or out of this wallet is not confirmed yet; prepare again once it is.', { unconfirmed: state.balance.unconfirmed.toString() });
      }
      const judged = await mustSpendNow(legs, wallet, state);
      if (judged.ok === false) return judged;
      const must = judged.must;
      if (must.blockedOrderIds.length) {
        return refusal(409, 'RELEASED_SEND_LIVE', 'An earlier send of these legs is on the LANA network after all; they wait for it.', { orderIds: must.blockedOrderIds, txids: must.live });
      }
      if (must.foreign.length) return otherWalletRefusal(must.foreign);

      const confirmed = state.unspent.filter(c => c.height > 0);
      const byValue = (a: { value: bigint; txid: string; vout: number }, b: { value: bigint; txid: string; vout: number }) =>
        a.value > b.value ? -1 : a.value < b.value ? 1 : a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout;
      const worth = confirmed.filter(c => c.value > INPUT_FEE_LANOSHIS).sort(byValue);
      const listed = worth.slice(0, MAX_COINS_LISTED);
      // A coin a binding set names is always offered, even below the 40 largest.
      for (const set of must.binding) {
        for (const key of set) {
          const coin = worth.find(c => outpointKey(c.txid, c.vout) === key);
          if (coin && !listed.includes(coin)) listed.push(coin);
        }
      }
      const unlisted = worth.filter(c => !listed.includes(c));
      const raws = await chain.rawTxs(listed.map(c => c.txid));
      const read: ListedCoin[] = listed.map(c => ({ ...c, rawTx: raws.get(c.txid) ?? '' }));
      // Read here too, as the browser will: a coin whose transaction is missing or says otherwise is no coin — and one
      // paid to the wallet's public key (a staking reward) is left out and counted, never a reason to refuse the rest.
      const verified = verifiedCoins(read, wallet);
      if (verified.ok === false) return refusal(503, 'CHAIN_UNKNOWN', 'The wallet\'s coins could not be read in full; try again shortly.');
      const skippedKeys = new Set(verified.skipped.map(c => outpointKey(c.txid, c.vout)));
      let offered = read.filter(c => !skippedKeys.has(outpointKey(c.txid, c.vout)));

      const allocations = mergedAllocations(legs);
      const allocationList: Allocation[] = allocations.map(a => ({ address: a.wallet, lanoshis: BigInt(a.lanoshis) }));
      if (must.binding.length) {
        // The browser plans largest coins first (shared/lana-tx/select.ts). Offer the coins so that the plan it will
        // make spends a coin of every set — the announce refuses any send that does not.
        const prevoutsOf = (coins: ListedCoin[]): Prevout[] => {
          const v = verifiedCoins(coins, wallet);
          return v.ok === true ? v.coins : [];
        };
        const hits = (coins: ListedCoin[]): boolean => {
          const plan = planPayout({ from: wallet, coins: prevoutsOf(coins), allocations: allocationList, nowSec: nowSec(), step: LEG_LANOSHI_STEP });
          return plan.ok === true && unmetMustSpend(must.binding, plan.coins.map(c => outpointKey(c.txid, c.vout))).length === 0;
        };
        if (!hits(offered)) {
          let narrowed: ListedCoin[] | null = null;
          if (must.binding.length === 1) {
            // The largest coin of the set first: every coin larger than it is left out of this send, so the plan's
            // first coin is that one.
            const candidates = offered.filter(c => must.binding[0].includes(outpointKey(c.txid, c.vout))).sort(byValue);
            const anchor = candidates[0];
            if (anchor) {
              const n = offered.filter(c => c === anchor || byValue(anchor, c) < 0);
              if (hits(n)) narrowed = n;
            }
          }
          if (!narrowed) {
            return refusal(409, 'MUST_SPEND_UNMET', 'These legs were in sends that were refused; a new send of them must spend one of those coins, and no plan from this wallet does. Send the purchases of each earlier send on their own.', {
              mustSpend: must.binding,
            });
          }
          offered = narrowed;
        }
      }
      const sum = (list: readonly { value: bigint }[]) => list.reduce((s, c) => s + c.value, 0n).toString();
      const paying = legs.reduce((s, l) => s + lanoshisOf(l), 0n);
      return {
        ok: true,
        body: {
          currency,
          wallet,
          nowSec: nowSec(),
          balance: { confirmed: state.balance.confirmed.toString(), unconfirmed: state.balance.unconfirmed.toString() },
          coins: offered.map(c => ({ txid: c.txid, vout: c.vout, value: c.value.toString(), height: c.height, rawTx: c.rawTx })),
          skipped: { count: verified.skipped.length, value: sum(verified.skipped as Coin[]) },
          unlisted: { count: unlisted.length, value: sum(unlisted) },
          allocations,
          legs: legs.map(l => ({ orderId: l.id, transactionRef: l.transaction_ref as string, orderType: l.order_type, toWallet: l.to_wallet, toHex: l.to_hex, lanoshis: String(l.lana_amount), mustSpend: !!l.must_spend_json })),
          payingLanoshis: paying.toString(),
          maxFee: payoutMaxFee(Math.max(1, allocations.length)).toString(),
          mustSpend: must.binding,
          limits: LIMITS,
        },
      };
    },

    async announce(owner, input) {
      const body = (input ?? {}) as Record<string, unknown>;
      const rawIn = body.rawTx ?? body.raw_tx;
      const rawTx = typeof rawIn === 'string' ? rawIn.trim().toLowerCase() : '';
      if (!HEX.test(rawTx) || rawTx.length / 2 > MAX_TX_BYTES) return refusal(400, 'BAD_TX', 'rawTx must be one signed transaction in hex.');
      let tx: LanaTx;
      try {
        tx = decodeTx(rawTx);
      } catch {
        return refusal(400, 'BAD_TX', 'rawTx does not read as a LANA transaction.');
      }
      const txid = txidOfRaw(rawTx);
      const idsIn = body.orderIds ?? body.order_ids;

      // The same transaction again (a double click, an answer that did not come): the same send, nothing done twice.
      const before = rowOf(txid);
      if (before) {
        const sameSet = Array.isArray(idsIn) && [...idsIn].map(String).sort().join(',') === [...jsonList(before.order_ids_json)].sort().join(',');
        if (before.sender === 'financer' && lc(before.owner_hex) === owner && sameSet) return { ok: true, send: viewOf(before), already: true };
        return refusal(409, 'CONFLICT', 'This transaction is already recorded for other legs.', { txid });
      }

      const req = legsOfRequest(owner, idsIn);
      if (req.ok === false) return req;
      const legs = req.legs;
      // The wallet of THESE purchases' currency: a GBP purchase is never announced from the EUR wallet.
      const cur = currencyOfLegs(legs);
      if (cur.ok === false) return cur;
      const ready = await readyWallet(owner, cur.currency);
      if (ready.ok === false) return ready;
      const wallet = ready.wallet;
      const busy = inFlightRefusal(wallet);
      if (busy) return busy;

      // The wallet now: nothing out of it waiting, and every coin spent a confirmed coin of it.
      const state = await chain.state(wallet);
      if (!state) return refusal(503, 'CHAIN_UNKNOWN', 'The LANA network could not be read right now; announce the same transaction again shortly.');
      if (state.balance.unconfirmed !== 0n) return refusal(409, 'WALLET_UNCONFIRMED', 'A payment into or out of this wallet is not confirmed yet.', { unconfirmed: state.balance.unconfirmed.toString() });
      const listed = new Set(state.unspent.filter(c => c.height > 0).map(c => outpointKey(c.txid, c.vout)));
      const inputs = tx.inputs.map(i => outpointKey(i.prevTxid, i.vout));
      const unavailable = inputs.filter(key => !listed.has(key));
      if (unavailable.length) return refusal(409, 'COIN_UNAVAILABLE', 'A coin this transaction spends is not a confirmed coin of your wallet now.', { outpoints: unavailable });
      const judged = await mustSpendNow(legs, wallet, state);
      if (judged.ok === false) return judged;
      const must = judged.must;
      if (must.blockedOrderIds.length) {
        return refusal(409, 'RELEASED_SEND_LIVE', 'An earlier send of these legs is on the LANA network after all; they wait for it.', { orderIds: must.blockedOrderIds, txids: must.live });
      }
      if (must.foreign.length) return otherWalletRefusal(must.foreign);
      const unmet = unmetMustSpend(must.binding, inputs);
      if (unmet.length) {
        return refusal(409, 'MUST_SPEND_UNMET', 'These legs were in a send that was refused; a new send of them must spend one of its coins. Prepare again.', { mustSpend: unmet });
      }

      // Each coin read from its own previous transaction, fetched here and re-hashed to its id.
      const parents = await chain.rawTxs(tx.inputs.map(i => i.prevTxid));
      let prevouts: Prevout[];
      try {
        prevouts = tx.inputs.map(i => prevoutFromRawTx(parents.get(i.prevTxid) ?? '', i.prevTxid, i.vout));
      } catch {
        return refusal(503, 'CHAIN_UNKNOWN', 'A coin this transaction spends could not be read; announce the same transaction again shortly.');
      }
      // Against the legs as they are NOW: a leg redirected or changed since prepare gives other outputs.
      const checked = checkPayoutTx({ rawTx, allocations: perLegAllocations(legs), prevouts, from: wallet, nowSec: nowSec(), step: LEG_LANOSHI_STEP });
      if (checked.ok === false) {
        const codes = checked.code === 'SHAPE' ? [...new Set(checked.problems.map(p => p.code))]
          : checked.code === 'ALLOCATIONS' ? [...new Set(checked.problems.map(p => p.code))] : [checked.code];
        if (checked.code === 'SHAPE' && codes.some(c => c === 'OUTPUT_COUNT' || c === 'OUTPUT_ADDRESS' || c === 'OUTPUT_VALUE')) {
          return refusal(409, 'LEGS_CHANGED', 'The legs changed since this send was prepared (a wallet or an amount); prepare and sign again.', { codes });
        }
        return refusal(checked.code === 'MALFORMED' ? 400 : 422, 'TX_REFUSED', `The transaction is not the send these legs need: ${checked.detail}`.slice(0, 500), { codes });
      }

      // ONE database transaction: each leg moved to this send — exactly one row each, as it was checked — and the send.
      try {
        db.transaction(() => {
          if (rowOf(txid)) throw new Refused(refusal(409, 'CONFLICT', 'This transaction was recorded meanwhile.', { txid }));
          const busyNow = inFlightRefusal(wallet);
          if (busyNow) throw new Refused(busyNow);
          const move = db.prepare(`
            UPDATE brain_lana_orders SET status = 'sending', send_txid = ?
            WHERE id = ? AND status = 'pending' AND send_txid IS NULL AND brain_authorized = 1
              AND to_wallet = ? AND lana_amount = ?
              AND EXISTS (SELECT 1 FROM purchase_settlement ps
                          WHERE ps.transaction_ref = brain_lana_orders.transaction_ref AND ps.settled_by = 'financer' AND ps.owner_hex = ?)
          `);
          for (const l of legs) {
            if (move.run(txid, l.id, l.to_wallet, l.lana_amount, owner).changes !== 1) {
              throw new Refused(refusal(409, 'LEGS_CHANGED', 'A leg changed while the send was being checked (cancelled, redirected or sent); nothing was sent. Prepare again.', { orderIds: [l.id] }));
            }
          }
          const at = nowSql();
          db.prepare(`
            INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis, state, broadcasts, created_at, updated_at)
            VALUES (?, 'financer', ?, ?, ?, ?, ?, ?, ?, 'announced', 0, ?, ?)
          `).run(txid, owner, wallet, rawTx, JSON.stringify(legs.map(l => l.id)), JSON.stringify(inputs),
            Number(checked.pay.reduce((s, p) => s + p.lanoshis, 0n)), Number(checked.fee), at, at);
        }).immediate();
      } catch (err) {
        if (err instanceof Refused) return err.refusal;
        if (String((err as Error)?.message ?? '').includes('UNIQUE constraint failed')) return refusal(409, 'CONFLICT', 'This transaction was recorded meanwhile.', { txid });
        throw err;
      }
      log(`[lana-discount] send ${short(txid)} announced by ${owner.slice(0, 8)}…: ${legs.length} leg(s), ${checked.pay.length} wallet(s), ${tx.inputs.length} coin(s)`);
      // Only now broadcast: whatever it answers, the send is kept (refused and held by no server: released at once).
      await broadcastRow(rowOf(txid) as SendRow);
      return { ok: true, send: viewOf(rowOf(txid) as SendRow), already: false };
    },

    list(owner) {
      return (db.prepare("SELECT * FROM lana_sends WHERE sender = 'financer' AND owner_hex = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(owner, SENDS_LISTED) as SendRow[]).map(viewOf);
    },

    view(txid) {
      const row = TXID.test(txid) ? rowOf(txid) : undefined;
      return row ? viewOf(row) : null;
    },

    async treasuryCoinRules(wallet, orders, avoid) {
      const inFlight = new Set(inFlightOf(wallet).keys());
      if (!orders.some(o => o.must_spend_json)) return { ok: true, rules: { inFlight, forced: [], blockedOrderIds: [], deferredOrderIds: [] } };
      const state = await chain.state(wallet);
      if (!state) return refusal(503, 'CHAIN_UNKNOWN', 'The treasury wallet could not be read to honour an earlier refused send.');
      const legs = orders.map(o => ({ id: String(o.id), must_spend_json: o.must_spend_json ?? null }));
      const judged = await mustSpendNow(legs, wallet, state);
      if (judged.ok === false) return judged;
      const must = judged.must;
      // A set of the OTHER treasury address (the auto-sender moves between the uncompressed and the compressed one):
      // nothing sent from this one can meet it. The manual button (no list) is refused, as ever. The auto-sender's
      // legs of it wait (deferred, must_spend as it is) and the rest go — recheck of 9. 10. 2026: one cycle from the
      // compressed address with a refused send, and every later cycle from the uncompressed one was skipped whole,
      // fresh purchases too, for as long as that address had coins. They go once a send from that address spends one
      // of its coins (the auto-sender uses it when the uncompressed address lists none) or a transaction proven in a
      // block spends one there; recordTreasurySend refuses any of them from here, whatever the caller.
      if (must.foreign.length && !avoid) return otherWalletRefusal(must.foreign);
      // One coin per binding set — the largest of it that is a confirmed coin now, in no treasury send on its way, and
      // not on the caller's -22 list: after a co-tenant spent a coin in the mempool, forcing that very coin (the
      // largest) got every cycle refused and chained every new purchase to it. A coin already forced for another set
      // meets this one too. None left: its legs wait this cycle (deferred, must_spend as it is) — or, with no list to
      // steer by (the manual button), the send is refused.
      // NOT CLOSED (C4/N4, recheck of 9. 10. 2026): once the 20-minute -22 entries expire, the largest coin is forced
      // again — while the co-tenant's transaction that spends it is still unconfirmed (no expiry on the 2013-era node),
      // that send is refused again with every purchase pending in that cycle, and they all get must_spend holding that
      // coin. It repeats about every fourth cycle until the co-tenant's transaction confirms. Closing it would mean
      // counting refusals per coin in the auto-sender (preferring the coin of the set refused least or longest ago) and
      // sending purchases with a binding set in a transaction of their own, never beside fresh ones.
      const values = new Map(state.unspent.filter(c => c.height > 0).map(c => [outpointKey(c.txid, c.vout), c.value]));
      const byValue = (a: string, b: string) => {
        const va = values.get(a) ?? 0n;
        const vb = values.get(b) ?? 0n;
        return vb > va ? 1 : vb < va ? -1 : a < b ? -1 : a > b ? 1 : 0;
      };
      const forced: string[] = [];
      const unmet: string[][] = [];
      for (const set of must.binding) {
        if (set.some(o => forced.includes(o))) continue;
        const best = set.filter(o => values.has(o) && !inFlight.has(o) && !avoid?.has(o)).sort(byValue)[0];
        if (best) forced.push(best);
        else unmet.push(set);
      }
      const waiting = unmet.filter(set => !set.some(o => forced.includes(o)));
      if (waiting.length && !avoid) {
        return refusal(409, 'MUST_SPEND_UNMET', 'A coin an earlier refused send of these legs spent is not a confirmed coin of the treasury free to spend now; they cannot go yet.', { mustSpend: waiting });
      }
      const keys = new Set([...waiting, ...must.foreign.map(f => f.set)].map(set => [...set].sort().join(',')));
      const deferredOrderIds = legs.filter(l => l.must_spend_json && keys.has([...jsonList(l.must_spend_json)].sort().join(','))).map(l => l.id);
      return { ok: true, rules: { inFlight, forced, blockedOrderIds: must.blockedOrderIds, deferredOrderIds } };
    },

    async recordTreasurySend(r) {
      const rawTx = String(r.rawTx || '').toLowerCase();
      let inputs: string[];
      let txid: string;
      try {
        decodeTx(rawTx);
        inputs = inputsOf(rawTx);
        txid = txidOfRaw(rawTx);
      } catch {
        return refusal(500, 'BAD_TX', 'The treasury transaction does not read.');
      }
      if (r.orders.length === 0) return refusal(400, 'NO_LEGS', 'No legs to record.');
      // Must-spend, against the wallet now: a leg released from a refused send goes only in a send that conflicts with it.
      const carried = db.prepare(`SELECT id, must_spend_json FROM brain_lana_orders WHERE id IN (${r.orders.map(() => '?').join(',')})`).all(...r.orders.map(o => o.id)) as Array<{ id: string; must_spend_json: string | null }>;
      if (carried.some(l => l.must_spend_json)) {
        const state = await chain.state(r.wallet);
        if (!state) return refusal(503, 'CHAIN_UNKNOWN', 'The treasury wallet could not be read to honour an earlier refused send.');
        const judged = await mustSpendNow(carried, r.wallet, state);
        if (judged.ok === false) return judged;
        const must = judged.must;
        if (must.blockedOrderIds.length) return refusal(409, 'RELEASED_SEND_LIVE', 'An earlier send of these legs is on the LANA network after all.', { orderIds: must.blockedOrderIds });
        if (must.foreign.length) return otherWalletRefusal(must.foreign);
        const unmet = unmetMustSpend(must.binding, inputs);
        if (unmet.length) return refusal(409, 'MUST_SPEND_UNMET', 'These legs were in a refused send; the new one must spend one of its coins.', { mustSpend: unmet });
      }
      try {
        db.transaction(() => {
          if (rowOf(txid)) throw new Refused(refusal(409, 'CONFLICT', 'This transaction is already recorded.', { txid }));
          const flying = inFlightOf(r.wallet);
          const taken = inputs.filter(k => flying.has(k));
          if (taken.length) throw new Refused(refusal(409, 'COIN_IN_FLIGHT', 'A coin of this transaction is spent by a send still on its way.', { outpoints: taken }));
          // Every leg exactly as it was selected, still the treasury's, still authorised (the auto-sender's own gate).
          const move = db.prepare(`
            UPDATE brain_lana_orders SET status = 'sending', send_txid = ?
            WHERE id = ? AND status = 'pending' AND send_txid IS NULL AND to_wallet = ? AND lana_amount = ?
              AND EXISTS (SELECT 1 FROM purchase_settlement ps
                          WHERE ps.transaction_ref = brain_lana_orders.transaction_ref AND ps.settled_by = 'treasury')
              AND (brain_authorized = 1 OR EXISTS (SELECT 1 FROM incoming_batches ib
                                                   WHERE ib.batch_ref = brain_lana_orders.batch_ref AND ib.status = 'lana_bought'))
          `);
          for (const o of r.orders) {
            if (move.run(txid, o.id, o.to_wallet, o.lana_amount).changes !== 1) {
              throw new Refused(refusal(409, 'LEGS_CHANGED', `Leg ${o.id} changed while the transaction was built (cancelled, redirected or taken by another send); nothing was sent.`, { orderIds: [o.id] }));
            }
          }
          const at = nowSql();
          db.prepare(`
            INSERT INTO lana_sends (txid, sender, owner_hex, wallet_id, raw_tx, order_ids_json, inputs_json, paying_lanoshis, fee_lanoshis, state, broadcasts, created_at, updated_at)
            VALUES (?, 'treasury', NULL, ?, ?, ?, ?, ?, ?, 'announced', 0, ?, ?)
          `).run(txid, r.wallet, rawTx, JSON.stringify(r.orders.map(o => String(o.id))), JSON.stringify(inputs),
            r.orders.reduce((s, o) => s + Number(o.lana_amount), 0), Number(r.feeLanoshis) || 0, at, at);
        }).immediate();
      } catch (err) {
        if (err instanceof Refused) return err.refusal;
        throw err;
      }
      log(`[lana-discount] send ${short(txid)} (treasury) recorded: ${r.orders.length} leg(s), ${inputs.length} coin(s) — broadcasting`);
      return { ok: true, txid };
    },

    async broadcastRecorded(txid) {
      const row = rowOf(txid);
      if (!row || (row.state !== 'announced' && row.state !== 'mempool')) return null;
      return broadcastRow(row);
    },

    async round() {
      const result: RoundResult = { confirmed: [], released: [], sent: [], held: [], stuck: [], lateConfirmed: [] };
      if (roundRunning) return { ...result, skipped: 'BUSY' };
      roundRunning = true;
      const each = async (rows: SendRow[], what: (row: SendRow) => Promise<void>) => {
        for (const row of rows) {
          try {
            await what(row);
          } catch (err) {
            console.error(`[lana-discount] send ${short(row.txid)}: round failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
          }
        }
      };
      try {
        const open = db.prepare("SELECT * FROM lana_sends WHERE state IN ('announced', 'mempool') ORDER BY created_at, rowid").all() as SendRow[];
        const released = db.prepare("SELECT * FROM lana_sends WHERE state = 'released' AND release_reason = 'refused' AND created_at > ? ORDER BY created_at").all(watchSince()) as SendRow[];
        const of = (sender: Sender, rows: SendRow[]) => rows.filter(r => r.sender === sender);
        // The financers' own wallets: nothing else spends them here.
        await each(of('financer', open), row => step(row, result));
        await each(of('financer', released), row => watchReleased(row, result));
        // The treasury's sends only while no treasury send is being built — never beside the auto-sender or the manual
        // button on the same wallet (the send lock both take). Taken, they wait for the next beat.
        const treasuryOpen = of('treasury', open);
        const treasuryReleased = of('treasury', released);
        if (treasuryOpen.length || treasuryReleased.length) {
          if (tryAcquireSendLock('send-round')) {
            try {
              await each(treasuryOpen, row => step(row, result));
              await each(treasuryReleased, row => watchReleased(row, result));
            } finally {
              releaseSendLock('send-round');
            }
          } else result.treasurySkipped = true;
        }
      } finally {
        roundRunning = false;
      }
      return result;
    },
  };
  return sends;
}

const LIMITS: SendableAnswer['limits'] = {
  maxWallets: MAX_PAY_OUTPUTS,
  maxLegs: MAX_ORDER_IDS,
  maxInputs: MAX_INPUTS,
  dustLanoshis: DUST_LANOSHIS.toString(),
  stepLanoshis: LEG_LANOSHI_STEP.toString(),
};

/** At most this many purchases named by ownerMismatchPurchases (the count is of all). */
export const OWNER_MISMATCH_LISTED = 50;

/**
 * Purchases Direct.Fund lists in a batch a financer confirmed that nobody owns here and whose investor leg names
 * another investor (recheck of 9. 10. 2026, M2): their legs have no route — the treasury door refuses the batch
 * (OWNER_CONFLICT), the other financer cannot confirm what Direct.Fund lists in this one's batch, and this financer's
 * repeat is refused OWNER_MISMATCH. Which batch a purchase nobody owns is in only Direct.Fund says, read by GET
 * /api/financer/batches, which notes them here (purchase → that batch's financer); ownerMismatchPurchases names them
 * while they still are so. Process-local: after a restart they are noted again at the financer's next look.
 */
const unownedMismatchSeen = new Map<string, string>();
/** Notes kept at most; the oldest go first. */
const UNOWNED_MISMATCH_KEPT = 5000;

export function noteUnownedMismatch(ownerHex: string, refs: readonly string[]): void {
  for (const ref of refs) {
    unownedMismatchSeen.delete(ref);
    unownedMismatchSeen.set(ref, String(ownerHex).toLowerCase());
    if (unownedMismatchSeen.size > UNOWNED_MISMATCH_KEPT) unownedMismatchSeen.delete(unownedMismatchSeen.keys().next().value as string);
  }
}

/** Tests only: forget every note of noteUnownedMismatch. */
export function forgetUnownedMismatches(): void {
  unownedMismatchSeen.clear();
}

/**
 * Financer-owned purchases nobody can send (recheck of 9. 10. 2026): purchase_settlement says a financer settles them,
 * a leg of theirs is still pending, and their live investor_lana leg now pays ANOTHER financer — the brain moved it
 * after the confirm. The owner's /financer no longer offers them (sendableLegs: OWNER_MISMATCH), the other financer's
 * confirm skips them, and being owned they are no "unowned" order either: every leg of them — the merchant's, the
 * caretaker's, the cashback — stays pending, unseen, until an administrator settles them. The same test as
 * sendableLegs' FOREIGN_INVESTOR, against each purchase's own owner. Oldest first; then the purchases nobody owns of a
 * financer's confirmed batch whose investor leg names another investor (noteUnownedMismatch, M2) — stuck the same
 * way. `refs` at most OWNER_MISMATCH_LISTED.
 */
export function ownerMismatchPurchases(db: Database.Database): { count: number; refs: string[] } {
  const rows = db.prepare(`
    SELECT ps.transaction_ref FROM purchase_settlement ps
    WHERE ps.settled_by = 'financer'
      AND EXISTS (SELECT 1 FROM brain_lana_orders p WHERE p.transaction_ref = ps.transaction_ref AND p.status = 'pending')
      AND ${foreignInvestorSql('ps.transaction_ref', 'LOWER(ps.owner_hex)')}
    ORDER BY ps.created_at, ps.transaction_ref
  `).all() as Array<{ transaction_ref: string }>;
  const refs = rows.map(r => r.transaction_ref);
  // And those nobody owns, of a financer's confirmed batch (noteUnownedMismatch), as they are now: still owned by
  // nobody, a leg still pending, the investor leg still naming another than that batch's financer. Owned meanwhile:
  // forgotten (the query above judges it from now on).
  if (unownedMismatchSeen.size > 0) {
    const owned = db.prepare('SELECT 1 FROM purchase_settlement WHERE transaction_ref = ?');
    const stuck = db.prepare(`
      SELECT 1 FROM brain_lana_orders p WHERE p.transaction_ref = ? AND p.status = 'pending'
        AND ${foreignInvestorSql('?', '?')}
      LIMIT 1
    `);
    for (const [ref, owner] of unownedMismatchSeen) {
      if (owned.get(ref)) unownedMismatchSeen.delete(ref);
      else if (stuck.get(ref, ref, owner)) refs.push(ref);
    }
  }
  return { count: refs.length, refs: refs.slice(0, OWNER_MISMATCH_LISTED) };
}

/**
 * Sends on their way and those a person must look at, for /api/heartbeat-status — and the financer-owned purchases
 * whose investor leg now pays another financer (ownerMismatchPurchases: ownerMismatchPurchases is their count,
 * ownerMismatchRefs at most OWNER_MISMATCH_LISTED of them).
 */
export function sendsHealth(db: Database.Database, nowMs = Date.now()): {
  inFlight: number; stuck: number; stuckTxids: string[]; ownerMismatchPurchases: number; ownerMismatchRefs: string[];
} {
  const inFlight = (db.prepare("SELECT COUNT(*) AS c FROM lana_sends WHERE state IN ('announced', 'mempool')").get() as { c: number }).c;
  const stuck = db.prepare("SELECT txid FROM lana_sends WHERE state IN ('announced', 'mempool') AND created_at <= ? ORDER BY created_at").all(sqlTime(nowMs - REBROADCAST_FOR_S * 1000)) as Array<{ txid: string }>;
  const mismatch = ownerMismatchPurchases(db);
  return { inFlight, stuck: stuck.length, stuckTxids: stuck.map(s => s.txid), ownerMismatchPurchases: mismatch.count, ownerMismatchRefs: mismatch.refs };
}

// ─── the one instance this process sends with ─────────────────────────────

let instance: Sends | null = null;

/**
 * The production machine: the database, the Electrum servers of the newest KIND 38888 (read at every question),
 * Direct.Fund and the Registrar as configured. ONE per process — the financer routes, the manual button, the
 * auto-sender and the round all use it, so a broadcast running in one is seen by the others.
 */
export function defaultSends(): Sends {
  if (instance) return instance;
  const servers = () => electrumServersFrom(getElectrumServersFromDb());
  const df: DfClientOptions = {};
  const checkBaseUrl = process.env.WALLET_CHECK_BASE_URL || 'https://check.lanapays.us';
  instance = createSends({
    db: getDbHandle(),
    chain: createPayoutChain({ servers }),
    payments: createPaymentReader({ servers }),
    financer: hex => fetchFinancer(hex, df),
    checkWallet: (walletId, ownerHex) => checkFinancerWallet(walletId, ownerHex, { checkBaseUrl }),
  });
  return instance;
}

/** Tests only: the instance defaultSends() answers with (null — build the production one again). */
export function setDefaultSends(sends: Sends | null): void {
  instance = sends;
}
