/**
 * SPLIT GATE — which Split a wallet was registered in decides whether its LANA
 * may be sold back.
 *
 * The LANA Registrar records `split_created` for every LanaPays.Us wallet, and
 * lana.discount only ever offers registered wallets on the sell page. The
 * buyback window is deliberately narrow: by default only the split immediately
 * before the current one.
 *
 *   - the CURRENT split is still in play — its LANA has not finished its round;
 *   - OLDER splits are past — buying them back now would settle them at a rate
 *     that no longer describes what they are.
 *
 * The window is one app setting (buyback_allowed_split_offsets, offsets from
 * the current split) so it can be widened or moved without a deploy. Everything
 * that decides is in this file, and it decides on numbers only — the fetching
 * lives in the route.
 *
 * FAIL-CLOSED, for the same reason the freeze gate is: we are not deciding
 * whether to SHOW something, we are deciding whether to let money leave. "We
 * could not establish which split this wallet belongs to" is not permission.
 */

export interface SplitVerdict {
  allowed: boolean;
  code: 'OK' | 'SPLIT_TOO_NEW' | 'SPLIT_TOO_OLD' | 'SPLIT_UNKNOWN' | 'SPLIT_UNVERIFIABLE';
  reason: string;
  walletSplit: number | null;
  currentSplit: number | null;
  allowedSplits: number[];
}

/** The documented policy when nothing else is configured: only current − 1. */
export const DEFAULT_ALLOWED_OFFSETS = [1];

/**
 * "1" → [1]   ·   "1,2" → [1, 2]   ·   "0,1" → [0, 1] (0 = the current split)
 *
 * A missing or unreadable setting falls back to the default rather than to an
 * empty list: a typo in the database must not quietly become either "sell
 * nothing" or "sell everything".
 */
export function parseAllowedOffsets(raw: string | null | undefined): number[] {
  if (raw === null || raw === undefined) return [...DEFAULT_ALLOWED_OFFSETS];
  const parsed = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => parseInt(s, 10));
  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_ALLOWED_OFFSETS];
}

function human(splits: number[]): string {
  if (splits.length === 1) return `Split ${splits[0]}`;
  return `Splits ${splits.slice(0, -1).join(', ')} and ${splits[splits.length - 1]}`;
}

export function evaluateBuybackSplit(input: {
  /** split_created from the registrar; null when unknown or not registered. */
  walletSplit: number | null | undefined;
  /** The current split from KIND 38888; null when we have no KIND 38888 yet. */
  currentSplit: number | null | undefined;
  allowedOffsets: number[];
  /** Did the registrar actually answer? An outage is not a clearance. */
  registrarReachable: boolean;
}): SplitVerdict {
  const currentSplit = Number.isFinite(input.currentSplit as number) ? Number(input.currentSplit) : null;
  const walletSplit = Number.isFinite(input.walletSplit as number) ? Number(input.walletSplit) : null;

  const allowedSplits = currentSplit === null
    ? []
    : [...new Set(input.allowedOffsets.map((o) => currentSplit - o))].filter((s) => s >= 0).sort((a, b) => a - b);

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
  if (allowedSplits.includes(walletSplit)) {
    return { ...base, allowed: true, code: 'OK', reason: '' };
  }

  // Above the window means the LANA is newer than what we buy back — including
  // the current split, which is still running.
  const tooNew = walletSplit > Math.max(...allowedSplits);
  return tooNew
    ? {
        ...base, allowed: false, code: 'SPLIT_TOO_NEW',
        reason: walletSplit === currentSplit
          ? `This wallet was registered in the current Split ${walletSplit}, which is still running. Only LANA from ${human(allowedSplits)} is bought back.`
          : `This wallet was registered in Split ${walletSplit}. Only LANA from ${human(allowedSplits)} is bought back.`,
      }
    : {
        ...base, allowed: false, code: 'SPLIT_TOO_OLD',
        reason: `This wallet was registered in Split ${walletSplit}, which has already passed. Only LANA from ${human(allowedSplits)} is bought back.`,
      };
}
