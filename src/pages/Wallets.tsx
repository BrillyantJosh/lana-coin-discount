import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface Wallet {
  walletId: string;
  walletType: string;
  note?: string;
  amountUnregistered?: string;
  status?: string;
  freezeStatus?: string;
}

interface WalletWithBalance extends Wallet {
  balance?: number;
  balanceLoading?: boolean;
}

interface WatchedWallet {
  id: number;
  wallet_id: string;
  wallet_type: string;
  note: string;
  last_balance: number | null;
}

const Wallets = () => {
  const { session, isLoading: authLoading, logout } = useAuth();
  const navigate = useNavigate();

  const [wallets, setWallets] = useState<WalletWithBalance[]>([]);
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialWatchedIds, setInitialWatchedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
  }, [session, authLoading, navigate]);

  // Fetch wallets + watched wallets on mount
  const fetchAll = useCallback(async () => {
    if (!session) return;
    setLoading(true);

    try {
      // Fetch wallets from Nostr and watched wallets from DB in parallel
      const [walletsRes, watchedRes] = await Promise.all([
        fetch(`/api/user/${session.nostrHexId}/wallets`),
        fetch(`/api/user/${session.nostrHexId}/watched-wallets`),
      ]);

      const walletsData = await walletsRes.json();
      const watchedData = await watchedRes.json();

      const fetchedWallets: Wallet[] = walletsData.wallets || [];
      const watched: WatchedWallet[] = watchedData.watchedWallets || [];

      // Set watched IDs
      const watchedSet = new Set(watched.map(w => w.wallet_id));
      setWatchedIds(watchedSet);
      setInitialWatchedIds(new Set(watchedSet));

      // Build wallet list with cached balances from watched
      const balanceMap = new Map(watched.filter(w => w.last_balance !== null).map(w => [w.wallet_id, w.last_balance!]));

      const walletsWithBalance: WalletWithBalance[] = fetchedWallets.map(w => ({
        ...w,
        balance: balanceMap.get(w.walletId),
        balanceLoading: false,
      }));

      setWallets(walletsWithBalance);

      // Fetch live balances
      if (fetchedWallets.length > 0) {
        setBalancesLoading(true);
        try {
          const balancesRes = await fetch('/api/wallets/balances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ addresses: fetchedWallets.map(w => w.walletId) }),
          });
          const balancesData = await balancesRes.json();

          if (balancesData.balances) {
            const bMap = new Map(balancesData.balances.map((b: any) => [b.wallet_id, b.balance]));
            setWallets(prev => prev.map(w => ({
              ...w,
              balance: bMap.has(w.walletId) ? (bMap.get(w.walletId) as number) : w.balance,
              balanceLoading: false,
            })));
          }
        } catch (e) {
          console.error('Balance fetch failed:', e);
        } finally {
          setBalancesLoading(false);
        }
      }
    } catch (error) {
      console.error('Failed to fetch wallets:', error);
      toast.error('Failed to load wallets');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Toggle wallet watching
  const toggleWallet = (walletId: string) => {
    setWatchedIds(prev => {
      const next = new Set(prev);
      if (next.has(walletId)) {
        next.delete(walletId);
      } else {
        next.add(walletId);
      }
      return next;
    });
  };

  // Select all / deselect all
  const selectAll = () => setWatchedIds(new Set(wallets.map(w => w.walletId)));
  const deselectAll = () => setWatchedIds(new Set());

  // Check if selection changed
  const hasChanges = (() => {
    if (watchedIds.size !== initialWatchedIds.size) return true;
    for (const id of watchedIds) {
      if (!initialWatchedIds.has(id)) return true;
    }
    return false;
  })();

  // Save watched wallets
  const saveWatched = async () => {
    if (!session) return;
    setSaving(true);

    try {
      const selectedWallets = wallets
        .filter(w => watchedIds.has(w.walletId))
        .map(w => ({ walletId: w.walletId, walletType: w.walletType, note: w.note }));

      const res = await fetch(`/api/user/${session.nostrHexId}/watched-wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallets: selectedWallets }),
      });

      const data = await res.json();
      if (data.success) {
        setInitialWatchedIds(new Set(watchedIds));
        toast.success(`${selectedWallets.length} wallet(s) saved for monitoring`);
      } else {
        toast.error('Failed to save');
      }
    } catch (error) {
      console.error('Save error:', error);
      toast.error('Failed to save watched wallets');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || !session) return null;

  const displayName = session.profileDisplayName || session.profileName || 'User';

  // Sort wallets: Main Wallet first, then by type
  const typeOrder: Record<string, number> = {
    'Main Wallet': 1, 'Wallet': 2, 'LanaPays.Us': 3, 'Lana.Discount': 4,
  };
  const sorted = [...wallets].sort((a, b) =>
    (typeOrder[a.walletType] || 99) - (typeOrder[b.walletType] || 99)
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/dashboard" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            Lana<span className="text-gold">.discount</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Dashboard
            </Link>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 container mx-auto px-6 py-12 max-w-4xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Your Wallets</h1>
          <p className="text-muted-foreground">
            Select wallets you'd like us to monitor for buyback opportunities.
            We'll notify you when your coins are ready for instant payout.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading wallets from Nostr relays...</p>
            </div>
          </div>
        ) : wallets.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">No registered wallets found.</p>
            <p className="text-sm text-muted-foreground mt-2">
              Your wallets will appear here once they're registered in the LanaCoin system.
            </p>
          </div>
        ) : (
          <>
            {/* Select all / Deselect all */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <button onClick={selectAll} className="text-sm text-primary hover:underline font-medium">
                  Select All
                </button>
                <span className="text-muted-foreground">|</span>
                <button onClick={deselectAll} className="text-sm text-muted-foreground hover:underline">
                  Deselect All
                </button>
              </div>
              <div className="text-sm text-muted-foreground">
                {watchedIds.size} of {wallets.length} selected
              </div>
            </div>

            {/* Wallet list */}
            <div className="space-y-3">
              {sorted.map(wallet => {
                const isWatched = watchedIds.has(wallet.walletId);
                const isFrozen = !!wallet.freezeStatus;
                const shortAddr = wallet.walletId.slice(0, 10) + '...' + wallet.walletId.slice(-6);

                return (
                  <div
                    key={wallet.walletId}
                    onClick={() => toggleWallet(wallet.walletId)}
                    className={`rounded-xl border-2 p-5 cursor-pointer transition-all ${
                      isWatched
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-card hover:border-muted-foreground/30'
                    } ${isFrozen ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start gap-4">
                      {/* Checkbox */}
                      <div className={`mt-1 h-5 w-5 flex-shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
                        isWatched ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                      }`}>
                        {isWatched && (
                          <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>

                      {/* Wallet info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-sm font-medium text-foreground">{shortAddr}</span>
                          {isFrozen && (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                              Frozen
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <span className="font-medium text-foreground/70">Type:</span>
                            {wallet.walletType}
                          </span>
                          {wallet.note && (
                            <span className="inline-flex items-center gap-1">
                              <span className="font-medium text-foreground/70">Note:</span>
                              {wallet.note}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Balance */}
                      <div className="text-right flex-shrink-0">
                        {balancesLoading && wallet.balance === undefined ? (
                          <div className="h-4 w-20 animate-pulse bg-muted rounded" />
                        ) : wallet.balance !== undefined ? (
                          <div>
                            <span className="font-mono text-sm font-bold text-foreground">
                              {wallet.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span className="text-xs text-muted-foreground ml-1">LANA</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Save button */}
            <div className="mt-8 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {watchedIds.size} wallet(s) will be monitored for buyback
              </p>
              <button
                onClick={saveWatched}
                disabled={saving || !hasChanges}
                className={`rounded-xl px-8 py-3 font-semibold text-white transition-all ${
                  saving || !hasChanges
                    ? 'bg-muted-foreground/30 cursor-not-allowed'
                    : 'bg-primary hover:bg-primary/90 shadow-lg hover:shadow-xl'
                }`}
              >
                {saving ? 'Saving...' : hasChanges ? 'Save Selection' : 'Saved'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.discount — Instant LanaCoin Buyback
      </footer>
    </div>
  );
};

export default Wallets;
