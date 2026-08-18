import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav, { OFFERS_COUNT_EVENT } from '@/components/AdminNav';
import { CLASS_LABELS, type WalletClass } from '../../server/lib/treasuryMandate';

/**
 * WHERE A PERSON DECIDES.
 *
 * The treasury mandate answers most proposals on its own — inside the cap it
 * makes a purchase offer, outside the currency or the class it declines. What
 * it will not do is guess: an offer above the automatic ceiling, or one it
 * could not put a value on, is parked in `under_review` and lands here.
 *
 * That parking is the compliance argument made visible. The framework requires
 * that transactions outside normal thresholds get elevated approval (§13) and
 * that each proposed acquisition is genuinely decided rather than executed
 * (§3 stage 5) — so this screen has to be able to say no, and to say why.
 *
 * The interaction is deliberately the same as AdminVerifyTx: per-row busy
 * state, an inline two-step confirm before anything destructive, a toast, a
 * refetch. One difference on purpose — declining asks for a real reason and
 * refuses to send an empty one, because the counterparty reads it. The verify
 * screen hardcodes "Rejected by admin", which tells nobody anything.
 */

interface QueueOffer {
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
  // Admin-only additions to the seller's view of the same offer.
  userHexId: string;
  walletClass: WalletClass;
  grossFiat: number | null;
  indicativePrice: number | null;
  mandateCode: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF',
};

/**
 * Why this proposal needed a person. The mandate stores the code on the offer,
 * so the reason a decision was escalated survives long after the settings that
 * caused it have been changed.
 */
const WHY_HERE: Record<string, { label: string; detail: string }> = {
  ABOVE_AUTO_CAP: {
    label: 'Above the automatic ceiling',
    detail: 'Larger than the auto-cap set for this currency and wallet class, so the mandate would not take it on its own.',
  },
  MANUAL_ONLY: {
    label: 'Manual only',
    detail: 'This currency and wallet class has its auto-cap set to 0 — nothing here is ever automatic.',
  },
  UNMEASURABLE: {
    label: 'No reference value',
    detail: 'We could not put a fiat value on this offer, so there was nothing to weigh against the ceiling.',
  },
};

const AdminOffers = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [offers, setOffers] = useState<QueueOffer[]>([]);
  const [loading, setLoading] = useState(true);

  // One row at a time may be mid-decision; the ref doubles as the busy flag so
  // two cards can never both be spinning against the same admin session.
  const [busyRef, setBusyRef] = useState<string | null>(null);

  // Counteroffer: an open price field on one row.
  const [counterRef, setCounterRef] = useState<string | null>(null);
  const [counterPrice, setCounterPrice] = useState('');

  // Decline: the two-step confirm, plus the reason the counterparty will read.
  const [declineRef, setDeclineRef] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchQueue();
  }, [session, isAdmin]);

  const fetchQueue = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/acquisitions/admin/queue', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const list: QueueOffer[] = data.offers || [];
      setOffers(list);
      // Keep the nav badge honest the instant a decision changes the count.
      window.dispatchEvent(new CustomEvent(OFFERS_COUNT_EVENT, { detail: list.length }));
    } catch (err: any) {
      console.error('Failed to load acquisition offers:', err);
      toast.error(err.message || 'Failed to load acquisition offers');
    } finally {
      setLoading(false);
    }
  };

  /** Accept, counter and decline are one endpoint and one decision. */
  const decide = async (
    ref: string,
    action: 'accept' | 'counter' | 'decline',
    body: { purchasePrice?: number; reason?: string } = {},
  ) => {
    if (!session) return;
    setBusyRef(ref);
    try {
      const res = await fetch(`/api/acquisitions/admin/${ref}/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (action === 'decline') {
        toast.success(`${ref} declined`);
      } else {
        const price = data.offer?.purchasePrice;
        const sym = CURRENCY_SYMBOLS[data.offer?.currency] || data.offer?.currency || '';
        toast.success(
          action === 'counter'
            ? `${ref} — counteroffer of ${sym}${Number(price).toFixed(2)} sent`
            : `${ref} — purchase offer of ${sym}${Number(price).toFixed(2)} sent`,
        );
      }

      setCounterRef(null);
      setCounterPrice('');
      setDeclineRef(null);
      setDeclineReason('');
      await fetchQueue();
    } catch (err: any) {
      toast.error(err.message || 'Decision failed');
    } finally {
      setBusyRef(null);
    }
  };

  const submitCounter = (offer: QueueOffer) => {
    const price = Number(counterPrice);
    if (!Number.isFinite(price) || price <= 0) {
      toast.error('Enter the purchase price you are offering');
      return;
    }
    decide(offer.offerRef, 'counter', { purchasePrice: price });
  };

  const submitDecline = (offer: QueueOffer) => {
    const reason = declineReason.trim();
    // The server refuses an empty reason too — this is the friendlier half of
    // the same rule, not a substitute for it.
    if (!reason) {
      toast.error('A reason is required — the counterparty reads it');
      return;
    }
    decide(offer.offerRef, 'decline', { reason });
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('sl-SI', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const money = (value: number | null, currency: string) => {
    if (value === null || value === undefined) return '—';
    const sym = CURRENCY_SYMBOLS[currency] || currency;
    return `${sym}${value.toFixed(2)}`;
  };

  const truncate = (value: string | null, head = 8, tail = 6) => {
    if (!value) return '—';
    if (value.length <= head + tail + 3) return value;
    return `${value.slice(0, head)}...${value.slice(-tail)}`;
  };

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-5xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Acquisition Offers</h1>
          <p className="text-muted-foreground">
            Proposals the treasury mandate would not decide on its own. Accept at our standard discount,
            counter with a price of your own, or decline with a reason the counterparty will read.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading acquisition offers...</p>
            </div>
          </div>
        ) : offers.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <div className="flex flex-col items-center gap-3">
              <svg className="h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-lg text-muted-foreground">Nothing is waiting for a decision</p>
              <p className="text-sm text-muted-foreground/70">
                Offers the mandate cannot settle by itself appear here. Everything else was already
                priced or declined automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="min-w-0">
                <span className="font-bold text-amber-800">
                  {offers.length} offer{offers.length !== 1 ? 's' : ''}
                </span>
                <span className="text-amber-700"> under treasury review — oldest first</span>
              </div>
              <button
                onClick={fetchQueue}
                className="ml-auto flex-shrink-0 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 transition-colors"
              >
                Refresh
              </button>
            </div>

            {offers.map(offer => {
              const busy = busyRef === offer.offerRef;
              const why = offer.mandateCode ? WHY_HERE[offer.mandateCode] : undefined;
              const isCountering = counterRef === offer.offerRef;
              const isDeclining = declineRef === offer.offerRef;

              return (
                <div key={offer.offerRef} className="rounded-2xl border-2 border-amber-200 bg-card overflow-hidden">
                  {/* Header — reference, when it arrived, why it is here */}
                  <div className="px-4 sm:px-6 py-3 border-b border-amber-200 bg-amber-50/40 flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm font-bold text-foreground flex-shrink-0">{offer.offerRef}</span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">{formatDate(offer.createdAt)}</span>
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 flex-shrink-0">
                      Under Treasury Review
                    </span>
                    {why && (
                      <span
                        title={why.detail}
                        className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground flex-shrink-0"
                      >
                        {why.label}
                      </span>
                    )}
                  </div>

                  <div className="px-4 sm:px-6 py-4 space-y-4">
                    {/* Who and what */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-24 flex-shrink-0">Counterparty</span>
                          <span className="font-mono text-xs text-foreground truncate" title={offer.userHexId}>
                            {truncate(offer.userHexId)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-24 flex-shrink-0">From wallet</span>
                          <span className="font-mono text-xs text-foreground truncate" title={offer.senderWallet}>
                            {truncate(offer.senderWallet)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-24 flex-shrink-0">Wallet class</span>
                          <span className="text-xs font-medium text-foreground truncate">
                            {CLASS_LABELS[offer.walletClass] || offer.walletClass}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-28 flex-shrink-0">LANA offered</span>
                          <span className="font-mono text-sm font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                            {offer.lanaAmount.toLocaleString()} LANA
                          </span>
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-28 flex-shrink-0">Reference gross</span>
                          <span className="font-mono text-xs text-foreground flex-shrink-0 whitespace-nowrap">
                            {money(offer.grossFiat, offer.currency)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-28 flex-shrink-0">Indicative price</span>
                          <span className="font-mono text-sm font-bold text-green-600 flex-shrink-0 whitespace-nowrap">
                            {money(offer.indicativePrice, offer.currency)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {why && (
                      <p className="text-xs text-muted-foreground border-l-2 border-amber-200 pl-3">{why.detail}</p>
                    )}

                    {/* Decision */}
                    <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border/30">
                      <button
                        onClick={() => decide(offer.offerRef, 'accept')}
                        disabled={busy}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                          busy ? 'bg-green-400 text-white cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700'
                        }`}
                      >
                        {busy ? (
                          <>
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            Deciding...
                          </>
                        ) : (
                          <>
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Accept at {money(offer.indicativePrice, offer.currency)}
                          </>
                        )}
                      </button>

                      {!isCountering && (
                        <button
                          onClick={() => {
                            setDeclineRef(null);
                            setCounterRef(offer.offerRef);
                            // Start from our own number so a counteroffer is an
                            // edit of the price, not a blank page.
                            setCounterPrice(offer.indicativePrice !== null ? String(offer.indicativePrice) : '');
                          }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-bold text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                        >
                          Counteroffer
                        </button>
                      )}

                      {!isDeclining ? (
                        <button
                          onClick={() => { setCounterRef(null); setDeclineRef(offer.offerRef); setDeclineReason(''); }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-bold hover:bg-red-50 transition-colors disabled:opacity-50"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Decline
                        </button>
                      ) : (
                        <span className="text-xs text-red-600 font-medium">Declining — give a reason below</span>
                      )}
                    </div>

                    {/* Counteroffer — a price of our own; the server records the
                        real discount it implies against the reference gross. */}
                    {isCountering && (
                      <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3 space-y-3">
                        <label className="block text-xs font-bold text-foreground">
                          Counteroffer — Lana.discount Purchase Offer ({offer.currency})
                        </label>
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={counterPrice}
                            onChange={e => setCounterPrice(e.target.value)}
                            placeholder="0.00"
                            className="w-40 flex-shrink-0 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          <button
                            onClick={() => submitCounter(offer)}
                            disabled={busy || !counterPrice}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                          >
                            {busy ? 'Sending...' : 'Send counteroffer'}
                          </button>
                          <button
                            onClick={() => { setCounterRef(null); setCounterPrice(''); }}
                            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Against a reference gross of {money(offer.grossFiat, offer.currency)}. Whatever you enter
                          becomes the discount recorded on this acquisition.
                        </p>
                      </div>
                    )}

                    {/* Decline — the reason is not optional, and it is not
                        boilerplate: it is what the counterparty is told. */}
                    {isDeclining && (
                      <div className="rounded-xl border-2 border-red-200 bg-red-50 p-3 space-y-3">
                        <label className="block text-xs font-bold text-red-800">
                          Why are we not acquiring this? The counterparty sees this text.
                        </label>
                        <textarea
                          value={declineReason}
                          onChange={e => setDeclineReason(e.target.value)}
                          rows={2}
                          placeholder="e.g. Treasury has no appetite for this size in EUR this week."
                          className="w-full rounded-lg border border-red-200 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={() => submitDecline(offer)}
                            disabled={busy || !declineReason.trim()}
                            className="inline-flex items-center px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy ? 'Declining...' : 'Yes, decline this offer'}
                          </button>
                          <button
                            onClick={() => { setDeclineRef(null); setDeclineReason(''); }}
                            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Cancel
                          </button>
                          {!declineReason.trim() && (
                            <span className="text-[11px] text-red-700">A reason is required.</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
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

export default AdminOffers;
