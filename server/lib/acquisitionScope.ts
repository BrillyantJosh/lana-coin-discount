import type { WalletClass } from './sellerEligibility.js';

/**
 * Which wallets the treasury is acquiring from at all, right now.
 *
 * Separate from the round mandate, and deliberately blunter. A mandate says how
 * much may be acquired from a given financing round and on what terms; this says
 * whether a whole CLASS of wallet is being bought from today. The treasury needs
 * to be able to stop taking offers from people's own Main Wallets and Wallets
 * for a while — to work through what it already owes on the LanaPays.Us side —
 * without unpicking any mandate or closing the page to everyone.
 *
 * It is a single admin switch, and when it is off nothing about the old
 * behaviour changes. That matters: the safe state for a settings key that has
 * never been written is "carry on as before", not "refuse everybody".
 */

export const LANAPAYS_ONLY_KEY = 'acq_lanapays_only';

/** The refusal code, shared by the gate and by the page that greys the wallet out. */
export const NOT_ACQUIRING_CODE = 'WALLET_CLASS_NOT_ACQUIRED';

/**
 * app_settings holds strings. Absent, empty or anything unrecognised means OFF —
 * an unwritten key must never narrow what the treasury accepts.
 */
export function lanapaysOnlyEnabled(raw: string | undefined | null): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Is the treasury acquiring from this class of wallet at all?
 *
 * The switch names LanaPays.Us because that is the class it keeps open; every
 * other class is paused together. An unknown class is treated as "other" — the
 * cautious end, since the only way to be in scope is to be positively
 * recognised as a LanaPays.Us wallet.
 */
export function acquiringFromClass(walletClass: WalletClass | null | undefined, lanapaysOnly: boolean): boolean {
  if (!lanapaysOnly) return true;
  return walletClass === 'lanapays';
}

/**
 * What the seller is told, in one place.
 *
 * It says what the treasury is doing, not what is wrong with them — nothing is.
 * "Not at the moment" is the whole message, and it must not read as a freeze, a
 * sanction or a fault in the wallet, because it is none of those.
 */
export const NOT_ACQUIRING_MESSAGE =
  'We are not acquiring LANA from this wallet at the moment. Offers are open from LanaPays.Us wallets only for now.';
