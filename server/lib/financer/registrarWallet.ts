/**
 * May THIS wallet pay a financer's legs? Asked of the LANA Registrar (through
 * check.lanapays.us) before every prepare, every announce and every rebroadcast.
 *
 * Yes only when the registrar says, explicitly, all four:
 *   - the wallet is registered;
 *   - its type is exactly 'Lana.Discount' (the type the owner set aside for
 *     this on 8 Oct 2026; a type cannot be changed after registration);
 *   - it is registered to THIS financer (nostr_hex_id === the signer);
 *   - it is not frozen.
 *
 * Fail CLOSED, unlike a page that only shows a badge. LANA sent from a wallet
 * the registrar does not know arrives at its recipients as unregistered LANA,
 * and the registrar freezes THEM for it (frozen_unreg_Lanas) — every merchant,
 * caretaker and customer of the purchase. So "not registered", an error, a
 * timeout and an answer we cannot read are all a no (REGISTRAR_UNKNOWN), never
 * a maybe. check.lanapays.us answers `registered: false` for an outage too
 * (lib/freeze.ts parseRegistrarBody), which is one more reason it cannot clear.
 *
 * The two answer shapes — flattened by check.lanapays.us, nested under
 * `wallet` by the mobile proxy — are read the way lib/freeze.ts reads them.
 */
import { parseRegistrarBody } from '../freeze.js';

export const LANA_DISCOUNT_WALLET_TYPE = 'Lana.Discount';
export const REGISTRAR_TIMEOUT_MS = 8000;

export type WalletCheckReason =
  | 'NO_WALLET'          // no wallet chosen (on DF) / not a string
  | 'REGISTRAR_UNKNOWN'  // not registered, unreachable, timed out, unreadable
  | 'WALLET_FROZEN'
  | 'WRONG_WALLET_TYPE'
  | 'WRONG_OWNER';

export interface FinancerWalletCheck {
  ok: boolean;
  reason?: WalletCheckReason;
  walletType?: string;
  frozen?: boolean;
  freezeReason?: string;
}

export interface WalletCheckOptions {
  /** Defaults to WALLET_CHECK_BASE_URL or https://check.lanapays.us */
  checkBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Pure: the registrar's answer about `walletId`, judged for `ownerHex`. */
export function judgeRegistrarAnswer(data: unknown, ownerHex: string): FinancerWalletCheck {
  const d = data as any;
  const signal = parseRegistrarBody(d);
  const walletType = signal.walletType;
  if (signal.frozen) {
    return { ok: false, reason: 'WALLET_FROZEN', walletType, frozen: true, freezeReason: signal.freezeReason };
  }
  // parseRegistrarBody counts only an explicit `registered: true` as an answer.
  if (!signal.reachable || d?.registered !== true) return { ok: false, reason: 'REGISTRAR_UNKNOWN', walletType };
  if (walletType !== LANA_DISCOUNT_WALLET_TYPE) return { ok: false, reason: 'WRONG_WALLET_TYPE', walletType, frozen: false };
  const rawOwner = d?.nostr_hex_id ?? d?.wallet?.nostr_hex_id;
  const owner = typeof rawOwner === 'string' ? rawOwner.trim().toLowerCase() : '';
  if (!owner || owner !== String(ownerHex || '').trim().toLowerCase()) {
    return { ok: false, reason: 'WRONG_OWNER', walletType, frozen: false };
  }
  return { ok: true, walletType, frozen: false };
}

export async function checkFinancerWallet(
  walletId: string | null | undefined,
  ownerHex: string,
  opts: WalletCheckOptions = {},
): Promise<FinancerWalletCheck> {
  const wallet = typeof walletId === 'string' ? walletId.trim() : '';
  if (!wallet) return { ok: false, reason: 'NO_WALLET' };
  const base = String(opts.checkBaseUrl || process.env.WALLET_CHECK_BASE_URL || 'https://check.lanapays.us').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${base}/api/check-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_id: wallet }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REGISTRAR_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'REGISTRAR_UNKNOWN' };
    return judgeRegistrarAnswer(await res.json(), ownerHex);
  } catch {
    return { ok: false, reason: 'REGISTRAR_UNKNOWN' };
  }
}
