import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface BuybackStats {
  totalLanaBoughtBack: number;
  totalOwed: number;
  totalPaidOut: number;
  totalRemaining: number;
  totalTransactions: number;
  usersServed: number;
  pendingVerificationCount: number;
  buybackWalletBalance: number | null;
  buybackWalletId: string;
  recentTransactions: Array<{
    id: number;
    date: string;
    user: string;
    hexId: string;
    fullHexId: string;
    lanaAmount: number;
    eurPayout: number;
    currency?: string;
    status: string;
    txHash: string | null;
    rpcVerified: boolean;
    rpcConfirmations: number;
    rpcBlockHeight: number | null;
    rpcVerifiedAt: string | null;
    source: string;
  }>;
}

const AdminDashboard = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<BuybackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;

    const fetchStats = async () => {
      try {
        const res = await fetch('/api/admin/stats', {
          headers: { 'x-admin-hex-id': session.nostrHexId },
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setStats(data);

        // Resolve names for Anonymous users via payout-account endpoint
        const anonymousTxs = (data.recentTransactions || []).filter(
          (tx: any) => tx.user === 'Anonymous' && tx.fullHexId
        );
        // Deduplicate by fullHexId
        const uniqueHexIds = [...new Set(anonymousTxs.map((tx: any) => tx.fullHexId))] as string[];
        if (uniqueHexIds.length > 0) {
          const names: Record<string, string> = {};
          await Promise.all(
            uniqueHexIds.map(async (hexId) => {
              try {
                const accRes = await fetch(`/api/user/${hexId}/payout-account`);
                const accData = await accRes.json();
                if (accData.payoutAccount?.fields?.account_holder) {
                  names[hexId] = accData.payoutAccount.fields.account_holder;
                }
              } catch {}
            })
          );
          if (Object.keys(names).length > 0) {
            setResolvedNames(names);
          }
        }
      } catch (err) {
        console.error('Failed to fetch admin stats:', err);
        toast.error('Failed to load dashboard stats');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [session, isAdmin]);

  /** Resolve user display name, falling back to payout account holder */
  const getUserName = (tx: BuybackStats['recentTransactions'][0]) => {
    if (tx.user !== 'Anonymous') return tx.user;
    if (tx.fullHexId && resolvedNames[tx.fullHexId]) return resolvedNames[tx.fullHexId];
    return 'Anonymous';
  };

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/admin" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            <span>Lana<span className="text-gold">.Discount</span></span>
            <span className="ml-2 text-xs font-mono bg-red-100 text-red-700 px-2 py-0.5 rounded-full uppercase tracking-wider">Admin</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              User Dashboard
            </Link>
            <Link to="/admin" className="text-sm text-foreground font-medium">
              Admin
            </Link>
            <Link to="/admin/verify-tx" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Verify TX
            </Link>
            <Link to="/admin/payouts" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Payouts
            </Link>
            <Link to="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Settings
            </Link>
            <Link to="/admin/api-keys" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              API Keys
            </Link>
            <Link to="/admin/admins" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Admins
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
      <div className="flex-1 container mx-auto px-6 py-12 max-w-6xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Buyback Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of LanaCoin buyback operations and pending payouts.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading dashboard...</p>
            </div>
          </div>
        ) : stats ? (
          <>
            {/* Stats cards — row 1 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
              <StatCard
                label="Total LANA Bought Back"
                value={stats.totalLanaBoughtBack.toLocaleString()}
                unit="LANA"
                color="text-primary"
              />
              <StatCard
                label="Total Owed"
                value={stats.totalOwed.toFixed(2)}
                unit="EUR"
                color="text-foreground"
              />
              <StatCard
                label="Total Paid Out"
                value={stats.totalPaidOut.toFixed(2)}
                unit="EUR"
                color="text-green-600"
              />
            </div>

            {/* Stats cards — row 2 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
              <StatCard
                label="Remaining to Pay"
                value={stats.totalRemaining.toFixed(2)}
                unit="EUR"
                color={stats.totalRemaining > 0 ? 'text-amber-600' : 'text-green-600'}
              />
              {stats.pendingVerificationCount > 0 && (
                <Link to="/admin/verify-tx" className="block hover:scale-[1.02] transition-transform">
                  <StatCard
                    label="Pending Verification"
                    value={stats.pendingVerificationCount.toString()}
                    unit="tx"
                    color="text-orange-600"
                    subtitle="Click to review →"
                  />
                </Link>
              )}
              <StatCard
                label="Buyback Wallet Balance"
                value={stats.buybackWalletBalance !== null ? stats.buybackWalletBalance.toLocaleString() : '—'}
                unit="LANA"
                color="text-primary"
                subtitle={stats.buybackWalletId ? stats.buybackWalletId.slice(0, 12) + '...' : 'Not configured'}
              />
              <div className="rounded-2xl border-2 border-border bg-card p-6">
                <p className="text-sm text-muted-foreground mb-2">Transactions / Users</p>
                <div className="flex items-baseline gap-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-foreground">{stats.totalTransactions}</span>
                    <span className="text-sm text-muted-foreground">tx</span>
                  </div>
                  <span className="text-muted-foreground">/</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-foreground">{stats.usersServed}</span>
                    <span className="text-sm text-muted-foreground">users</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Recent transactions */}
            <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Recent Buyback Transactions</h2>
                <Link
                  to="/admin/payouts"
                  className="text-sm text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  Manage Payouts &rarr;
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-6 py-3 font-medium text-muted-foreground">Date</th>
                      <th className="text-left px-6 py-3 font-medium text-muted-foreground">User</th>
                      <th className="text-right px-6 py-3 font-medium text-muted-foreground">LANA Amount</th>
                      <th className="text-right px-6 py-3 font-medium text-muted-foreground">Payout</th>
                      <th className="text-center px-6 py-3 font-medium text-muted-foreground">Status</th>
                      <th className="text-center px-6 py-3 font-medium text-muted-foreground">RPC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...stats.recentTransactions]
                      .sort((a, b) => {
                        // Broadcast first (awaiting verification), then completed/unpaid, paid last
                        const priority = (s: string) => s === 'broadcast' ? 0 : s === 'pending_verification' ? 1 : s === 'paid' ? 3 : 2;
                        return priority(a.status) - priority(b.status);
                      })
                      .map(tx => {
                        const isPaid = tx.status === 'paid';
                        const isBroadcast = tx.status === 'broadcast';
                        return (
                          <tr key={tx.id} className={`border-b border-border/50 transition-colors ${isPaid ? 'opacity-40' : 'hover:bg-muted/20'}`}>
                            <td className="px-6 py-4 text-foreground">{tx.date}</td>
                            <td className="px-6 py-4">
                              <div className={`font-medium ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>{getUserName(tx)}</div>
                              <div className="text-xs text-muted-foreground font-mono">{tx.hexId}</div>
                            </td>
                            <td className={`px-6 py-4 text-right font-mono ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>
                              {tx.lanaAmount.toLocaleString()}
                            </td>
                            <td className={`px-6 py-4 text-right font-mono ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>
                              {tx.eurPayout.toFixed(2)} {tx.currency || 'EUR'}
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
                                isBroadcast
                                  ? 'bg-blue-100 text-blue-700'
                                  : tx.status === 'pending_verification'
                                  ? 'bg-orange-100 text-orange-700'
                                  : isPaid
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-amber-100 text-amber-700'
                              }`}>
                                {isBroadcast ? 'broadcast' : tx.status === 'pending_verification' ? 'pending' : tx.status}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-center">
                              {tx.rpcVerified ? (
                                <div className="flex flex-col items-center gap-0.5">
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-green-600">
                                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    </svg>
                                    Verified
                                  </span>
                                  {tx.rpcBlockHeight && (
                                    <span className="text-[9px] font-mono text-muted-foreground">
                                      Block #{tx.rpcBlockHeight.toLocaleString()}
                                    </span>
                                  )}
                                  <span className="text-[9px] text-muted-foreground">
                                    {tx.rpcConfirmations} conf
                                  </span>
                                </div>
                              ) : tx.txHash ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-500">
                                  <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                                  Awaiting
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">&mdash;</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">Failed to load dashboard data.</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

const StatCard = ({ label, value, unit, color, subtitle }: { label: string; value: string; unit?: string; color: string; subtitle?: string }) => (
  <div className="rounded-2xl border-2 border-border bg-card p-6">
    <p className="text-sm text-muted-foreground mb-2">{label}</p>
    <div className="flex items-baseline gap-2">
      <span className={`text-3xl font-bold font-mono ${color}`}>{value}</span>
      {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
    </div>
    {subtitle && <p className="text-xs text-muted-foreground font-mono mt-1">{subtitle}</p>}
  </div>
);

export default AdminDashboard;
