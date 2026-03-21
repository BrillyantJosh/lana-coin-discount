import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  orderType: string | null;
  paymentType: string | null;
  destinationType: string;
  destinationName: string | null;
  recipientWallet: string | null;
  recipientHex: string | null;
  shopName: string | null;
  status: string;
  lanaTxHash: string | null;
  rpcVerified: boolean;
  ppConfirmed: boolean;
  ppId: number | null;
  createdAt: string;
}

interface Batch {
  key: string;
  currency: string;
  orderType: string;
  recipientWallet: string | null;
  recipientHex: string | null;
  shopName: string | null;
  orders: FiatOrder[];
  totalFiat: number;
  totalLana: number;
  allPaid: boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso + 'Z');
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatFiat(v: number, c: string): string {
  return v.toLocaleString(undefined, { style: 'currency', currency: c });
}

function shortenWallet(w: string): string {
  return w.length > 16 ? `${w.slice(0, 8)}...${w.slice(-6)}` : w;
}

const purposeConfig: Record<string, { label: string; cls: string }> = {
  lana_purchase: { label: 'LANA Purchase', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
  merchant_payment: { label: 'Merchant LANA', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  merchant_commission: { label: 'Merchant Commission', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' },
  caretaker_via_discount: { label: 'Caretaker', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' },
};

const AdminIncomingPayments = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<FiatOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'paid'>('all');
  const [exchangeRate, setExchangeRate] = useState(0.016);

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
        // Only keep lana_discount destination orders
        const ldOrders = (data.orders || []).filter((o: FiatOrder) => o.destinationType === 'lana_discount');
        setOrders(ldOrders);
        // Fetch exchange rate
        try {
          const spRes = await fetch('/api/system-params');
          const spData = await spRes.json();
          if (spData.exchange_rates?.EUR) setExchangeRate(spData.exchange_rates.EUR);
        } catch {}
      } catch {
        toast.error('Failed to load incoming payments');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [session, isAdmin]);

  if (authLoading || !session || !isAdmin) return null;

  // exchangeRate is fetched in useEffect above

  // Filter
  const filtered = orders.filter(o => {
    if (statusFilter === 'pending' && o.ppConfirmed) return false;
    if (statusFilter === 'paid' && !o.ppConfirmed) return false;
    return true;
  });

  // Group into batches by currency + orderType + recipientWallet
  const batchMap = new Map<string, FiatOrder[]>();
  for (const o of filtered) {
    const key = `${o.currency}|${o.orderType || 'unknown'}|${o.recipientWallet || 'discount'}|${o.ppConfirmed ? 'paid' : 'pending'}`;
    const group = batchMap.get(key) || [];
    group.push(o);
    batchMap.set(key, group);
  }

  const batches: Batch[] = Array.from(batchMap.entries()).map(([key, ords]) => {
    const first = ords[0];
    const totalFiat = ords.reduce((s, o) => s + o.amountFiat, 0);
    return {
      key,
      currency: first.currency,
      orderType: first.orderType || 'unknown',
      recipientWallet: first.recipientWallet,
      recipientHex: first.recipientHex,
      shopName: first.shopName,
      orders: ords.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      totalFiat,
      totalLana: exchangeRate > 0 ? Math.round(totalFiat / exchangeRate) : 0,
      allPaid: ords.every(o => o.ppConfirmed),
    };
  }).sort((a, b) => {
    if (a.allPaid !== b.allPaid) return a.allPaid ? 1 : -1;
    return b.totalFiat - a.totalFiat;
  });

  // Summary
  const pendingTotal = new Map<string, number>();
  const paidTotal = new Map<string, number>();
  for (const o of orders) {
    const map = o.ppConfirmed ? paidTotal : pendingTotal;
    map.set(o.currency, (map.get(o.currency) || 0) + o.amountFiat);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminNav />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <h1 className="text-lg font-bold">Lana Discount — Incoming Payments</h1>
        <p className="text-sm text-muted-foreground -mt-3">
          FIAT payments from investors that Lana Discount receives for LANA purchases, merchant payouts, and caretaker fees.
        </p>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-[11px] font-medium text-amber-500 uppercase tracking-wider mb-1">Awaiting Payment</p>
            {pendingTotal.size > 0 ? (
              Array.from(pendingTotal.entries()).map(([c, v]) => (
                <p key={c} className="text-lg font-bold tabular-nums">{formatFiat(v, c)}</p>
              ))
            ) : (
              <p className="text-lg font-bold text-muted-foreground">—</p>
            )}
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-[11px] font-medium text-emerald-500 uppercase tracking-wider mb-1">Received</p>
            {paidTotal.size > 0 ? (
              Array.from(paidTotal.entries()).map(([c, v]) => (
                <p key={c} className="text-lg font-bold tabular-nums">{formatFiat(v, c)}</p>
              ))
            ) : (
              <p className="text-lg font-bold text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {/* Filter */}
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 rounded-lg border bg-card text-sm"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
          </select>
        </div>

        {/* Batches */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : batches.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">No incoming payments</div>
        ) : (
          <div className="space-y-3">
            {batches.map(batch => {
              const isExpanded = expandedKey === batch.key;
              const pc = purposeConfig[batch.orderType] || { label: batch.orderType, cls: 'bg-muted text-muted-foreground' };

              return (
                <div
                  key={batch.key}
                  className={`rounded-xl border overflow-hidden transition-all ${
                    batch.allPaid ? 'opacity-50' : ''
                  }`}
                >
                  {/* Batch header */}
                  <div
                    className="px-4 py-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => setExpandedKey(isExpanded ? null : batch.key)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${pc.cls}`}>{pc.label}</span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">{batch.currency}</span>
                          {batch.allPaid && (
                            <span className="text-[10px] text-emerald-500 font-medium">✓ Paid</span>
                          )}
                        </div>

                        {batch.shopName && (
                          <p className="text-sm font-medium">{batch.shopName}</p>
                        )}

                        {batch.recipientWallet && (
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            Wallet: {shortenWallet(batch.recipientWallet)}
                          </p>
                        )}

                        <p className="text-xs text-muted-foreground mt-0.5">
                          {batch.orders.length} payment{batch.orders.length !== 1 ? 's' : ''}
                        </p>
                      </div>

                      <div className="text-right shrink-0 ml-3">
                        <p className="text-xl font-bold tabular-nums">{formatFiat(batch.totalFiat, batch.currency)}</p>
                        {batch.totalLana > 0 && (
                          <p className="text-xs text-muted-foreground tabular-nums">
                            ≈ {batch.totalLana.toLocaleString()} LANA
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded: individual orders */}
                  {isExpanded && (
                    <div className="border-t divide-y">
                      {batch.orders.map(o => (
                        <div key={o.id} className={`px-4 py-2.5 text-xs flex items-center justify-between ${o.ppConfirmed ? 'opacity-50' : ''}`}>
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-muted-foreground">#{o.ppId || '—'}</span>
                            <div className="whitespace-nowrap">
                              <span>{formatDate(o.createdAt)}</span>
                              <span className="text-muted-foreground ml-1">{formatTime(o.createdAt)}</span>
                            </div>
                            {o.recipientWallet && (
                              <span className="font-mono text-muted-foreground truncate max-w-[120px]" title={o.recipientWallet}>
                                {shortenWallet(o.recipientWallet)}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="font-medium tabular-nums">{formatFiat(o.amountFiat, o.currency)}</span>
                            {exchangeRate > 0 && (
                              <span className="text-muted-foreground tabular-nums w-20 text-right">
                                {Math.round(o.amountFiat / exchangeRate).toLocaleString()} LANA
                              </span>
                            )}
                            {o.ppConfirmed ? (
                              <span className="text-emerald-500 text-[10px]">✓ Paid</span>
                            ) : (
                              <span className="text-amber-500 text-[10px]">Pending</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminIncomingPayments;
