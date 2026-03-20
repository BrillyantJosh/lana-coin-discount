import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', CZK: 'CZK',
};

interface Payout {
  id: number;
  payoutId: string;
  amount: number;
  currency: string;
  paidToAccount: string | null;
  reference: string | null;
  note: string | null;
  paidAt: string;
}

interface Sale {
  id: number;
  lanaAmount: number;
  currency: string;
  exchangeRate: number;
  split: string | null;
  grossFiat: number;
  commissionPercent: number;
  commissionFiat: number;
  netFiat: number;
  txHash: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  senderWallet: string;
  buybackWallet: string;
  totalPaid: number;
  remaining: number;
  payouts: Payout[];
}

const Dashboard = () => {
  const { session, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const [sales, setSales] = useState<Sale[]>([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const [expandedSale, setExpandedSale] = useState<number | null>(null);

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    fetchSales();
  }, [session]);

  const fetchSales = async () => {
    if (!session) return;
    setSalesLoading(true);
    try {
      const res = await fetch(`/api/user/${session.nostrHexId}/sales`);
      const data = await res.json();
      setSales(data.sales || []);
    } catch (err) {
      console.error('Failed to fetch sales:', err);
    } finally {
      setSalesLoading(false);
    }
  };

  if (!session) return null;

  const displayName = session.profileDisplayName || session.profileName || 'User';
  const shortHex = session.nostrHexId.slice(0, 8) + '...' + session.nostrHexId.slice(-8);

  // Aggregates
  const totalLanaSold = sales.reduce((s, sale) => s + sale.lanaAmount, 0);
  const totalOwed = sales.reduce((s, sale) => s + sale.netFiat, 0);
  const totalPaid = sales.reduce((s, sale) => s + sale.totalPaid, 0);
  const totalRemaining = sales.reduce((s, sale) => s + sale.remaining, 0);
  const mainCurrency = sales.length > 0 ? sales[0].currency : 'EUR';
  const sym = CURRENCY_SYMBOLS[mainCurrency] || mainCurrency;

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  const getStatusBadge = (sale: Sale) => {
    if (sale.status === 'broadcast') {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
          <span className="inline-block h-2 w-2 animate-spin rounded-full border border-blue-700 border-t-transparent" />
          Confirming
        </span>
      );
    }
    if (sale.status === 'paid') {
      return <span className="text-[10px] font-bold uppercase tracking-wider bg-green-100 text-green-700 px-2 py-0.5 rounded">Paid</span>;
    }
    if (sale.status === 'failed') {
      return <span className="text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-700 px-2 py-0.5 rounded">Failed</span>;
    }
    if (sale.totalPaid > 0) {
      return <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-2 py-0.5 rounded">Partial</span>;
    }
    return <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-2 py-0.5 rounded">Pending Payout</span>;
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between h-14 sm:h-16">
          <a href="/" className="flex items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            <span>Lana<span className="text-gold">.Discount</span></span>
          </a>
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2">
              {session.profilePicture && (
                <img src={session.profilePicture} alt="" className="h-8 w-8 rounded-full object-cover" />
              )}
              <span className="text-sm font-medium text-foreground">{displayName}</span>
            </div>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      {/* Dashboard content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12">
        {/* Welcome */}
        <div className="mb-12 text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            Welcome, {displayName}
          </h1>
          <p className="text-muted-foreground text-sm font-mono">{shortHex}</p>
          {session.walletId && (
            <p className="text-muted-foreground text-xs">
              Wallet: <span className="font-mono">{session.walletId}</span>
            </p>
          )}
        </div>

        {/* Two main options */}
        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Option 1: Sell Registered Lana */}
          <Link to="/sell" className="group relative rounded-2xl border-2 border-border bg-card p-8 hover:border-primary transition-colors cursor-pointer block">
            <div className="space-y-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center">
                <svg className="h-7 w-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground">Sell Registered Lana</h2>
              <p className="text-muted-foreground leading-relaxed">
                Sell your registered LanaCoins and receive an instant 70% cash payout.
                Fast, secure, and straightforward.
              </p>
              <div className="pt-2">
                <span className="inline-flex items-center gap-1 text-primary font-semibold group-hover:gap-2 transition-all">
                  Get Started
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </div>
          </Link>

          {/* Option 2: Register Wallets for Monitoring */}
          <Link to="/wallets" className="group relative rounded-2xl border-2 border-border bg-card p-8 hover:border-primary transition-colors cursor-pointer block">
            <div className="space-y-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center">
                <svg className="h-7 w-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground">Register Wallets</h2>
              <p className="text-muted-foreground leading-relaxed">
                Submit wallet addresses you'd like us to monitor for buyback opportunities.
                We'll notify you when your coins are ready for instant payout.
              </p>
              <div className="pt-2">
                <span className="inline-flex items-center gap-1 text-primary font-semibold group-hover:gap-2 transition-all">
                  Register Wallets
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </div>
          </Link>
        </div>

        {/* Admin panel link — only visible to admins */}
        {isAdmin && (
          <div className="max-w-4xl mx-auto mt-8">
            <Link to="/admin" className="group relative rounded-2xl border-2 border-dashed border-red-300 bg-red-50/30 p-6 hover:border-red-400 transition-colors block">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-red-100 flex items-center justify-center">
                  <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-red-700">Admin Panel</h3>
                  <p className="text-sm text-red-600/80">View buyback stats, manage admins</p>
                </div>
                <svg className="h-5 w-5 text-red-400 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          </div>
        )}

        {/* ============ SALES HISTORY ============ */}
        <div className="max-w-4xl mx-auto mt-16">
          <h2 className="text-2xl font-bold text-foreground mb-6">Your Sales</h2>

          {salesLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : sales.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-border p-12 text-center">
              <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
                </svg>
              </div>
              <p className="text-muted-foreground font-medium">No sales yet</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Your sell transactions and payout history will appear here.
              </p>
            </div>
          ) : (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">LANA Sold</div>
                  <div className="text-lg font-bold font-mono text-foreground mt-1">
                    {totalLanaSold.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Total Owed</div>
                  <div className="text-lg font-bold font-mono text-foreground mt-1">
                    {sym}{totalOwed.toFixed(2)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Paid Out</div>
                  <div className="text-lg font-bold font-mono text-green-600 mt-1">
                    {sym}{totalPaid.toFixed(2)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Remaining</div>
                  <div className="text-lg font-bold font-mono text-amber-600 mt-1">
                    {sym}{totalRemaining.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Sales List */}
              <div className="space-y-3">
                {sales.map(sale => {
                  const isExpanded = expandedSale === sale.id;
                  const progress = sale.netFiat > 0 ? Math.min((sale.totalPaid / sale.netFiat) * 100, 100) : 0;
                  const saleSym = CURRENCY_SYMBOLS[sale.currency] || sale.currency;

                  return (
                    <div key={sale.id} className="rounded-2xl border-2 border-border bg-card overflow-hidden transition-colors">
                      {/* Sale Row */}
                      <button
                        onClick={() => setExpandedSale(isExpanded ? null : sale.id)}
                        className="w-full px-5 py-4 text-left hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-center gap-2 sm:gap-4">
                          {/* Expand icon */}
                          <svg
                            className={`h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>

                          {/* Date */}
                          <div className="hidden sm:block w-24 flex-shrink-0">
                            <span className="text-sm text-muted-foreground">{formatDate(sale.createdAt)}</span>
                          </div>

                          {/* LANA Amount */}
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-sm font-bold text-foreground">
                              {sale.lanaAmount.toLocaleString()} LANA
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div className="hidden sm:block w-32 flex-shrink-0">
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  progress >= 100 ? 'bg-green-500' : progress > 0 ? 'bg-amber-500' : 'bg-blue-300'
                                }`}
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5 text-center">
                              {saleSym}{sale.totalPaid.toFixed(2)} / {saleSym}{sale.netFiat.toFixed(2)}
                            </div>
                          </div>

                          {/* Net payout */}
                          <div className="w-24 text-right flex-shrink-0">
                            <span className="font-mono text-sm font-bold text-primary">
                              {saleSym}{sale.netFiat.toFixed(2)}
                            </span>
                          </div>

                          {/* Status badge */}
                          <div className="flex-shrink-0">
                            {getStatusBadge(sale)}
                          </div>
                        </div>
                      </button>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div className="border-t border-border bg-muted/10 px-5 py-4 space-y-4">
                          {/* Sale breakdown */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div>
                              <span className="text-muted-foreground">Gross Value</span>
                              <div className="font-mono font-medium text-foreground">{saleSym}{sale.grossFiat.toFixed(2)}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Commission ({sale.commissionPercent}%)</span>
                              <div className="font-mono font-medium text-red-600">-{saleSym}{sale.commissionFiat.toFixed(2)}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Net Payout</span>
                              <div className="font-mono font-bold text-primary">{saleSym}{sale.netFiat.toFixed(2)}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">TX Hash</span>
                              <div className="font-mono text-foreground truncate" title={sale.txHash || ''}>
                                {sale.txHash ? sale.txHash.slice(0, 12) + '...' + sale.txHash.slice(-8) : '—'}
                              </div>
                            </div>
                          </div>

                          {/* Payouts sub-table */}
                          <div>
                            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">
                              Payouts ({sale.payouts.length})
                            </h4>

                            {sale.payouts.length > 0 ? (
                              <div className="rounded-lg border border-border overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/40">
                                    <tr>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Payout ID</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Paid To</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Note</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border">
                                    {sale.payouts.map(payout => (
                                      <tr key={payout.id} className="hover:bg-muted/20">
                                        <td className="px-3 py-2 font-mono text-foreground font-medium">{payout.payoutId}</td>
                                        <td className="px-3 py-2 text-foreground">{formatDate(payout.paidAt)}</td>
                                        <td className="px-3 py-2 text-right font-mono font-medium text-green-600">
                                          +{saleSym}{payout.amount.toFixed(2)}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-muted-foreground hidden sm:table-cell">
                                          {payout.paidToAccount
                                            ? (payout.paidToAccount.length > 10
                                                ? payout.paidToAccount.slice(0, 4) + '...' + payout.paidToAccount.slice(-4)
                                                : payout.paidToAccount)
                                            : '—'}
                                        </td>
                                        <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                                          {payout.note || '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                                <p className="text-xs text-muted-foreground">No payouts yet — payment is being processed.</p>
                              </div>
                            )}

                            {/* Payout summary */}
                            <div className="flex items-center justify-between mt-3 px-1">
                              <div className="text-xs text-muted-foreground">
                                Total paid: <span className="font-mono font-bold text-green-600">{saleSym}{sale.totalPaid.toFixed(2)}</span>
                                {' / '}
                                <span className="font-mono font-bold text-foreground">{saleSym}{sale.netFiat.toFixed(2)}</span>
                              </div>
                              {sale.remaining > 0 && (
                                <div className="text-xs">
                                  Remaining: <span className="font-mono font-bold text-amber-600">{saleSym}{sale.remaining.toFixed(2)}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Instant LanaCoin Buyback
      </footer>
    </div>
  );
};

export default Dashboard;
