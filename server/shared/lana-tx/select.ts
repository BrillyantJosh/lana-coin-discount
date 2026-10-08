/**
 * Which coins of the payout wallet pay the buyers, and that each coin really is
 * what the server said it is.
 *
 * Brilly (6. 10. 2026): "The admin can pay them according to the balance of
 * that wallet." So the balance is read as coins, and the coins that pay are
 * chosen here, in the browser, before the key is asked for: the admin sees the
 * network fee, the change and what stays in the wallet first.
 *
 * WHERE THE RULE COMES FROM. The payout branch of the archived km-signer's
 * selectCoins (krog-menjave-signer src/sign.ts, 2 Oct 2026), unchanged except
 * that a payout has as many payment outputs as it pays wallets, not one:
 *   - coins worth no more than their own input fee (INPUT_FEE_LANOSHIS) are
 *     left where they are. Spending one only loses money, and anyone can send
 *     a public wallet as many of them as they like;
 *   - then the largest coins first, until the change rule (fee.ts settle) is
 *     met, so as few inputs (and as small a fee) as possible;
 *   - at most MAX_INPUTS (20) inputs. A payout that needs more is refused with
 *     "consolidate first": nothing larger has been proven on the chain;
 *   - ties are broken by txid and vout, so the same coins give the same choice.
 *
 * NEVER A VALUE ON TRUST. A legacy signature does not cover the value of the
 * coins it spends (sighash.ts), so a server or a relay that lied about a coin
 * could turn the difference into fee. verifiedCoins() reads every coin from the
 * raw transaction that created it, after hashing those bytes to the coin's txid,
 * and refuses a coin whose value or wallet differs from what was listed, or that
 * is not confirmed yet (listunspent keeps listing a coin an unconfirmed
 * transaction already spends: the Lana8Wonder double cash-out of 12 Sep 2026).
 * One kind of coin is the wallet's and still not spendable here: an output paid
 * to the wallet's PUBLIC KEY (pay-to-public-key — a staking reward of the LANA
 * desktop wallet, or anything anyone sends to a key the chain has shown), which
 * the servers list under the address. It is left out and counted apart
 * (`skipped`), never a reason to refuse the others: one such coin among the
 * listed ones would otherwise stop every payout (review of 6. 10. 2026).
 *
 * Pure: no key, no clock, no connection. Money is integer lanoshis as bigint.
 */
import { addressToHash160, p2pkHash160, scriptOfAddress } from './address.ts';
import { outpointKey } from './codec.ts';
import { BYTES_PER_INPUT, feeFor, LANOSHIS_PER_BYTE, MAX_INPUTS, settle } from './fee.ts';
import { prevoutFromRawTx, type Prevout } from './shape.ts';

/**
 * What one more input adds to the fee: 180 bytes at 150 lanoshis (fee.ts),
 * 27,000 lanoshis. A coin worth no more than this costs more to spend than it
 * brings, so it can never be the coin that makes a payout possible.
 */
export const INPUT_FEE_LANOSHIS = BYTES_PER_INPUT * LANOSHIS_PER_BYTE;

/** Anything with a place on the chain and a value: a listed coin or a verified Prevout. */
export interface Coin {
  txid: string;
  vout: number;
  value: bigint;
}

export type CoinChoice<C extends Coin> =
  | {
      ok: true;
      /** The coins to spend, largest first: the transaction's inputs in this order. */
      coins: C[];
      /** What the chosen coins hold together. */
      totalIn: bigint;
      /** The network fee by the change rule. */
      fee: bigint;
      /** What goes back to the payout wallet; 0n when the remainder under dust joins the fee. */
      change: bigint;
    }
  | { ok: false; code: 'INSUFFICIENT'; detail: string; shortBy: bigint }
  | { ok: false; code: 'TOO_MANY_INPUTS'; detail: string; needed: number };

/**
 * The coins that pay `paying` lanoshis in `payOutputs` payment outputs, plus the
 * fee and the change by the rule. `coins` are the payout wallet's CONFIRMED
 * coins (verifiedCoins below); nothing here looks at heights.
 */
export function selectPayoutCoins<C extends Coin>(coins: readonly C[], paying: bigint, payOutputs: number, maxInputs: number = MAX_INPUTS): CoinChoice<C> {
  if (typeof paying !== 'bigint' || paying <= 0n) throw new Error('paying must be a positive bigint');
  if (!Number.isSafeInteger(payOutputs) || payOutputs < 1) throw new Error('payOutputs must be a positive integer');
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1) throw new Error('maxInputs must be a positive integer');
  for (const c of coins) {
    if (typeof c.value !== 'bigint' || c.value < 0n) throw new Error(`coin ${outpointKey(c.txid, c.vout)} has no valid value`);
  }

  const byKey = (a: Coin, b: Coin) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout);
  const largestFirst = coins.filter((c) => c.value > INPUT_FEE_LANOSHIS).sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : byKey(a, b)));

  const chosen: C[] = [];
  let totalIn = 0n;
  for (const c of largestFirst) {
    chosen.push(c);
    totalIn += c.value;
    const rule = settle(totalIn, paying, chosen.length, payOutputs);
    if (!rule.ok) continue;
    if (chosen.length > maxInputs) {
      return {
        ok: false,
        code: 'TOO_MANY_INPUTS',
        needed: chosen.length,
        detail: `${chosen.length} coins are needed, at most ${maxInputs} fit in one transaction: consolidate the wallet first`,
      };
    }
    return { ok: true, coins: chosen, totalIn, fee: rule.fee, change: rule.change };
  }

  // Not even every coin worth spending is enough. With none at all, the least
  // any payout costs is one input and no change.
  const last = chosen.length ? settle(totalIn, paying, chosen.length, payOutputs) : null;
  const shortBy = last && last.ok === false ? last.shortBy : paying + feeFor(1, payOutputs);
  return {
    ok: false,
    code: 'INSUFFICIENT',
    shortBy,
    detail: `the wallet's confirmed coins worth spending (${totalIn} lanoshis in ${chosen.length}) do not cover ${paying} plus the fee`,
  };
}

/** A coin as the server lists it: Electrum's listunspent, with the raw transaction that created it. */
export interface ListedCoin {
  txid: string;
  vout: number;
  /** What listunspent says it holds. A claim until the raw transaction is re-hashed. */
  value: bigint;
  /** ≤ 0: unconfirmed. */
  height: number;
  /** The raw transaction `txid`, as transaction.get returned it. */
  rawTx: string;
}

export type VerifiedCoins =
  | {
      ok: true;
      coins: Prevout[];
      /** What `coins` hold together. */
      balance: bigint;
      /** Coins of the wallet paid to its public key (pay-to-public-key): read and true, but not spendable here. */
      skipped: Coin[];
    }
  | { ok: false; problems: string[] };

/**
 * Every listed coin, read from its own previous transaction: the bytes must hash
 * to its txid, the output must exist, hold exactly the listed value and be
 * locked to `wallet`, and the coin must be confirmed. One coin wrong refuses
 * them all: a server that lies about one coin is not believed about the others.
 * A coin locked to the wallet's own public key instead (see the top) is not
 * wrong: it is left out, in `skipped`.
 */
export function verifiedCoins(listed: readonly ListedCoin[], wallet: string): VerifiedCoins {
  const problems: string[] = [];
  let script: string;
  try {
    script = scriptOfAddress(wallet);
  } catch {
    return { ok: false, problems: [`${String(wallet)} is not a LANA address`] };
  }
  const walletHash160 = addressToHash160(wallet);
  const seen = new Set<string>();
  const coins: Prevout[] = [];
  const skipped: Coin[] = [];
  let balance = 0n;
  listed.forEach((c, i) => {
    const key = c && typeof c.txid === 'string' ? outpointKey(c.txid, c.vout) : `coin ${i}`;
    if (!c || !/^[0-9a-f]{64}$/.test(c.txid) || !Number.isSafeInteger(c.vout) || c.vout < 0) return void problems.push(`${key}: not a coin`);
    if (seen.has(key)) return void problems.push(`${key}: listed twice`);
    seen.add(key);
    if (typeof c.value !== 'bigint' || c.value < 0n) return void problems.push(`${key}: no valid value`);
    if (!Number.isSafeInteger(c.height) || c.height <= 0) return void problems.push(`${key}: not confirmed yet`);
    let prev: Prevout;
    try {
      prev = prevoutFromRawTx(typeof c.rawTx === 'string' ? c.rawTx.toLowerCase() : '', c.txid, c.vout);
    } catch (e) {
      return void problems.push(`${key}: ${(e as Error).message}`);
    }
    if (prev.value !== c.value) return void problems.push(`${key}: listed as ${c.value} lanoshis, its transaction says ${prev.value}`);
    if (prev.scriptPubKeyHex !== script) {
      // The wallet's own public key: its coin, but not one a P2PKH signature spends — left where it is.
      if (walletHash160 !== null && p2pkHash160(prev.scriptPubKeyHex) === walletHash160) return void skipped.push({ txid: c.txid, vout: c.vout, value: prev.value });
      return void problems.push(`${key}: not locked to ${wallet}`);
    }
    coins.push(prev);
    balance += prev.value;
  });
  if (problems.length) return { ok: false, problems };
  return { ok: true, coins, balance, skipped };
}
