/**
 * FREEZE GATE — a frozen account must not be able to sell its LANA back.
 *
 * A freeze exists precisely to stop funds from moving. Until now lana.discount
 * checked payment rating, currency, minimum and buyback wallet before a
 * buyback, but never whether the account was frozen: the sell page showed a
 * "Frozen" badge and then let you click straight through it, and the server
 * never looked at all. The mobile app has always refused to move funds from a
 * frozen wallet (`/api/check-wallet` → `wallet.frozen`); this brings the buyback
 * in line with it.
 *
 * TWO INDEPENDENT SOURCES, because they can freeze different things:
 *   - the LANA Registrar, per WALLET (the same source the mobile app uses);
 *   - KIND 30889, which carries an account-level `status` tag AND a per-wallet
 *     freeze in the `w` tag — so an account can be frozen as a whole.
 *
 * The verdict is deliberately conservative, and the reasoning is: we are not
 * deciding whether to SHOW something, we are deciding whether to let money
 * leave. "We could not check" is not evidence that an account is free to sell.
 *
 * The two sources cover each other: the registrar catches a per-wallet freeze
 * no matter which identity is selling, and KIND 30889 catches an account-level
 * freeze. KNOWN RESIDUAL GAP: if the registrar is unreachable AND the seller is
 * logged in as a different, active hex than the one holding the frozen wallet,
 * only the registrar would have known — so that sale passes. Closing it would
 * mean requiring the sender wallet to appear on the seller's own KIND 30889
 * list, which would also block legitimate sales from a newly added wallet.
 */

export interface FreezeSignal {
  source: string;        // 'registrar' | 'wallet-list'
  reachable: boolean;    // did we get an answer at all?
  frozen: boolean;       // does this source say frozen?
  detail?: string;       // e.g. 'frozen_max_cap', 'account status: frozen'
  /**
   * The registrar's split_created for this wallet, carried through so the
   * buyback split gate (lib/buybackSplit.ts) can decide from the SAME answer
   * instead of asking the registrar a second time. Only ever set by the
   * registrar signal; undefined means "this source does not know".
   */
  splitCreated?: number;
  /**
   * The registrar's wallet_type, carried through for the same reason: the
   * buyback window applies to LanaPays.Us wallets only, and this is the
   * answer that says which kind this is.
   */
  walletType?: string;
}

export interface FreezeVerdict {
  blocked: boolean;
  code: 'OK' | 'WALLET_FROZEN' | 'FREEZE_UNVERIFIABLE';
  reason: string;
  signals: FreezeSignal[];
}

/**
 * Pure decision:
 *   any source says frozen        → BLOCK   (a single freeze is enough)
 *   nothing reachable             → BLOCK   (cannot establish it is not frozen)
 *   at least one clean answer     → ALLOW
 *
 * Note the asymmetry: one "frozen" outvotes any number of "not frozen", because
 * the sources guard different things and neither can clear the other's freeze.
 */
export function evaluateFreeze(signals: FreezeSignal[]): FreezeVerdict {
  const frozen = signals.filter(s => s.reachable && s.frozen);
  if (frozen.length > 0) {
    const detail = frozen.map(s => s.detail).filter(Boolean).join('; ');
    return {
      blocked: true,
      code: 'WALLET_FROZEN',
      reason: detail
        ? `This account is frozen (${detail}). Funds cannot be sold from a frozen account.`
        : 'This account is frozen. Funds cannot be sold from a frozen account.',
      signals,
    };
  }

  if (!signals.some(s => s.reachable)) {
    return {
      blocked: true,
      code: 'FREEZE_UNVERIFIABLE',
      reason: 'Freeze status could not be verified right now. Please try again shortly.',
      signals,
    };
  }

  return { blocked: false, code: 'OK', reason: '', signals, };
}

/**
 * The registrar's per-wallet answer, read through check.lanapays.us — the same
 * evidence the mobile app refuses on.
 *
 * TWO SHAPES ON PURPOSE. check.lanapays.us FLATTENS the registrar reply to
 * `{registered, frozen, …}`, while the mobile proxy forwards it raw as
 * `{success, registered, wallet:{frozen}}`. Reading only one of them would find
 * `frozen` undefined against the other and silently report "not frozen" — a
 * false clearance on a safety gate. So both are read.
 */
export function parseRegistrarBody(data: any): FreezeSignal {
  const frozen = (data?.frozen ?? data?.wallet?.frozen) === true;
  // Same two shapes as `frozen`: flattened by check.lanapays.us, nested by the
  // mobile proxy.
  const rawSplit = data?.split_created ?? data?.wallet?.split_created;
  const rawType = data?.wallet_type ?? data?.wallet?.wallet_type;
  const walletType = typeof rawType === 'string' && rawType.trim() ? rawType.trim() : undefined;
  const splitCreated = Number.isFinite(Number(rawSplit)) && rawSplit !== null && rawSplit !== ''
    ? Number(rawSplit)
    : undefined;

  // An explicit freeze is definitive on its own and needs no registration
  // status to be believed.
  if (frozen) {
    return { source: 'registrar', reachable: true, frozen: true, detail: 'registrar: wallet frozen', splitCreated, walletType };
  }
  if (data?.registered === true) {
    return { source: 'registrar', reachable: true, frozen: false, splitCreated, walletType };
  }

  // `registered: false` is ALSO what this proxy returns when the registrar API
  // errors or the id fails its format check — an outage is indistinguishable
  // from a genuine negative (see ops_mobile_check_lanapays_dependency: when
  // check.lanapays.us falls, everyone reads as "not enrolled"). So it is NOT
  // treated as a clearance. Legitimate sellers are cleared by the wallet-list
  // signal, which is derived from the registrar's own signed KIND 30889.
  return { source: 'registrar', reachable: false, frozen: false, detail: 'not registered / unavailable' };
}

export async function registrarSignal(
  walletId: string,
  checkBaseUrl: string,
  timeoutMs = 8000,
): Promise<FreezeSignal> {
  try {
    const res = await fetch(`${checkBaseUrl.replace(/\/$/, '')}/api/check-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_id: walletId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { source: 'registrar', reachable: false, frozen: false };
    return parseRegistrarBody(await res.json());
  } catch {
    return { source: 'registrar', reachable: false, frozen: false };
  }
}

/**
 * KIND 30889. `wallets` is the already-parsed list for this hex, where
 * `freezeStatus` is set when the ACCOUNT is frozen or when that individual
 * wallet is. An empty list means we found no authoritative wallet list at all.
 */
export function walletListSignal(
  wallets: Array<{ walletId: string; status?: string; freezeStatus?: string }>,
  senderWalletId: string,
): FreezeSignal {
  if (!wallets || wallets.length === 0) {
    return { source: 'wallet-list', reachable: false, frozen: false };
  }

  const accountFrozen = wallets.some(w => w.status === 'frozen');
  if (accountFrozen) {
    return { source: 'wallet-list', reachable: true, frozen: true, detail: 'account status: frozen' };
  }

  // Match case-insensitively: wallet ids travel through QR scans, manual entry
  // and relay tags, and a case difference must not silently clear a freeze.
  const target = String(senderWalletId || '').trim().toLowerCase();
  const mine = wallets.find(w => String(w.walletId || '').trim().toLowerCase() === target);
  if (mine?.freezeStatus) {
    return { source: 'wallet-list', reachable: true, frozen: true, detail: `wallet: ${mine.freezeStatus}` };
  }

  // The account is demonstrably not frozen. If the wallet itself isn't on the
  // list we say so, but that is still a valid account-level clearance.
  return {
    source: 'wallet-list',
    reachable: true,
    frozen: false,
    detail: mine ? undefined : 'wallet not on account list',
  };
}
