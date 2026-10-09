/**
 * What /financer's tests draw the page from: the server's answers as JSON, built
 * around THROWAWAY wallets and made-up coins (server/shared/lana-tx/fixtures/
 * wallets.ts) — real keys drawn fresh in the test process, coins whose "previous
 * transactions" hash to their txid — so the page plans, the key opens the
 * wallet and the browser signs exactly as it would in production.
 *
 * A test helper (src/test is outside the page-code scans): no page imports it.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode } from '@/lib/financer/wif';
import { LANA, NOW_SEC, listedCoins, throwawayAddress, throwawayWallet, type ThrowawayWallet } from '../../server/shared/lana-tx/fixtures/wallets.ts';
import type { FinancerBatch, FinancerMe, PrepareAnswer, SendView, SendableAnswer, SendablePurchase } from '@/lib/financer/financerApi';

export { LANA, NOW_SEC, throwawayAddress, throwawayWallet, type ThrowawayWallet };

export const SIGNER = 'f1'.repeat(32);

/** A LanaCoin WIF (version 0xB0) of this key, compressed (T…) or not (6…), as a wallet prints it. */
export function wifOf(privateKey: Uint8Array, compressed: boolean): string {
  const body = new Uint8Array([0xb0, ...privateKey, ...(compressed ? [0x01] : [])]);
  const check = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(new Uint8Array([...body, ...check]));
}

export const LIMITS = { maxWallets: 98, maxLegs: 400, maxInputs: 20, dustLanoshis: '500000', stepLanoshis: '1' };

/**
 * GET /api/financer/me: the signer with one wallet, listed as their EUR wallet (owner, 9 Oct 2026: one per currency) —
 * or with the list `over.wallets` gives.
 */
export function meOf(wallet: string | null, over: Partial<FinancerMe> = {}): FinancerMe {
  const me: FinancerMe = {
    hexId: SIGNER,
    isFinancer: true,
    lanaDiscountWallet: wallet,
    lanaDiscountWalletSetAt: wallet ? '2026-10-08 10:00:00' : null,
    walletCheck: wallet ? { ok: true, walletType: 'Lana.Discount', frozen: false } : { ok: false, reason: 'NO_WALLET' },
    ...over,
  };
  return {
    wallets: me.lanaDiscountWallet ? [{ currency: 'EUR', walletId: me.lanaDiscountWallet, walletCheck: me.walletCheck }] : [],
    unknownCurrencyRefs: [],
    ...me,
  };
}

export function batchOf(batchRef: string, over: Partial<FinancerBatch> = {}, ld: Partial<FinancerBatch['ld']> = {}): FinancerBatch {
  return {
    batchRef,
    status: 'paid',
    currency: 'EUR',
    totalAmount: 243.89,
    paymentCount: 3,
    confirmedCount: 3,
    fundSettingId: 7,
    createdAt: '2026-10-08 09:00:00',
    closedAt: '2026-10-08 09:30:00',
    paidAt: '2026-10-08 09:40:00',
    transactionRefs: [`TX-${batchRef}-1`],
    held: false,
    canConfirm: true,
    canConfirmAgain: false,
    resendStopped: false,
    ...over,
    ld: {
      confirmed: false,
      settledBy: null,
      status: null,
      receivedAt: null,
      purchases: { total: 1, mine: 0, treasury: 0, other: 0, unclaimed: 1, retakeable: 1, cancelled: 0 },
      unclaimedRefs: [`TX-${batchRef}-1`],
      legs: { total: 3, pending: 3, authorized: 0, sending: 0, sent: 0, cancelled: 0 },
      ...ld,
    },
  };
}

/** One purchase: legs to the given wallets with the given lanoshis (the brain's own odd amounts). */
export function purchaseOf(transactionRef: string, legs: Array<{ id: string; type: string; to: string; lanoshis: bigint }>, batchRef = 'B-1'): SendablePurchase {
  const total = legs.reduce((s, l) => s + l.lanoshis, 0n);
  return {
    transactionRef,
    batchRef,
    legs: legs.map((l) => ({ orderId: l.id, orderType: l.type, toWallet: l.to, toHex: 'ab'.repeat(32), lanoshis: l.lanoshis.toString(), mustSpend: false })),
    lanoshis: total.toString(),
    wallets: new Set(legs.map((l) => l.to)).size,
    belowDustAlone: false,
  };
}

export function sendableOf(wallet: string | null, purchases: SendablePurchase[], confirmed: bigint, over: Partial<SendableAnswer> = {}): SendableAnswer {
  const total = purchases.reduce((s, p) => s + BigInt(p.lanoshis), 0n);
  return {
    currency: 'EUR',
    wallet,
    walletProblem: wallet ? null : 'NO_WALLET',
    balance: wallet ? { confirmed: confirmed.toString(), unconfirmed: '0' } : null,
    purchases,
    totalLanoshis: total.toString(),
    legCount: purchases.reduce((s, p) => s + p.legs.length, 0),
    wallets: new Set(purchases.flatMap((p) => p.legs.map((l) => l.toWallet))).size,
    shortfallLanoshis: '0',
    inFlight: [],
    limits: LIMITS,
    ...over,
  };
}

/**
 * The server's prepare answer for these purchases from `wallet`: its coins (each with the made-up raw transaction that
 * made it), the legs merged per wallet in the order they first appear, the server's clock.
 */
export function prepareOf(wallet: ThrowawayWallet, purchases: SendablePurchase[], coinValues: bigint[] = [100n * LANA, 3n * LANA]): PrepareAnswer {
  const coins = listedCoins(wallet.address, coinValues, NOW_SEC - 3600).map((c) => ({ ...c, value: c.value.toString() }));
  const legs = purchases.flatMap((p) => p.legs.map((l) => ({ ...l, transactionRef: p.transactionRef })));
  const by = new Map<string, { lanoshis: bigint; orderIds: string[] }>();
  for (const l of legs) {
    const a = by.get(l.toWallet);
    if (a) {
      a.lanoshis += BigInt(l.lanoshis);
      a.orderIds.push(l.orderId);
    } else by.set(l.toWallet, { lanoshis: BigInt(l.lanoshis), orderIds: [l.orderId] });
  }
  const allocations = [...by].map(([w, a]) => ({ wallet: w, lanoshis: a.lanoshis.toString(), orderIds: a.orderIds }));
  const paying = legs.reduce((s, l) => s + BigInt(l.lanoshis), 0n);
  const balance = coinValues.reduce((s, v) => s + v, 0n);
  return {
    currency: 'EUR',
    wallet: wallet.address,
    nowSec: NOW_SEC,
    balance: { confirmed: balance.toString(), unconfirmed: '0' },
    coins,
    skipped: { count: 0, value: '0' },
    unlisted: { count: 0, value: '0' },
    allocations,
    legs,
    payingLanoshis: paying.toString(),
    maxFee: '0',
    mustSpend: [],
    limits: LIMITS,
  };
}

export function sendViewOf(txid: string, over: Partial<SendView> = {}): SendView {
  return {
    txid,
    sender: 'financer',
    state: 'mempool',
    wallet: 'L-wallet',
    orderIds: ['leg-1'],
    transactionRefs: ['TX-1'],
    payingLanoshis: '1004492188',
    feeLanoshis: '20000',
    broadcasts: 1,
    lastOutcome: 'accepted by a',
    nextBroadcastAt: null,
    releaseReason: null,
    blockHeight: null,
    confirmedAt: null,
    createdAt: '2026-10-08 12:00:00',
    stuck: false,
    chainTxid: txid,
    ...over,
  };
}
