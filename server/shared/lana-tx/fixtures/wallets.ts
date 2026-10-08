/**
 * Throwaway wallets and made-up coins for the payout tests (select, payout,
 * verify). Nothing here is a real key or a real coin: every secret is drawn
 * fresh in the test process and gone when it ends, and a "previous
 * transaction" is bytes made here, spending an outpoint that does not exist.
 * They are well-formed, though, so they hash to their txid and decode like the
 * chain's own, and the library reads them exactly as it reads a real one.
 */
import * as secp from '@noble/secp256k1';
import { addressOfPublicKey, scriptOfAddress } from '../address.ts';
import { bytesToHex } from '../bytes.ts';
import { encodeTxHex, SEQUENCE_FINAL, txidOfRaw } from '../codec.ts';
import type { Allocation } from '../payments.ts';
import { planPayout, signPayoutTx } from '../payout.ts';
import { verifiedCoins, type ListedCoin } from '../select.ts';

export const LANA = 100_000_000n;

export interface ThrowawayWallet {
  privateKey: Uint8Array;
  compressed: boolean;
  publicKey: Uint8Array;
  address: string;
}

/** A fresh key, read as a WIF of that compression flag would be read. */
export function throwawayWallet(compressed = true, privateKey: Uint8Array = secp.utils.randomSecretKey()): ThrowawayWallet {
  const publicKey = secp.getPublicKey(privateKey, compressed);
  return { privateKey, compressed, publicKey, address: addressOfPublicKey(publicKey) };
}

/** Just an address nobody keeps the key to. */
export const throwawayAddress = (): string => throwawayWallet().address;

/** A made-up transaction paying `values` to `address`, one output each, dated `nTime`. */
export function parentPaying(address: string, values: readonly bigint[], nTime: number): { raw: string; txid: string } {
  const raw = encodeTxHex({
    version: 1,
    nTime,
    inputs: [{ prevTxid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, scriptSigHex: '', sequence: SEQUENCE_FINAL }],
    outputs: values.map((value) => ({ value, scriptPubKeyHex: scriptOfAddress(address) })),
    locktime: 0,
  });
  return { raw, txid: txidOfRaw(raw) };
}

/** A made-up transaction with these outputs (any scripts), dated `nTime`. */
export function parentWithOutputs(outputs: readonly { value: bigint; scriptPubKeyHex: string }[], nTime: number): { raw: string; txid: string } {
  const raw = encodeTxHex({
    version: 1,
    nTime,
    inputs: [{ prevTxid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, scriptSigHex: '', sequence: SEQUENCE_FINAL }],
    outputs: outputs.map((o) => ({ value: o.value, scriptPubKeyHex: o.scriptPubKeyHex })),
    locktime: 0,
  });
  return { raw, txid: txidOfRaw(raw) };
}

/** Coins of `address` as the server would list them: one made-up parent per coin, confirmed at `height`. */
export function listedCoins(address: string, values: readonly bigint[], nTime: number, height = 100): ListedCoin[] {
  return values.map((value) => {
    const p = parentPaying(address, [value], nTime);
    return { txid: p.txid, vout: 0, value, height, rawTx: p.raw };
  });
}

/** The server's clock in the payout tests: a fixed moment, seconds UTC. */
export const NOW_SEC = 1_800_000_000;

/**
 * A whole payout, the way the admin's page makes it: a throwaway payout wallet
 * holding made-up confirmed coins, four throwaway buyers, five allocations (two
 * to the same buyer, one of exactly 0.005 LANA), the plan, and the transaction
 * signed by the wallet's key. 29.62845 LANA need two of the three coins
 * (20 + 15 LANA; the 1-LANA coin stays).
 */
export async function signedPayout(o: { compressed?: boolean; coinValues?: readonly bigint[]; nowSec?: number } = {}) {
  const nowSec = o.nowSec ?? NOW_SEC;
  const wallet = throwawayWallet(o.compressed ?? true);
  const payees = Array.from({ length: 4 }, throwawayAddress);
  const listed = listedCoins(wallet.address, o.coinValues ?? [20n * LANA, 15n * LANA, 1n * LANA], nowSec - 3600);
  const verified = verifiedCoins(listed, wallet.address);
  if (verified.ok === false) throw new Error(verified.problems.join('; '));
  const allocations: Allocation[] = [
    { address: payees[0], lanoshis: 10n * LANA },
    { address: payees[1], lanoshis: 1_250_000_000n },
    { address: payees[0], lanoshis: 12_345_000n },
    { address: payees[2], lanoshis: 7n * LANA },
    { address: payees[3], lanoshis: 500_000n },
  ];
  const plan = planPayout({ from: wallet.address, coins: verified.coins, allocations, nowSec });
  if (plan.ok === false) throw new Error(`${plan.code}: ${plan.detail}`);
  const signed = await signPayoutTx({ from: wallet.address, pay: plan.pay, coins: plan.coins, nowSec, privateKey: wallet.privateKey, compressed: wallet.compressed });
  if (signed.ok === false) throw new Error(`${signed.code}: ${signed.detail}`);
  return { nowSec, wallet, payees, listed, coins: verified.coins, allocations, plan, signed };
}
