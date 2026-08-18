import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  BRAND, LANDING, UI, OFFER,
  OFFER_STATUS_LABELS, ACQUISITION_STATUS_LABELS,
} from '@/copy';

/**
 * The counterparty's own view: what they have offered us, and what we have
 * acquired from them and still owe for.
 *
 * It is not an account. There is no balance here, because Lana.discount holds
 * nothing on anyone's behalf — every figure below is either a proposal that
 * binds nobody or a purchase price we owe from our own funds, with the date we
 * owe it by.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', CZK: 'CZK',
};

/**
 * The colour half of each status. The LABEL half lives in src/copy.ts, keyed
 * by the same status strings — which are a wire protocol (atomic SQL, the
 * public external API, KIND 30936 tag values) and are never renamed. Only what
 * a person reads changes.
 */
const ACQUISITION_TONE: Record<string, string> = {
  broadcast: 'bg-blue-100 text-blue-700',
  pending_verification: 'bg-blue-100 text-blue-700',
  completed: 'bg-amber-100 text-amber-700',
  paid: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  part_settled: 'bg-amber-100 text-amber-700',
};

const OFFER_TONE: Record<string, string> = {
  submitted: 'bg-blue-100 text-blue-700',
  under_review: 'bg-blue-100 text-blue-700',
  offered: 'bg-primary/10 text-primary',
  accepted: 'bg-green-100 text-green-700',
  settled: 'bg-green-100 text-green-700',
  declined: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  withdrawn: 'bg-muted text-muted-foreground',
};

/** Offers a counterparty can still act on, so the row offers a way back in. */
const LIVE_OFFER_STATUSES = ['submitted', 'under_review', 'offered', 'accepted'];

/** Wire field names are the server's; only the type name says what it is. */
interface Settlement {
  id: number;
  payoutId: string;
  amount: number;
  currency: string;
  paidToAccount: string | null;
  reference: string | null;
  note: string | null;
  paidAt: string;
}

interface Acquisition {
  id: number;
  lanaAmount: number;
  currency: string;
  netFiat: number;
  txHash: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  senderWallet: string;
  buybackWallet: string;
  /** Null on everything acquired before the offer model existed. */
  offerRef: string | null;
  settlementDueAt: string | null;
  totalPaid: number;
  remaining: number;
  payouts: Settlement[];
}

interface OfferSummary {
  offerRef: string;
  status: string;
  lanaAmount: number;
  currency: string;
  purchasePrice: number | null;
  settlementDueAt: string | null;
  offerExpiresAt: string | null;
  decisionReason: string | null;
  senderWallet: string;
  createdAt: string;
  transactionId: number | null;
}

/**
 * SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC; `new Date()` would read that as
 * local time and can land a settlement date on the wrong day.
 */
function parseSqliteUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const formatDate = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  return d ? d.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
};

const Dashboard = () => {
  const { session, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const [sales, setSales] = useState<Acquisition[]>([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const [offers, setOffers] = useState<OfferSummary[]>([]);
  const [expandedSale, setExpandedSale] = useState<number | null>(null);

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    fetchOwnRecord();
  }, [session]);

  const fetchOwnRecord = async () => {
    if (!session) return;
    setSalesLoading(true);
    try {
      // Two different things: proposals that bind nobody, and acquisitions we
      // owe for. They are fetched together but never added together.
      const [salesRes, offersRes] = await Promise.all([
        fetch(`/api/user/${session.nostrHexId}/sales`),
        fetch(`/api/acquisitions/mine/${session.nostrHexId}`),
      ]);
      const salesData = await salesRes.json();
      setSales(salesData.sales || []);
      try {
        const offersData = await offersRes.json();
        setOffers(offersData.offers || []);
      } catch (err) {
        console.error('Failed to fetch offers:', err);
      }
    } catch (err) {
      console.error('Failed to fetch acquisitions:', err);
    } finally {
      setSalesLoading(false);
    }
  };

  if (!session) return null;

  const displayName = session.profileDisplayName || session.profileName || 'User';
  const shortHex = session.nostrHexId.slice(0, 8) + '...' + session.nostrHexId.slice(-8);

  // Aggregates
  const totalLanaAcquired = sales.reduce((s, sale) => s + sale.lanaAmount, 0);
  const totalOwed = sales.reduce((s, sale) => s + sale.netFiat, 0);
  const totalSettled = sales.reduce((s, sale) => s + sale.totalPaid, 0);
  const totalOutstanding = sales.reduce((s, sale) => s + sale.remaining, 0);
  const mainCurrency = sales.length > 0 ? sales[0].currency : 'EUR';
  const sym = CURRENCY_SYMBOLS[mainCurrency] || mainCurrency;

  /**
   * Part-settlement is not a stored status: the row still says what it says
   * while some of the purchase price has been paid, so it is derived here.
   */
  const acquisitionBadge = (sale: Acquisition) => {
    const key = sale.status !== 'paid' && sale.status !== 'failed' && sale.totalPaid > 0 && sale.remaining > 0
      ? 'part_settled'
      : sale.status;
    return {
      label: ACQUISITION_STATUS_LABELS[key] || key,
      tone: ACQUISITION_TONE[key] || 'bg-muted text-muted-foreground',
      spinning: key === 'broadcast',
    };
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between gap-3 h-14 sm:h-16">
          <a href="/" className="flex min-w-0 items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 shrink-0 dark:invert" />
            <span className="truncate">Lana<span className="text-gold">.Discount</span></span>
          </a>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            {isAdmin && (
              <Link
                to="/admin"
                className="rounded-lg bg-red-600 px-2.5 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-bold text-white uppercase tracking-wider hover:bg-red-700 transition-colors"
              >
                Admin
              </Link>
            )}
            <div className="hidden sm:flex min-w-0 items-center gap-2">
              {session.profilePicture && (
                <img src={session.profilePicture} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
              )}
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
            </div>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors whitespace-nowrap"
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
          <p className="text-muted-foreground text-sm font-mono break-all">{shortHex}</p>
          {session.walletId && (
            <p className="text-muted-foreground text-xs break-all">
              Wallet: <span className="font-mono">{session.walletId}</span>
            </p>
          )}
        </div>

        {/* Submit an offer */}
        <div className="max-w-4xl mx-auto">
          <Link to="/offer" className="group relative block rounded-2xl border-2 border-border bg-card p-6 sm:p-8 hover:border-primary transition-colors cursor-pointer">
            <div className="space-y-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center">
                <svg className="h-7 w-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground">{UI.primaryAction}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {UI.intro} Each proposal is reviewed on its own merits; submitting one obliges neither side to
                anything.
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
        </div>

        {/* ============ OFFERS ============ */}
        {offers.length > 0 && (
          <div className="max-w-4xl mx-auto mt-16">
            <h2 className="text-2xl font-bold text-foreground">{OFFER.myOffersTitle}</h2>
            <p className="mt-1.5 mb-6 text-sm text-muted-foreground leading-relaxed">{OFFER.myOffersIntro}</p>

            <div className="space-y-3">
              {offers.map(o => {
                const tone = OFFER_TONE[o.status] || 'bg-muted text-muted-foreground';
                const label = OFFER_STATUS_LABELS[o.status] || o.status;
                const offerSym = CURRENCY_SYMBOLS[o.currency] || o.currency;
                const live = LIVE_OFFER_STATUSES.includes(o.status);
                return (
                  <div key={o.offerRef} className="rounded-2xl border-2 border-border bg-card px-4 sm:px-5 py-4">
                    <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                      {/* Reference + date */}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-mono text-sm font-bold text-foreground truncate">{o.offerRef}</span>
                          <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${tone}`}>
                            {label}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span className="whitespace-nowrap">{formatDate(o.createdAt)}</span>
                          <span className="font-mono whitespace-nowrap">{o.lanaAmount.toLocaleString()} LANA</span>
                          {o.settlementDueAt && (
                            <span className="whitespace-nowrap">{OFFER.offeredDueLabel} {formatDate(o.settlementDueAt)}</span>
                          )}
                        </div>
                        {o.decisionReason && (
                          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{o.decisionReason}</p>
                        )}
                      </div>

                      {/* Purchase price — never shrinks, never wraps. */}
                      <div className="flex-shrink-0 whitespace-nowrap text-right">
                        {o.purchasePrice !== null ? (
                          <>
                            <div className="font-mono text-sm font-bold text-primary">
                              {offerSym}{o.purchasePrice.toFixed(2)}
                            </div>
                            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                              {OFFER.offeredPriceLabel}
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>

                    {live && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <Link to="/offer" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:gap-2 transition-all">
                          Open
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============ COMPLETED TREASURY ACQUISITIONS ============ */}
        <div className="max-w-4xl mx-auto mt-16">
          <h2 className="text-2xl font-bold text-foreground mb-6">{UI.history}</h2>

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
              <p className="text-muted-foreground font-medium">Nothing acquired from you yet</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Once we acquire LANA from you, it appears here with the purchase price we owe and the date we
                owe it by.
              </p>
            </div>
          ) : (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{OFFER.completedAcquiredLabel}</div>
                  <div className="text-lg font-bold font-mono text-foreground mt-1 truncate">
                    {totalLanaAcquired.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Purchase prices</div>
                  <div className="text-lg font-bold font-mono text-foreground mt-1 truncate">
                    {sym}{totalOwed.toFixed(2)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Settled</div>
                  <div className="text-lg font-bold font-mono text-green-600 mt-1 truncate">
                    {sym}{totalSettled.toFixed(2)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Outstanding</div>
                  <div className="text-lg font-bold font-mono text-amber-600 mt-1 truncate">
                    {sym}{totalOutstanding.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Acquisitions */}
              <div className="space-y-3">
                {sales.map(sale => {
                  const isExpanded = expandedSale === sale.id;
                  const progress = sale.netFiat > 0 ? Math.min((sale.totalPaid / sale.netFiat) * 100, 100) : 0;
                  const saleSym = CURRENCY_SYMBOLS[sale.currency] || sale.currency;
                  const badge = acquisitionBadge(sale);

                  return (
                    <div key={sale.id} className="rounded-2xl border-2 border-border bg-card overflow-hidden transition-colors">
                      <button
                        onClick={() => setExpandedSale(isExpanded ? null : sale.id)}
                        className="w-full px-4 sm:px-5 py-4 text-left hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
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

                          {/* What we acquired */}
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-sm font-bold text-foreground truncate block">
                              {sale.lanaAmount.toLocaleString()} LANA
                            </span>
                            {sale.settlementDueAt && (
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {OFFER.offeredDueLabel} {formatDate(sale.settlementDueAt)}
                              </span>
                            )}
                          </div>

                          {/* How much of the price is settled */}
                          <div className="hidden sm:block w-32 flex-shrink-0">
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  progress >= 100 ? 'bg-green-500' : progress > 0 ? 'bg-amber-500' : 'bg-blue-300'
                                }`}
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5 text-center whitespace-nowrap">
                              {saleSym}{sale.totalPaid.toFixed(2)} / {saleSym}{sale.netFiat.toFixed(2)}
                            </div>
                          </div>

                          {/* Purchase price */}
                          <div className="w-24 text-right flex-shrink-0 whitespace-nowrap">
                            <span className="font-mono text-sm font-bold text-primary">
                              {saleSym}{sale.netFiat.toFixed(2)}
                            </span>
                          </div>

                          {/* Status */}
                          <div className="flex-shrink-0">
                            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded whitespace-nowrap ${badge.tone}`}>
                              {badge.spinning && (
                                <span className="inline-block h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
                              )}
                              {badge.label}
                            </span>
                          </div>
                        </div>
                      </button>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div className="border-t border-border bg-muted/10 px-4 sm:px-5 py-4 space-y-4">
                          {/* What was agreed. No reference rate and no
                              percentage: the price is the price we agreed for
                              this acquisition, not a formula anyone can apply
                              to the next one. */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div className="min-w-0">
                              <span className="text-muted-foreground">{OFFER.offeredPriceLabel}</span>
                              <div className="font-mono font-bold text-primary truncate">{saleSym}{sale.netFiat.toFixed(2)}</div>
                            </div>
                            <div className="min-w-0">
                              <span className="text-muted-foreground">Settled</span>
                              <div className="font-mono font-medium text-green-600 truncate">{saleSym}{sale.totalPaid.toFixed(2)}</div>
                            </div>
                            <div className="min-w-0">
                              <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                              <div className="font-medium text-foreground truncate">{formatDate(sale.settlementDueAt)}</div>
                            </div>
                            <div className="min-w-0">
                              <span className="text-muted-foreground">{OFFER.transferHashLabel}</span>
                              <div className="font-mono text-foreground truncate" title={sale.txHash || ''}>
                                {sale.txHash ? sale.txHash.slice(0, 12) + '...' + sale.txHash.slice(-8) : '—'}
                              </div>
                            </div>
                          </div>

                          {sale.offerRef && (
                            <div className="text-xs text-muted-foreground">
                              {OFFER.reviewRef}: <span className="font-mono font-medium text-foreground">{sale.offerRef}</span>
                            </div>
                          )}

                          {/* Settlements against this purchase price */}
                          <div>
                            <h4 className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">
                              {UI.settlement} ({sale.payouts.length})
                            </h4>

                            {sale.payouts.length > 0 ? (
                              <div className="rounded-lg border border-border overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/40">
                                    <tr>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Reference</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Date</th>
                                      <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Amount</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Paid to</th>
                                      <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Note</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border">
                                    {sale.payouts.map(settlement => (
                                      <tr key={settlement.id} className="hover:bg-muted/20">
                                        <td className="px-3 py-2 font-mono text-foreground font-medium whitespace-nowrap">{settlement.payoutId}</td>
                                        <td className="px-3 py-2 text-foreground whitespace-nowrap">{formatDate(settlement.paidAt)}</td>
                                        <td className="px-3 py-2 text-right font-mono font-medium text-green-600 whitespace-nowrap">
                                          +{saleSym}{settlement.amount.toFixed(2)}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-muted-foreground hidden sm:table-cell">
                                          {settlement.paidToAccount
                                            ? (settlement.paidToAccount.length > 10
                                                ? settlement.paidToAccount.slice(0, 4) + '...' + settlement.paidToAccount.slice(-4)
                                                : settlement.paidToAccount)
                                            : '—'}
                                        </td>
                                        <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                                          {settlement.note || '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                                <p className="text-xs text-muted-foreground">
                                  Nothing settled yet — the whole purchase price is outstanding.
                                </p>
                              </div>
                            )}

                            <div className="flex flex-wrap items-center justify-between gap-2 mt-3 px-1">
                              <div className="text-xs text-muted-foreground">
                                Settled: <span className="font-mono font-bold text-green-600">{saleSym}{sale.totalPaid.toFixed(2)}</span>
                                {' / '}
                                <span className="font-mono font-bold text-foreground">{saleSym}{sale.netFiat.toFixed(2)}</span>
                              </div>
                              {sale.remaining > 0 && (
                                <div className="text-xs">
                                  Outstanding: <span className="font-mono font-bold text-amber-600">{saleSym}{sale.remaining.toFixed(2)}</span>
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

              <p className="mt-6 text-xs text-muted-foreground leading-relaxed">
                {OFFER.settlementTiming}{' '}
                <Link to="/obligations" className="font-medium underline hover:text-foreground transition-colors">
                  {LANDING.settlementsLink}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        {BRAND} — {LANDING.heroEyebrow}
      </footer>
    </div>
  );
};

export default Dashboard;
