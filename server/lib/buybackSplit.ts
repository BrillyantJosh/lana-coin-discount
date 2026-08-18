/**
 * SPLIT GATE — which Split a wallet was registered in decides whether its LANA
 * may be sold back.
 *
 * IT APPLIES TO LanaPays.Us WALLETS AND NOTHING ELSE (owner, 18 Aug 2026).
 *
 * That is where the question even means something. A LanaPays.Us wallet is
 * created at issue time, so the split it was registered in genuinely describes
 * the LANA inside it. A person's own Main Wallet is not like that: they may
 * have held it for a year and kept receiving into it, so its registration date
 * says nothing about the coins it holds today.
 *
 * The measurement agrees. Across the last 60 wallets that actually sold, all
 * 15 LanaPays.Us wallets carried a split stamp and every one of them read 7;
 * of 40 Main Wallets, 35 had no stamp at all. Treating "the registrar never
 * recorded a split" as a disqualification refused half of the honest sellers
 * for a fact nobody had ever written down — including wallets that had sold
 * without trouble days earlier.
 *
 * The buyback window is exactly ONE split wide: the one immediately before the
 * current one.
 *
 *   - the CURRENT split is still in play — its LANA has not finished its round;
 *   - OLDER splits are past — buying them back now would settle them at a rate
 *     that no longer describes what they are.
 *
 * THIS IS NOT CONFIGURABLE, AND DELIBERATELY SO. The whole settlement model
 * rests on it: change the window and the rest stops adding up. It lives here as
 * a constant rather than as an app setting so that nobody can move it from an
 * admin screen — moving it has to be a considered change to the code, reviewed
 * and deployed like any other change to how money settles.
 *
 * FAIL-CLOSED WITHIN ITS SCOPE, for the same reason the freeze gate is: we
 * are not deciding whether to SHOW something, we are deciding whether to let
 * money leave. For a LanaPays.Us wallet, "we could not establish which split
 * this belongs to" is still not permission.
 */

/**
 * How far back from the current split the buyback window sits. 1 = the split
 * immediately before the current one, and nothing else. Permanent.
 */
export const BUYBACK_SPLIT_OFFSET = 1;

/**
 * Wallet types the window applies to. Matched on a lowercase prefix because
 * the registrar also issues sub-types such as "LanaPays.Us Investors", and a
 * new sub-type must not fall out of scope by being unlisted.
 */
const SCOPED_TYPE_PREFIX = 'lanapays';

/** Is this wallet the kind the buyback window is about? */
export function isScopedWalletType(walletType: string | null | undefined): boolean {
  return String(walletType || '').trim().toLowerCase().startsWith(SCOPED_TYPE_PREFIX);
}

export interface SplitVerdict {
  allowed: boolean;
  code: 'OK' | 'OUT_OF_SCOPE' | 'SPLIT_TOO_NEW' | 'SPLIT_TOO_OLD' | 'SPLIT_UNKNOWN' | 'SPLIT_UNVERIFIABLE';
  reason: string;
  walletSplit: number | null;
  currentSplit: number | null;
  /** The single split being bought back right now, or [] when we don't know the current one. */
  allowedSplits: number[];
}

export function evaluateBuybackSplit(input: {
  /** split_created from the registrar; null when unknown or not registered. */
  walletSplit: number | null | undefined;
  /** The current split from KIND 38888; null when we have no KIND 38888 yet. */
  currentSplit: number | null | undefined;
  /** Did the registrar actually answer? An outage is not a clearance. */
  registrarReachable: boolean;
  /**
   * The wallet's type, from any source that knows it — the registrar's own
   * answer or the signed KIND 30889 list. Only LanaPays.Us wallets are in
   * scope; everything else passes straight through.
   */
  walletType?: string | null;
}): SplitVerdict {
  const currentSplit = Number.isFinite(input.currentSplit as number) ? Number(input.currentSplit) : null;
  const walletSplit = Number.isFinite(input.walletSplit as number) ? Number(input.walletSplit) : null;

  const buybackSplit = currentSplit === null ? null : currentSplit - BUYBACK_SPLIT_OFFSET;
  const allowedSplits = buybackSplit !== null && buybackSplit >= 0 ? [buybackSplit] : [];
  const base = { walletSplit, currentSplit, allowedSplits };

  // Scope first, and before any of the fail-closed arms below: a wallet this
  // rule was never about must not be refused because we could not answer a
  // question we were not asking. A wallet whose type nobody records is not a
  // LanaPays.Us wallet — the issuer is exactly who stamps that type.
  if (!isScopedWalletType(input.walletType)) {
    return { ...base, allowed: true, code: 'OUT_OF_SCOPE', reason: '' };
  }

  if (currentSplit === null) {
    return {
      ...base, allowed: false, code: 'SPLIT_UNVERIFIABLE',
      reason: 'The current Split is not known right now, so buyback eligibility cannot be checked. Please try again shortly.',
    };
  }
  if (!input.registrarReachable) {
    return {
      ...base, allowed: false, code: 'SPLIT_UNVERIFIABLE',
      reason: 'The wallet registry could not be reached, so the Split of this wallet cannot be confirmed. Please try again shortly.',
    };
  }
  if (walletSplit === null) {
    return {
      ...base, allowed: false, code: 'SPLIT_UNKNOWN',
      reason: 'This wallet has no registered Split, so its LANA cannot be bought back.',
    };
  }
  // Before the first buyback split ever existed there is nothing to buy back.
  if (allowedSplits.length === 0) {
    return {
      ...base, allowed: false, code: 'SPLIT_TOO_NEW',
      reason: 'No Split has completed yet, so there is nothing to buy back.',
    };
  }
  if (walletSplit === buybackSplit) {
    return { ...base, allowed: true, code: 'OK', reason: '' };
  }

  // Above the window means the LANA is newer than what we buy back — including
  // the current split, which is still running.
  return walletSplit > (buybackSplit as number)
    ? {
        ...base, allowed: false, code: 'SPLIT_TOO_NEW',
        reason: walletSplit === currentSplit
          ? `This wallet was registered in the current Split ${walletSplit}, which is still running. Only LANA from Split ${buybackSplit} is bought back.`
          : `This wallet was registered in Split ${walletSplit}. Only LANA from Split ${buybackSplit} is bought back.`,
      }
    : {
        ...base, allowed: false, code: 'SPLIT_TOO_OLD',
        reason: `This wallet was registered in Split ${walletSplit}, which has already passed. Only LANA from Split ${buybackSplit} is bought back.`,
      };
}
