/**
 * /financer's calls to lana.discount — every one signed (src/lib/nip98Fetch.ts),
 * because the signer IS the financer: the server answers only about the key
 * that signed (server/lib/financer/requireSigner.ts), never about a hex a body
 * or a query names.
 *
 * The answers' shapes are written out here rather than imported from the
 * server, whose modules pull the database and Node in with them; each names the
 * server file it mirrors. Lanoshis come as strings of digits and are read with
 * payoutView.ts readLanoshis, never as floats.
 *
 * NO KEY PASSES HERE. What goes out is batch references, leg ids and, for a
 * send, the SIGNED transaction — public the moment it is sent. The wallet's key
 * is read and used in src/lib/financer/payoutKey.ts only
 * (keyStaysInBrowser.test.ts holds every line of this file to that).
 *
 * A call never throws: a request that got no answer at all comes back with
 * `status: null`, which the send step treats as "maybe stored"
 * (payoutView.ts announceInDoubt) — never as "refused".
 */
import { signedFetch } from '@/lib/nip98Fetch';
import type { PreparedSend } from './payoutView';

/** What a call came back with: the HTTP status (null when no answer came) and the JSON, if any. */
export interface Answer<T> {
  status: number | null;
  data: T | null;
  /** The server's refusal, when it said one (code + English for the log; the page words the code itself). */
  refusal: { code: string | null; error: string | null; reason: string | null; [extra: string]: unknown } | null;
}

async function ask<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await signedFetch(path, init);
  } catch {
    return { status: null, data: null, refusal: null };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return { status: res.status, data: json as T, refusal: null };
  const said = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return { status: res.status, data: null, refusal: { ...said, code: text(said.code), error: text(said.error), reason: text(said.reason) } };
}

const post = <T>(path: string, payload: unknown): Promise<Answer<T>> => {
  const text = JSON.stringify(payload);
  return ask<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
};

/* ── GET /api/financer/me (server/routes/financer.ts) ─────────────────────── */

/** server/lib/financer/registrarWallet.ts FinancerWalletCheck. */
export interface WalletCheck {
  ok: boolean;
  reason?: 'NO_WALLET' | 'REGISTRAR_UNKNOWN' | 'WALLET_FROZEN' | 'WRONG_WALLET_TYPE' | 'WRONG_OWNER' | string;
  walletType?: string;
  frozen?: boolean;
  freezeReason?: string;
}

export interface FinancerMe {
  hexId: string;
  /** Direct.Fund knows this key as a financer. */
  isFinancer: boolean;
  /** The Lana.Discount wallet they chose on Direct.Fund, or null. */
  lanaDiscountWallet: string | null;
  lanaDiscountWalletSetAt: string | null;
  walletCheck: WalletCheck;
}

/* ── GET /api/financer/batches ────────────────────────────────────────────── */

export interface LegStats {
  total: number;
  pending: number;
  /** Pending AND approved by the brain: what can be sent now. */
  authorized: number;
  sending: number;
  sent: number;
  cancelled: number;
}

/** server/routes/financer.ts WaitingPart: a part of a purchase not paid on Direct.Fund yet. */
export interface WaitingPart {
  /** The Direct.Fund batch it is in; null: in no batch there yet. */
  batchRef: string | null;
  /** open | closed | paid; null with no batch. */
  batchStatus: string | null;
  /** lana_purchase, merchant_payment, merchant_commission, caretaker_via_discount, … ('' when Direct.Fund said none). */
  orderType: string;
  /** 'bank' (a bank transfer) or 'lana_discount' (internal); null when Direct.Fund did not say. */
  destinationType: string | null;
  amount: number;
  currency: string;
  transactionRef: string;
}

export interface FinancerBatch {
  batchRef: string;
  /** Direct.Fund's status: open → closed → paid ("I Have Paid This Batch"). */
  status: string;
  currency: string;
  totalAmount: number;
  paymentCount: number;
  confirmedCount: number;
  fundSettingId: number | string | null;
  createdAt: string | null;
  closedAt: string | null;
  paidAt: string | null;
  transactionRefs: string[];
  ld: {
    /** Confirmed here by this financer. */
    confirmed: boolean;
    settledBy: 'financer' | 'treasury' | null;
    status: string | null;
    receivedAt: string | null;
    /**
     * Who settles its purchases here. `unclaimed`: nobody yet — on a batch you confirmed, the ones Direct.Fund did not
     * count then (moved by a reallocation, say), left out of your confirmation (review N7); `retakeable` of them a repeat
     * confirmation could take. `cancelled` (review M5): nobody's purchases whose every payment here is cancelled — never
     * counted in `unclaimed`, never offered again; they need nothing. Both optional: a server before them sends neither
     * (`retakeable` then reads as `unclaimed`, `cancelled` as 0).
     */
    purchases: { total: number; mine: number; treasury: number; other: number; unclaimed: number; retakeable?: number; cancelled?: number };
    /** The unclaimed purchases by reference (the cancelled ones not among them), at most the server's MAX_UNCLAIMED_REFS (50); the count is whole. */
    unclaimedRefs: string[];
    /** On a batch you confirmed: the legs of YOUR purchases only. */
    legs: LegStats;
    /**
     * On a batch you confirmed whose purchases wait for the approval: the parts of them Direct.Fund does not have as
     * paid yet. `[]`: it has every part paid (the approval comes by itself). null — or absent, from a server before
     * it — when Direct.Fund could not be asked: the page keeps its general sentence.
     */
    waitingOn?: WaitingPart[] | null;
  };
  /**
   * Lana.Discount's administrator decides who settles it (server/lib/financer/confirm.ts heldBatches: it may already
   * have been paid to the treasury's bank account). Never canConfirm then; a confirm is refused BATCH_HELD.
   */
  held: boolean;
  /** Paid on Direct.Fund, not yet confirmed here, nobody else's, and not held. */
  canConfirm: boolean;
  /**
   * Confirmed by you, and a repeat confirmation (the same call, the same reference) would change something: take in a
   * purchase nobody settles here yet, or send again the notice to the brain that the batch is paid, which stopped
   * while a purchase of it still waits for approval (review N7/N9).
   */
  canConfirmAgain: boolean;
  /**
   * Confirmed by you, and the notice to the brain that the batch is paid stopped while a purchase of it still waits
   * for approval: a repeat confirmation sends it again (review M7 — said whenever true, beside the unclaimed purchases
   * when there are both). Optional: a server before it sends none.
   */
  resendStopped?: boolean;
}

/** server/lib/financer/confirm.ts ConfirmResult. */
export interface ConfirmResult {
  batchRef: string;
  ok: boolean;
  code?: string;
  error?: string;
  alreadyConfirmed?: boolean;
  transactionRefs?: string[];
  /**
   * Only when not empty: purchases (and Direct.Fund's payment ids) of this batch Direct.Fund no longer counts —
   * cancelled, or moved by a reallocation — left out of the confirmation and nobody's here.
   */
  skippedRefs?: string[];
  skippedPaymentIds?: number[];
}

/* ── the sends (server/lib/financer/sends.ts) ─────────────────────────────── */

export type SendState = 'announced' | 'mempool' | 'confirmed' | 'released';

/** sends.ts SendView. */
export interface SendView {
  txid: string;
  sender: 'treasury' | 'financer';
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
  stuck: boolean;
  /**
   * The transaction on the chain that paid its legs: `txid`, or — confirmed as a copy of it (the same payment under
   * other signatures) — the copy's id. The one an explorer link opens.
   */
  chainTxid: string;
}

/** sends.ts SendableLeg. */
export interface SendableLeg {
  orderId: string;
  orderType: string;
  toWallet: string;
  toHex: string;
  lanoshis: string;
  mustSpend: boolean;
}

/** sends.ts SendablePurchase. */
export interface SendablePurchase {
  transactionRef: string;
  batchRef: string | null;
  legs: SendableLeg[];
  lanoshis: string;
  wallets: number;
  belowDustAlone: boolean;
}

export interface SendLimits {
  maxWallets: number;
  /** The payments (legs) one send may carry (sends.ts MAX_ORDER_IDS); more is refused BAD_ORDER_IDS. */
  maxLegs: number;
  maxInputs: number;
  dustLanoshis: string;
  stepLanoshis: string;
}

/** sends.ts SendableAnswer. */
export interface SendableAnswer {
  wallet: string | null;
  walletProblem: 'NO_WALLET' | 'DF_UNAVAILABLE' | null;
  balance: { confirmed: string; unconfirmed: string } | null;
  purchases: SendablePurchase[];
  totalLanoshis: string;
  legCount: number;
  wallets: number;
  shortfallLanoshis: string;
  inFlight: SendView[];
  limits: SendLimits;
}

/** sends.ts PrepareAnswer: what the browser signs from (payoutView.ts reads its PreparedSend part). */
export interface PrepareAnswer extends PreparedSend {
  balance: { confirmed: string; unconfirmed: string };
  coins: { txid: string; vout: number; value: string; height: number; rawTx: string }[];
  allocations: { wallet: string; lanoshis: string; orderIds: string[] }[];
  skipped: { count: number; value: string };
  unlisted: { count: number; value: string };
  legs: (SendableLeg & { transactionRef: string })[];
  payingLanoshis: string;
  maxFee: string;
  mustSpend: string[][];
  limits: SendLimits;
}

export const financerApi = {
  me: () => ask<FinancerMe>('/api/financer/me'),
  batches: () => ask<{ batches: FinancerBatch[] }>('/api/financer/batches'),
  /** Only the references go: the server builds every batch from Direct.Fund's own fresh answer. */
  confirm: (batchRefs: string[]) => post<{ results: ConfirmResult[] }>('/api/financer/batches/confirm', { batchRefs }),
  sendable: () => ask<SendableAnswer>('/api/financer/sendable'),
  prepare: (orderIds: string[]) => post<PrepareAnswer>('/api/financer/sends/prepare', { orderIds }),
  /** The signed transaction and the legs it pays — the same bytes again when an answer did not come. */
  announce: (orderIds: string[], rawTx: string) => post<{ send: SendView; already: boolean }>('/api/financer/sends', { orderIds, rawTx }),
  sends: () => ask<{ sends: SendView[] }>('/api/financer/sends'),
};

/** A transaction on the LANA block explorer, as the admin pages link it. */
export const txUrl = (txid: string): string => `https://chainz.cryptoid.info/lana/tx.dws?${txid}`;

/** Where a financer pays and closes their batches, and chooses their wallet. */
export const DIRECT_FUND_URL = 'https://direct.lana.fund';
