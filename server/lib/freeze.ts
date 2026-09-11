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

import { isScopedWalletType } from './buybackSplit.js';

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
  /**
   * WHY this source says frozen — the registrar's own `freeze_reason`, or the
   * per-wallet code carried in the KIND 30889 `w` tag. Freezes are not all the
   * same statement, and one of them is waived below.
   */
  freezeReason?: string;
}

/**
 * The OWN process freezing a person, and the one freeze that does not stop a
 * financing-round sale.
 *
 * The other codes are statements about the COINS — unregistered LANA on the
 * wallet (`frozen_unreg_Lanas`), a balance over the published cap
 * (`frozen_max_cap`), a Lana8Wonder finding (`frozen_l8w`), a wallet moving in
 * ways the registrar would not vouch for (`frozen_too_wild`). Letting any of
 * those sell would walk the treasury straight past the finding.
 *
 * `frozen_own_person` is not about the coins. It is a sanction inside the OWN
 * process against a PERSON, and the owner's decision (9 Sep 2026) is that it
 * must not also take away what they financed: someone whose whole account is
 * frozen this way may still sell from a LanaPays.Us wallet when their financing
 * round is open. It is waived for that wallet class and nothing else — a
 * frozen_own_person Main Wallet still cannot sell, and a wallet frozen for any
 * other reason still cannot sell whatever class it is.
 */
export const OWN_PROCESS_FREEZE = 'frozen_own_person';

/**
 * Does a freeze on THIS wallet stop it being sold from?
 *
 * The same rule the gate applies, exported so the wallet list can be built from
 * it too. The sell page used to grey out anything carrying a freeze status and
 * never asked the server at all, so a wallet the gate would have allowed was
 * unreachable — the seller saw only "unfreeze it first, then come back", which
 * for an OWN-process freeze is advice they cannot act on.
 *
 * One definition, two callers: the gate that refuses, and the list that offers.
 */
export function freezeStopsSale(freezeStatus: string | null | undefined, walletType: string | null | undefined): boolean {
  const status = String(freezeStatus || '').trim();
  if (!status) return false;
  if (status !== OWN_PROCESS_FREEZE) return true;
  return !isScopedWalletType(walletType);
}

/** Does this signal's freeze stand, given what is being sold from? */
function freezeStands(s: FreezeSignal, sellingWalletType: string | undefined): boolean {
  if (!s.reachable || !s.frozen) return false;
  if (s.freezeReason !== OWN_PROCESS_FREEZE) return true;
  // Waived only for the wallet class the financing-round mandates are about,
  // judged by the same test the buyback window uses so the two can never
  // disagree about what a LanaPays.Us wallet is.
  return !isScopedWalletType(sellingWalletType);
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
export function evaluateFreeze(signals: FreezeSignal[], sellingWalletType?: string): FreezeVerdict {
  // The class being sold FROM decides whether an OWN-process freeze stands.
  // When no class was passed, or the registrar never told us one, nothing is
  // waived — a gate that guesses is not a gate.
  const type = sellingWalletType ?? signals.find(s => s.walletType)?.walletType;
  const frozen = signals.filter(s => freezeStands(s, type));
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
  const rawReason = data?.freeze_reason ?? data?.wallet?.freeze_reason;
  const freezeReason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
  const walletType = typeof rawType === 'string' && rawType.trim() ? rawType.trim() : undefined;
  const splitCreated = Number.isFinite(Number(rawSplit)) && rawSplit !== null && rawSplit !== ''
    ? Number(rawSplit)
    : undefined;

  // An explicit freeze is definitive on its own and needs no registration
  // status to be believed.
  if (frozen) {
    return {
      source: 'registrar', reachable: true, frozen: true,
      detail: freezeReason ? `registrar: wallet frozen (${freezeReason})` : 'registrar: wallet frozen',
      splitCreated, walletType, freezeReason,
    };
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

  // An account frozen as a whole. The OWN-process monitor deliberately leaves
  // the profile status 'active' and marks the wallets instead, so this path is
  // some OTHER freeze and carries no waiver: if every wallet on the list is
  // marked frozen_own_person we take that as the reason, and otherwise none.
  const accountFrozen = wallets.some(w => w.status === 'frozen');
  if (accountFrozen) {
    const allOwnProcess = wallets.length > 0 && wallets.every(w => w.freezeStatus === OWN_PROCESS_FREEZE);
    return {
      source: 'wallet-list', reachable: true, frozen: true, detail: 'account status: frozen',
      freezeReason: allOwnProcess ? OWN_PROCESS_FREEZE : undefined,
    };
  }

  // Match case-insensitively: wallet ids travel through QR scans, manual entry
  // and relay tags, and a case difference must not silently clear a freeze.
  const target = String(senderWalletId || '').trim().toLowerCase();
  const mine = wallets.find(w => String(w.walletId || '').trim().toLowerCase() === target);
  if (mine?.freezeStatus) {
    return { source: 'wallet-list', reachable: true, frozen: true, detail: `wallet: ${mine.freezeStatus}`, freezeReason: mine.freezeStatus };
  }

  // ANOTHER WALLET'S FREEZE NO LONGER STOPS THIS ONE — owner, 11 Sept 2026:
  // "rekli smo da ta denarnica ne more biti blokirana tudi če so druge".
  //
  // From 2026-08-28 until today a freeze on ANY wallet of the account stopped
  // the sale, on the reasoning that the registrar freezes a wallet when it
  // finds unregistered LANA on it, and that is a statement about the HOLDER
  // rather than about one address — so a clean sibling would walk past the
  // finding. Nine days of live data say otherwise about the reason that
  // actually bites: `frozen_max_cap` is a finding about the BALANCE ON THAT
  // ONE WALLET against the published cap, and a cap breach on wallet A is not
  // a fact about wallet B's coins at all. It stopped a financing-round sale
  // from a clean wallet whose owner could do nothing about the other one.
  //
  // What still stops a sale, and it is the whole list:
  //   • a freeze on the wallet being SOLD FROM — above, and from the registrar
  //     signal, which asks about that wallet by name;
  //   • an account frozen as a WHOLE (`status: frozen`) — above;
  //   • nothing reachable at all — evaluateFreeze, which fails closed.
  // A sibling is none of those. The wallet being sold from is judged on
  // itself, which is the same precision the public board already keeps
  // (wallet-level ≠ account-level).

  // The account is demonstrably not frozen. If the wallet itself isn't on the
  // list we say so, but that is still a valid account-level clearance.
  return {
    source: 'wallet-list',
    reachable: true,
    frozen: false,
    detail: mine ? undefined : 'wallet not on account list',
  };
}
