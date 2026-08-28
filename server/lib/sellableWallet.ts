/**
 * Which wallets may be offered to the treasury at all.
 *
 * This used to be a blocklist — everything except Lana8Wonder and Knights —
 * and a blocklist is the wrong shape for a rule like this: every wallet type
 * the registry gains in future is admitted by default, silently. A Retail
 * card reached the offer page that way. So the rule is now stated the other
 * way round: three types are sellable, everything else is not, and a new type
 * has to be added here deliberately before it can be sold.
 *
 * 'LanaPays.Us' matches by prefix because the registry carries sub-types
 * ('LanaPays.Us Investors', 'Pays.Us Admin' …) that are the same thing for
 * this purpose — the same prefix rule the buyback window already uses.
 */

export const SELLABLE_EXACT = ['main wallet', 'wallet'] as const;
export const SELLABLE_PREFIX = 'lanapays';

export function isSellableWalletType(walletType: string | null | undefined): boolean {
  const t = String(walletType || '').trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith(SELLABLE_PREFIX)) return true;
  return (SELLABLE_EXACT as readonly string[]).includes(t);
}
