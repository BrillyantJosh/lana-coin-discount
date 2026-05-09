import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';

interface BuybackRow {
  currency: string;
  txCount: number;
  totalLana: number;
  worthAtTime: number;
  commission: number;
  netOwed: number;
  paidOut: number;
  outstanding: number;
}

interface ReceivedRow {
  currency: string;
  batchCount: number;
  totalAmount: number;
}

interface OverviewResponse {
  generatedAt: string;
  currentRates: { EUR: number; GBP: number };
  buybacks: {
    totalLanaBought: number;
    worthAtTimeEur: number;
    netOwedEur: number;
    paidEur: number;
    outstandingEur: number;
    differenceEur: number;
    commissionEur: number;
    perCurrency: BuybackRow[];
  };
  moneyIn: {
    totalReceivedEur: number;
    perCurrency: ReceivedRow[];
  };
  buybackWallet: {
    walletId: string;
    balanceLana: number | null;
    balanceEur: number | null;
  };
  feeEarned: {
    totalCommissionEur: number;
    feeOverGrossPct: number;
    feeOverPaidPct: number;
  };
}

function formatFiat(amount: number, currency: string = 'EUR'): string {
  const sym: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
  return `${sym[currency] || currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLana(lana: number): string {
  return lana.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

const AdminOverview = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  const fetchOverview = async () => {
    if (!session || !isAdmin) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/overview', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchOverview(); }, [session, isAdmin]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <AdminNav />
        <div className="container mx-auto px-4 sm:px-6 py-8 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-muted-foreground">Loading overview…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-background">
        <AdminNav />
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">Failed to load overview.</p>
          </div>
        </div>
      </div>
    );
  }

  const { buybacks, moneyIn, buybackWallet, feeEarned, currentRates } = data;

  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <div className="container mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">Overview</h1>
            <p className="text-sm text-muted-foreground">
              Rough feel: LANA bought, what we paid, what we have, what we earned.
              <span className="ml-2 text-xs font-mono">
                (1 LANA = €{currentRates.EUR.toFixed(4)})
              </span>
            </p>
          </div>
          <button
            onClick={fetchOverview}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            Refresh
          </button>
        </div>

        {/* ─── Section A: LANA Buybacks ─── */}
        <section>
          <SectionHeader
            n="A"
            title="LANA buybacks"
            subtitle="Users sold LANA back to us. We paid them in EUR/GBP."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
            <BigCard
              label="LANA bought"
              value={formatLana(buybacks.totalLanaBought)}
              unit="LANA"
              color="text-primary"
              subtitle={`from ${buybacks.perCurrency.reduce((s, r) => s + r.txCount, 0)} transactions`}
            />
            <BigCard
              label="We paid"
              value={formatFiat(buybacks.paidEur)}
              subtitle="actually paid out (EUR equiv.)"
              color="text-foreground"
            />
            <BigCard
              label="Worth at time"
              value={formatFiat(buybacks.worthAtTimeEur)}
              subtitle="value when bought (gross, EUR equiv.)"
              color="text-foreground"
            />
            <BigCard
              label="Difference"
              value={formatFiat(buybacks.differenceEur)}
              subtitle={`= commission ${formatFiat(buybacks.commissionEur)} + outstanding ${formatFiat(buybacks.outstandingEur)}`}
              color="text-emerald-600"
            />
          </div>

          {/* Per-currency table for accuracy */}
          {buybacks.perCurrency.length > 0 && (
            <div className="mt-4 rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="text-left px-4 py-2 font-medium">Currency</th>
                      <th className="text-right px-4 py-2 font-medium">TX</th>
                      <th className="text-right px-4 py-2 font-medium">LANA</th>
                      <th className="text-right px-4 py-2 font-medium">Worth at time</th>
                      <th className="text-right px-4 py-2 font-medium">Net owed</th>
                      <th className="text-right px-4 py-2 font-medium">Paid</th>
                      <th className="text-right px-4 py-2 font-medium">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buybacks.perCurrency.map((r) => (
                      <tr key={r.currency} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-medium">{r.currency}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{r.txCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-primary font-medium">{formatLana(r.totalLana)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.worthAtTime, r.currency)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.netOwed, r.currency)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatFiat(r.paidOut, r.currency)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums font-semibold ${r.outstanding > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                          {formatFiat(r.outstanding, r.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* ─── Section B: Money flow / current state ─── */}
        <section>
          <SectionHeader
            n="B"
            title="Money in &amp; LANA on hand"
            subtitle="What flowed into our bank account vs. what's currently sitting in the buyback wallet."
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <BigCard
              label="Money received"
              value={formatFiat(moneyIn.totalReceivedEur)}
              subtitle={`from ${moneyIn.perCurrency.reduce((s, r) => s + r.batchCount, 0)} investor batches (EUR equiv.)`}
              color="text-foreground"
            />
            <BigCard
              label="LANA on buyback wallet"
              value={buybackWallet.balanceLana !== null ? formatLana(buybackWallet.balanceLana) : '—'}
              unit={buybackWallet.balanceLana !== null ? 'LANA' : ''}
              subtitle={buybackWallet.walletId ? `${buybackWallet.walletId.slice(0, 14)}…` : 'wallet not configured'}
              color="text-primary"
            />
            <BigCard
              label="LANA value (current rate)"
              value={buybackWallet.balanceEur !== null ? formatFiat(buybackWallet.balanceEur) : '—'}
              subtitle={`@ €${currentRates.EUR.toFixed(4)} / LANA`}
              color="text-foreground"
            />
          </div>

          {moneyIn.perCurrency.length > 0 && (
            <div className="mt-4 rounded-2xl border-2 border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="text-left px-4 py-2 font-medium">Currency</th>
                      <th className="text-right px-4 py-2 font-medium">Batches</th>
                      <th className="text-right px-4 py-2 font-medium">Total received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moneyIn.perCurrency.map((r) => (
                      <tr key={r.currency} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-medium">{r.currency}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{r.batchCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatFiat(r.totalAmount, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* ─── Section C: Fee earned ─── */}
        <section>
          <SectionHeader
            n="C"
            title="Fee earned"
            subtitle="Commission we kept on each buyback."
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <BigCard
              label="Total commission earned"
              value={formatFiat(feeEarned.totalCommissionEur)}
              subtitle="EUR equivalent across all currencies"
              color="text-emerald-600"
            />
            <BigCard
              label="Effective fee % (vs gross)"
              value={`${feeEarned.feeOverGrossPct.toFixed(1)}%`}
              subtitle="commission / worth-at-time"
              color="text-emerald-600"
            />
            <BigCard
              label="Effective fee % (vs paid out)"
              value={`${feeEarned.feeOverPaidPct.toFixed(1)}%`}
              subtitle="commission / actually paid"
              color="text-emerald-600"
            />
          </div>
        </section>

        <p className="text-[10px] text-muted-foreground text-center pt-4">
          Generated at {new Date(data.generatedAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
};

const BigCard = ({
  label, value, unit, subtitle, color,
}: { label: string; value: string; unit?: string; subtitle?: string; color: string }) => (
  <div className="rounded-2xl border-2 border-border bg-card p-5">
    <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className={`text-2xl font-bold font-mono ${color}`}>{value}</span>
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
    {subtitle && <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">{subtitle}</p>}
  </div>
);

const SectionHeader = ({ n, title, subtitle }: { n: string; title: string; subtitle?: string }) => (
  <div className="flex items-start gap-3">
    <div className="shrink-0 w-9 h-9 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">
      {n}
    </div>
    <div>
      <h2 className="text-lg font-semibold text-foreground" dangerouslySetInnerHTML={{ __html: title }} />
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  </div>
);

export default AdminOverview;
