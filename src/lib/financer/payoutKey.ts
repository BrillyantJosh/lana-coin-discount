/**
 * The PAYOUT WALLET's key, read and used in the admin's browser only —
 * »Poplačaj več naenkrat« on /admin/poplacilo.
 *
 * Brilly (6. 10. 2026): "At the end the admin enters the private key before
 * paying and the transaction happens." The admin types or scans the payout
 * wallet's WIF; this module reads it (src/lib/wif.ts: strict, the key's own
 * compression flag decides which wallet it opens), checks it opens EXACTLY the
 * payout wallet the profile names, signs the payout with it
 * (shared/lana-tx/payout.ts — the fleet's nonce-safe signer, every input, the
 * finished bytes verified by two libraries) and wipes the key's bytes in a
 * `finally`, whatever happened. What leaves this module is the SIGNED
 * transaction — public the moment it is sent — or why there is none; never
 * anything of the key. app.mejmosefajn.org's example sends the WIF to its
 * server: never copied.
 *
 * A T…/A… key and a 6…/3… key of the same secret open two different wallets
 * (MEM:ops_lana_wif_prefix_0x41.md); only the one whose address is the payout
 * wallet is taken — the other form is refused and the wallet it opens named,
 * so the admin sees why. A WIF typed is a JavaScript string, which cannot be
 * wiped: the page empties its field before signing and keeps no copy.
 *
 * This module sends, stores and logs nothing (keyStaysInBrowser.test.ts reads
 * it): one of the few that may touch the key reader.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's src/lib/payoutKey.ts
 * (origin/main a46f618). Changed: its import paths, and `decoded.ok === false`
 * where it wrote `!decoded.ok` — this repository's TypeScript (strict off)
 * narrows a result only on an explicit comparison
 * (server/shared/lana-tx/lanaDiscount.test.ts says more). The "payout wallet" is
 * the financer's own Lana.Discount wallet, and the payout pays the legs of the
 * purchases they confirmed on /financer (Brilly's decision of 8. 10. 2026: the
 * financer signs in the browser; the key never reaches lana.discount). It is the
 * ONLY module of this site that reads a LANA wallet key
 * (src/lib/financer/keyStaysInBrowser.test.ts holds that).
 */
import { classifyKeyInput, decodeWif, wipe, type KeyInputKind, type WifError } from './wif.ts';
import { signPayoutTx } from '../../../server/shared/lana-tx/payout.ts';
import type { Payment, Prevout } from '../../../server/shared/lana-tx/shape.ts';

/**
 * What the typed or scanned text is, beside the payout wallet: nothing yet, something that is no LANA key at all (an
 * address, a Nostr key, 64 hex), a key that cannot be read (a typo, another network), the key of ANOTHER wallet (and
 * which), or the key that opens the payout wallet.
 */
export type PayoutKeyCheck =
  | { state: Exclude<KeyInputKind, 'candidate'> | WifError | 'opens' }
  | { state: 'other'; opens: string };

/** Read the key, compare the wallet it opens with the payout wallet, wipe it: only what is public comes back. */
export function checkPayoutKey(input: string, wallet: string): PayoutKeyCheck {
  const kind = classifyKeyInput(input);
  if (kind !== 'candidate') return { state: kind };
  const decoded = decodeWif(input);
  if (decoded.ok === false) return { state: decoded.reason };
  wipe(decoded.privateKey);
  return decoded.address === wallet ? { state: 'opens' } : { state: 'other', opens: decoded.address };
}

/** The payout as planned (src/lib/payoutView.ts, shared/lana-tx planPayout): from where, the outputs, the coins, the server's clock. */
export interface PayoutToSign {
  from: string;
  pay: readonly Payment[];
  coins: readonly Prevout[];
  /** The server's clock, seconds — the payout's nTime (never this device's). */
  nowSec: number;
}

export type PayoutSignature =
  | { ok: true; rawTx: string; txid: string; fee: bigint; change: bigint; nTime: number }
  | { ok: false; check: PayoutKeyCheck }
  | { ok: false; code: 'BAD_KEY' | 'KEY_NOT_SOURCE' | 'SHAPE' | 'SIGNATURE_FAILED' };

/**
 * Sign the payout with the key typed: only a key that opens `payout.from` signs, and its bytes are wiped once signing is
 * over — signed, refused or failed. The signed bytes are checked again inside signPayoutTx (shape, both libraries).
 */
export async function signPayoutWithKey(input: string, payout: PayoutToSign): Promise<PayoutSignature> {
  const kind = classifyKeyInput(input);
  if (kind !== 'candidate') return { ok: false, check: { state: kind } };
  const decoded = decodeWif(input);
  if (decoded.ok === false) return { ok: false, check: { state: decoded.reason } };
  try {
    if (decoded.address !== payout.from) return { ok: false, check: { state: 'other', opens: decoded.address } };
    const signed = await signPayoutTx({ from: payout.from, pay: payout.pay, coins: payout.coins, nowSec: payout.nowSec, privateKey: decoded.privateKey, compressed: decoded.compressed });
    if (signed.ok === false) return { ok: false, code: signed.code };
    return { ok: true, rawTx: signed.rawTx, txid: signed.txid, fee: signed.fee, change: signed.change, nTime: signed.nTime };
  } finally {
    wipe(decoded.privateKey);
  }
}
