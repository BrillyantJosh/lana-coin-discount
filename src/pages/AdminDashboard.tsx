import { useEffect, useState, Fragment } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';

interface FiatOrder {
  id: string;
  transactionRef: string;
  investorHex: string;
  fundSettingId: number;
  budgetNote: string;
  amountFiat: number;
  currency: string;
  destinationType: string;
  destinationName: string | null;
  destinationBank: string | null;
  destinationSwift: string | null;
  destinationAccount: string | null;
  status: string;
  lanaTxHash: string | null;
  rpcVerified: boolean;
  ppConfirmed: boolean;
  ppId: number | null;
  createdAt: string;
}

interface FiatOrderSummary {
  pendingBank: Record<string, number>;
  pendingLanaDiscount: Record<string, number>;
  paidBank: Record<string, number>;
}

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
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<BuybackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});
  const [fiatOrders, setFiatOrders] = useState<FiatOrder[]>([]);
  const [fiatSummary, setFiatSummary] = useState<FiatOrderSummary>({ pendingBank: {}, pendingLanaDiscount: {}, paidBank: {} });
  const [expandedTxRef, setExpandedTxRef] = useState<string | null>(null);

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

        // Fetch incoming FIAT payments from Direct Fund
        try {
          const fiatRes = await fetch('/api/admin/incoming-payments', {
            headers: { 'x-admin-hex-id': session.nostrHexId },
          });
          const fiatData = await fiatRes.json();
          setFiatOrders(fiatData.orders || []);
          setFiatSummary(fiatData.summary || { pendingBank: {}, pendingLanaDiscount: {}, paidBank: {} });
        } catch {}

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
      <AdminNav active="admin" />

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
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

            {/* Incoming FIAT Payments from investors */}
            {fiatOrders.length > 0 && (() => {
              const txGroups = new Map<string, FiatOrder[]>();
              for (const o of fiatOrders) {
                const group = txGroups.get(o.transactionRef) || [];
                group.push(o);
                txGroups.set(o.transactionRef, group);
              }
              const pendingBankOrders = fiatOrders.filter(o => o.destinationType === 'bank' && !o.ppConfirmed);
              const hasPending = Object.keys(fiatSummary.pendingBank).length > 0;

              const formatFiat = (v: number, c: string) => {
                return v.toLocaleString(undefined, { style: 'currency', currency: c });
              };

              const formatDate = (iso: string) => {
                const d = new Date(iso + 'Z');
                return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
              };

              return (
                <div className="rounded-2xl border-2 border-border bg-card overflow-hidden mb-10">
                  <div className="px-6 py-4 border-b border-border">
                    <h2 className="text-lg font-semibold text-foreground">Incoming FIAT Payments</h2>
                    <p className="text-sm text-muted-foreground">
                      Payments from investors via Direct Fund — {fiatOrders.length} total orders
                    </p>
                  </div>

                  {/* Summary cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-6">
                    <div className={`rounded-xl border p-4 ${hasPending ? 'border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5' : 'border-border'}`}>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Awaiting Bank Transfer</p>
                      {Object.keys(fiatSummary.pendingBank).length > 0 ? (
                        Object.entries(fiatSummary.pendingBank).map(([c, v]) => (
                          <p key={c} className="text-xl font-bold font-mono text-amber-600">{formatFiat(v, c)}</p>
                        ))
                      ) : (
                        <p className="text-xl font-bold font-mono text-muted-foreground">—</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">{pendingBankOrders.length} pending</p>
                    </div>
                    <div className="rounded-xl border border-border p-4">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Caretaker (Auto)</p>
                      {Object.keys(fiatSummary.pendingLanaDiscount).length > 0 ? (
                        Object.entries(fiatSummary.pendingLanaDiscount).map(([c, v]) => (
                          <p key={c} className="text-xl font-bold font-mono text-blue-600">{formatFiat(v, c)}</p>
                        ))
                      ) : (
                        <p className="text-xl font-bold font-mono text-muted-foreground">—</p>
                      )}
                    </div>
                    <div className="rounded-xl border border-border p-4">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Paid (Bank)</p>
                      {Object.keys(fiatSummary.paidBank).length > 0 ? (
                        Object.entries(fiatSummary.paidBank).map(([c, v]) => (
                          <p key={c} className="text-xl font-bold font-mono text-green-600">{formatFiat(v, c)}</p>
                        ))
                      ) : (
                        <p className="text-xl font-bold font-mono text-muted-foreground">—</p>
                      )}
                    </div>
                  </div>

                  {/* Orders table */}
                  <div className="border-t border-border">
                    <div className="px-6 py-3 border-b border-border">
                      <p className="text-sm font-medium text-muted-foreground">
                        All Orders ({fiatOrders.length}) — grouped by transaction
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/30">
                            <th className="w-8 px-4 py-3"></th>
                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Destination</th>
                            <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Blockchain TX</th>
                            <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from(txGroups.entries()).map(([txRef, group]) => {
                            const isExpanded = expandedTxRef === txRef;
                            const allPaid = group.every(o => o.ppConfirmed);
                            const totalFiat = group.reduce((s, o) => s + o.amountFiat, 0);
                            const currency = group[0].currency;
                            const lanaHash = group[0].lanaTxHash;
                            const rpcOk = group[0].rpcVerified;
                            const date = group[0].createdAt;
                            const types = [...new Set(group.map(o => o.destinationType))];

                            return (
                              <Fragment key={txRef}>
                                <tr
                                  onClick={() => setExpandedTxRef(isExpanded ? null : txRef)}
                                  className={`border-b border-border/50 cursor-pointer transition-colors ${
                                    allPaid ? 'opacity-40 hover:opacity-60' : 'hover:bg-muted/20'
                                  }`}
                                >
                                  <td className="px-4 py-3 text-muted-foreground">
                                    <svg className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                    </svg>
                                  </td>
                                  <td className="px-4 py-3 text-foreground whitespace-nowrap">{formatDate(date)}</td>
                                  <td className="px-4 py-3">
                                    {types.map(t => (
                                      <span key={t} className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mr-1 ${
                                        t === 'bank'
                                          ? 'bg-amber-100 text-amber-700'
                                          : 'bg-blue-100 text-blue-700'
                                      }`}>
                                        {t === 'bank' ? 'Bank' : 'Caretaker'}
                                      </span>
                                    ))}
                                  </td>
                                  <td className="px-4 py-3 text-foreground">
                                    {group.length} recipient{group.length !== 1 ? 's' : ''}
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono font-medium text-foreground whitespace-nowrap">
                                    {formatFiat(totalFiat, currency)}
                                  </td>
                                  <td className="px-4 py-3 text-xs">
                                    {lanaHash ? (
                                      <div className="flex items-center gap-1.5">
                                        <a
                                          href={`https://chainz.cryptoid.info/lana/tx.dws?${lanaHash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-primary hover:text-primary/80 font-mono"
                                          onClick={e => e.stopPropagation()}
                                        >
                                          {lanaHash.slice(0, 10)}...
                                        </a>
                                        {rpcOk ? (
                                          <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                          </svg>
                                        ) : (
                                          <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-center">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                      allPaid ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                                    }`}>
                                      {allPaid ? 'Paid' : 'Pending'}
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded && group.map(o => (
                                  <tr key={o.id} className={`border-b border-border/30 bg-muted/10 ${o.ppConfirmed ? 'opacity-50' : ''}`}>
                                    <td className="px-4 py-2.5"></td>
                                    <td className="px-4 py-2.5 text-xs text-muted-foreground">#{o.ppId || '—'}</td>
                                    <td className="px-4 py-2.5">
                                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                        o.destinationType === 'bank' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                                      }`}>
                                        {o.destinationType === 'bank' ? 'Bank' : 'Caretaker'}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2.5">
                                      <div className="text-sm font-medium text-foreground">
                                        {o.destinationName || '—'}
                                        {o.destinationBank && <span className="text-muted-foreground font-normal"> · {o.destinationBank}</span>}
                                      </div>
                                      {o.destinationAccount && (
                                        <div className="text-xs text-muted-foreground font-mono mt-0.5">
                                          {o.destinationAccount}
                                          {o.destinationSwift && <span className="ml-2">({o.destinationSwift})</span>}
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono font-medium text-foreground whitespace-nowrap">
                                      {formatFiat(o.amountFiat, o.currency)}
                                    </td>
                                    <td className="px-4 py-2.5 text-xs">
                                      {o.lanaTxHash ? (
                                        <a
                                          href={`https://chainz.cryptoid.info/lana/tx.dws?${o.lanaTxHash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-primary hover:text-primary/80 font-mono"
                                        >
                                          {o.lanaTxHash.slice(0, 10)}...
                                        </a>
                                      ) : (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-center">
                                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                        o.ppConfirmed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                                      }`}>
                                        {o.ppConfirmed ? 'Paid' : 'Pending'}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

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
