/**
 * Is this counterparty and this wallet eligible at all?
 *
 * Extracted verbatim from what `/sell/execute` has always done, because the
 * acquisition flow now needs the same answer TWICE: once when the offer is
 * submitted, to decide whether to make a purchase offer at all, and again at
 * transfer time, because a wallet can be frozen in the minutes between the
 * two and an accepted offer is not a licence to move frozen coins.
 *
 * Three gates, unchanged in substance:
 *   payment rating — a seller with open obligations does not sell;
 *   freeze — two independent sources, conservative verdict (lib/freeze.ts);
 *   buyback window — which Split the wallet belongs to, for the wallet types
 *     that rule is about (lib/buybackSplit.ts).
 *
 * It also resolves the wallet's TYPE and CLASS while it has the authoritative
 * answers in hand. That matters beyond tidiness: the commission tier used to
 * be taken from whatever `walletType` the client posted, so a tampered request
 * could pick the cheaper tier. Here the class comes from the signed KIND 30889
 * and the registrar, and nothing else.
 *
 * A crash inside a gate is a refusal, never an open door.
 */
import { evaluateFreeze, registrarSignal, walletListSignal } from './freeze.js';
import { evaluateBuybackSplit, isScopedWalletType } from './buybackSplit.js';
import { isSellableWalletType } from './sellableWallet.js';
import { fetchPaymentScore, fetchUserWallets } from './nostr.js';
import type { WalletClass } from './treasuryMandate.js';

/**
 * One shape rather than a discriminated union: this repo's tsconfig runs with
 * strictNullChecks off, under which narrowing on an `ok: true | false` literal
 * is unreliable, and a guard that silently stops narrowing is worse than a
 * slightly looser type.
 */
export interface EligibilityResult {
  ok: boolean;
  /** Set when ok is false. */
  httpStatus?: number;
  code?: string;
  error?: string;
  /** Extra fields the existing clients already read (unfreezeUrl, split info). */
  detail?: Record<string, unknown>;
  /** Set when ok is true — the registrar's type string, if either source knows it. */
  walletType?: string | null;
  /** Set when ok is true — which mandate branch this wallet falls under. */
  walletClass?: WalletClass;
  /** Set when ok is true — the evidence behind the decision (framework section 11). */
  evidence?: Record<string, unknown>;
}

export interface EligibilityDeps {
  relays: string[];
  trustedRegistrars: string[];
  walletCheckBaseUrl: string;
  currentSplit: string | null;
}

/**
 * `LanaPays.Us` and its sub-types are the payment system's own wallets;
 * everything else — a person's main wallet, a retail card — is `other`.
 * (The crowd-funding class was retired with the old settlement order; rows
 * that already carry it are read, never written.)
 */
export function classifyWallet(walletType: string | null): WalletClass {
  if (isScopedWalletType(walletType)) return 'lanapays';
  return 'other';
}

export async function checkSellerEligibility(
  hexId: string,
  senderAddress: string,
  deps: EligibilityDeps,
): Promise<EligibilityResult> {
  // ── Payment rating ──────────────────────────────────────────────────
  try {
    const rating = await fetchPaymentScore(hexId, deps.relays);
    if (!rating || !rating.qualifies) {
      const score = rating?.score ?? 'none';
      console.log(`[lana-discount] Blocked: ${hexId.slice(0, 12)}… rating ${score} (open obligations)`);
      return {
        ok: false, httpStatus: 403, code: 'RATING_BLOCKED',
        error: 'Selling is only available to users with no open obligations.',
        detail: { rating: score },
      };
    }
  } catch (err: any) {
    console.warn('[lana-discount] Rating check failed, blocking:', err.message);
    return {
      ok: false, httpStatus: 403, code: 'RATING_UNVERIFIABLE',
      error: 'Unable to verify payment rating. Please try again.',
    };
  }

  // ── Freeze + buyback window ─────────────────────────────────────────
  try {
    const [registrar, listedWallets] = await Promise.all([
      registrarSignal(senderAddress, deps.walletCheckBaseUrl),
      fetchUserWallets(hexId, deps.relays, deps.trustedRegistrars)
        .catch(() => [] as Awaited<ReturnType<typeof fetchUserWallets>>),
    ]);
    const walletList = walletListSignal(listedWallets, senderAddress);
    const freeze = evaluateFreeze([registrar, walletList]);
    if (freeze.blocked) {
      console.log(
        `[lana-discount] Blocked (${freeze.code}): ${hexId.slice(0, 12)}… wallet ${senderAddress.slice(0, 10)}… — ` +
        freeze.signals.map(s => `${s.source}:${s.reachable ? (s.frozen ? 'FROZEN' : 'ok') : 'unreachable'}`).join(' '),
      );
      return {
        ok: false, httpStatus: 403, code: freeze.code, error: freeze.reason,
        detail: freeze.code === 'WALLET_FROZEN' ? { unfreezeUrl: 'https://unfreeze.lanapays.us' } : undefined,
      };
    }

    const listedType = listedWallets.find(
      w => String(w.walletId || '').trim().toLowerCase() === senderAddress.trim().toLowerCase(),
    )?.walletType;
    // Being in scope is the stricter reading, so a wallet only escapes the
    // buyback window when NEITHER source calls it a LanaPays.Us one.
    const scopedType = [registrar.walletType, listedType].find(isScopedWalletType) ?? null;

    const split = evaluateBuybackSplit({
      walletSplit: registrar.splitCreated ?? null,
      currentSplit: parseInt(deps.currentSplit || '') || null,
      registrarReachable: registrar.reachable,
      walletType: scopedType,
    });
    if (!split.allowed) {
      console.log(
        `[lana-discount] Blocked (${split.code}): wallet ${senderAddress.slice(0, 10)}… ` +
        `split ${split.walletSplit ?? '?'} vs allowed [${split.allowedSplits.join(',')}] (current ${split.currentSplit ?? '?'})`,
      );
      return {
        ok: false, httpStatus: 403, code: split.code, error: split.reason,
        detail: {
          walletSplit: split.walletSplit,
          currentSplit: split.currentSplit,
          allowedSplits: split.allowedSplits,
        },
      };
    }

    // The type for pricing and for the mandate: prefer whichever source
    // actually named it, registrar first.
    const walletType = registrar.walletType ?? listedType ?? null;

    // The offer page only lists sellable types, but a list is a courtesy and
    // not a gate: the type is checked here, against what the REGISTRAR says,
    // so a hand-made request naming a Retail card gets the same refusal the
    // page would have given.
    if (!isSellableWalletType(walletType)) {
      console.log(`[lana-discount] Blocked (WALLET_TYPE_NOT_SELLABLE): ${senderAddress.slice(0, 10)}… is ${walletType ?? 'untyped'}`);
      return {
        ok: false, httpStatus: 403, code: 'WALLET_TYPE_NOT_SELLABLE',
        error: walletType
          ? `A ${walletType} wallet cannot be offered. Offers are made from a Main Wallet, a Wallet or a LanaPays.Us wallet.`
          : 'This wallet is not registered under a type that can be offered.',
        detail: { walletType },
      };
    }

    return {
      ok: true,
      walletType,
      walletClass: classifyWallet(scopedType ?? walletType),
      evidence: {
        checkedAt: new Date().toISOString(),
        registrarReachable: registrar.reachable,
        registrarWalletType: registrar.walletType ?? null,
        listedWalletType: listedType ?? null,
        walletSplit: split.walletSplit,
        currentSplit: split.currentSplit,
        splitCode: split.code,
        freezeCode: freeze.code,
      },
    };
  } catch (err: any) {
    console.warn('[lana-discount] Eligibility check failed, blocking:', err.message);
    return {
      ok: false, httpStatus: 403, code: 'FREEZE_UNVERIFIABLE',
      error: 'Freeze status could not be verified right now. Please try again shortly.',
    };
  }
}
