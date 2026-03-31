import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { AdminPagination } from '@/components/AdminPagination';

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
}

interface Transaction {
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
  source: string;
}

const statusOptions = ['all', 'broadcast', 'pending_verification', 'completed', 'paid'] as const;
const statusLabels: Record<string, string> = {
  all: 'All Status',
  broadcast: 'Broadcast',
  pending_verification: 'Pending Verification',
  completed: 'Completed',
  paid: 'Paid',
};

const AdminDashboard = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<BuybackStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Paginated transactions
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txPage, setTxPage] = useState(1);
  const [txLimit, setTxLimit] = useState(25);
  const [txTotal, setTxTotal] = useState(0);
  const [txTotalPages, setTxTotalPages] = useState(0);
  const [txStatus, setTxStatus] = useState('all');
  const [txSearch, setTxSearch] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  // Fetch stats (once)
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
      } catch (err) {
        toast.error('Failed to load dashboard stats');
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [session, isAdmin]);

  // Fetch paginated transactions
  const fetchTransactions = useCallback(async () => {
    if (!session || !isAdmin) return;
    setTxLoading(true);
    try {
      const params = new URLSearchParams({
        page: txPage.toString(),
        limit: txLimit.toString(),
        status: txStatus,
        search: txSearch,
      });
      const res = await fetch(`/api/admin/transactions?${params}`, {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      setTransactions(data.transactions || []);
      setTxTotal(data.total || 0);
      setTxTotalPages(data.totalPages || 0);

      // Resolve anonymous names via KIND 0 profile, then payout-account as fallback
      const anon = (data.transactions || []).filter((tx: Transaction) => tx.user === 'Anonymous' && tx.fullHexId);
      const uniqueIds = [...new Set(anon.map((tx: Transaction) => tx.fullHexId))] as string[];
      if (uniqueIds.length > 0) {
        const names: Record<string, string> = {};
        await Promise.all(uniqueIds.map(async (hexId) => {
          try {
            // Try KIND 0 profile first (display_name / name)
            const profileRes = await fetch(`/api/user/${hexId}/profile`);
            const profileData = await profileRes.json();
            if (profileData.displayName) { names[hexId] = profileData.displayName; return; }
            if (profileData.fullName) { names[hexId] = profileData.fullName; return; }
            // Fallback: payout account holder
            const r = await fetch(`/api/user/${hexId}/payout-account`);
            const d = await r.json();
            if (d.payoutAccount?.fields?.account_holder) names[hexId] = d.payoutAccount.fields.account_holder;
          } catch {}
        }));
        if (Object.keys(names).length > 0) setResolvedNames(prev => ({ ...prev, ...names }));
      }
    } catch {
      toast.error('Failed to load transactions');
    } finally {
      setTxLoading(false);
    }
  }, [session, isAdmin, txPage, txLimit, txStatus, txSearch]);

  useEffect(() => { fetchTransactions(); }, [fetchTransactions]);

  const getUserName = (tx: Transaction) => {
    if (tx.user !== 'Anonymous') return tx.user;
    if (tx.fullHexId && resolvedNames[tx.fullHexId]) return resolvedNames[tx.fullHexId];
    return 'Anonymous';
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTxPage(1);
    fetchTransactions();
  };

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">BuyOuts Dashboard</h1>
          <p className="text-muted-foreground">Overview of LanaCoin buyback operations and pending payouts.</p>
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
            {/* Stats cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <StatCard label="Total LANA Bought Back" value={stats.totalLanaBoughtBack.toLocaleString()} unit="LANA" color="text-primary" />
              <StatCard label="Total Owed" value={stats.totalOwed.toFixed(2)} unit="EUR" color="text-foreground" />
              <StatCard label="Total Paid Out" value={stats.totalPaidOut.toFixed(2)} unit="EUR" color="text-green-600" />
              <StatCard label="Remaining to Pay" value={stats.totalRemaining.toFixed(2)} unit="EUR" color={stats.totalRemaining > 0 ? 'text-amber-600' : 'text-green-600'} />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
              {stats.pendingVerificationCount > 0 && (
                <Link to="/admin/verify-tx" className="block hover:scale-[1.02] transition-transform">
                  <StatCard label="Pending Verification" value={stats.pendingVerificationCount.toString()} unit="tx" color="text-orange-600" subtitle="Click to review →" />
                </Link>
              )}
              <StatCard
                label="Buyback Wallet"
                value={stats.buybackWalletBalance !== null ? stats.buybackWalletBalance.toLocaleString() : '—'}
                unit="LANA"
                color="text-primary"
                subtitle={stats.buybackWalletId ? stats.buybackWalletId.slice(0, 12) + '...' : 'Not configured'}
              />
              <div className="rounded-2xl border-2 border-border bg-card p-5">
                <p className="text-xs text-muted-foreground mb-1">Transactions / Users</p>
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-bold font-mono text-foreground">{stats.totalTransactions}</span>
                  <span className="text-xs text-muted-foreground">tx</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-2xl font-bold font-mono text-foreground">{stats.usersServed}</span>
                  <span className="text-xs text-muted-foreground">users</span>
                </div>
              </div>
            </div>

            {/* Transactions table with filters + pagination */}
            <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Buyback Transactions</h2>
                    <p className="text-xs text-muted-foreground">{txTotal.toLocaleString()} total</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={txStatus}
                      onChange={e => { setTxStatus(e.target.value); setTxPage(1); }}
                      className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {statusOptions.map(s => (
                        <option key={s} value={s}>{statusLabels[s]}</option>
                      ))}
                    </select>
                    <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="Search user / tx hash..."
                        value={txSearch}
                        onChange={e => setTxSearch(e.target.value)}
                        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground w-44 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button type="submit" className="rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                        </svg>
                      </button>
                    </form>
                    <Link to="/admin/payouts" className="text-xs text-primary hover:text-primary/80 font-medium">
                      Manage Payouts →
                    </Link>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                {txLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="text-left px-5 py-3 font-medium text-muted-foreground">Date</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">User</th>
                        <th className="text-right px-4 py-3 font-medium text-muted-foreground">LANA</th>
                        <th className="text-right px-4 py-3 font-medium text-muted-foreground">Payout</th>
                        <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                        <th className="text-center px-4 py-3 font-medium text-muted-foreground">RPC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.length === 0 ? (
                        <tr><td colSpan={6} className="px-5 py-8 text-center text-muted-foreground">No transactions found</td></tr>
                      ) : transactions.map(tx => {
                        const isPaid = tx.status === 'paid';
                        const isBroadcast = tx.status === 'broadcast';
                        return (
                          <tr key={tx.id} className={`border-b border-border/50 transition-colors ${isPaid ? 'opacity-40' : 'hover:bg-muted/20'}`}>
                            <td className="px-5 py-3 text-foreground whitespace-nowrap text-xs">{tx.date?.split(' ')[0] || tx.date}</td>
                            <td className="px-4 py-3">
                              <div className={`text-sm font-medium ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>{getUserName(tx)}</div>
                              <div className="text-[10px] text-muted-foreground font-mono">{tx.hexId}</div>
                            </td>
                            <td className={`px-4 py-3 text-right font-mono text-sm ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>
                              {tx.lanaAmount.toLocaleString()}
                            </td>
                            <td className={`px-4 py-3 text-right font-mono text-sm ${isPaid ? 'text-muted-foreground' : 'text-foreground'}`}>
                              {tx.eurPayout.toFixed(2)} {tx.currency || 'EUR'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                isBroadcast ? 'bg-blue-100 text-blue-700'
                                : tx.status === 'pending_verification' ? 'bg-orange-100 text-orange-700'
                                : isPaid ? 'bg-green-100 text-green-700'
                                : 'bg-amber-100 text-amber-700'
                              }`}>
                                {isBroadcast ? 'broadcast' : tx.status === 'pending_verification' ? 'pending' : tx.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {tx.rpcVerified ? (
                                <div className="flex flex-col items-center gap-0.5">
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-green-600">
                                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    </svg>
                                    Verified
                                  </span>
                                  {tx.rpcBlockHeight && <span className="text-[9px] font-mono text-muted-foreground">#{tx.rpcBlockHeight.toLocaleString()}</span>}
                                  <span className="text-[9px] text-muted-foreground">{tx.rpcConfirmations} conf</span>
                                </div>
                              ) : tx.txHash ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-500">
                                  <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                                  Awaiting
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="border-t border-border">
                <AdminPagination
                  page={txPage}
                  totalPages={txTotalPages}
                  total={txTotal}
                  limit={txLimit}
                  onPageChange={setTxPage}
                  onLimitChange={v => { setTxLimit(v); setTxPage(1); }}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">Failed to load dashboard data.</p>
          </div>
        )}
      </div>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

const StatCard = ({ label, value, unit, color, subtitle }: { label: string; value: string; unit?: string; color: string; subtitle?: string }) => (
  <div className="rounded-2xl border-2 border-border bg-card p-5">
    <p className="text-xs text-muted-foreground mb-1">{label}</p>
    <div className="flex items-baseline gap-2">
      <span className={`text-2xl font-bold font-mono ${color}`}>{value}</span>
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
    {subtitle && <p className="text-[10px] text-muted-foreground font-mono mt-1">{subtitle}</p>}
  </div>
);

export default AdminDashboard;
