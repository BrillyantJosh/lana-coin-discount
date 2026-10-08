/**
 * What direct.lana.fund says about a financer and their batches — read FRESH,
 * every time, for a decision that moves money.
 *
 * The admin page's DF feed (/api/admin/incoming-payments) is cached for two
 * minutes and falls back to a stale copy when DF does not answer. That is fine
 * for a list on a screen and wrong for "who owns this purchase" or "has this
 * batch been paid": two minutes is long enough for a batch to be reopened or a
 * purchase to move to another financer. So nothing here caches, nothing falls
 * back, and every answer is checked for the shape we rely on. A field that is
 * missing (a DF not yet carrying it, a partial reply) reads as the SAFE value —
 * a payment without `live: true` is not live — and every failure throws a
 * DfError the caller refuses on. The caller never guesses.
 *
 * Peer calls, authenticated with this server's own key (lib/fundPeer.ts), to
 * three read-only routes DF admits for its peer:
 *   GET /api/admin/batch-by-ref/:batchRef
 *   GET /api/admin/financers/:hexId
 *   GET /api/admin/financers/:hexId/lana-discount-batches
 */
import { DIRECT_FUND_URL } from '../directFund.js';
import { fundPeerHeaders } from '../fundPeer.js';

export const DF_TIMEOUT_MS = 10_000;

export type DfErrorCode = 'DF_UNAVAILABLE' | 'DF_NOT_FOUND' | 'DF_REFUSED' | 'DF_BAD_RESPONSE';

export class DfError extends Error {
  readonly code: DfErrorCode;
  readonly httpStatus?: number;
  constructor(code: DfErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'DfError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface DfClientOptions {
  /** Defaults to DIRECT_FUND_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to fundPeerHeaders() (Authorization: Bearer FUND_PEER_KEY). */
  headers?: () => Record<string, string>;
}

export interface DfBatch {
  batchRef: string;
  /** The financer whose budget settled these purchases (lower-case hex, '' when DF gave none). */
  investorHex: string;
  totalAmount: number;
  currency: string;
  paymentCount: number;
  confirmedCount: number;
  /** open | closed | paid (DF payment_batches.status). */
  status: string;
  /** 'lana_discount' for the internal share; null when DF did not say. */
  destinationType: string | null;
  fundSettingId: number | string | null;
  createdAt: string | null;
  paidAt: string | null;
}

export interface DfBatchPayment {
  ppId: number;
  amount: number;
  currency: string;
  confirmed: boolean;
  confirmedAt: string | null;
  transactionRef: string | null;
  orderType: string | null;
  paymentType: string | null;
  shopName: string | null;
  recipientWallet: string | null;
  /** brain_fiat_orders.investor_hex — lower-case, '' when DF gave none. */
  investorHex: string;
  destinationType: string | null;
  /** brain_fiat_orders.status */
  orderStatus: string | null;
  /** Not cancelled, not superseded. Anything but an explicit true is false. */
  live: boolean;
}

export interface DfBatchByRef {
  batch: DfBatch;
  payments: DfBatchPayment[];
}

export interface DfFinancer {
  hexId: string;
  isInvestor: boolean;
  lanaDiscountWallet: string | null;
  lanaDiscountWalletSetAt: string | null;
}

export interface DfFinancerBatch {
  batchRef: string;
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
}

const BATCH_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;

export function isBatchRef(v: unknown): v is string {
  return typeof v === 'string' && BATCH_REF_RE.test(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
const hex = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const idOrNull = (v: unknown): number | string | null => (typeof v === 'number' || (typeof v === 'string' && v !== '') ? v : null);

async function getJson(path: string, opts: DfClientOptions): Promise<any> {
  const base = String(opts.baseUrl ?? DIRECT_FUND_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method: 'GET',
      // Never a cached copy at any layer between us. (Node's fetch keeps no
      // HTTP cache of its own; the header is for anything in the path.)
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', ...(opts.headers ?? fundPeerHeaders)() },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DF_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new DfError('DF_UNAVAILABLE', `Direct.Fund did not answer (${err?.name === 'TimeoutError' ? 'timeout' : err?.message || err})`);
  }
  if (res.status === 404) throw new DfError('DF_NOT_FOUND', `Direct.Fund: not found (${path.split('/').slice(0, 4).join('/')}…)`, 404);
  if (res.status === 401 || res.status === 403) throw new DfError('DF_REFUSED', `Direct.Fund refused this server (HTTP ${res.status}) — is FUND_PEER_KEY set and allowed there?`, res.status);
  if (!res.ok) throw new DfError('DF_UNAVAILABLE', `Direct.Fund answered HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund answered with something that is not JSON');
  }
}

/** Pure: DF's batch-by-ref answer, checked. Exported for tests. */
export function parseBatchByRef(data: any, askedRef: string): DfBatchByRef {
  const b = data?.batch;
  if (!b || typeof b !== 'object') throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund batch answer has no batch');
  if (b.batchRef !== askedRef) throw new DfError('DF_BAD_RESPONSE', `Direct.Fund answered for batch ${String(b.batchRef)}, not ${askedRef}`);
  if (!Array.isArray(data?.payments)) throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund batch answer has no payments list');
  const batch: DfBatch = {
    batchRef: b.batchRef,
    investorHex: hex(b.investorHex),
    totalAmount: num(b.totalAmount),
    currency: str(b.currency) ?? '',
    paymentCount: num(b.paymentCount),
    confirmedCount: num(b.confirmedCount),
    status: str(b.status) ?? '',
    destinationType: str(b.destinationType),
    fundSettingId: idOrNull(b.fundSettingId),
    createdAt: str(b.createdAt),
    paidAt: str(b.paidAt),
  };
  const payments: DfBatchPayment[] = data.payments.map((p: any) => ({
    ppId: num(p?.ppId),
    amount: num(p?.amount),
    currency: str(p?.currency) ?? '',
    confirmed: p?.confirmed === true,
    confirmedAt: str(p?.confirmedAt),
    transactionRef: str(p?.transactionRef),
    orderType: str(p?.orderType),
    paymentType: str(p?.paymentType),
    shopName: str(p?.shopName),
    recipientWallet: str(p?.recipientWallet),
    investorHex: hex(p?.investorHex),
    destinationType: str(p?.destinationType),
    orderStatus: str(p?.orderStatus),
    live: p?.live === true,
  }));
  return { batch, payments };
}

/** One batch and its payments, as DF has them NOW. Throws DfError. */
export async function fetchBatchByRef(batchRef: string, opts: DfClientOptions = {}): Promise<DfBatchByRef> {
  if (!isBatchRef(batchRef)) throw new DfError('DF_NOT_FOUND', 'Not a batch reference');
  return parseBatchByRef(await getJson(`/api/admin/batch-by-ref/${encodeURIComponent(batchRef)}`, opts), batchRef);
}

/** Is this hex a financer on DF, and which Lana.Discount wallet did they choose. Throws DfError. */
export async function fetchFinancer(hexId: string, opts: DfClientOptions = {}): Promise<DfFinancer> {
  const h = hex(hexId);
  if (!HEX_RE.test(h)) throw new DfError('DF_NOT_FOUND', 'Not a hex id');
  const d = await getJson(`/api/admin/financers/${h}`, opts);
  if (!d || typeof d !== 'object' || hex(d.hexId) !== h) throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund financer answer is for somebody else');
  if (typeof d.isInvestor !== 'boolean') throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund financer answer has no isInvestor');
  return {
    hexId: h,
    isInvestor: d.isInvestor,
    lanaDiscountWallet: str(d.lanaDiscountWallet),
    lanaDiscountWalletSetAt: str(d.lanaDiscountWalletSetAt),
  };
}

/** The financer's lana_discount batches on DF, newest first (DF caps at 500). Throws DfError. */
export async function fetchFinancerBatches(hexId: string, opts: DfClientOptions = {}): Promise<DfFinancerBatch[]> {
  const h = hex(hexId);
  if (!HEX_RE.test(h)) throw new DfError('DF_NOT_FOUND', 'Not a hex id');
  const d = await getJson(`/api/admin/financers/${h}/lana-discount-batches`, opts);
  if (!Array.isArray(d?.batches)) throw new DfError('DF_BAD_RESPONSE', 'Direct.Fund batches answer has no list');
  return d.batches
    .filter((b: any) => isBatchRef(b?.batchRef))
    .map((b: any): DfFinancerBatch => ({
      batchRef: b.batchRef,
      status: str(b.status) ?? '',
      currency: str(b.currency) ?? '',
      totalAmount: num(b.totalAmount),
      paymentCount: num(b.paymentCount),
      confirmedCount: num(b.confirmedCount),
      fundSettingId: idOrNull(b.fundSettingId),
      createdAt: str(b.createdAt),
      closedAt: str(b.closedAt),
      paidAt: str(b.paidAt),
      transactionRefs: Array.isArray(b.transactionRefs)
        ? [...new Set<string>(b.transactionRefs.filter((r: unknown) => typeof r === 'string' && r.trim() !== '').map((r: string) => r.trim()))]
        : [],
    }));
}

/** What a route tells the browser when DF could not be asked; 404 stays 404, the rest is 502. */
export function dfHttpStatus(err: unknown): number {
  return err instanceof DfError && err.code === 'DF_NOT_FOUND' ? 404 : 502;
}
