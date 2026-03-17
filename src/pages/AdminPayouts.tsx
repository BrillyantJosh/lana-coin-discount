import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

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
  createdAt: string;
  totalPaid: number;
  remaining: number;
  payouts: PayoutEntry[];
}

interface UserWithSales {
  hexId: string;
  displayName: string;
  sales: SaleEntry[];
  payoutAccount?: {
    scheme: string;
    fields: Record<string, string>;
  } | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF',
};

const AdminPayouts = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
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
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);

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

      // Fetch payout accounts for each user
      const usersWithAccounts = await Promise.all(
        (data.users || []).map(async (user: UserWithSales) => {
          try {
            const accRes = await fetch(`/api/user/${user.hexId}/payout-account`);
            const accData = await accRes.json();
            return { ...user, payoutAccount: accData.payoutAccount };
          } catch {
            return { ...user, payoutAccount: null };
          }
        })
      );

      setUsers(usersWithAccounts);
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

  const openPayoutForm = async (sale: SaleEntry, userPayoutAccount: any) => {
    setPayoutFormSaleId(sale.id);
    setPayoutAmount(sale.remaining.toFixed(2));
    setPayoutNote('');

    // Pre-fill payout account from user's KIND 0 profile
    if (userPayoutAccount?.fields?.iban) {
      setPayoutAccount(userPayoutAccount.fields.iban);
    } else if (userPayoutAccount?.fields?.account_number) {
      setPayoutAccount(userPayoutAccount.fields.account_number);
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

  const verifyTx = async (txId: number) => {
    if (!session) return;
    setVerifyingId(txId);
    try {
      const res = await fetch(`/api/admin/verify-transaction/${txId}`, {
        method: 'POST',
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(`Transaction #${txId} verified`);
      await fetchPayouts();
    } catch (err: any) {
      toast.error(err.message || 'Failed to verify');
    } finally {
      setVerifyingId(null);
    }
  };

  const rejectTx = async (txId: number) => {
    if (!session) return;
    setRejectingId(txId);
    try {
      const res = await fetch(`/api/admin/reject-transaction/${txId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({ reason: 'Rejected by admin' }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(`Transaction #${txId} rejected`);
      setConfirmRejectId(null);
      await fetchPayouts();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject');
    } finally {
      setRejectingId(null);
    }
  };

  /** Resolve user display name: DB name → payout account holder → Anonymous */
  const resolveDisplayName = (user: UserWithSales): string => {
    if (user.displayName && user.displayName !== 'Anonymous') return user.displayName;
    if (user.payoutAccount?.fields?.account_holder) return user.payoutAccount.fields.account_holder;
    return user.displayName || 'Anonymous';
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

  // Sort sales within each user: unpaid/partial first, then fully paid
  // Sort users: those with remaining > 0 first, fully paid last
  const sortedUsers = users.map(user => {
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
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/admin" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            <span>Lana<span className="text-gold">.Discount</span></span>
            <span className="ml-2 text-xs font-mono bg-red-100 text-red-700 px-2 py-0.5 rounded-full uppercase tracking-wider">Admin</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              User Dashboard
            </Link>
            <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Admin
            </Link>
            <Link to="/admin/payouts" className="text-sm text-foreground font-medium">
              Payouts
            </Link>
            <Link to="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Settings
            </Link>
            <Link to="/admin/api-keys" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              API Keys
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
          <h1 className="text-3xl font-bold text-foreground">Payout Management</h1>
          <p className="text-muted-foreground">
            Record payout installments per user transaction. Unpaid transactions appear first.
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
                <div key={user.hexId} className={`rounded-2xl border-2 border-border bg-card overflow-hidden ${userRemaining <= 0 ? 'opacity-40' : ''}`}>
                  {/* User header */}
                  <button
                    onClick={() => setExpandedUser(isUserExpanded ? null : user.hexId)}
                    className="w-full px-6 py-4 text-left hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <svg
                        className={`h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform ${isUserExpanded ? 'rotate-90' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`font-bold ${userRemaining > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>{displayName}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {user.hexId.slice(0, 8)}...{user.hexId.slice(-6)}
                          </span>
                        </div>
                        {user.payoutAccount && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            <span className="font-mono">{user.payoutAccount.scheme}</span>
                            {user.payoutAccount.fields?.iban && (
                              <span className="font-mono ml-1">{user.payoutAccount.fields.iban}</span>
                            )}
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
                        const isPendingVerification = sale.status === 'pending_verification';
                        const isExternal = sale.source === 'external';

                        return (
                          <div key={sale.id} className={`border-b border-border/50 last:border-b-0 ${isFullyPaid ? 'opacity-40' : ''}`}>
                            {/* Sale row */}
                            <button
                              onClick={() => setExpandedSale(isSaleExpanded ? null : sale.id)}
                              className={`w-full px-6 py-3 text-left transition-colors ${isFullyPaid ? 'hover:bg-muted/10' : 'hover:bg-muted/20'}`}
                            >
                              <div className="flex items-center gap-4 pl-8">
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
                                {isExternal && !isPendingVerification && (
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-100 text-blue-600 flex-shrink-0">
                                    EXT
                                  </span>
                                )}

                                {/* Status badge */}
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex-shrink-0 ${
                                  isPendingVerification
                                    ? 'bg-orange-100 text-orange-700'
                                    : isFullyPaid
                                    ? 'bg-green-100 text-green-700'
                                    : sale.totalPaid > 0
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-red-100 text-red-700'
                                }`}>
                                  {isPendingVerification ? 'Pending' : isFullyPaid ? 'Paid' : sale.totalPaid > 0 ? 'Partial' : 'Unpaid'}
                                </span>

                                {/* Verify / Reject buttons for pending external transactions */}
                                {isPendingVerification && (
                                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                                    <span
                                      role="button"
                                      onClick={() => verifyTx(sale.id)}
                                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                                        verifyingId === sale.id ? 'bg-green-400 text-white' : 'bg-green-600 text-white hover:bg-green-700'
                                      }`}
                                    >
                                      {verifyingId === sale.id ? '...' : 'Verify'}
                                    </span>
                                    {confirmRejectId === sale.id ? (
                                      <>
                                        <span
                                          role="button"
                                          onClick={() => rejectTx(sale.id)}
                                          className="inline-flex items-center px-2.5 py-1 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors cursor-pointer"
                                        >
                                          {rejectingId === sale.id ? '...' : 'Confirm'}
                                        </span>
                                        <span
                                          role="button"
                                          onClick={() => setConfirmRejectId(null)}
                                          className="inline-flex items-center px-2 py-1 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                        >
                                          No
                                        </span>
                                      </>
                                    ) : (
                                      <span
                                        role="button"
                                        onClick={() => setConfirmRejectId(sale.id)}
                                        className="inline-flex items-center px-2.5 py-1 rounded-lg border border-red-200 text-red-600 text-xs font-bold hover:bg-red-50 transition-colors cursor-pointer"
                                      >
                                        Reject
                                      </span>
                                    )}
                                  </div>
                                )}

                                {/* Quick Pay button — only for verified/completed unpaid transactions */}
                                {!isFullyPaid && !isPendingVerification && (
                                  <span
                                    role="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedSale(sale.id);
                                      openPayoutForm(sale, user.payoutAccount);
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
                              <div className={`px-6 pb-4 pl-20 space-y-3 ${isFullyPaid ? 'opacity-100' : ''}`}>
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

                                {/* Add Payout button / form — only for verified unpaid */}
                                {sale.remaining > 0 && !isFullyPaid && !isPendingVerification && (
                                  <>
                                    {!isFormOpen ? (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openPayoutForm(sale, user.payoutAccount);
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
