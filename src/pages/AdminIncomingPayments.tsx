import { useEffect, useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { AdminPagination } from '@/components/AdminPagination';

interface FiatOrder {
  id: string;
  transactionRef: string;
  investorHex: string;
  fundSettingId: number;
  budgetNote: string;
  amountFiat: number;
  currency: string;
  orderType: string | null;
  paymentType: string | null;
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

const AdminIncomingPayments = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<FiatOrder[]>([]);
  const [summary, setSummary] = useState<FiatOrderSummary>({ pendingBank: {}, pendingLanaDiscount: {}, paidBank: {} });
  const [loading, setLoading] = useState(true);
  const [expandedTxRef, setExpandedTxRef] = useState<string | null>(null);

  // Filters + pagination (client-side since data comes from external API)
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'paid'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'cash' | 'lana'>('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    const fetchData = async () => {
      try {
        const res = await fetch('/api/admin/incoming-payments', {
          headers: { 'x-admin-hex-id': session.nostrHexId },
        });
        const data = await res.json();
        setOrders(data.orders || []);
        setSummary(data.summary || { pendingBank: {}, pendingLanaDiscount: {}, paidBank: {} });
      } catch {
        toast.error('Failed to load incoming payments');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [session, isAdmin]);

  if (authLoading || !session || !isAdmin) return null;

  // Group by transaction and apply filters
  const txGroups = new Map<string, FiatOrder[]>();
  for (const o of orders) {
    // Apply filters
    if (statusFilter === 'pending' && o.ppConfirmed) continue;
    if (statusFilter === 'paid' && !o.ppConfirmed) continue;
    if (typeFilter !== 'all' && o.orderType !== typeFilter && o.destinationType !== typeFilter) continue;
    if (paymentFilter !== 'all' && o.paymentType !== paymentFilter) continue;

    const group = txGroups.get(o.transactionRef) || [];
    group.push(o);
    txGroups.set(o.transactionRef, group);
  }

  const allGroups = Array.from(txGroups.entries());
  const totalFiltered = allGroups.length;
  const totalPages = Math.ceil(totalFiltered / limit);
  const paginatedGroups = allGroups.slice((page - 1) * limit, page * limit);

  const pendingBankOrders = orders.filter(o => o.destinationType === 'bank' && !o.ppConfirmed);
  const hasPending = Object.keys(summary.pendingBank).length > 0;

  const formatFiat = (v: number, c: string) => v.toLocaleString(undefined, { style: 'currency', currency: c });

  // Infer order_type from available data (handles old records without order_type)
  const inferOrderType = (ot: string | null, dt: string, dn: string | null): string => {
    if (ot) return ot;
    // Fallback inference for old records
    if (dt === 'lana_discount' && dn?.toLowerCase().includes('caretaker')) return 'caretaker_via_discount';
    if (dt === 'lana_discount') return 'lana_purchase';
    if (dt === 'bank') return 'merchant_payment'; // LANA payment → investor pays merchant
    return 'merchant_payment';
  };

  const purposeConfig: Record<string, { label: string; color: string }> = {
    lana_purchase: { label: 'LANA Purchase', color: 'bg-green-100 text-green-700' },
    merchant_payment: { label: 'Shop Invoice', color: 'bg-amber-100 text-amber-700' },
    merchant_commission: { label: 'Shop Incentive', color: 'bg-blue-100 text-blue-700' },
    caretaker_via_discount: { label: 'Caretaker', color: 'bg-purple-100 text-purple-700' },
  };

  const orderTypeBadge = (ot: string | null, dt: string, dn: string | null = null) => {
    const type = inferOrderType(ot, dt, dn);
    const cfg = purposeConfig[type] || { label: type, color: 'bg-gray-100 text-gray-700' };
    return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>;
  };

  const paymentBadge = (pt: string | null, currency?: string) => {
    const type = pt || 'lana';
    const isLana = type === 'lana';
    if (isLana) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <img src="/lana-logo.png" alt="LANA" className="h-4 w-4 dark:invert opacity-70" />
          <span className="text-[11px] font-bold text-amber-500">LANA</span>
        </span>
      );
    }
    // Cash — show currency icon
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
        <svg className="h-4 w-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
        </svg>
        <span className="text-[11px] font-bold text-emerald-500">Cash</span>
      </span>
    );
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso + 'Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Incoming FIAT Payments</h1>
          <p className="text-muted-foreground">
            Payments from investors via Direct Fund — {orders.length} total orders
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              <div className={`rounded-2xl border-2 p-5 ${hasPending ? 'border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5' : 'border-border bg-card'}`}>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Awaiting Bank Transfer</p>
                {Object.keys(summary.pendingBank).length > 0 ? (
                  Object.entries(summary.pendingBank).map(([c, v]) => (
                    <p key={c} className="text-2xl font-bold font-mono text-amber-600">{formatFiat(v, c)}</p>
                  ))
                ) : (
                  <p className="text-2xl font-bold font-mono text-muted-foreground">—</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">{pendingBankOrders.length} pending</p>
              </div>
              <div className="rounded-2xl border-2 border-border bg-card p-5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Caretaker (Auto)</p>
                {Object.keys(summary.pendingLanaDiscount).length > 0 ? (
                  Object.entries(summary.pendingLanaDiscount).map(([c, v]) => (
                    <p key={c} className="text-2xl font-bold font-mono text-blue-600">{formatFiat(v, c)}</p>
                  ))
                ) : (
                  <p className="text-2xl font-bold font-mono text-muted-foreground">—</p>
                )}
              </div>
              <div className="rounded-2xl border-2 border-border bg-card p-5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Paid (Bank)</p>
                {Object.keys(summary.paidBank).length > 0 ? (
                  Object.entries(summary.paidBank).map(([c, v]) => (
                    <p key={c} className="text-2xl font-bold font-mono text-green-600">{formatFiat(v, c)}</p>
                  ))
                ) : (
                  <p className="text-2xl font-bold font-mono text-muted-foreground">—</p>
                )}
              </div>
            </div>

            {/* Orders table with filters */}
            <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">
                  {totalFiltered} transaction group{totalFiltered !== 1 ? 's' : ''}
                </p>
                <div className="flex items-center gap-2">
                  <select
                    value={statusFilter}
                    onChange={e => { setStatusFilter(e.target.value as any); setPage(1); }}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="all">All Status</option>
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                  </select>
                  <select
                    value={typeFilter}
                    onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="all">All Purposes</option>
                    <option value="lana_purchase">LANA Purchase</option>
                    <option value="merchant_payment">Shop Invoice</option>
                    <option value="merchant_commission">Shop Incentive</option>
                    <option value="caretaker_via_discount">Caretaker</option>
                  </select>
                  <select
                    value={paymentFilter}
                    onChange={e => { setPaymentFilter(e.target.value as any); setPage(1); }}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="all">Cash & LANA</option>
                    <option value="cash">Cash Only</option>
                    <option value="lana">LANA Only</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="w-8 px-4 py-3"></th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Payment</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Orders</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Blockchain TX</th>
                      <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedGroups.length === 0 ? (
                      <tr><td colSpan={7} className="px-5 py-8 text-center text-muted-foreground">No orders match your filters</td></tr>
                    ) : paginatedGroups.map(([txRef, group]) => {
                      const isExpanded = expandedTxRef === txRef;
                      const allPaid = group.every(o => o.ppConfirmed);
                      const totalFiatVal = group.reduce((s, o) => s + o.amountFiat, 0);
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
                              {paymentBadge(group[0].paymentType, group[0].currency)}
                            </td>
                            <td className="px-4 py-3 text-foreground">{group.length} order{group.length !== 1 ? 's' : ''}</td>
                            <td className="px-4 py-3 text-right font-mono font-medium text-foreground whitespace-nowrap">
                              {formatFiat(totalFiatVal, currency)}
                            </td>
                            <td className="px-4 py-3 text-xs">
                              {lanaHash ? (
                                <div className="flex items-center gap-1.5">
                                  <a href={`https://chainz.cryptoid.info/lana/tx.dws?${lanaHash}`} target="_blank" rel="noopener noreferrer"
                                    className="text-primary hover:text-primary/80 font-mono" onClick={e => e.stopPropagation()}>
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
                              ) : <span className="text-muted-foreground">—</span>}
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
                                {orderTypeBadge(o.orderType, o.destinationType, o.destinationName)}
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="text-sm font-medium text-foreground">
                                  {o.destinationName || '—'}
                                  {o.destinationBank && <span className="text-muted-foreground font-normal"> · {o.destinationBank}</span>}
                                </div>
                                {o.destinationAccount && (
                                  <div className="text-xs text-muted-foreground font-mono mt-0.5">
                                    {o.destinationAccount}{o.destinationSwift && <span className="ml-2">({o.destinationSwift})</span>}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono font-medium text-foreground whitespace-nowrap">
                                {formatFiat(o.amountFiat, o.currency)}
                              </td>
                              <td className="px-4 py-2.5 text-xs">
                                {o.lanaTxHash ? (
                                  <a href={`https://chainz.cryptoid.info/lana/tx.dws?${o.lanaTxHash}`} target="_blank" rel="noopener noreferrer"
                                    className="text-primary hover:text-primary/80 font-mono">{o.lanaTxHash.slice(0, 10)}...</a>
                                ) : <span className="text-muted-foreground">—</span>}
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

              <div className="border-t border-border">
                <AdminPagination
                  page={page}
                  totalPages={totalPages}
                  total={totalFiltered}
                  limit={limit}
                  onPageChange={setPage}
                  onLimitChange={v => { setLimit(v); setPage(1); }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminIncomingPayments;
