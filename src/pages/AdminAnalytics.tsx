import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';

interface FiatInRow {
  currency: string;
  batchCount: number;
  paymentCount: number;
  totalAmount: number;
}

interface FiatInByStatus {
  status: string;
  currency: string;
  batchCount: number;
  totalAmount: number;
}

interface LanaOutRow {
  orderType: string;
  orderCount: number;
  totalLana: number;
  fiatValueAtTime: Record<string, number>;
  currentEurValue: number;
}

interface BuybackRow {
  currency: string;
  txCount: number;
  totalLana: number;
  grossFiat: number;
  commissionFiat: number;
  commissionPct: number;
  netFiat: number;
  paidOut: number;
  paidCount: number;
  outstanding: number;
}

interface ReconciliationRow {
  currency: string;
  incomingFiat: number;
  lanaOutFiatAtTime: number;
  buybackPaidOut: number;
  buybackOutstanding: number;
  commissionEarned: number;
}

interface AnalyticsResponse {
  generatedAt: string;
  since: string | null;
  currentRates: Record<string, number>;
  fiatIn: { perCurrency: FiatInRow[]; byStatus: FiatInByStatus[] };
  lanaOut: { byType: LanaOutRow[] };
  buyback: { perCurrency: BuybackRow[] };
  reconciliation: ReconciliationRow[];
}

const orderTypeLabel: Record<string, string> = {
  customer_cashback: 'Customer cashback',
  merchant_commission: 'Merchant payment (LANA)',
  caretaker_commission: 'Caretaker (LANA)',
  investor_lana: 'Investor buyback (LANA)',
};

const orderTypeDesc: Record<string, string> = {
  customer_cashback: 'Discount given to customers — credited to their LANA wallet',
  merchant_commission: 'Merchant chose LANA payout method',
  caretaker_commission: 'LANA paid to caretaker',
  investor_lana: 'LANA bought back from market and credited to investor',
};

function formatFiat(amount: number, currency: string): string {
  const sym: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
  return `${sym[currency] || currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLana(lana: number): string {
  return lana.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

const PRESETS = [
  { label: 'All time', value: '' },
  { label: 'This month', value: 'month' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Today', value: 'today' },
];

function presetToSince(preset: string): string {
  const now = new Date();
  if (preset === 'today') {
    return now.toISOString().slice(0, 10);
  }
  if (preset === '7d') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  if (preset === '30d') {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }
  if (preset === 'month') {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }
  return '';
}

const AdminAnalytics = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<string>('');

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  const fetchAnalytics = async () => {
    if (!session || !isAdmin) return;
    setLoading(true);
    try {
      const since = presetToSince(preset);
      const url = since ? `/api/admin/analytics?since=${since}` : '/api/admin/analytics';
      const res = await fetch(url, {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAnalytics(); }, [session, isAdmin, preset]);

  const eurRate = data?.currentRates?.EUR || 0;
  const gbpRate = data?.currentRates?.GBP || 0;

  // Roll-up totals
  const totals = useMemo(() => {
    if (!data) return null;
    const fiatInTotalEur = data.fiatIn.perCurrency.reduce((sum, r) => {
      // Convert to EUR using current rate as a coarse pivot
      if (r.currency === 'EUR') return sum + r.totalAmount;
      if (r.currency === 'GBP' && eurRate > 0 && gbpRate > 0) {
        // GBP → EUR via LANA pivot: amount/gbpRate × eurRate
        return sum + (r.totalAmount / gbpRate) * eurRate;
      }
      return sum;
    }, 0);

    const totalLanaOut = data.lanaOut.byType.reduce((s, r) => s + r.totalLana, 0);
    const totalLanaOutEur = data.lanaOut.byType.reduce((s, r) => s + r.currentEurValue, 0);

    const totalBuybackEur = data.buyback.perCurrency.reduce((sum, r) => {
      if (r.currency === 'EUR') return sum + r.netFiat;
      if (r.currency === 'GBP' && eurRate > 0 && gbpRate > 0) {
        return sum + (r.netFiat / gbpRate) * eurRate;
      }
      return sum;
    }, 0);

    const totalCommissionEur = data.buyback.perCurrency.reduce((sum, r) => {
      if (r.currency === 'EUR') return sum + r.commissionFiat;
      if (r.currency === 'GBP' && eurRate > 0 && gbpRate > 0) {
        return sum + (r.commissionFiat / gbpRate) * eurRate;
      }
      return sum;
    }, 0);

    const totalPaidEur = data.buyback.perCurrency.reduce((sum, r) => {
      if (r.currency === 'EUR') return sum + r.paidOut;
      if (r.currency === 'GBP' && eurRate > 0 && gbpRate > 0) {
        return sum + (r.paidOut / gbpRate) * eurRate;
      }
      return sum;
    }, 0);

    const totalOutstandingEur = data.buyback.perCurrency.reduce((sum, r) => {
      if (r.currency === 'EUR') return sum + r.outstanding;
      if (r.currency === 'GBP' && eurRate > 0 && gbpRate > 0) {
        return sum + (r.outstanding / gbpRate) * eurRate;
      }
      return sum;
    }, 0);

    return {
      fiatInTotalEur,
      totalLanaOut,
      totalLanaOutEur,
      totalBuybackEur,
      totalCommissionEur,
      totalPaidEur,
      totalOutstandingEur,
    };
  }, [data, eurRate, gbpRate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <AdminNav />
        <div className="container mx-auto px-4 sm:px-6 py-8 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-muted-foreground">Loading analytics…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !totals) {
    return (
      <div className="min-h-screen bg-background">
        <AdminNav />
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">Failed to load analytics data.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <div className="container mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Header + filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              FIAT in · LANA out · Buybacks &amp; commission · Reconciliation
              <span className="ml-2 text-xs font-mono">
                (1 LANA = {eurRate ? `€${eurRate.toFixed(4)}` : '—'}
                {gbpRate ? ` · £${gbpRate.toFixed(4)}` : ''})
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {PRESETS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <button
              onClick={fetchAnalytics}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Top KPIs — single coarse view in EUR */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="FIAT received (EUR equiv.)"
            value={formatFiat(totals.fiatInTotalEur, 'EUR')}
            subtitle="From Direct Fund investors"
            color="text-foreground"
          />
          <KpiCard
            label="LANA distributed"
            value={formatLana(totals.totalLanaOut)}
            unit="LANA"
            subtitle={`≈ ${formatFiat(totals.totalLanaOutEur, 'EUR')} at current rate`}
            color="text-primary"
          />
          <KpiCard
            label="Owed to sellers (net, EUR equiv.)"
            value={formatFiat(totals.totalBuybackEur, 'EUR')}
            subtitle={`Paid: ${formatFiat(totals.totalPaidEur, 'EUR')}`}
            color="text-foreground"
          />
          <KpiCard
            label="Outstanding to sellers"
            value={formatFiat(totals.totalOutstandingEur, 'EUR')}
            subtitle={`Commission earned: ${formatFiat(totals.totalCommissionEur, 'EUR')}`}
            color={totals.totalOutstandingEur > 0 ? 'text-amber-600' : 'text-green-600'}
          />
        </div>

        {/* ─── Section 1: FIAT IN (Money on bank account) ─── */}
        <Section
          title="1. FIAT received (Money on bank account)"
          subtitle="Investor batches paid from Direct Fund into Lana.Discount's bank for LANA buybacks."
        >
          {data.fiatIn.perCurrency.length === 0 ? (
            <EmptyState>No incoming FIAT in this period.</EmptyState>
          ) : (
            <Table headers={['Currency', 'Batches', 'Payments', 'Total received']}>
              {data.fiatIn.perCurrency.map((r) => (
                <tr key={r.currency} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{r.currency}</td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.batchCount}</td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.paymentCount}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{formatFiat(r.totalAmount, r.currency)}</td>
                </tr>
              ))}
            </Table>
          )}
          {data.fiatIn.byStatus.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-2 px-1">By batch status:</p>
              <Table headers={['Status', 'Currency', 'Batches', 'Amount']} dense>
                {data.fiatIn.byStatus.map((r, i) => (
                  <tr key={`${r.status}-${r.currency}-${i}`} className="border-t border-border">
                    <td className="px-4 py-1.5">
                      <StatusPill label={r.status} />
                    </td>
                    <td className="px-4 py-1.5">{r.currency}</td>
                    <td className="px-4 py-1.5 tabular-nums text-muted-foreground">{r.batchCount}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatFiat(r.totalAmount, r.currency)}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Section>

        {/* ─── Section 2: LANA OUT (LANA distributed) ─── */}
        <Section
          title="2. LANA distributed"
          subtitle="LANA orders broadcast via the brain orchestrator, grouped by recipient type."
        >
          {data.lanaOut.byType.length === 0 ? (
            <EmptyState>No LANA distributed in this period.</EmptyState>
          ) : (
            <Table headers={['Recipient', 'Orders', 'LANA', 'EUR (at time)', 'EUR (current rate)']}>
              {data.lanaOut.byType.map((r) => {
                const fiatAtTimeStr = Object.entries(r.fiatValueAtTime)
                  .map(([cur, v]) => formatFiat(v as number, cur))
                  .join(' + ');
                return (
                  <tr key={r.orderType} className="border-t border-border">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground">{orderTypeLabel[r.orderType] || r.orderType}</div>
                      <div className="text-[11px] text-muted-foreground">{orderTypeDesc[r.orderType] || ''}</div>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.orderCount}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-primary">
                      {formatLana(r.totalLana)} LANA
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                      {fiatAtTimeStr || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                      {formatFiat(r.currentEurValue, 'EUR')}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-border bg-muted/30">
                <td className="px-4 py-2.5 font-semibold">Total</td>
                <td className="px-4 py-2.5 tabular-nums font-semibold">
                  {data.lanaOut.byType.reduce((s, r) => s + r.orderCount, 0)}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-primary">
                  {formatLana(totals.totalLanaOut)} LANA
                </td>
                <td className="px-4 py-2.5"></td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                  {formatFiat(totals.totalLanaOutEur, 'EUR')}
                </td>
              </tr>
            </Table>
          )}
        </Section>

        {/* ─── Section 3: Buybacks (EUR out from our bank) ─── */}
        <Section
          title="3. Buyback payouts (EUR/GBP from our bank to LANA sellers)"
          subtitle="Users who sold LANA back to us. Gross is what they sold, commission is our cut, net is what we owe them."
        >
          {data.buyback.perCurrency.length === 0 ? (
            <EmptyState>No buyback transactions in this period.</EmptyState>
          ) : (
            <Table headers={['Currency', 'TX', 'LANA bought', 'Gross', 'Commission', 'Net (owed)', 'Paid out', 'Outstanding']}>
              {data.buyback.perCurrency.map((r) => (
                <tr key={r.currency} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{r.currency}</td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.txCount}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-primary font-medium">{formatLana(r.totalLana)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.grossFiat, r.currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-emerald-600">
                    {formatFiat(r.commissionFiat, r.currency)}
                    <span className="ml-1 text-[10px] text-muted-foreground">({r.commissionPct.toFixed(1)}%)</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatFiat(r.netFiat, r.currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatFiat(r.paidOut, r.currency)}
                    <span className="ml-1 text-[10px] text-muted-foreground">({r.paidCount}×)</span>
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums font-semibold ${r.outstanding > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                    {formatFiat(r.outstanding, r.currency)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* ─── Section 4: Reconciliation ─── */}
        <Section
          title="4. Reconciliation per currency"
          subtitle="A coarse view: money in (from investors) vs. money out (to LANA sellers) and LANA outflow valued at order-time rates."
        >
          {data.reconciliation.length === 0 ? (
            <EmptyState>Nothing to reconcile in this period.</EmptyState>
          ) : (
            <Table headers={['Currency', 'FIAT in', 'LANA out (at time)', 'Paid to sellers', 'Outstanding', 'Commission earned']}>
              {data.reconciliation.map((r) => (
                <tr key={r.currency} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{r.currency}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.incomingFiat, r.currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatFiat(r.lanaOutFiatAtTime, r.currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.buybackPaidOut, r.currency)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${r.buybackOutstanding > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                    {formatFiat(r.buybackOutstanding, r.currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-emerald-600">{formatFiat(r.commissionEarned, r.currency)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        <p className="text-[10px] text-muted-foreground text-center">
          Generated at {new Date(data.generatedAt).toLocaleString()}
          {data.since && ` · since ${data.since}`}
        </p>
      </div>
    </div>
  );
};

const KpiCard = ({
  label, value, unit, subtitle, color,
}: { label: string; value: string; unit?: string; subtitle?: string; color: string }) => (
  <div className="rounded-2xl border-2 border-border bg-card p-5">
    <p className="text-xs text-muted-foreground mb-1">{label}</p>
    <div className="flex items-baseline gap-2">
      <span className={`text-2xl font-bold font-mono ${color}`}>{value}</span>
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
    {subtitle && <p className="text-[11px] text-muted-foreground mt-1">{subtitle}</p>}
  </div>
);

const Section = ({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) => (
  <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
    <div className="px-5 py-3 border-b border-border">
      <h2 className="font-semibold text-foreground">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
    <div className="p-3">
      {children}
    </div>
  </div>
);

const Table = ({
  headers, children, dense,
}: { headers: string[]; children: React.ReactNode; dense?: boolean }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {headers.map((h, i) => (
            <th
              key={h}
              className={`${dense ? 'px-4 py-1.5' : 'px-4 py-2'} ${i === 0 ? 'text-left' : i === 1 ? 'text-left' : 'text-right'} font-medium`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const EmptyState = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>
);

const StatusPill = ({ label }: { label: string }) => {
  const cls =
    label === 'paid' || label === 'lana_sent' || label === 'lana_bought'
      ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
      : label === 'incoming' || label === 'received'
      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
      : 'bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-gray-400';
  return <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${cls}`}>{label}</span>;
};

export default AdminAnalytics;
