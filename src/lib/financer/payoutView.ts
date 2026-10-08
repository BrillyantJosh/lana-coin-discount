/**
 * The financer's send on /financer as the page reads it: the coins of their
 * Lana.Discount wallet, what the send will be (the network fee, what goes back
 * to the wallet, what stays in it) before the key is asked for, the page's own
 * check of the bytes it signed, and when an announce must be repeated with the
 * SAME bytes.
 *
 * Brilly's decisions of 8. 10. 2026: the financer pays every leg of the
 * purchases they confirmed — the purchase, the caretaker, the commissions, the
 * customer's cashback and their own budget's investor_lana — signing in the
 * browser, the key never on our server. The server's prepare answer lists the coins (each
 * with the raw transaction that made it), what each wallet gets (the legs as the
 * database holds them now) and its own clock; this file turns that into the
 * transaction the page will sign, with the very functions that sign and check
 * it (server/shared/lana-tx), so the fee, the change and what stays in the
 * wallet shown are the ones that will be signed.
 *
 * WHERE IT COMES FROM. Krog Menjave's src/lib/payoutView.ts (origin/main
 * a46f618), cut to what lana.discount needs. Krog Menjave's admin TYPES the
 * amount of each purchase and its page words its own refusals; here the amounts
 * are the brain's legs — never typed, never rounded — and the words are the
 * page's (src/copy.ts), so this file returns codes. What is kept as it was:
 *   - every coin is read from its own transaction (shared/lana-tx/select.ts
 *     verifiedCoins: a value the server only claimed is never believed);
 *   - the payout is planned by planPayout, the function signPayoutTx builds
 *     with, at the SERVER's clock (serverNowSec), never this device's;
 *   - an announce whose answer did not come is repeated with the same signed
 *     bytes, never a new signature over the same legs.
 * What is lana.discount's own: the step. A leg is a whole number of LANOSHIS
 * (1,004,492,188 — the brain's figure), so every plan and check here passes
 * LEG_LANOSHI_STEP (1 lanoshi), never Krog Menjave's 1,000.
 *
 * Pure: no key, no request, no clock but the one passed in. Money is lanoshis as
 * bigint; what the server sends as JSON (a string of digits, or a whole number)
 * is read strictly, never as a float.
 */
import { verifiedCoins, type ListedCoin } from '../../../server/shared/lana-tx/select.ts';
import { checkPayoutTx, planPayout, type PayoutCheck, type PayoutPlan } from '../../../server/shared/lana-tx/payout.ts';
import { feeFor, MAX_INPUTS } from '../../../server/shared/lana-tx/fee.ts';
import { LEG_LANOSHI_STEP, MAX_PAY_OUTPUTS, type Allocation } from '../../../server/shared/lana-tx/payments.ts';
import type { Prevout } from '../../../server/shared/lana-tx/shape.ts';

/** 1 LANA in lanoshis. */
export const LANOSHIS_PER_LANA = 100_000_000n;
/**
 * The coins and the server's clock are read again before the key is asked for when they are older than this: a leg
 * may have been cancelled or redirected meanwhile (the server refuses the send then, LEGS_CHANGED).
 */
export const FRESH_BEFORE_KEY_MS = 10 * 60 * 1000;
/**
 * Older than this, nothing is signed with them: they are read again first. The server takes a send dated at most an
 * hour behind its clock (shared/lana-tx/shape.ts); half of that leaves room for a slow device.
 */
export const STALE_MS = 30 * 60 * 1000;
/** How often the page asks how a send on its way stands, while it is in view. */
export const POLL_MS = 30 * 1000;

/** The server's clock now, in seconds: what it said, plus the time that passed on this device since — for the send's nTime. */
export function serverNowSec(nowSec: number, receivedAt: number, nowMs: number): number {
  return nowSec + Math.max(0, Math.floor((nowMs - receivedAt) / 1000));
}

/**
 * Lanoshis as LANA, exact: every digit but trailing zeros, at least two decimals, grouped as this site writes money
 * (src/lib/money.ts formatLana: "," between thousands, "." before the decimals). 100449218800n → "1,004.492188".
 */
export function lanoshisText(lanoshis: bigint): string {
  const negative = lanoshis < 0n;
  const abs = negative ? -lanoshis : lanoshis;
  const whole = (abs / LANOSHIS_PER_LANA).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % LANOSHIS_PER_LANA).toString().padStart(8, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Lanoshis as the server writes them in JSON: a string of digits, or a whole number JavaScript holds exactly. Null for
 * anything else — never a float rounded into money.
 */
export function readLanoshis(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d{1,19}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/* ── the server's prepare answer ──────────────────────────────────────────── */

/** One coin of the financer's wallet, as the server listed it, with the raw transaction that made it. */
export interface PreparedCoin {
  txid: string;
  vout: number;
  /** Lanoshis (a claim until the raw transaction is re-hashed: verifiedCoins). */
  value: string | number;
  /** ≤ 0: not confirmed. */
  height: number;
  rawTx: string;
}

/** What one wallet gets from this send: the legs of the chosen purchases to it, added up by the server. */
export interface PreparedAllocation {
  wallet: string;
  lanoshis: string | number;
  /** The legs (brain_lana_orders ids) this allocation pays: what the announce names, and lana-sent reports. */
  orderIds: string[];
}

/** What POST /api/financer/sends/prepare answers — the part this file reads. */
export interface PreparedSend {
  /** The financer's Lana.Discount wallet: every coin is its, the change goes back to it, its key signs. */
  wallet: string;
  coins: PreparedCoin[];
  allocations: PreparedAllocation[];
  /** The server's clock, seconds UTC, when it answered. */
  nowSec: number;
  /**
   * The wallet's coins the server did NOT list: it lists the 40 largest worth spending (sends.ts MAX_COINS_LISTED),
   * twice what one send can spend. Lanoshis as digits.
   */
  unlisted?: { count: number; value: string | number };
  /** Staking coins (paid to the wallet's public key), never listed: they stay in the wallet. */
  skipped?: { count: number; value: string | number };
  /**
   * The wallet's whole confirmed balance, as the server read it: every coin, listed or not — the ones a refused
   * send's coin left out of this send included (review N13). Lanoshis as digits.
   */
  balance?: { confirmed: string | number; unconfirmed?: string | number };
}

/**
 * The wallet's coins, each read from its own transaction — one wrong and none is believed. A coin paid to the wallet's
 * public key (a staking reward) is no lie: it is left out, in `skipped`, and the page may say so.
 */
export function coinsOf(prepared: Pick<PreparedSend, 'coins' | 'wallet'>): { ok: true; coins: Prevout[]; balance: bigint; skipped: number } | { ok: false } {
  const listed: ListedCoin[] = [];
  for (const c of prepared.coins ?? []) {
    const value = readLanoshis(c?.value);
    if (value === null) return { ok: false };
    listed.push({ txid: c.txid, vout: c.vout, value, height: c.height, rawTx: c.rawTx });
  }
  const verified = verifiedCoins(listed, prepared.wallet);
  return verified.ok ? { ok: true, coins: verified.coins, balance: verified.balance, skipped: verified.skipped.length } : { ok: false };
}

/** The allocations as shared/lana-tx takes them, in the server's order — or null when an amount does not read. */
export function allocationsOf(prepared: Pick<PreparedSend, 'allocations'>): Allocation[] | null {
  const out: Allocation[] = [];
  for (const a of prepared.allocations ?? []) {
    const lanoshis = readLanoshis(a?.lanoshis);
    if (lanoshis === null || typeof a.wallet !== 'string') return null;
    out.push({ address: a.wallet, lanoshis });
  }
  return out;
}

/* ── the send planned ─────────────────────────────────────────────────────── */

/**
 * Why there is no send to sign, as a code the page words (src/copy.ts):
 *   NOTHING — no leg chosen; UNREADABLE — the server's answer does not read (an amount, a coin);
 *   BELOW_DUST — a wallet would get less than 0.005 LANA in this send (`orderIds`: its legs); they wait for more;
 *   TOO_MANY_WALLETS — more than `max` wallets in one send: choose fewer purchases;
 *   INSUFFICIENT — the wallet's confirmed coins do not cover the legs and the fee: `shortBy` lanoshis more are needed.
 *     `merge`: the wallet holds coins that were not offered — more than were listed, or staking ones (review M9) —
 *     and even with all of them it is short (review N12): `shortBy` is then counted from the WHOLE confirmed balance,
 *     against the fee of a send of `MAX_INPUTS` coins, and once that is moved in the wallet must also be merged;
 *   TOO_MANY_INPUTS — `needed` coins would be needed, at most `max` fit: consolidate the wallet first. `atLeast`:
 *     `needed` is only the least it could be — the wallet holds coins that were not offered (more than were listed,
 *     or staking ones), even all the listed ones (its largest it can spend) do not cover the send, so no send of
 *     `max` of them can, yet the whole confirmed balance does cover it (review C20: a top-up figure there would be
 *     wrong, and topping up would not help);
 *   AHEAD — a coin is dated after the server's clock: it can be spent a little later;
 *   SHAPE — anything else the builder refuses (it never signs what the server's check would refuse).
 */
export type PlanProblem =
  | { code: 'NOTHING' | 'UNREADABLE' | 'AHEAD' | 'SHAPE' }
  | { code: 'BELOW_DUST'; orderIds: string[] }
  | { code: 'TOO_MANY_WALLETS'; max: number }
  | { code: 'INSUFFICIENT'; shortBy: bigint; merge?: true }
  | { code: 'TOO_MANY_INPUTS'; needed: number; max: number; atLeast?: true };

export type PagePlan =
  | {
      ok: true;
      plan: Extract<PayoutPlan, { ok: true }>;
      /** Coins spent, and wallets paid (outputs but the change). */
      inputs: number;
      wallets: number;
      /**
       * What the wallet holds once this send confirms: its WHOLE confirmed balance less what is paid and the fee — the
       * coins not offered for this send (not listed, staking, left out for a refused send's coin) stay where they are.
       */
      left: bigint;
    }
  | { ok: false; problem: PlanProblem };

/**
 * The wallet's whole confirmed balance: the server's figure (`balance.confirmed`) — every coin, the ones not offered
 * for this send included — and never less than the coins offered, those not listed and the staking ones added up (an
 * answer without the figure, or one read a moment apart from the coins).
 */
function wholeBalance(prepared: Pick<PreparedSend, 'unlisted' | 'skipped' | 'balance'>, coins: readonly Prevout[]): bigint {
  const unlisted = readLanoshis(prepared.unlisted?.value ?? '0') ?? 0n;
  const skipped = readLanoshis(prepared.skipped?.value ?? '0') ?? 0n;
  const counted = coins.reduce((s, c) => s + c.value, 0n) + unlisted + skipped;
  const said = prepared.balance ? readLanoshis(prepared.balance.confirmed) : null;
  return said !== null && said > counted ? said : counted;
}

/** The send the server's answer makes from these coins, at the server's clock — or why there is none. */
export function planOfPrepared(
  prepared: Pick<PreparedSend, 'wallet' | 'allocations' | 'unlisted' | 'skipped' | 'balance'>,
  coins: readonly Prevout[],
  nowSec: number,
): PagePlan {
  if (!prepared.allocations?.length) return { ok: false, problem: { code: 'NOTHING' } };
  const allocations = allocationsOf(prepared);
  if (!allocations) return { ok: false, problem: { code: 'UNREADABLE' } };
  const whole = wholeBalance(prepared, coins);
  const plan = planPayout({ from: prepared.wallet, coins, allocations, nowSec, step: LEG_LANOSHI_STEP });
  // What stays: from the whole wallet, not from the coins offered (review N13) — a refused send's coin can narrow the
  // coins offered to it and the smaller ones, and what was left out stays too.
  if (plan.ok === true) return { ok: true, plan, inputs: plan.coins.length, wallets: plan.pay.length, left: whole - plan.paying - plan.fee };
  switch (plan.code) {
    case 'ALLOCATIONS': {
      if (plan.problems.some((p) => p.code === 'TOO_MANY_OUTPUTS')) return { ok: false, problem: { code: 'TOO_MANY_WALLETS', max: MAX_PAY_OUTPUTS } };
      const dust = plan.problems.filter((p) => p.code === 'BELOW_DUST' && p.index >= 0);
      if (dust.length && dust.length === plan.problems.length) {
        // BELOW_DUST names the wallet's first allocation: every leg to that wallet waits with it.
        const wallets = new Set(dust.map((p) => prepared.allocations[p.index].wallet));
        const orderIds = prepared.allocations.filter((a) => wallets.has(a.wallet)).flatMap((a) => a.orderIds);
        return { ok: false, problem: { code: 'BELOW_DUST', orderIds } };
      }
      return { ok: false, problem: { code: 'UNREADABLE' } };
    }
    case 'INSUFFICIENT': {
      // Coins the wallet holds that were not offered: more than were listed, or staking ones (review M9 — a wallet that
      // stakes turns its coins into staking ones, which this page never spends).
      const notOffered = Number(prepared.unlisted?.count) > 0 || Number(prepared.skipped?.count) > 0;
      if (!notOffered) return { ok: false, problem: { code: 'INSUFFICIENT', shortBy: plan.shortBy } };
      // The listed coins are the wallet's largest it can spend. With more coins not offered, all of them short means no
      // send of MAX_INPUTS coins can cover this, however much more LANA comes in as small coins: the wallet must be
      // merged (or fewer purchases chosen). Merging helps only if the whole wallet covers the send — the fee of the
      // largest send counted (review N12); otherwise LANA is missing too, counted from the whole wallet (the
      // shortfall of the listed coins alone would ask for more than is missing), and the wallet must also be merged.
      const paying = allocations.reduce((s, a) => s + a.lanoshis, 0n);
      const need = paying + feeFor(MAX_INPUTS, new Set(allocations.map((a) => a.address)).size);
      if (whole >= need) return { ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: coins.length + 1, max: MAX_INPUTS, atLeast: true } };
      return { ok: false, problem: { code: 'INSUFFICIENT', shortBy: need - whole, merge: true } };
    }
    case 'TOO_MANY_INPUTS':
      return { ok: false, problem: { code: 'TOO_MANY_INPUTS', needed: plan.needed, max: MAX_INPUTS } };
    default:
      return { ok: false, problem: { code: plan.problems.some((p) => p.code === 'NTIME_AHEAD') ? 'AHEAD' : 'SHAPE' } };
  }
}

/**
 * The page's own check of the bytes it just signed, by the rule the server will run on them (checkPayoutTx, with this
 * site's step): the outputs exactly the allocations, from the financer's wallet, signed by its key. Only bytes that pass
 * are announced; signPayoutWithKey already refuses to return any that do not verify, so this is the second look the
 * plan asks for, against the ALLOCATIONS (what each wallet is owed), not only the outputs that were built from them.
 */
export function checkOwnSend(rawTx: string, prepared: Pick<PreparedSend, 'wallet' | 'allocations'>, coins: readonly Prevout[], nowSec: number): PayoutCheck {
  const allocations = allocationsOf(prepared);
  if (!allocations) return { ok: false, code: 'MALFORMED', detail: 'an allocation of the prepare answer does not read' };
  return checkPayoutTx({ rawTx, allocations, prevouts: coins, from: prepared.wallet, nowSec, step: LEG_LANOSHI_STEP });
}

/**
 * The least the wallet lacks for `paying` lanoshis to `wallets` wallets, before any coin is chosen: the legs plus the
 * fee of the smallest such send (one coin, no change). 0n when the confirmed balance may cover it — whether it does is
 * the plan's to say (INSUFFICIENT carries the exact figure).
 */
export function leastShortfall(paying: bigint, confirmedBalance: bigint, wallets: number): bigint {
  if (paying <= 0n || !Number.isSafeInteger(wallets) || wallets < 1) return 0n;
  const missing = paying + feeFor(1, wallets) - confirmedBalance;
  return missing > 0n ? missing : 0n;
}

/* ── the announce ─────────────────────────────────────────────────────────── */

/**
 * An announce whose answer did not come, or that the server could not finish (no answer, a timeout, too many
 * requests, a server error): the send may have been stored and broadcast. The SAME signed bytes are announced again —
 * the server answers a transaction it already holds with its state — never a new signature over the same legs, which
 * could pay every wallet twice. Any other answer is the server's word: stored (2xx) or refused before anything was
 * stored (4xx — the legs changed, the wallet failed the Registrar, the bytes failed the check).
 */
export function announceInDoubt(status: number | null | undefined): boolean {
  if (status === null || status === undefined || !Number.isInteger(status) || status <= 0) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
