import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';

interface PayoutEntry {
  id: number;
  payoutId: string;
  amount: number;
  currency: string;
  paidToAccount: string | null;
  reference: string | null;
  note: string | null;
  paidAt: string;
}

interface SaleEntry {
  id: number;
  lanaAmount: number;
  currency: string;
  exchangeRate: number;
  grossFiat: number;
  commissionPercent: number;
  commissionFiat: number;
  netFiat: number;
  txHash: string | null;
  status: string;
  source: 'internal' | 'external';
  verifiedAt: string | null;
  rpcVerified: boolean;
  rpcConfirmations: number;
  rpcBlockHeight: number | null;
  rpcVerifiedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  totalPaid: number;
  remaining: number;
  payouts: PayoutEntry[];
}

interface PaymentMethod {
  id?: string;
  scope?: string;
  country?: string;
  scheme?: string;
  currency?: string;
  label?: string;
  fields: Record<string, string>;
  verified?: boolean;
  primary?: boolean;
}

interface UserProfile {
  displayName?: string;
  fullName?: string;
  name?: string;
  display_name?: string;
  country?: string;
  location?: string;
  email?: string;
  phone?: string;
  phone_country_code?: string;
  payment_methods?: PaymentMethod[];
  // legacy
  bankName?: string;
  bankAccount?: string;
  bankSWIFT?: string;
  bankAddress?: string;
}

interface UserWithSales {
  hexId: string;
  displayName: string;
  sales: SaleEntry[];
  profile?: UserProfile | null;
  paymentMethods?: PaymentMethod[];
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF',
};

const AdminPayouts = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState<UserWithSales[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [expandedSale, setExpandedSale] = useState<number | null>(null);

  // Add payout form state
  const [payoutFormSaleId, setPayoutFormSaleId] = useState<number | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [payoutAccount, setPayoutAccount] = useState('');
  const [nextPayoutId, setNextPayoutId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedText(null), 2000);
  };

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchPayouts();
  }, [session, isAdmin]);

  const fetchPayouts = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/payouts', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Fetch full KIND 0 profile for each user (payment methods + names)
      const usersWithProfiles = await Promise.all(
        (data.users || []).map(async (user: UserWithSales) => {
          let profile: UserProfile | null = null;
          let paymentMethods: PaymentMethod[] = [];
          try {
            const profileRes = await fetch(`/api/user/${user.hexId}/profile`);
            const profileData = await profileRes.json();
            if (profileData.profile) {
              profile = profileData.profile;
              paymentMethods = profile?.payment_methods?.filter(
                (m: PaymentMethod) => m.scope === 'payout' || m.scope === 'both'
              ) || [];
            }
          } catch {}
          return { ...user, profile, paymentMethods };
        })
      );

      setUsers(usersWithProfiles);
    } catch (err) {
      console.error('Failed to fetch payouts:', err);
      toast.error('Failed to load payouts data');
    } finally {
      setLoading(false);
    }
  };

  const fetchNextPayoutId = async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/admin/next-payout-id', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.payoutId) setNextPayoutId(data.payoutId);
    } catch {
      setNextPayoutId(null);
    }
  };

  const openPayoutForm = async (sale: SaleEntry, user: UserWithSales) => {
    setPayoutFormSaleId(sale.id);
    setPayoutAmount(sale.remaining.toFixed(2));
    setPayoutNote('');

    // Pre-fill payout account from user's payment methods or legacy fields
    const pm = getPaymentMethodForCurrency(user, sale.currency);
    if (pm?.fields?.iban) {
      setPayoutAccount(pm.fields.iban);
    } else if (pm?.fields?.account_number) {
      setPayoutAccount(pm.fields.account_number);
    } else if (user.profile?.bankAccount) {
      setPayoutAccount(user.profile.bankAccount);
    } else {
      setPayoutAccount('');
    }

    // Fetch the next payout ID for preview
    await fetchNextPayoutId();
  };

  const submitPayout = async (sale: SaleEntry) => {
    if (!session || !payoutAmount) return;

    const amount = parseFloat(payoutAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Invalid amount');
      return;
    }

    if (amount > sale.remaining + 0.01) {
      toast.error(`Amount exceeds remaining (${sale.remaining.toFixed(2)} ${sale.currency})`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/payouts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({
          transactionId: sale.id,
          amount,
          currency: sale.currency,
          paidToAccount: payoutAccount || null,
          note: payoutNote || null,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      toast.success(`Payout ${data.payout.payoutId} recorded successfully!`);
      setPayoutFormSaleId(null);
      setNextPayoutId(null);

      // Refresh data
      await fetchPayouts();
    } catch (err: any) {
      toast.error(err.message || 'Failed to record payout');
    } finally {
      setSubmitting(false);
    }
  };

  /** Resolve user display name: DB name → KIND 0 display_name → KIND 0 name → Anonymous */
  const resolveDisplayName = (user: UserWithSales): string => {
    if (user.displayName && user.displayName !== 'Anonymous') return user.displayName;
    if (user.profile?.display_name) return user.profile.display_name;
    if (user.profile?.name) return user.profile.name;
    // Fallback to account holder from payment methods
    for (const pm of user.paymentMethods || []) {
      if (pm.fields?.account_holder) return pm.fields.account_holder;
    }
    return user.displayName || 'Anonymous';
  };

  /** Get full name (KIND 0 name field, different from display_name) */
  const getFullName = (user: UserWithSales): string | null => {
    const dn = user.profile?.display_name || user.displayName;
    const n = user.profile?.name;
    if (n && n !== dn) return n;
    return null;
  };

  /** Find relevant payment method for a currency */
  const getPaymentMethodForCurrency = (user: UserWithSales, currency: string): PaymentMethod | null => {
    const methods = user.paymentMethods || [];
    // Prefer method matching the transaction currency
    const match = methods.find(m => m.currency === currency);
    if (match) return match;
    // Fallback to primary method
    const primary = methods.find(m => m.primary);
    if (primary) return primary;
    // Fallback to first payout method
    return methods[0] || null;
  };

  /** Format payment method fields for display */
  const formatPaymentFields = (pm: PaymentMethod): string => {
    const parts: string[] = [];
    if (pm.fields.iban) parts.push(pm.fields.iban);
    else if (pm.fields.account_number) {
      if (pm.fields.sort_code) parts.push(`Sort: ${pm.fields.sort_code}`);
      if (pm.fields.routing_number) parts.push(`Routing: ${pm.fields.routing_number}`);
      parts.push(`Acc: ${pm.fields.account_number}`);
    }
    if (pm.fields.bic) parts.push(`BIC: ${pm.fields.bic}`);
    return parts.join(' · ');
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  const maskAccount = (account: string | null) => {
    if (!account) return '\u2014';
    if (account.length > 10) {
      return account.slice(0, 4) + '...' + account.slice(-4);
    }
    return account;
  };

  if (authLoading || !session || !isAdmin) return null;

  // Show all sales including pending_verification (external API sales)
  // Sort sales within each user: unpaid/partial first, then fully paid
  // Sort users: those with remaining > 0 first, fully paid last
  const sortedUsers = users.filter(user => user.sales.length > 0).map(user => {
    const totalOwed = user.sales.reduce((s, sale) => s + sale.netFiat, 0);
    const totalPaid = user.sales.reduce((s, sale) => s + sale.totalPaid, 0);
    const remaining = Math.round((totalOwed - totalPaid) * 100) / 100;
    return {
      ...user,
      _remaining: remaining,
      sales: [...user.sales].sort((a, b) => {
        if (a.status === 'paid' && b.status !== 'paid') return 1;
        if (a.status !== 'paid' && b.status === 'paid') return -1;
        return b.remaining - a.remaining;
      }),
    };
  }).sort((a, b) => {
    // Users with remaining > 0 first
    if (a._remaining > 0 && b._remaining <= 0) return -1;
    if (a._remaining <= 0 && b._remaining > 0) return 1;
    // Among same group, highest remaining first
    return b._remaining - a._remaining;
  });

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Payout Management</h1>
          <p className="text-muted-foreground">
            Record FIAT payout installments for verified transactions. Unpaid transactions appear first.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading payouts data...</p>
            </div>
          </div>
        ) : sortedUsers.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <p className="text-lg text-muted-foreground">No completed transactions yet.</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Transactions will appear here once users start selling LANA.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedUsers.map(user => {
              const isUserExpanded = expandedUser === user.hexId;
              const userTotalOwed = user.sales.reduce((s, sale) => s + sale.netFiat, 0);
              const userTotalPaid = user.sales.reduce((s, sale) => s + sale.totalPaid, 0);
              const userRemaining = Math.round((userTotalOwed - userTotalPaid) * 100) / 100;
              const mainCurrency = user.sales.length > 0 ? user.sales[0].currency : 'EUR';
              const sym = CURRENCY_SYMBOLS[mainCurrency] || mainCurrency;
              const displayName = resolveDisplayName(user);

              return (
                <div key={user.hexId} className={`rounded-2xl border-2 border-border bg-card overflow-hidden ${userRemaining <= 0 ? 'opacity-60' : ''}`}>
                  {/* User header */}
                  <button
                    onClick={() => setExpandedUser(isUserExpanded ? null : user.hexId)}
                    className="w-full px-4 sm:px-6 py-4 text-left hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-2 sm:gap-4">
                      <svg
                        className={`h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform ${isUserExpanded ? 'rotate-90' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-bold ${userRemaining > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>{displayName}</span>
                          {getFullName(user) && (
                            <span className="text-xs text-muted-foreground">({getFullName(user)})</span>
                          )}
                          <span className="text-xs text-muted-foreground font-mono">
                            {user.hexId.slice(0, 8)}...{user.hexId.slice(-6)}
                          </span>
                        </div>
                        {(() => {
                          const pm = getPaymentMethodForCurrency(user, mainCurrency);
                          if (pm) {
                            return (
                              <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                                <span className="text-primary/70 font-sans font-medium">{pm.scheme}</span>
                                {pm.currency && <span className="ml-1 font-sans">{pm.currency}</span>}
                                {pm.label && <span className="ml-1 font-sans text-muted-foreground/70">· {pm.label}</span>}
                                <span className="ml-1 cursor-pointer hover:text-foreground transition-colors" onClick={(e) => { e.stopPropagation(); copyToClipboard(formatPaymentFields(pm)); }} title="Click to copy">
                                  {formatPaymentFields(pm)} {copiedText === formatPaymentFields(pm) ? '✓' : '📋'}
                                </span>
                                {pm.fields?.account_holder && <span className="ml-1 font-sans">· {pm.fields.account_holder}</span>}
                              </div>
                            );
                          }
                          // Legacy fallback (bankName, bankSWIFT, bankAccount)
                          if (user.profile?.bankAccount) {
                            return (
                              <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                                {user.profile.bankName && <span className="font-sans">{user.profile.bankName} · </span>}
                                {user.profile.bankSWIFT && <span>SWIFT: {user.profile.bankSWIFT} · </span>}
                                <span className="cursor-pointer hover:text-foreground transition-colors" onClick={(e) => { e.stopPropagation(); copyToClipboard(user.profile!.bankAccount!); }} title="Click to copy">
                                  {user.profile.bankAccount} {copiedText === user.profile.bankAccount ? '✓' : '📋'}
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        {user.profile?.location && (
                          <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                            {user.profile.location}{user.profile.country ? ` (${user.profile.country})` : ''}
                          </div>
                        )}
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div className="text-xs text-muted-foreground">Remaining</div>
                        <div className={`font-mono font-bold text-xl ${userRemaining > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                          {sym}{userRemaining.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </button>

                  {/* User expanded — sales list */}
                  {isUserExpanded && (
                    <div className="border-t border-border">
                      {user.sales.map(sale => {
                        const isSaleExpanded = expandedSale === sale.id;
                        const progress = sale.netFiat > 0 ? Math.min((sale.totalPaid / sale.netFiat) * 100, 100) : 0;
                        const saleSym = CURRENCY_SYMBOLS[sale.currency] || sale.currency;
                        const isFormOpen = payoutFormSaleId === sale.id;
                        const isFullyPaid = sale.status === 'paid' || sale.remaining <= 0;
                        const isBroadcast = sale.status === 'broadcast';
                        const isExternal = sale.source === 'external';

                        return (
                          <div key={sale.id} className={`border-b border-border/50 last:border-b-0 ${isFullyPaid ? 'opacity-60' : ''}`}>
                            {/* Sale row */}
                            <button
                              onClick={() => setExpandedSale(isSaleExpanded ? null : sale.id)}
                              className={`w-full px-4 sm:px-6 py-3 text-left transition-colors ${isFullyPaid ? 'hover:bg-muted/10' : 'hover:bg-muted/20'}`}
                            >
                              <div className="flex items-center gap-2 sm:gap-4 pl-2 sm:pl-8">
                                <svg
                                  className={`h-3 w-3 text-muted-foreground flex-shrink-0 transition-transform ${isSaleExpanded ? 'rotate-90' : ''}`}
                                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>

                                <span className="text-sm text-muted-foreground w-24 flex-shrink-0">
                                  {formatDate(sale.createdAt)}
                                </span>

                                <span className={`font-mono text-sm font-bold flex-1 min-w-0 ${isFullyPaid ? 'text-muted-foreground' : 'text-foreground'}`}>
                                  {sale.lanaAmount.toLocaleString()} LANA
                                </span>

                                {/* Progress */}
                                <div className="hidden sm:block w-28 flex-shrink-0">
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

                                {/* Remaining — bold and clear */}
                                {!isFullyPaid ? (
                                  <div className="w-28 text-right flex-shrink-0">
                                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Remaining</div>
                                    <div className="font-mono text-sm font-bold text-amber-600">
                                      {saleSym}{sale.remaining.toFixed(2)}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="w-28 text-right flex-shrink-0">
                                    <div className="font-mono text-sm text-muted-foreground">
                                      {saleSym}{sale.netFiat.toFixed(2)}
                                    </div>
                                  </div>
                                )}

                                {/* Source badge */}
                                {isExternal && (
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-100 text-blue-600 flex-shrink-0">
                                    EXT
                                  </span>
                                )}

                                {/* Status badge */}
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex-shrink-0 ${
                                  isBroadcast
                                    ? 'bg-blue-100 text-blue-700'
                                    : isFullyPaid
                                    ? 'bg-green-100 text-green-700'
                                    : sale.totalPaid > 0
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-red-100 text-red-700'
                                }`}>
                                  {isBroadcast && (
                                    <div className="h-2 w-2 animate-spin rounded-full border border-blue-700 border-t-transparent" />
                                  )}
                                  {isBroadcast ? 'Broadcast' : isFullyPaid ? 'Paid' : sale.totalPaid > 0 ? 'Partial' : 'Unpaid'}
                                </span>

                                {/* RPC verification info */}
                                {sale.rpcVerified && sale.rpcBlockHeight && (
                                  <span className="text-[9px] font-mono text-green-600 flex-shrink-0">
                                    #{sale.rpcBlockHeight.toLocaleString()}
                                  </span>
                                )}

                                {/* Quick Pay button — only for RPC-verified, unpaid transactions */}
                                {!isFullyPaid && !isBroadcast && (
                                  <span
                                    role="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedSale(sale.id);
                                      openPayoutForm(sale, user);
                                    }}
                                    className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-bold hover:bg-green-700 transition-colors flex-shrink-0 cursor-pointer"
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                    </svg>
                                    Pay
                                  </span>
                                )}
                              </div>
                            </button>

                            {/* Sale expanded — payouts + add form */}
                            {isSaleExpanded && (
                              <div className={`px-4 sm:px-6 pb-4 pl-4 sm:pl-20 space-y-3 ${isFullyPaid ? 'opacity-100' : ''}`}>
                                {/* Payment method details for this currency (new or legacy) */}
                                {(() => {
                                  const pm = getPaymentMethodForCurrency(user, sale.currency);
                                  // Legacy fallback: bankName/bankSWIFT/bankAccount
                                  if (!pm && user.profile?.bankAccount) {
                                    return (
                                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs font-bold text-primary uppercase">Bank Transfer</span>
                                          <span className="text-[10px] text-amber-600 font-medium">Legacy format</span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
                                          {user.profile.bankName && (
                                            <div><span className="text-muted-foreground">Bank: </span><span className="font-medium text-foreground">{user.profile.bankName}</span></div>
                                          )}
                                          {user.profile.bankSWIFT && (
                                            <div><span className="text-muted-foreground">SWIFT/BIC: </span><span className="font-mono font-medium text-foreground">{user.profile.bankSWIFT}</span></div>
                                          )}
                                          {user.profile.bankAddress && (
                                            <div><span className="text-muted-foreground">Bank Address: </span><span className="font-medium text-foreground">{user.profile.bankAddress}</span></div>
                                          )}
                                          <div className="flex items-center gap-1">
                                            <span className="text-muted-foreground">Account: </span>
                                            <span className="font-mono font-medium text-foreground">{user.profile.bankAccount}</span>
                                            <button onClick={() => copyToClipboard(user.profile!.bankAccount!)} className="text-primary hover:text-primary/70 text-[10px] ml-1" title="Copy account">
                                              {copiedText === user.profile.bankAccount ? '✓' : 'Copy'}
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  }
                                  if (!pm) return null;
                                  return (
                                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-primary uppercase">{pm.scheme}</span>
                                        {pm.currency && <span className="text-xs text-muted-foreground">{pm.currency}</span>}
                                        {pm.label && <span className="text-xs text-muted-foreground">· {pm.label}</span>}
                                        {pm.verified && <span className="text-[10px] text-green-600 font-medium">✓ Verified</span>}
                                      </div>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
                                        {pm.fields.account_holder && (
                                          <div><span className="text-muted-foreground">Account Holder: </span><span className="font-mono font-medium text-foreground">{pm.fields.account_holder}</span></div>
                                        )}
                                        {pm.fields.iban && (
                                          <div className="flex items-center gap-1">
                                            <span className="text-muted-foreground">IBAN: </span>
                                            <span className="font-mono font-medium text-foreground">{pm.fields.iban}</span>
                                            <button onClick={() => copyToClipboard(pm.fields.iban)} className="text-primary hover:text-primary/70 text-[10px] ml-1" title="Copy IBAN">
                                              {copiedText === pm.fields.iban ? '✓' : 'Copy'}
                                            </button>
                                          </div>
                                        )}
                                        {pm.fields.bic && (
                                          <div><span className="text-muted-foreground">BIC/SWIFT: </span><span className="font-mono font-medium text-foreground">{pm.fields.bic}</span></div>
                                        )}
                                        {pm.fields.account_number && (
                                          <div className="flex items-center gap-1">
                                            <span className="text-muted-foreground">Account: </span>
                                            <span className="font-mono font-medium text-foreground">{pm.fields.account_number}</span>
                                            <button onClick={() => copyToClipboard(pm.fields.account_number)} className="text-primary hover:text-primary/70 text-[10px] ml-1" title="Copy account">
                                              {copiedText === pm.fields.account_number ? '✓' : 'Copy'}
                                            </button>
                                          </div>
                                        )}
                                        {pm.fields.sort_code && (
                                          <div><span className="text-muted-foreground">Sort Code: </span><span className="font-mono font-medium text-foreground">{pm.fields.sort_code}</span></div>
                                        )}
                                        {pm.fields.routing_number && (
                                          <div><span className="text-muted-foreground">Routing: </span><span className="font-mono font-medium text-foreground">{pm.fields.routing_number}</span></div>
                                        )}
                                        {pm.fields.clabe && (
                                          <div><span className="text-muted-foreground">CLABE: </span><span className="font-mono font-medium text-foreground">{pm.fields.clabe}</span></div>
                                        )}
                                        {pm.fields.pix_key && (
                                          <div><span className="text-muted-foreground">PIX: </span><span className="font-mono font-medium text-foreground">{pm.fields.pix_key}</span></div>
                                        )}
                                        {pm.fields.ifsc && (
                                          <div><span className="text-muted-foreground">IFSC: </span><span className="font-mono font-medium text-foreground">{pm.fields.ifsc}</span></div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Existing payouts */}
                                {sale.payouts.length > 0 && (
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
                                        {sale.payouts.map(p => (
                                          <tr key={p.id} className="hover:bg-muted/20">
                                            <td className="px-3 py-2 font-mono text-foreground font-medium">{p.payoutId}</td>
                                            <td className="px-3 py-2 text-foreground">{formatDate(p.paidAt)}</td>
                                            <td className="px-3 py-2 text-right font-mono font-medium text-green-600">
                                              +{saleSym}{p.amount.toFixed(2)}
                                            </td>
                                            <td className="px-3 py-2 font-mono text-muted-foreground hidden sm:table-cell">
                                              {maskAccount(p.paidToAccount)}
                                            </td>
                                            <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                                              {p.note || '\u2014'}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                {/* Broadcast warning — can't pay until RPC verified */}
                                {isBroadcast && (
                                  <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5">
                                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent flex-shrink-0" />
                                    <p className="text-xs text-blue-700 font-medium">
                                      Transaction broadcast to network — awaiting RPC confirmation before payout can be recorded.
                                    </p>
                                  </div>
                                )}

                                {/* Add Payout button / form */}
                                {sale.remaining > 0 && !isFullyPaid && !isBroadcast && (
                                  <>
                                    {!isFormOpen ? (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openPayoutForm(sale, user);
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                                      >
                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                        </svg>
                                        Record Payout ({saleSym}{sale.remaining.toFixed(2)} remaining)
                                      </button>
                                    ) : (
                                      <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                          <h5 className="text-sm font-bold text-foreground">Record Payout for TX #{sale.id}</h5>
                                          {nextPayoutId && (
                                            <div className="flex items-center gap-2">
                                              <span className="text-xs text-muted-foreground">Payout ID:</span>
                                              <span className="font-mono text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                                                {nextPayoutId}
                                              </span>
                                            </div>
                                          )}
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                          {/* Amount */}
                                          <div>
                                            <label className="text-xs text-muted-foreground font-medium mb-1 block">
                                              Amount ({sale.currency}) *
                                            </label>
                                            <input
                                              type="number"
                                              step="0.01"
                                              min="0.01"
                                              max={sale.remaining}
                                              value={payoutAmount}
                                              onChange={(e) => setPayoutAmount(e.target.value)}
                                              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                                              placeholder="0.00"
                                            />
                                            <p className="text-[10px] text-muted-foreground mt-0.5">
                                              Remaining: <span className="font-bold text-amber-600">{saleSym}{sale.remaining.toFixed(2)}</span>
                                            </p>
                                          </div>

                                          {/* Paid to account */}
                                          <div>
                                            <label className="text-xs text-muted-foreground font-medium mb-1 block">
                                              Paid to Account
                                            </label>
                                            <input
                                              type="text"
                                              value={payoutAccount}
                                              onChange={(e) => setPayoutAccount(e.target.value)}
                                              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                                              placeholder="IBAN / Account"
                                            />
                                          </div>

                                          {/* Note */}
                                          <div>
                                            <label className="text-xs text-muted-foreground font-medium mb-1 block">
                                              Note
                                            </label>
                                            <input
                                              type="text"
                                              value={payoutNote}
                                              onChange={(e) => setPayoutNote(e.target.value)}
                                              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                              placeholder="Optional note"
                                            />
                                          </div>
                                        </div>

                                        <div className="flex items-center gap-2">
                                          <button
                                            onClick={() => submitPayout(sale)}
                                            disabled={submitting || !payoutAmount}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                          >
                                            {submitting ? (
                                              <>
                                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                                Recording...
                                              </>
                                            ) : (
                                              <>
                                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                </svg>
                                                Record Payout
                                              </>
                                            )}
                                          </button>
                                          <button
                                            onClick={() => { setPayoutFormSaleId(null); setNextPayoutId(null); }}
                                            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </>
                                )}

                                {isFullyPaid && (
                                  <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Fully paid — {saleSym}{sale.totalPaid.toFixed(2)}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
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

export default AdminPayouts;
