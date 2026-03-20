import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';

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
  senderWalletId: string | null;
  buybackWalletId: string | null;
  status: string;
  source: 'internal' | 'external';
  verifiedAt: string | null;
  createdAt: string;
}

interface UserWithSales {
  hexId: string;
  displayName: string;
  sales: SaleEntry[];
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF',
};

const AdminVerifyTx = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState<UserWithSales[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
  const [copiedHash, setCopiedHash] = useState<number | null>(null);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchPending();
  }, [session, isAdmin]);

  const fetchPending = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/payouts', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Filter only users who have pending_verification sales
      const filtered = (data.users || [])
        .map((user: UserWithSales) => ({
          ...user,
          sales: user.sales.filter((s: SaleEntry) => s.status === 'pending_verification'),
        }))
        .filter((user: UserWithSales) => user.sales.length > 0);

      setUsers(filtered);
    } catch (err) {
      console.error('Failed to fetch pending verifications:', err);
      toast.error('Failed to load pending verifications');
    } finally {
      setLoading(false);
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
      toast.success(`Transaction #${txId} verified ✓`);
      await fetchPending();
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
      await fetchPending();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject');
    } finally {
      setRejectingId(null);
    }
  };

  const copyToClipboard = (text: string, txId: number) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(txId);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  const truncateHash = (hash: string | null) => {
    if (!hash) return '—';
    if (hash.length > 20) return hash.slice(0, 10) + '...' + hash.slice(-8);
    return hash;
  };

  const truncateWallet = (wallet: string | null) => {
    if (!wallet) return '—';
    if (wallet.length > 16) return wallet.slice(0, 8) + '...' + wallet.slice(-6);
    return wallet;
  };

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav active="verify-tx" />

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Transaction Verification</h1>
          <p className="text-muted-foreground">
            Verify that LANA coins were received on the buyback wallet before approving transactions.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading pending verifications...</p>
            </div>
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <div className="flex flex-col items-center gap-3">
              <svg className="h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-lg text-muted-foreground">No transactions pending verification</p>
              <p className="text-sm text-muted-foreground/70">
                All external transactions have been reviewed. New ones will appear here automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="rounded-xl border border-orange-200 bg-orange-50 px-5 py-3 flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                <svg className="h-4 w-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <span className="font-bold text-orange-800">
                  {users.reduce((sum, u) => sum + u.sales.length, 0)} transaction{users.reduce((sum, u) => sum + u.sales.length, 0) !== 1 ? 's' : ''}
                </span>
                <span className="text-orange-700"> awaiting verification from </span>
                <span className="font-bold text-orange-800">{users.length} user{users.length !== 1 ? 's' : ''}</span>
              </div>
            </div>

            {users.map(user => {
              const isUserExpanded = expandedUser === user.hexId;

              return (
                <div key={user.hexId} className="rounded-2xl border-2 border-orange-200 bg-card overflow-hidden">
                  {/* User header */}
                  <button
                    onClick={() => setExpandedUser(isUserExpanded ? null : user.hexId)}
                    className="w-full px-4 sm:px-6 py-4 text-left hover:bg-orange-50/50 transition-colors"
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
                          <span className="font-bold text-foreground">{user.displayName}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {user.hexId.slice(0, 8)}...{user.hexId.slice(-6)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700">
                          {user.sales.length} pending
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Expanded — transaction details */}
                  {isUserExpanded && (
                    <div className="border-t border-orange-200">
                      {user.sales.map(sale => {
                        const sym = CURRENCY_SYMBOLS[sale.currency] || sale.currency;

                        return (
                          <div key={sale.id} className="border-b border-border/50 last:border-b-0 px-4 sm:px-6 py-4 sm:pl-14">
                            {/* Transaction details grid */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 mb-4">
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-20">TX #</span>
                                  <span className="font-mono text-sm font-bold text-foreground">{sale.id}</span>
                                  <span className="text-xs text-muted-foreground">{formatDate(sale.createdAt)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-20">TX Hash</span>
                                  <span className="font-mono text-xs text-foreground">{truncateHash(sale.txHash)}</span>
                                  {sale.txHash && (
                                    <button
                                      onClick={() => copyToClipboard(sale.txHash!, sale.id)}
                                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                                    >
                                      {copiedHash === sale.id ? '✓ Copied' : 'Copy'}
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-20">Sender</span>
                                  <span className="font-mono text-xs text-foreground">{truncateWallet(sale.senderWalletId)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-20">Buyback</span>
                                  <span className="font-mono text-xs text-foreground">{truncateWallet(sale.buybackWalletId)}</span>
                                </div>
                              </div>

                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-24">LANA Amount</span>
                                  <span className="font-mono text-sm font-bold text-foreground">{sale.lanaAmount.toLocaleString()} LANA</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-24">Exchange Rate</span>
                                  <span className="font-mono text-xs text-foreground">{sale.exchangeRate}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-24">Gross</span>
                                  <span className="font-mono text-xs text-foreground">{sym}{sale.grossFiat.toFixed(2)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-24">Commission</span>
                                  <span className="font-mono text-xs text-foreground">{sale.commissionPercent}% = {sym}{sale.commissionFiat.toFixed(2)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground w-24">Net Payout</span>
                                  <span className="font-mono text-sm font-bold text-green-600">{sym}{sale.netFiat.toFixed(2)}</span>
                                </div>
                              </div>
                            </div>

                            {/* Action buttons */}
                            <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                              <button
                                onClick={() => verifyTx(sale.id)}
                                disabled={verifyingId === sale.id}
                                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                                  verifyingId === sale.id
                                    ? 'bg-green-400 text-white cursor-not-allowed'
                                    : 'bg-green-600 text-white hover:bg-green-700'
                                }`}
                              >
                                {verifyingId === sale.id ? (
                                  <>
                                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                    Verifying...
                                  </>
                                ) : (
                                  <>
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    </svg>
                                    Verify — LANA Received
                                  </>
                                )}
                              </button>

                              {confirmRejectId === sale.id ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-red-600 font-medium">Are you sure?</span>
                                  <button
                                    onClick={() => rejectTx(sale.id)}
                                    disabled={rejectingId === sale.id}
                                    className="inline-flex items-center px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors disabled:opacity-50"
                                  >
                                    {rejectingId === sale.id ? 'Rejecting...' : 'Yes, Reject'}
                                  </button>
                                  <button
                                    onClick={() => setConfirmRejectId(null)}
                                    className="inline-flex items-center px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setConfirmRejectId(sale.id)}
                                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-bold hover:bg-red-50 transition-colors"
                                >
                                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                  Reject
                                </button>
                              )}
                            </div>
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

export default AdminVerifyTx;
