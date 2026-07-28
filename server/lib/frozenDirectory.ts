/**
 * WHO IS FROZEN — a directory of freeze status for the people shown on the
 * public transparency board (the payout queue and the recent-payouts list).
 *
 * The freeze itself is already public: it lives in KIND 30889, published by the
 * registrar. This module only collects it for the handful of people the page
 * actually names, so a reader can see at a glance that someone in the queue is
 * frozen and therefore cannot be settled the usual way.
 *
 * BATCHED ON PURPOSE. Nostr filters take arrays, so all ~60 people resolve in
 * THREE relay queries (~1s measured against production), not 60 × 3. Fetching
 * per person would be ~180 subscriptions per refresh for a page anyone can load.
 *
 * PRECISION MATTERS HERE. Measured on live data, nobody currently has an
 * account-level freeze; three people have an individual wallet frozen
 * (`frozen_max_cap`). Those are different facts, so the summary reports WHICH
 * one it is and the UI says "frozen wallet" when that is what is true. Calling
 * a capped wallet a frozen account would be a public accusation we cannot back.
 */

export type FreezeLevel = 'none' | 'wallet' | 'account';

export interface FreezeSummary {
  /** true when anything at all is frozen — account or a single wallet. */
  frozen: boolean;
  level: FreezeLevel;
  frozenWallets: number;
  totalWallets: number;
  /** distinct registrar reasons, e.g. ['frozen_max_cap'] */
  reasons: string[];
}

export interface WalletListEvent {
  tags: string[][];
  created_at: number;
}

/** The owner a KIND 30889 wallet list belongs to — `d`, `wallet-list-<hex>` or `p`. */
export function ownerOf(ev: WalletListEvent): string {
  const d = ev.tags.find(t => t[0] === 'd')?.[1] || '';
  if (/^[0-9a-f]{64}$/i.test(d)) return d.toLowerCase();
  if (d.startsWith('wallet-list-')) return d.slice(12).toLowerCase();
  return (ev.tags.find(t => t[0] === 'p')?.[1] || '').toLowerCase();
}

/**
 * Pure read of one wallet list. `w` tags are
 * [w, walletId, type, currency, notes, amount, freeze_status?] — index 6 is the
 * per-wallet freeze, and an account-level `status` tag freezes everything.
 */
export function summarise(ev: WalletListEvent): FreezeSummary {
  const wallets = ev.tags.filter(t => t[0] === 'w');
  const accountFrozen = (ev.tags.find(t => t[0] === 'status')?.[1] || 'active') === 'frozen';
  const frozenTags = wallets.filter(t => t.length >= 7 && t[6]);
  const reasons = [...new Set(frozenTags.map(t => t[6]).filter(Boolean))];

  if (accountFrozen) {
    return {
      frozen: true,
      level: 'account',
      // An account freeze covers every wallet on it, whatever the per-wallet tags say.
      frozenWallets: wallets.length,
      totalWallets: wallets.length,
      reasons: reasons.length ? reasons : ['frozen'],
    };
  }
  return {
    frozen: frozenTags.length > 0,
    level: frozenTags.length > 0 ? 'wallet' : 'none',
    frozenWallets: frozenTags.length,
    totalWallets: wallets.length,
    reasons,
  };
}

/** Newest event per owner wins — KIND 30889 is replaceable. */
export function buildDirectory(events: WalletListEvent[], wanted: string[]): Map<string, FreezeSummary> {
  const want = new Set(wanted.map(h => h.toLowerCase()));
  const newest = new Map<string, WalletListEvent>();
  for (const ev of events) {
    const owner = ownerOf(ev);
    if (!owner || !want.has(owner)) continue;
    const prev = newest.get(owner);
    if (!prev || ev.created_at > prev.created_at) newest.set(owner, ev);
  }
  const out = new Map<string, FreezeSummary>();
  for (const [owner, ev] of newest) out.set(owner, summarise(ev));
  return out;
}

// ─── live directory ──────────────────────────────────────────────────────

type QueryFn = (relays: string[], filter: any) => Promise<any[]>;

let directory = new Map<string, FreezeSummary>();
let lastRefresh = 0;

/** Freeze status for one hex, or null when we have never resolved them. */
export function freezeOf(hexId: string | null | undefined): FreezeSummary | null {
  if (!hexId) return null;
  return directory.get(hexId.toLowerCase()) || null;
}

export function directoryAge(): number {
  return lastRefresh ? Date.now() - lastRefresh : Infinity;
}

/**
 * Refresh the directory for exactly the people named on the board. Three
 * batched queries cover the three d-tag conventions registrars use.
 * Best-effort: on a relay failure the previous answer is KEPT rather than
 * cleared, because "we could not reach a relay" must not read as "not frozen".
 */
export async function refreshFrozenDirectory(
  hexes: string[],
  relays: string[],
  query: QueryFn,
): Promise<{ resolved: number; frozen: number }> {
  const wanted = [...new Set(hexes.filter(h => /^[0-9a-f]{64}$/i.test(h)).map(h => h.toLowerCase()))];
  if (wanted.length === 0 || relays.length === 0) return { resolved: 0, frozen: 0 };

  const limit = Math.max(500, wanted.length * 2);
  const [byD, byWalletList, byP] = await Promise.all([
    query(relays, { kinds: [30889], '#d': wanted, limit }),
    query(relays, { kinds: [30889], '#d': wanted.map(h => `wallet-list-${h}`), limit }),
    query(relays, { kinds: [30889], '#p': wanted, limit }),
  ]);

  const next = buildDirectory([...byD, ...byWalletList, ...byP], wanted);
  if (next.size === 0) return { resolved: 0, frozen: 0 }; // keep what we had

  // Carry forward anyone this pass did not resolve — a missing answer is not
  // evidence that their freeze was lifted.
  for (const [hex, prev] of directory) if (!next.has(hex)) next.set(hex, prev);
  directory = next;
  lastRefresh = Date.now();

  let frozen = 0;
  for (const s of next.values()) if (s.frozen) frozen++;
  return { resolved: next.size, frozen };
}

/** Test seam. */
export function _setDirectory(d: Map<string, FreezeSummary>): void {
  directory = d;
  lastRefresh = d.size ? 1 : 0;
}
