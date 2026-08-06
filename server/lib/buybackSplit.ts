/**
 * SPLIT GATE — which Split a wallet was registered in decides whether its LANA
 * may be sold back.
 *
 * The LANA Registrar records `split_created` for every LanaPays.Us wallet, and
 * lana.discount only ever offers registered wallets on the sell page. The
 * buyback window is exactly ONE split wide: the one immediately before the
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
 * FAIL-CLOSED, for the same reason the freeze gate is: we are not deciding
 * whether to SHOW something, we are deciding whether to let money leave. "We
 * could not establish which split this wallet belongs to" is not permission.
 */

/**
 * How far back from the current split the buyback window sits. 1 = the split
 * immediately before the current one, and nothing else. Permanent.
 */
export const BUYBACK_SPLIT_OFFSET = 1;

export interface SplitVerdict {
  allowed: boolean;
  code: 'OK' | 'SPLIT_TOO_NEW' | 'SPLIT_TOO_OLD' | 'SPLIT_UNKNOWN' | 'SPLIT_UNVERIFIABLE';
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
}): SplitVerdict {
  const currentSplit = Number.isFinite(input.currentSplit as number) ? Number(input.currentSplit) : null;
  const walletSplit = Number.isFinite(input.walletSplit as number) ? Number(input.walletSplit) : null;

  const buybackSplit = currentSplit === null ? null : currentSplit - BUYBACK_SPLIT_OFFSET;
  const allowedSplits = buybackSplit !== null && buybackSplit >= 0 ? [buybackSplit] : [];
  const base = { walletSplit, currentSplit, allowedSplits };

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
