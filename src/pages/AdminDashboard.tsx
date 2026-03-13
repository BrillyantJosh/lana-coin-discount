import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface BuybackStats {
  totalLanaBoughtBack: number;
  totalEurOwed: number;
  totalTransactions: number;
  usersServed: number;
  recentTransactions: Array<{
    id: number;
    date: string;
    user: string;
    hexId: string;
    lanaAmount: number;
    eurPayout: number;
    currency?: string;
    status: string;
  }>;
}

const AdminDashboard = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<BuybackStats | null>(null);
  const [loading, setLoading] = useState(true);

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
      } catch (err) {
        console.error('Failed to fetch admin stats:', err);
        toast.error('Failed to load dashboard stats');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [session, isAdmin]);

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/admin" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            Lana<span className="text-gold">.discount</span>
            <span className="ml-2 text-xs font-mono bg-red-100 text-red-700 px-2 py-0.5 rounded-full uppercase tracking-wider">Admin</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              User Dashboard
            </Link>
            <Link to="/admin" className="text-sm text-foreground font-medium">
              Admin
            </Link>
            <Link to="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Settings
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
            {/* Stats cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
              <StatCard
                label="Total LANA Bought Back"
                value={stats.totalLanaBoughtBack.toLocaleString()}
                unit="LANA"
                color="text-primary"
              />
              <StatCard
                label="Total EUR Owed"
                value={stats.totalEurOwed.toFixed(2)}
                unit="EUR"
                color="text-red-600"
              />
              <StatCard
                label="Transactions"
                value={stats.totalTransactions.toString()}
                color="text-foreground"
              />
              <StatCard
                label="Users Served"
                value={stats.usersServed.toString()}
                color="text-foreground"
              />
            </div>

            {/* Recent transactions */}
            <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <h2 className="text-lg font-semibold text-foreground">Recent Buyback Transactions</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-6 py-3 font-medium text-muted-foreground">Date</th>
                      <th className="text-left px-6 py-3 font-medium text-muted-foreground">User</th>
                      <th className="text-right px-6 py-3 font-medium text-muted-foreground">LANA Amount</th>
                      <th className="text-right px-6 py-3 font-medium text-muted-foreground">EUR Payout</th>
                      <th className="text-center px-6 py-3 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentTransactions.map(tx => (
                      <tr key={tx.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-6 py-4 text-foreground">{tx.date}</td>
                        <td className="px-6 py-4">
                          <div className="text-foreground font-medium">{tx.user}</div>
                          <div className="text-xs text-muted-foreground font-mono">{tx.hexId}</div>
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-foreground">
                          {tx.lanaAmount.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-foreground">
                          {tx.eurPayout.toFixed(2)} {tx.currency || 'EUR'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
                            tx.status === 'paid'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            {tx.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-4 text-xs text-muted-foreground text-center">
              * Dashboard data is currently mock data for development purposes.
            </p>
          </>
        ) : (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">Failed to load dashboard data.</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.discount — Admin Panel
      </footer>
    </div>
  );
};

const StatCard = ({ label, value, unit, color }: { label: string; value: string; unit?: string; color: string }) => (
  <div className="rounded-2xl border-2 border-border bg-card p-6">
    <p className="text-sm text-muted-foreground mb-2">{label}</p>
    <div className="flex items-baseline gap-2">
      <span className={`text-3xl font-bold font-mono ${color}`}>{value}</span>
      {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
    </div>
  </div>
);

export default AdminDashboard;
