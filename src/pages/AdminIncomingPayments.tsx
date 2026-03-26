import { useEffect, useState, useCallback, useRef } from 'react';
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
  batchId: number | null;
  batchRef: string | null;
  batchStatus: string | null;
  discountStatus: string | null;
  createdAt: string;
}

interface LocalBatch {
  id: number;
  batchRef: string;
  investorHex: string;
  totalAmount: number;
  currency: string;
  paymentCount: number;
  status: string;
  receivedAt: string | null;
  lanaBoughtAt: string | null;
  lanaSentAt: string | null;
  lanaTxHash: string | null;
  notes: string | null;
  createdAt: string;
}

interface LanaOrder {
  id: string;
  transactionRef: string;
  orderType: string;
  toWallet: string;
  toHex: string;
  lanaAmount: number; // lanoshis
  fiatValue: number;
  currency: string;
  exchangeRate: number;
  txHash: string | null;
  status: string;
  createdAt: string;
}

interface BatchGroup {
  batchRef: string;
  batchId: number | null;
  batchStatus: string | null;
  discountStatus: string | null;
  currency: string;
  orders: FiatOrder[];
  totalFiat: number;
  totalLana: number;
  allPaid: boolean;
  recipientWallet: string | null;
  shopName: string | null;
  localBatch: LocalBatch | null;
}

type TabId = 'pending_direct' | 'incoming' | 'received' | 'lana_bought' | 'lana_sent';

const tabs: { id: TabId; label: string; desc: string; color: string }[] = [
  { id: 'pending_direct', label: 'Pending Direct', desc: 'Awaiting payment on Lana Direct Fund — not yet sent by investors', color: 'text-gray-500' },
  { id: 'incoming', label: 'Incoming', desc: 'FIAT payments sent by investors', color: 'text-amber-500' },
  { id: 'received', label: 'Received', desc: 'FIAT confirmed on bank account', color: 'text-blue-500' },
  { id: 'lana_bought', label: 'Pending to Send LANA', desc: 'LANA purchased with received FIAT — ready to distribute', color: 'text-purple-500' },
  { id: 'lana_sent', label: 'LANA Sent', desc: 'LANA distributed to recipients', color: 'text-emerald-500' },
];

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

function formatLana(lanoshis: number): string {
  const lana = lanoshis / 100_000_000;
  if (Number.isInteger(lana)) return lana.toLocaleString();
  // Show up to 3 decimal places, strip trailing zeros
  return parseFloat(lana.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function PaymentTypeIcon({ type }: { type: string | null }) {
  if ((type || 'lana') === 'lana') {
    return (
      <span className="inline-flex items-center px-1 py-0.5 rounded bg-[hsl(43,74%,49%)]/10 border border-[hsl(43,74%,49%)]/20" title="LANA">
        <img src="/lana-logo.png" alt="LANA" className="h-3.5 w-3.5 dark:invert opacity-70" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20" title="Cash">
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
    </span>
  );
}

const purposeConfig: Record<string, { label: string; cls: string }> = {
  lana_purchase: { label: 'LANA Purchase', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
  merchant_payment: { label: 'Shop Invoice', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  merchant_commission: { label: 'Shop Incentive', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' },
  caretaker_via_discount: { label: 'Caretaker', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' },
};

const AdminIncomingPayments = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<FiatOrder[]>([]);
  const [lanaOrders, setLanaOrders] = useState<LanaOrder[]>([]);
  const [buybackBalance, setBuybackBalance] = useState<{ wallet: string; balanceLana: number; confirmedLana?: number; unconfirmedLana?: number }>({ wallet: '', balanceLana: 0 });
  const [heartbeatInfo, setHeartbeatInfo] = useState<{ nextAutoSendMin: number; nextHeartbeatSec: number; pendingLanaOrders: number; lastAutoSendAt: string | null }>({ nextAutoSendMin: 0, nextHeartbeatSec: 60, pendingLanaOrders: 0, lastAutoSendAt: null });
  const [countdown, setCountdown] = useState(0);
  const [hbCountdown, setHbCountdown] = useState(60);
  const [lanaObligations, setLanaObligations] = useState<{ pendingLanoshis: number; sentLanoshis: number }>({ pendingLanoshis: 0, sentLanoshis: 0 });
  const [localBatches, setLocalBatches] = useState<LocalBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('incoming');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState(0.016);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  const fetchData = useCallback(async () => {
    if (!session || !isAdmin) return;
    try {
      const res = await fetch('/api/admin/incoming-payments', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      // Only show orders destined for lana_discount
      const ldOrders = (data.orders || []).filter((o: FiatOrder) => o.destinationType === 'lana_discount');
      setOrders(ldOrders);
      setLanaOrders(data.lanaOrders || []);
      setBuybackBalance(data.buybackBalance || { wallet: '', balanceLana: 0 });
      setLanaObligations(data.lanaObligations || { pendingLanoshis: 0, sentLanoshis: 0 });
      setLocalBatches(data.localBatches || []);
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
  }, [session, isAdmin]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Poll heartbeat status every 30s + countdown timer
  useEffect(() => {
    const fetchHb = async () => {
      try {
        const res = await fetch('/api/heartbeat-status');
        if (res.ok) {
          const data = await res.json();
          setHeartbeatInfo(data);
          // Only update countdown if server reports > 0 minutes remaining
          const serverSec = (data.nextAutoSendMin || 0) * 60;
          if (serverSec > 0) setCountdown(serverSec);
          setHbCountdown(data.nextHeartbeatSec || 60);
        }
      } catch {}
    };
    fetchHb();
    const hbTimer = setInterval(fetchHb, 30000);
    return () => clearInterval(hbTimer);
  }, []);

  // Countdown every second — auto-refresh data when countdown reaches 0
  const fetchingRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          // Debounce: don't fire if already fetching
          if (!fetchingRef.current) {
            fetchingRef.current = true;
            fetchData().finally(() => { fetchingRef.current = false; });
          }
          return 300; // reset to 5 minutes (not 0 — prevents rapid re-fetch)
        }
        return c - 1;
      });
      setHbCountdown(c => {
        if (c <= 1) return 60;
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [fetchData]);

  const updateBatchStatus = async (batch: BatchGroup, newStatus: TabId) => {
    if (!session) return;
    setUpdating(batch.batchRef);
    try {
      const res = await fetch(`/api/admin/incoming-batches/${encodeURIComponent(batch.batchRef)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({
          status: newStatus,
          investorHex: batch.orders[0]?.investorHex || '',
          totalAmount: batch.totalFiat,
          currency: batch.currency,
          paymentCount: batch.orders.length,
          payments: batch.orders.map(o => ({
            ppId: o.ppId,
            orderType: o.orderType,
            amountFiat: o.amountFiat,
            currency: o.currency,
            recipientWallet: o.recipientWallet,
            shopName: o.shopName,
            transactionRef: o.transactionRef,
          })),
        }),
      });
      if (!res.ok) throw new Error('Failed to update');
      toast.success(`Batch ${batch.batchRef} → ${newStatus.replace('_', ' ')}`);
      await fetchData();
    } catch {
      toast.error('Failed to update batch status');
    } finally {
      setUpdating(null);
    }
  };

  const sendBatchLana = async (batch: BatchGroup) => {
    if (!session) return;
    // Collect unique transaction_refs from the batch orders
    const txRefs = [...new Set(batch.orders.map(o => o.transactionRef).filter(Boolean))];
    if (txRefs.length === 0) {
      toast.error('No transaction references found');
      return;
    }
    if (!confirm(`Send LANA to ${batch.orders.length} recipients from buyback wallet?\n\nTotal: ${formatFiat(batch.totalFiat, batch.currency)} → ≈${batch.totalLana.toLocaleString()} LANA\n\nThis will broadcast a blockchain transaction.`)) {
      return;
    }
    setUpdating(batch.batchRef);
    try {
      const res = await fetch('/api/admin/send-batch-lana', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session.nostrHexId },
        body: JSON.stringify({ transaction_refs: txRefs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send LANA');
      toast.success(`LANA sent! TX: ${data.tx_hash?.slice(0, 12)}... (${data.orders_count} recipients)`);
      // Move batch to lana_sent
      await updateBatchStatus(batch, 'lana_sent');
    } catch (err: any) {
      toast.error(err.message || 'Failed to send LANA');
    } finally {
      setUpdating(null);
    }
  };

  if (authLoading || !session || !isAdmin) return null;

  // Orders not yet paid by investor (pending on direct.lana.fund)
  const pendingDirectOrders = orders.filter(o => !o.ppConfirmed || !o.batchRef || o.batchStatus !== 'paid');

  // Orders paid by investor (batched and confirmed)
  const paidOrders = orders.filter(o => o.ppConfirmed && o.batchRef && o.batchStatus === 'paid');

  // Build batch groups from paid orders
  const batchMap = new Map<string, FiatOrder[]>();
  for (const o of paidOrders) {
    const key = o.batchRef!;
    const group = batchMap.get(key) || [];
    group.push(o);
    batchMap.set(key, group);
  }

  const localBatchMap = new Map<string, LocalBatch>();
  for (const lb of localBatches) localBatchMap.set(lb.batchRef, lb);

  const allBatches: BatchGroup[] = Array.from(batchMap.entries()).map(([ref, ords]) => {
    const first = ords[0];
    const totalFiat = ords.reduce((s, o) => s + o.amountFiat, 0);
    const lb = localBatchMap.get(ref) || null;
    return {
      batchRef: ref,
      batchId: first.batchId,
      batchStatus: first.batchStatus,
      discountStatus: lb?.status || first.discountStatus || 'incoming',
      currency: first.currency,
      orders: ords.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      totalFiat,
      totalLana: exchangeRate > 0 ? Math.round(totalFiat / exchangeRate) : 0,
      allPaid: true,
      recipientWallet: first.recipientWallet,
      shopName: first.shopName,
      localBatch: lb,
    };
  }).sort((a, b) => b.totalFiat - a.totalFiat);

  // Filter by active tab
  const filteredBatches = allBatches.filter(b => {
    const ds = b.discountStatus || 'incoming';
    return ds === activeTab;
  });

  // Summary per tab
  const tabCounts: Record<TabId, number> = { pending_direct: 0, incoming: 0, received: 0, lana_bought: 0, lana_sent: 0 };
  const tabTotals: Record<TabId, Map<string, number>> = {
    pending_direct: new Map(), incoming: new Map(), received: new Map(), lana_bought: new Map(), lana_sent: new Map(),
  };

  // Count pending_direct orders (not grouped into batches)
  for (const o of pendingDirectOrders) {
    tabCounts.pending_direct++;
    tabTotals.pending_direct.set(o.currency, (tabTotals.pending_direct.get(o.currency) || 0) + o.amountFiat);
  }

  for (const b of allBatches) {
    const ds = (b.discountStatus || 'incoming') as TabId;
    if (tabCounts[ds] !== undefined) {
      tabCounts[ds]++;
      tabTotals[ds].set(b.currency, (tabTotals[ds].get(b.currency) || 0) + b.totalFiat);
    }
  }

  const nextAction: Record<TabId, { label: string; next: TabId }> = {
    pending_direct: { label: '', next: 'pending_direct' },
    incoming: { label: 'Confirm Received', next: 'received' },
    received: { label: 'Mark LANA Bought', next: 'lana_bought' },
    lana_bought: { label: 'Mark LANA Sent', next: 'lana_sent' },
    lana_sent: { label: '', next: 'lana_sent' },
  };

  // Calculate pending/sent LANA only for orders belonging to lana_bought/lana_sent batches
  const lanaBoughtBatches = allBatches.filter(b => b.discountStatus === 'lana_bought');
  const lanaSentBatches = allBatches.filter(b => b.discountStatus === 'lana_sent');
  const getBatchTxRefs = (batches: BatchGroup[]) =>
    [...new Set(batches.flatMap(b => b.orders.map(o => o.transactionRef).filter(Boolean)))];
  const boughtTxRefs = getBatchTxRefs(lanaBoughtBatches);
  const sentTxRefs = getBatchTxRefs(lanaSentBatches);
  const batchedPendingLanoshis = lanaOrders
    .filter(lo => lo.status === 'pending' && boughtTxRefs.includes(lo.transactionRef))
    .reduce((s, lo) => s + lo.lanaAmount, 0);
  const batchedSentLanoshis = lanaOrders
    .filter(lo => lo.status === 'sent' && [...boughtTxRefs, ...sentTxRefs].includes(lo.transactionRef))
    .reduce((s, lo) => s + lo.lanaAmount, 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminNav />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <h1 className="text-lg font-bold">Incoming FIAT Payments</h1>
        <p className="text-sm text-muted-foreground -mt-3">
          Track FIAT from investors through the full lifecycle: receive → buy LANA → distribute.
        </p>

        {/* 4 Tabs */}
        <div className="grid grid-cols-5 gap-1 bg-muted rounded-xl p-1">
          {tabs.map(tab => {
            const count = tabCounts[tab.id];
            const totals = tabTotals[tab.id];
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setExpandedKey(null); }}
                className={`rounded-lg py-3 px-2 text-center transition-all ${
                  isActive ? 'bg-card shadow-sm' : 'hover:bg-card/50'
                }`}
              >
                <p className={`text-[10px] font-semibold uppercase tracking-wider ${isActive ? tab.color : 'text-muted-foreground'}`}>
                  {tab.label}
                </p>
                {count > 0 ? (
                  <>
                    {Array.from(totals.entries()).map(([c, v]) => (
                      <p key={c} className={`text-sm font-bold tabular-nums ${isActive ? '' : 'text-muted-foreground'}`}>
                        {formatFiat(v, c)}
                      </p>
                    ))}
                    <p className="text-[10px] text-muted-foreground">
                      {count} {tab.id === 'pending_direct' ? (count !== 1 ? 'orders' : 'order') : (count !== 1 ? 'batches' : 'batch')}
                    </p>
                  </>
                ) : (
                  <p className="text-lg font-bold text-muted-foreground">—</p>
                )}
              </button>
            );
          })}
        </div>

        {/* LANA Balance Overview */}
        {buybackBalance.wallet && (
          <div className="rounded-xl border bg-card p-4">
            {/* Heartbeat status */}
            <div className="flex items-center justify-center gap-4 mb-3 pb-3 border-b text-xs">
              {heartbeatInfo.pendingLanaOrders > 0 ? (
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                  <span className="text-muted-foreground">Auto-send {heartbeatInfo.pendingLanaOrders} pending order{heartbeatInfo.pendingLanaOrders !== 1 ? 's' : ''} in</span>
                  <span className="font-bold tabular-nums text-amber-500">
                    {countdown > 0 ? `${Math.floor(countdown / 60)}:${(countdown % 60).toString().padStart(2, '0')}` : 'sending...'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-muted-foreground">No pending LANA orders</span>
                </div>
              )}
              <span className="text-muted-foreground/50">|</span>
              <span className="text-muted-foreground">
                Next heartbeat in <span className="font-bold tabular-nums text-foreground">
                  {hbCountdown > 0 ? `${hbCountdown}s` : 'now'}
                </span>
              </span>
              {heartbeatInfo.lastAutoSendAt && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="text-muted-foreground">
                    Last send: {formatDate(heartbeatInfo.lastAutoSendAt)} {formatTime(heartbeatInfo.lastAutoSendAt)}
                  </span>
                </>
              )}
            </div>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Buyback Wallet</p>
                <p className="text-lg font-bold tabular-nums">{buybackBalance.balanceLana.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-xs text-muted-foreground">LANA</span></p>
                {(buybackBalance.unconfirmedLana ?? 0) !== 0 && (
                  <p className="text-[10px] text-amber-500 font-mono">
                    +{(buybackBalance.unconfirmedLana ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} incoming
                  </p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Pending to Send</p>
                <p className="text-lg font-bold tabular-nums text-amber-500">{formatLana(batchedPendingLanoshis)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">Already Sent</p>
                <p className="text-lg font-bold tabular-nums text-emerald-500">{formatLana(batchedSentLanoshis)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Available</p>
                {(() => {
                  const pendingLana = batchedPendingLanoshis / 100_000_000;
                  const confirmed = buybackBalance.balanceLana; // already confirmed-only from backend
                  const available = confirmed - pendingLana;
                  return (
                    <p className={`text-lg font-bold tabular-nums ${available >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {available.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </p>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Tab description */}
        <p className="text-xs text-muted-foreground">{tabs.find(t => t.id === activeTab)?.desc}</p>

        {/* Batch list */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : activeTab === 'pending_direct' ? (
          /* Pending Direct tab: show individual orders waiting on Lana Direct Fund */
          pendingDirectOrders.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No pending orders on Lana Direct Fund</div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <div className="px-4 py-2 text-[10px] text-muted-foreground flex items-center justify-between bg-muted/30 border-b">
                <div className="flex items-center gap-4">
                  <span className="w-8">ID</span>
                  <span className="w-28">Date</span>
                  <span className="w-24">Type</span>
                  <span className="w-24">Status</span>
                  <span>Wallet</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="w-20 text-right">FIAT</span>
                  <span className="w-20 text-right">LANA</span>
                </div>
              </div>
              {pendingDirectOrders.map(o => {
                const pc = purposeConfig[o.orderType || ''] || { label: o.orderType || '?', cls: 'bg-muted text-muted-foreground' };
                const lanaAmount = exchangeRate > 0 ? Math.round(o.amountFiat / exchangeRate) : 0;
                const statusLabel = !o.ppConfirmed ? 'Awaiting Payment' : o.batchStatus !== 'paid' ? 'In Batch' : 'Paid';
                const statusCls = !o.ppConfirmed ? 'text-gray-400' : o.batchStatus !== 'paid' ? 'text-amber-500' : 'text-emerald-500';
                return (
                  <div key={o.id} className="px-4 py-2 text-xs flex items-center justify-between border-b last:border-0 hover:bg-accent/30 transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <span className="text-muted-foreground w-8">#{o.ppId || '—'}</span>
                      <div className="w-28 whitespace-nowrap">
                        <span>{formatDate(o.createdAt)}</span>
                        <span className="text-muted-foreground ml-1">{formatTime(o.createdAt)}</span>
                      </div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold w-24 text-center ${pc.cls}`}>{pc.label}</span>
                      <span className={`text-[10px] font-medium w-24 ${statusCls}`}>{statusLabel}</span>
                      {o.recipientWallet && (
                        <span className="font-mono text-muted-foreground truncate max-w-[140px]" title={o.recipientWallet}>
                          {shortenWallet(o.recipientWallet)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <span className="font-medium tabular-nums w-20 text-right">{formatFiat(o.amountFiat, o.currency)}</span>
                      <span className="text-muted-foreground tabular-nums w-20 text-right">
                        {lanaAmount > 0 ? lanaAmount.toLocaleString() : '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : filteredBatches.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No batches in "{tabs.find(t => t.id === activeTab)?.label}"
          </div>
        ) : (
          <div className="space-y-3">
            {filteredBatches.map(batch => {
              const isExpanded = expandedKey === batch.batchRef;
              const action = nextAction[activeTab];
              const types = [...new Set(batch.orders.map(o => o.orderType || 'unknown'))];

              return (
                <div key={batch.batchRef} className="rounded-xl border overflow-hidden">
                  {/* Batch header */}
                  <div
                    className="px-4 py-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => setExpandedKey(isExpanded ? null : batch.batchRef)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-mono text-xs font-semibold">{batch.batchRef}</span>
                          {types.map(t => {
                            const pc = purposeConfig[t] || { label: t, cls: 'bg-muted text-muted-foreground' };
                            return <span key={t} className={`px-2 py-0.5 rounded text-[10px] font-semibold ${pc.cls}`}>{pc.label}</span>;
                          })}
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">{batch.currency}</span>
                          <PaymentTypeIcon type={batch.orders[0]?.paymentType} />
                        </div>

                        {batch.shopName && <p className="text-sm">{batch.shopName}</p>}

                        {batch.recipientWallet && (
                          <p className="text-xs text-muted-foreground font-mono">
                            LANA → <span className="text-foreground font-medium">{shortenWallet(batch.recipientWallet)}</span>
                          </p>
                        )}

                        <p className="text-xs text-muted-foreground mt-0.5">
                          {batch.orders.length} payment{batch.orders.length !== 1 ? 's' : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        <div className="text-right">
                          <p className="text-xl font-bold tabular-nums">{formatFiat(batch.totalFiat, batch.currency)}</p>
                          {batch.totalLana > 0 && (
                            <p className="text-sm text-muted-foreground tabular-nums">
                              ≈ {batch.totalLana.toLocaleString()} LANA
                            </p>
                          )}
                        </div>
                        {activeTab === 'lana_bought' ? (
                          <button
                            onClick={e => { e.stopPropagation(); sendBatchLana(batch); }}
                            disabled={updating === batch.batchRef}
                            className="px-3 py-2 rounded-lg text-xs font-semibold bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap"
                          >
                            {updating === batch.batchRef ? 'Sending...' : 'Send LANA'}
                          </button>
                        ) : action.label ? (
                          <button
                            onClick={e => { e.stopPropagation(); updateBatchStatus(batch, action.next); }}
                            disabled={updating === batch.batchRef}
                            className="px-3 py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap"
                          >
                            {updating === batch.batchRef ? '...' : action.label}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* Expanded: individual payments */}
                  {isExpanded && (
                    <div className="border-t divide-y">
                      <div className="px-4 py-1.5 text-[10px] text-muted-foreground flex items-center justify-between bg-muted/30">
                        <div className="flex items-center gap-4">
                          <span className="w-8">ID</span>
                          <span className="w-28">Date</span>
                          <span className="w-24">Type</span>
                          <span>Wallet</span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="w-20 text-right">FIAT</span>
                          <span className="w-20 text-right">LANA</span>
                        </div>
                      </div>
                      {batch.orders.map(o => {
                        const pc = purposeConfig[o.orderType || ''] || { label: o.orderType || '?', cls: 'bg-muted text-muted-foreground' };
                        const lanaAmount = exchangeRate > 0 ? parseFloat((o.amountFiat / exchangeRate).toFixed(3)) : 0;
                        return (
                          <div key={o.id} className="px-4 py-2 text-xs flex items-center justify-between">
                            <div className="flex items-center gap-4 min-w-0">
                              <span className="text-muted-foreground w-8">#{o.ppId || '—'}</span>
                              <div className="w-28 whitespace-nowrap">
                                <span>{formatDate(o.createdAt)}</span>
                                <span className="text-muted-foreground ml-1">{formatTime(o.createdAt)}</span>
                              </div>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold w-24 text-center ${pc.cls}`}>{pc.label}</span>
                              <PaymentTypeIcon type={o.paymentType} />
                              {o.recipientWallet && (
                                <span className="font-mono text-muted-foreground truncate max-w-[140px]" title={o.recipientWallet}>
                                  {shortenWallet(o.recipientWallet)}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 shrink-0">
                              <span className="font-medium tabular-nums w-20 text-right">{formatFiat(o.amountFiat, o.currency)}</span>
                              <span className="text-muted-foreground tabular-nums w-20 text-right">
                                {lanaAmount > 0 ? lanaAmount.toLocaleString() : '—'}
                              </span>
                            </div>
                          </div>
                        );
                      })}

                      {/* LANA Recipients breakdown (for lana_bought and lana_sent tabs) */}
                      {(activeTab === 'lana_bought' || activeTab === 'lana_sent') && (() => {
                        const txRefs = [...new Set(batch.orders.map(o => o.transactionRef).filter(Boolean))];
                        const recipients = lanaOrders.filter(lo => txRefs.includes(lo.transactionRef));
                        if (recipients.length === 0) return null;
                        const totalLanoshis = recipients.reduce((s, r) => s + r.lanaAmount, 0);
                        return (
                          <div className="border-t bg-purple-500/5">
                            <div className="px-4 py-1.5 text-[10px] text-purple-400 font-semibold uppercase tracking-wider flex items-center justify-between">
                              <span>LANA Recipients ({recipients.length})</span>
                              <span className="tabular-nums">{formatLana(totalLanoshis)} LANA total</span>
                            </div>
                            {recipients.map(r => {
                              const pc = purposeConfig[r.orderType] || { label: r.orderType, cls: 'bg-muted text-muted-foreground' };
                              return (
                                <div key={r.id} className="px-4 py-2 text-xs flex items-center justify-between border-t border-purple-500/10">
                                  <div className="flex items-center gap-3 min-w-0">
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${pc.cls}`}>{pc.label}</span>
                                    <span className="font-mono text-muted-foreground truncate max-w-[180px]" title={r.toWallet}>
                                      → {shortenWallet(r.toWallet)}
                                    </span>
                                    {r.txHash && (
                                      <a href={`https://chainz.cryptoid.info/lana/tx.dws?${r.txHash}`} target="_blank" rel="noopener noreferrer" className="text-emerald-500 hover:underline font-mono text-[10px]">
                                        {r.txHash.slice(0, 8)}...
                                      </a>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 shrink-0">
                                    <span className="text-muted-foreground tabular-nums w-16 text-right">{formatFiat(r.fiatValue, r.currency)}</span>
                                    <span className="font-semibold text-purple-400 tabular-nums w-16 text-right">{formatLana(r.lanaAmount)}</span>
                                    <span className={`text-[10px] w-12 text-right ${r.status === 'sent' ? 'text-emerald-500' : 'text-amber-500'}`}>
                                      {r.status === 'sent' ? '✓ Sent' : '⏳'}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* Timestamps */}
                      {batch.localBatch && (
                        <div className="px-4 py-2 text-[11px] text-muted-foreground bg-muted/20 space-y-0.5">
                          {batch.localBatch.receivedAt && <p>✓ Received: {formatDate(batch.localBatch.receivedAt)} {formatTime(batch.localBatch.receivedAt)}</p>}
                          {batch.localBatch.lanaBoughtAt && <p>✓ LANA Bought: {formatDate(batch.localBatch.lanaBoughtAt)} {formatTime(batch.localBatch.lanaBoughtAt)}</p>}
                          {batch.localBatch.lanaSentAt && <p>✓ LANA Sent: {formatDate(batch.localBatch.lanaSentAt)} {formatTime(batch.localBatch.lanaSentAt)}</p>}
                          {batch.localBatch.lanaTxHash && (
                            <p>
                              TX:{' '}
                              <a
                                href={`https://chainz.cryptoid.info/lana/tx.dws?${batch.localBatch.lanaTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline font-mono"
                              >
                                {batch.localBatch.lanaTxHash.slice(0, 12)}...
                              </a>
                            </p>
                          )}
                        </div>
                      )}
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
