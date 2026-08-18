import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { convertWifToIds } from '@/lib/crypto';
import { SellTermsGate } from '@/components/SellTermsGate';
import { BRAND, OFFER, LANDING } from '@/copy';

const QrScanner = lazy(() => import('@/components/QrScanner'));

/**
 * Offering LANA to the Lana.discount treasury.
 *
 * The page this replaces did the whole thing in one request: the seller read a
 * price off a published rate, typed a private key, and the server broadcast the
 * chain transaction and booked the obligation together. There was no moment at
 * which Lana.discount decided whether it wanted the asset — which is a standing
 * service to holders, and the one shape the framework forbids.
 *
 * The order here IS the argument:
 *
 *   wallet   → which holding is being offered (all the old gates, unchanged)
 *   amount   → how much, and NO price: there is no price yet
 *   offer    → our decision comes back — a purchase offer, a review, or a no
 *   transfer → only after acceptance does a key get typed and LANA move
 *   done     → what we acquired, what we owe, and the date we owe it by
 *
 * Everything the old page knew about wallets — balances, freezes, input
 * consolidation, which Split a wallet belongs to, whether we could settle in
 * the counterparty's currency at all — is kept, because none of it was the
 * problem.
 */

interface RegisteredWallet {
  walletId: string;
  walletType: string;
  note?: string;
  amountUnregistered?: string;
  status?: string;
  freezeStatus?: string;
}

interface WalletBalance {
  wallet_id: string;
  balance: number;
  status: string;
}

/** Verdict from /api/sell/split-check — mirrors server/lib/buybackSplit.ts. */
interface SplitCheck {
  allowed: boolean;
  code: 'OK' | 'SPLIT_TOO_NEW' | 'SPLIT_TOO_OLD' | 'SPLIT_UNKNOWN' | 'SPLIT_UNVERIFIABLE';
  reason: string;
  walletSplit: number | null;
  currentSplit: number | null;
  allowedSplits: number[];
}

/**
 * Only the parts of /api/system-params this page is allowed to care about.
 * The reference rates are deliberately not read here: a price exists only
 * after we have decided we want the asset, and it arrives on the offer.
 */
interface SystemParams {
  split: string | null;
  activeCurrencies: string[];
  buybackWalletId: string;
}

interface PaymentMethod {
  id: string;
  scope: string;
  country?: string;
  scheme: string;
  currency: string;
  label: string;
  fields: Record<string, any>;
  verified?: boolean;
  primary?: boolean;
}

/** The account a purchase price could be settled to, from the KIND 0 profile. */
type SettlementAccount =
  | { type: 'modern'; method: PaymentMethod }
  | { type: 'legacy'; bank: any };

/** What the server lets a counterparty see about their own offer. */
interface AcquisitionOffer {
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

interface TransferResult {
  success: boolean;
  offerRef: string;
  txHash: string;
  lanaAmount: number;
  currency: string;
  purchasePrice: number;
  settlementDueAt: string | null;
  fee: number;
  transactionId: number;
}

type Stage = 'wallet' | 'amount' | 'offer' | 'transfer' | 'done';

const STAGES: Stage[] = ['wallet', 'amount', 'offer', 'transfer'];

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', CZK: 'CZK',
  PLN: 'PLN', HRK: 'HRK', RSD: 'RSD', HUF: 'HUF', BAM: 'BAM',
};

const SCHEME_LABELS: Record<string, string> = {
  'EU.IBAN': 'SEPA / IBAN',
  'UK.ACCT_SORT': 'UK Account',
  'US.ACH': 'US ACH',
};

const MAX_UTXOS = 20;

/**
 * SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC. `new Date()` reads that shape as
 * LOCAL time, which would put a 30-minute countdown hours out for anyone east
 * or west of the server — so the zone is made explicit before parsing.
 */
function parseSqliteUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const formatDay = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  return d ? d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
};

const formatMoment = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';
};

const formatLeft = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const shortAddress = (a: string) => (a && a.length > 22 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a || '—');

/** Ticks once a second so an offer window is visibly running out. */
function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  const target = parseSqliteUtc(until);
  if (!target) return { msLeft: null as number | null, expired: false };
  const msLeft = target.getTime() - now;
  return { msLeft, expired: msLeft <= 0 };
}

const SubmitOffer = () => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>('wallet');
  const [profileLang, setProfileLang] = useState(''); // KIND 0 `language` → terms default
  const [loading, setLoading] = useState(true);

  // Open obligations of the counterparty's own — checked here as a courtesy,
  // and again by the server on every offer and every transfer.
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingChecked, setRatingChecked] = useState(false);

  // Which holding is being offered
  const [wallets, setWallets] = useState<RegisteredWallet[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('');

  // Settlement currency comes from the KIND 0 profile; it is never chosen here.
  const [systemParams, setSystemParams] = useState<SystemParams | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState('');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [legacyBank, setLegacyBank] = useState<any>(null);

  const [utxoCount, setUtxoCount] = useState<number | null>(null);
  const [utxoLoading, setUtxoLoading] = useState(false);
  const [splitCheck, setSplitCheck] = useState<SplitCheck | null>(null);
  const [splitChecking, setSplitChecking] = useState(false);
  const tooManyUtxos = utxoCount !== null && utxoCount > MAX_UTXOS;

  // How much is being offered
  const [lanaAmount, setLanaAmount] = useState('');
  const [isEmptyWallet, setIsEmptyWallet] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Our decision
  const [offer, setOffer] = useState<AcquisitionOffer | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [refreshingDecision, setRefreshingDecision] = useState(false);
  // The server has told us the window closed, whatever this browser's clock says.
  const [serverLapsed, setServerLapsed] = useState(false);

  // The transfer
  const [privateKey, setPrivateKey] = useState('');
  const [privateKeyValid, setPrivateKeyValid] = useState<boolean | null>(null); // null = not yet checked
  const [privateKeyError, setPrivateKeyError] = useState('');
  const [validatingKey, setValidatingKey] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<{ error: string; code?: string; unfreezeUrl?: string } | null>(null);
  const [showQrScanner, setShowQrScanner] = useState(false);

  const [result, setResult] = useState<TransferResult | null>(null);

  const { msLeft, expired: clockExpired } = useCountdown(
    offer && (offer.status === 'offered' || offer.status === 'accepted') ? offer.offerExpiresAt : null,
  );
  // An accepted offer lapses on the same clock as an unaccepted one: the price
  // was priced for that window, and the server refuses a transfer after it.
  const lapsed = serverLapsed || offer?.status === 'expired' || clockExpired;

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    loadInitialData();
  }, [session]);

  const loadInitialData = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [ratingRes, walletsRes, paramsRes, profileRes, offersRes] = await Promise.all([
        fetch(`/api/user/${session.nostrHexId}/payment-score`),
        fetch(`/api/user/${session.nostrHexId}/wallets`),
        fetch('/api/system-params'),
        fetch(`/api/user/${session.nostrHexId}/profile`),
        fetch(`/api/acquisitions/mine/${session.nostrHexId}`),
      ]);

      const ratingData = await ratingRes.json();
      setUserRating(ratingData.score);
      setRatingChecked(true);

      const walletsData = await walletsRes.json();
      const paramsData = await paramsRes.json();
      const profileData = await profileRes.json();

      const fetchedWallets: RegisteredWallet[] = walletsData.wallets || [];
      setWallets(fetchedWallets);
      setSystemParams(paramsData);

      if (profileData.profile) {
        // KIND 0 `language` drives the language the terms open in.
        if (profileData.profile.language) setProfileLang(String(profileData.profile.language));
        if (profileData.profile.payment_methods) {
          setPaymentMethods(profileData.profile.payment_methods);
        }
        if (profileData.profile.bankName || profileData.profile.bankAccount) {
          setLegacyBank({
            bankName: profileData.profile.bankName,
            bankAddress: profileData.profile.bankAddress,
            bankSWIFT: profileData.profile.bankSWIFT,
            bankAccount: profileData.profile.bankAccount,
          });
        }
      }

      if (fetchedWallets.length > 0) {
        setBalancesLoading(true);
        try {
          const addresses = fetchedWallets.map((w: RegisteredWallet) => w.walletId);
          const balRes = await fetch('/api/wallets/balances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ addresses }),
          });
          const balData = await balRes.json();
          const balMap: Record<string, number> = {};
          (balData.balances || []).forEach((b: WalletBalance) => {
            balMap[b.wallet_id] = b.balance;
          });
          setBalances(balMap);
        } catch (e) {
          console.error('Balance fetch failed:', e);
        } finally {
          setBalancesLoading(false);
        }
      }

      const profileCurrency = profileData.profile?.currency;
      if (profileCurrency && paramsData.activeCurrencies?.includes(profileCurrency)) {
        setSelectedCurrency(profileCurrency);
      } else if (paramsData.activeCurrencies?.length > 0) {
        setSelectedCurrency(paramsData.activeCurrencies[0]);
      }

      // A live offer outlives this page. Someone who accepted and then closed
      // the tab must be able to come back and finish the transfer — the offer
      // is on the server, and without this they would be stranded in front of
      // a proposal that no longer exists in any browser.
      try {
        const mine = await offersRes.json();
        const open = (mine.offers || []).find((o: AcquisitionOffer) => {
          if (o.status === 'under_review') return true;
          if (o.status !== 'offered' && o.status !== 'accepted') return false;
          const until = parseSqliteUtc(o.offerExpiresAt);
          return !until || until.getTime() > Date.now();
        });
        if (open) {
          setOffer(open);
          setSelectedWallet(open.senderWallet);
          setSelectedCurrency(open.currency);
          setLanaAmount(String(open.lanaAmount));
          setStage(open.status === 'accepted' ? 'transfer' : 'offer');
        }
      } catch (e) {
        console.error('Open offer lookup failed:', e);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
      toast.error('Failed to load wallet data');
    } finally {
      setLoading(false);
    }
  };

  // Input count for the selected wallet — a transfer with too many inputs
  // cannot be signed, and the counterparty should learn that here.
  useEffect(() => {
    if (!selectedWallet) { setUtxoCount(null); return; }
    let cancelled = false;
    setUtxoLoading(true);
    fetch('/api/wallets/utxo-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: selectedWallet }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled && d.success) setUtxoCount(d.utxoCount || 0); })
      .catch(e => console.error('UTXO check failed:', e))
      .finally(() => { if (!cancelled) setUtxoLoading(false); });
    return () => { cancelled = true; };
  }, [selectedWallet]);

  // WHICH SPLIT — the Split a wallet was registered in decides whether we
  // acquire from it at all. Asked the moment a wallet is picked, so it is
  // learned here and not after a private key has been typed. The server checks
  // again on the offer and on the transfer; this is only the courtesy.
  useEffect(() => {
    if (!selectedWallet) { setSplitCheck(null); return; }
    let cancelled = false;
    setSplitChecking(true);
    fetch('/api/sell/split-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId: selectedWallet }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) setSplitCheck(d); })
      .catch(() => {
        if (!cancelled) setSplitCheck({
          allowed: false, code: 'SPLIT_UNVERIFIABLE',
          reason: 'Eligibility could not be checked right now. Please try again shortly.',
          walletSplit: null, currentSplit: null, allowedSplits: [],
        });
      })
      .finally(() => { if (!cancelled) setSplitChecking(false); });
    return () => { cancelled = true; };
  }, [selectedWallet]);

  // "Max" offers the balance less an estimated fee, and the transfer then has
  // to empty the wallet — otherwise it keeps a change output and the fee has
  // nowhere to come from. That flag lives in this page and is lost the moment
  // the tab is closed, so an offer resumed later would fail for want of a fee.
  // Recover it from the balance: the offer covering essentially the whole
  // wallet IS the emptying case.
  useEffect(() => {
    if (!offer || isEmptyWallet) return;
    const balance = balances[offer.senderWallet];
    if (!balance) return;
    const feeLana = Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5) / 100000000;
    if (offer.lanaAmount >= balance - feeLana * 3) setIsEmptyWallet(true);
  }, [offer?.offerRef, offer?.lanaAmount, balances, isEmptyWallet]);

  /**
   * Where a purchase price could be settled, in the counterparty's currency.
   * `payout` / `both` are KIND 0 scope values — a wire vocabulary, not ours.
   *
   * The literal `type` is what lets a reader (and the compiler) tell the two
   * shapes apart at the call site.
   */
  const getSettlementAccount = (): SettlementAccount | null => {
    if (!selectedCurrency) return null;

    const method = paymentMethods.find(
      pm => (pm.scope === 'payout' || pm.scope === 'both') && pm.currency === selectedCurrency,
    );
    if (method) return { type: 'modern', method };

    const anyMatch = paymentMethods.find(pm => pm.currency === selectedCurrency);
    if (anyMatch) return { type: 'modern', method: anyMatch };

    if (legacyBank && (legacyBank.bankName || legacyBank.bankAccount)) {
      return { type: 'legacy', bank: legacyBank };
    }
    return null;
  };

  // ── the three requests ────────────────────────────────────────────────

  const submitOffer = async () => {
    if (!session) return;
    const amount = parseFloat(lanaAmount);
    if (!selectedWallet || !selectedCurrency || !Number.isFinite(amount) || amount <= 0) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/acquisitions/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hexId: session.nostrHexId,
          senderAddress: selectedWallet,
          lanaAmount: amount,
          currency: selectedCurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.offer) {
        setSubmitError(data.error || 'This proposal could not be submitted right now.');
        return;
      }
      setOffer(data.offer);
      setServerLapsed(false);
      setShowTerms(false);
      setStage('offer');
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const acceptOffer = async () => {
    if (!session || !offer) return;
    setAccepting(true);
    try {
      const res = await fetch(`/api/acquisitions/${offer.offerRef}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hexId: session.nostrHexId }),
      });
      const data = await res.json();
      if (!res.ok || !data.offer) {
        // 409 is the offer lapsing under us, which is not an error to retry.
        if (res.status === 409) setServerLapsed(true);
        else toast.error(data.error || 'This purchase offer could not be accepted.');
        return;
      }
      setOffer(data.offer);
      setShowTerms(false);
      setTransferError(null);
      setStage('transfer');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setAccepting(false);
    }
  };

  /** "Not now" — close our offer without transferring anything. */
  const declineOffer = async () => {
    if (!session || !offer) return;
    try {
      await fetch(`/api/acquisitions/${offer.offerRef}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hexId: session.nostrHexId }),
      });
    } catch { /* closing our own offer is best-effort; it lapses anyway */ }
    toast.success(OFFER.notNowNote);
    resetToAmount();
  };

  const refreshDecision = async () => {
    if (!session || !offer) return;
    setRefreshingDecision(true);
    try {
      const res = await fetch(`/api/acquisitions/${offer.offerRef}?hexId=${session.nostrHexId}`);
      const data = await res.json();
      if (res.ok && data.offer) setOffer(data.offer);
    } catch { /* the next tick tries again */ }
    finally { setRefreshingDecision(false); }
  };

  // A person decides on a reviewed proposal, and that can happen while this
  // page is open — so it asks, rather than leaving a stale screen up.
  useEffect(() => {
    if (stage !== 'offer' || offer?.status !== 'under_review') return;
    const id = setInterval(refreshDecision, 20000);
    return () => clearInterval(id);
  }, [stage, offer?.status, offer?.offerRef]);

  const transfer = async () => {
    if (!session || !offer) return;
    if (!privateKey.trim()) {
      toast.error('Enter the private key for this wallet');
      return;
    }
    setTransferring(true);
    setTransferError(null);
    try {
      const res = await fetch(`/api/acquisitions/${offer.offerRef}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hexId: session.nostrHexId,
          privateKey: privateKey.trim(),
          emptyWallet: isEmptyWallet,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (data.code === 'OFFER_EXPIRED') setServerLapsed(true);
        setTransferError({ error: data.error || 'The transfer did not go through.', code: data.code, unfreezeUrl: data.unfreezeUrl });
        return;
      }
      setResult(data);
      setPrivateKey('');
      setPrivateKeyValid(null);
      setStage('done');
    } catch {
      setTransferError({ error: 'Network error. Please try again.' });
    } finally {
      setTransferring(false);
    }
  };

  // Validate the key against the wallet locally, before anything is sent.
  const keyValidateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (keyValidateRef.current) clearTimeout(keyValidateRef.current);

    const trimmed = privateKey.trim();
    if (!trimmed) {
      setPrivateKeyValid(null);
      setPrivateKeyError('');
      return;
    }

    setValidatingKey(true);
    keyValidateRef.current = setTimeout(() => {
      try {
        const ids = convertWifToIds(trimmed);
        const sender = offer?.senderWallet || selectedWallet;
        if (ids.walletIdCompressed === sender || ids.walletIdUncompressed === sender) {
          setPrivateKeyValid(true);
          setPrivateKeyError('');
        } else {
          setPrivateKeyValid(false);
          setPrivateKeyError('This private key does not match the wallet you offered from');
        }
      } catch (err: any) {
        setPrivateKeyValid(false);
        setPrivateKeyError(err.message || 'Invalid private key format');
      } finally {
        setValidatingKey(false);
      }
    }, 500);

    return () => {
      if (keyValidateRef.current) clearTimeout(keyValidateRef.current);
    };
  }, [privateKey, offer?.senderWallet, selectedWallet]);

  const resetToAmount = () => {
    setOffer(null);
    setServerLapsed(false);
    setShowTerms(false);
    setTransferError(null);
    setPrivateKey('');
    setPrivateKeyValid(null);
    setPrivateKeyError('');
    setSubmitError('');
    setStage('amount');
  };

  if (!session) return null;

  const walletBalance = selectedWallet ? (balances[selectedWallet] || 0) : 0;
  const settlementAccount = getSettlementAccount();
  const sym = (code: string) => CURRENCY_SYMBOLS[code] || '';
  const stageIndex = STAGES.indexOf(stage);
  const walletReady = !!selectedWallet && !tooManyUtxos && !utxoLoading && !!selectedCurrency
    && !!settlementAccount && !splitChecking && !!splitCheck?.allowed;
  const eligible = !ratingChecked || (userRating !== null && userRating === 10);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between gap-3 h-16">
          {/* The wordmark is the part that gives way on a narrow phone: it may
              shrink and truncate, while the actions keep their full width. */}
          <Link to="/dashboard" className="flex min-w-0 items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 shrink-0 dark:invert" />
            <span className="truncate">Lana<span className="text-gold">.Discount</span></span>
          </Link>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Link to="/dashboard" className="hidden sm:inline text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap">
              Dashboard
            </Link>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors whitespace-nowrap"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-3xl">
        {/* Header */}
        <div className="mb-8 space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{OFFER.pageTitle}</h1>
          <p className="text-muted-foreground">{OFFER.pageIntro}</p>
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-xs text-blue-700 dark:text-blue-400">
            {OFFER.settlementTiming}
          </div>
        </div>

        {/* Stage indicator */}
        <div className="flex items-center gap-2 mb-8">
          {STAGES.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                i === stageIndex ? 'bg-primary text-white' :
                i < stageIndex || stage === 'done' ? 'bg-primary/20 text-primary' :
                'bg-muted text-muted-foreground'
              }`}>
                {i < stageIndex || stage === 'done' ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : i + 1}
              </div>
              {i < STAGES.length - 1 && (
                <div className={`w-8 h-0.5 ${i < stageIndex || stage === 'done' ? 'bg-primary/40' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {/* Open obligations of their own — the first thing that decides
                whether we will look at a proposal at all. */}
            {ratingChecked && eligible && (
              <div className="flex items-center gap-3 rounded-xl border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-4 py-3 mb-4">
                <svg className="h-5 w-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                <span className="min-w-0 text-sm text-green-700 dark:text-green-400">
                  No open obligations — <strong>{userRating}/10</strong>
                </span>
              </div>
            )}

            {ratingChecked && !eligible ? (
              <div className="rounded-2xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-6 text-center space-y-4 mb-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                  <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </div>
                <h2 className="text-xl font-bold text-red-700 dark:text-red-400">{OFFER.blockedTitle}</h2>
                <p className="text-sm text-red-600 dark:text-red-400 max-w-md mx-auto leading-relaxed">
                  {OFFER.blockedBody}
                </p>
                {userRating !== null && (
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-100 dark:bg-red-900/40">
                    <span className="text-sm font-medium text-red-700 dark:text-red-400">
                      Your current rating: {userRating}/10
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            {eligible && (
            <>
            {/* ============ 1. WHICH WALLET ============ */}
            {stage === 'wallet' && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">{OFFER.selectWallet}</h2>

                  {wallets.length > 0 ? (
                    <div className="space-y-3">
                      {wallets.map(w => {
                        const isFrozen = !!w.freezeStatus;
                        return (
                          <button
                            key={w.walletId}
                            // A frozen wallet cannot transfer, so it cannot be
                            // offered from. The server refuses it too; this
                            // only stops the walk into a dead end.
                            disabled={isFrozen}
                            title={isFrozen ? OFFER.walletFrozen : undefined}
                            onClick={() => { if (!isFrozen) setSelectedWallet(w.walletId); }}
                            className={`w-full rounded-xl border-2 px-4 sm:px-5 py-4 text-left transition-all ${
                              selectedWallet === w.walletId
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-muted-foreground/30'
                            } ${isFrozen ? 'opacity-60 cursor-not-allowed hover:border-border' : ''}`}
                          >
                            <div className="flex items-start gap-3 sm:gap-4">
                              <div className="flex-1 min-w-0">
                                {/* min-w-0 has to repeat on EVERY level of the
                                    chain: without it here the inner row keeps
                                    its intrinsic width, the address refuses to
                                    shrink, and on a phone it runs underneath
                                    the balance. */}
                                <div className="flex min-w-0 items-center gap-2 mb-1">
                                  <span className="font-mono text-sm font-medium text-foreground truncate">
                                    {w.walletId.slice(0, 10)}...{w.walletId.slice(-6)}
                                  </span>
                                  {isFrozen && (
                                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                                      Frozen
                                    </span>
                                  )}
                                </div>
                                {isFrozen && (
                                  <p className="text-xs text-blue-700 mb-1">
                                    {OFFER.walletFrozen}{' '}
                                    <a
                                      href="https://unfreeze.lanapays.us"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={e => e.stopPropagation()}
                                      className="underline font-medium"
                                    >
                                      unfreeze.lanapays.us
                                    </a>
                                  </p>
                                )}
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  <span className="inline-flex items-center gap-1">
                                    <span className="font-medium text-foreground/70">Type:</span>
                                    {w.walletType}
                                  </span>
                                  {w.note && (
                                    <span className="inline-flex min-w-0 items-center gap-1">
                                      <span className="font-medium text-foreground/70">Note:</span>
                                      <span className="truncate">{w.note}</span>
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Balance — never shrinks, never wraps. */}
                              <div className="text-right flex-shrink-0 whitespace-nowrap">
                                {balancesLoading && balances[w.walletId] === undefined ? (
                                  <div className="h-4 w-20 animate-pulse bg-muted rounded" />
                                ) : balances[w.walletId] !== undefined ? (
                                  <div>
                                    <span className="font-mono text-sm font-bold text-foreground">
                                      {balances[w.walletId].toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                    <span className="text-xs text-muted-foreground ml-1">LANA</span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 dark:border-amber-800 p-4 text-center">
                      <p className="text-sm text-amber-700 dark:text-amber-400 font-medium mb-1">No registered wallets found</p>
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        No wallets are registered for your account. Please contact support.
                      </p>
                    </div>
                  )}
                </div>

                {/* The currency we would settle in — taken from the profile,
                    and shown WITHOUT a rate: there is no price at this stage. */}
                {selectedCurrency && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{OFFER.settlementCurrencyLabel}</p>
                      <p className="text-sm font-semibold">{selectedCurrency}</p>
                    </div>
                    {settlementAccount && (
                      <div className="min-w-0 text-right">
                        <p className="text-xs text-muted-foreground">Settled to</p>
                        <p className="text-sm font-medium truncate">
                          {settlementAccount.type === 'modern'
                            ? (settlementAccount.method.label || SCHEME_LABELS[settlementAccount.method.scheme] || settlementAccount.method.scheme)
                            : (settlementAccount.bank.bankName || settlementAccount.bank.bankAccount)}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Too many inputs to sign a single transfer */}
                {selectedWallet && tooManyUtxos && (
                  <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-2">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400">{OFFER.consolidateTitle}</p>
                    <p className="text-xs text-red-600 dark:text-red-500">
                      {OFFER.consolidateBody} This wallet has <strong>{utxoCount}</strong> separate inputs; the limit is {MAX_UTXOS}.
                    </p>
                    <a href="https://youtu.be/kBi4MKcc4qM?si=bIeWS_dlgHjFproo" target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline">
                      Watch: how to consolidate your wallet
                    </a>
                  </div>
                )}

                {selectedWallet && utxoLoading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent inline-block" />
                    Checking this wallet…
                  </p>
                )}

                {/* Nothing to settle a purchase price to */}
                {selectedCurrency && !settlementAccount && (
                  <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-3">
                    <p className="text-sm font-bold text-red-700 dark:text-red-400">{OFFER.noSettlementAccountTitle}</p>
                    <p className="text-xs text-red-600 dark:text-red-500">
                      {OFFER.noSettlementAccountBody.replace('{currency}', selectedCurrency)}
                    </p>
                    {paymentMethods.filter(pm => pm.scope === 'payout' || pm.scope === 'both').length > 0 ? (
                      <div className="text-xs text-red-600 dark:text-red-500">
                        <p className="font-medium mb-1">Your profile has details for:</p>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {paymentMethods
                            .filter(pm => pm.scope === 'payout' || pm.scope === 'both')
                            .map((pm, i) => (
                              <li key={i} className="min-w-0">
                                <strong>{pm.currency}</strong> — {pm.label || pm.scheme}
                                {pm.fields?.iban && <span className="font-mono ml-1">({pm.fields.iban.slice(-4)})</span>}
                                {pm.fields?.account_number && <span className="font-mono ml-1">({pm.fields.account_number.slice(-4)})</span>}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : legacyBank ? (
                      <div className="text-xs text-red-600 dark:text-red-500">
                        <p className="font-medium mb-1">Your profile has older bank details with no currency set:</p>
                        <p className="font-mono truncate">{legacyBank.bankName} — {legacyBank.bankAccount}</p>
                      </div>
                    ) : null}
                    <p className="text-xs text-red-600 dark:text-red-500">
                      <a href="https://app.mejmosefajn.org/profile" target="_blank" rel="noopener noreferrer"
                        className="font-medium underline hover:text-red-800 dark:hover:text-red-300">
                        Update your profile
                      </a>{' '}
                      to add details in {selectedCurrency}.
                    </p>
                  </div>
                )}

                {/* Which Split this wallet belongs to */}
                {selectedWallet && splitCheck && !splitCheck.allowed && (
                  <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 space-y-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{OFFER.walletOutOfScopeTitle}</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400">{splitCheck.reason}</p>
                    {splitCheck.walletSplit !== null && splitCheck.currentSplit !== null && (
                      <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                        Wallet Split {splitCheck.walletSplit} · current Split {splitCheck.currentSplit}
                      </p>
                    )}
                  </div>
                )}

                <div className="flex justify-between gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Cancel
                  </Link>
                  <button
                    onClick={() => setStage('amount')}
                    disabled={!walletReady}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      walletReady ? 'bg-primary hover:bg-primary/90 shadow-lg' : 'bg-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    {splitChecking ? 'Checking…' : 'Next'}
                  </button>
                </div>
              </div>
            )}

            {/* ============ 2. HOW MUCH ============ */}
            {stage === 'amount' && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-1">{OFFER.amountTitle}</h2>
                  <p className="text-sm text-muted-foreground mb-4">{OFFER.amountHint}</p>

                  <label className="block text-sm font-medium text-foreground mb-1.5">{OFFER.amountLabel}</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={lanaAmount}
                      onChange={e => { setLanaAmount(e.target.value); setIsEmptyWallet(false); setSubmitError(''); }}
                      placeholder="e.g. 100000"
                      min="1"
                      className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    />
                    {walletBalance > 0 && (
                      <button
                        onClick={() => {
                          // Leave room for the network fee: 1 input, 1 output,
                          // no change output when the wallet is emptied.
                          const estimatedFeeLanoshis = Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5);
                          const feeLana = estimatedFeeLanoshis / 100000000;
                          setLanaAmount(String(Math.max(0, walletBalance - feeLana)));
                          setIsEmptyWallet(true);
                          setSubmitError('');
                        }}
                        className="shrink-0 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/10 transition-colors"
                      >
                        Max
                      </button>
                    )}
                  </div>
                  {walletBalance > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Available: {walletBalance.toLocaleString()} LANA
                    </p>
                  )}

                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-xs">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">Offered from</span>
                      <span className="font-mono truncate">{shortAddress(selectedWallet)}</span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.settlementCurrencyLabel}</span>
                      <span className="font-semibold flex-shrink-0 whitespace-nowrap">{selectedCurrency}</span>
                    </div>
                  </div>

                  {submitError && (
                    <div className="mt-4 rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
                      <p className="text-sm text-red-700 dark:text-red-400">{submitError}</p>
                    </div>
                  )}
                </div>

                <div className="flex justify-between gap-3">
                  <button onClick={() => setStage('wallet')} className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back
                  </button>
                  <button
                    onClick={submitOffer}
                    disabled={submitting || !(parseFloat(lanaAmount) > 0)}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      submitting || !(parseFloat(lanaAmount) > 0)
                        ? 'bg-muted-foreground/30 cursor-not-allowed'
                        : 'bg-primary hover:bg-primary/90 shadow-lg'
                    }`}
                  >
                    {submitting ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        {OFFER.submitting}
                      </span>
                    ) : OFFER.submit}
                  </button>
                </div>
              </div>
            )}

            {/* ============ 3. OUR DECISION ============ */}
            {stage === 'offer' && offer && (
              <div className="space-y-6">
                {/* It lapsed while it was being read. Nothing moved. */}
                {lapsed && offer.status !== 'declined' && offer.status !== 'under_review' ? (
                  <div className="rounded-2xl border-2 border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-6 space-y-3">
                    <h2 className="text-xl font-bold text-amber-800 dark:text-amber-300">{OFFER.lapsedTitle}</h2>
                    <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">{OFFER.lapsedBody}</p>
                    <button
                      onClick={resetToAmount}
                      className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                    >
                      {OFFER.lapsedAgain}
                    </button>
                  </div>
                ) : offer.status === 'offered' ? (
                  <>
                    <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-5 sm:p-6 space-y-4">
                      <div>
                        <h2 className="text-xl font-bold text-foreground">{OFFER.offeredTitle}</h2>
                        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{OFFER.offeredBody}</p>
                      </div>

                      <div className="rounded-xl border border-border bg-card p-4 space-y-2.5 text-sm">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                          <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                            {offer.lanaAmount.toLocaleString()} LANA
                          </span>
                        </div>
                        <div className="border-t border-border pt-2.5 flex min-w-0 items-center justify-between gap-3">
                          <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                          <span className="font-mono font-bold text-lg text-primary flex-shrink-0 whitespace-nowrap">
                            {sym(offer.currency)}{(offer.purchasePrice ?? 0).toFixed(2)} {offer.currency}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                          <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(offer.settlementDueAt)}</span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.offeredExpiryLabel}</span>
                          <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatMoment(offer.offerExpiresAt)}</span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                          <span className="font-mono text-xs text-foreground flex-shrink-0 whitespace-nowrap">{offer.offerRef}</span>
                        </div>
                      </div>

                      {msLeft !== null && (
                        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-card border border-border px-4 py-2.5">
                          <span className="text-xs text-muted-foreground">{OFFER.timeLeftLabel}</span>
                          <span className={`font-mono text-sm font-bold flex-shrink-0 whitespace-nowrap ${
                            msLeft < 120000 ? 'text-red-600' : 'text-foreground'
                          }`}>
                            {formatLeft(msLeft)}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* The terms stand in front of acceptance, because that is
                        the contract moment — and the server records which
                        version was shown when /accept succeeds. */}
                    {showTerms ? (
                      <SellTermsGate
                        defaultLang={/^sl/i.test(profileLang) ? 'sl' : 'en'}
                        busy={accepting}
                        onAccept={acceptOffer}
                        onCancel={() => setShowTerms(false)}
                      />
                    ) : (
                      <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                        <button
                          onClick={declineOffer}
                          className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {OFFER.offeredDecline}
                        </button>
                        <button
                          onClick={() => setShowTerms(true)}
                          className="rounded-xl bg-primary px-6 py-3 font-semibold text-white hover:bg-primary/90 shadow-lg transition-all"
                        >
                          {OFFER.offeredAccept}
                        </button>
                      </div>
                    )}
                  </>
                ) : offer.status === 'under_review' ? (
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-1 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <div className="min-w-0">
                        <h2 className="text-xl font-bold text-foreground">{OFFER.reviewTitle}</h2>
                        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{OFFER.reviewBody}</p>
                      </div>
                    </div>

                    <div className="rounded-xl bg-muted/30 border border-border p-4 space-y-2 text-sm">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                        <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">{offer.offerRef}</span>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                        <span className="font-mono text-foreground flex-shrink-0 whitespace-nowrap">{offer.lanaAmount.toLocaleString()} LANA</span>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">{OFFER.settlementCurrencyLabel}</span>
                        <span className="text-foreground flex-shrink-0 whitespace-nowrap">{offer.currency}</span>
                      </div>
                    </div>

                    <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                      <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                        Back to Dashboard
                      </Link>
                      <button
                        onClick={refreshDecision}
                        disabled={refreshingDecision}
                        className="rounded-xl border border-primary/30 bg-primary/5 px-6 py-3 text-sm font-semibold text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                      >
                        {refreshingDecision ? 'Checking…' : 'Check again'}
                      </button>
                    </div>
                  </div>
                ) : offer.status === 'declined' ? (
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <h2 className="text-xl font-bold text-foreground">{OFFER.declinedTitle}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.declinedBody}</p>
                    {offer.decisionReason && (
                      <div className="rounded-xl bg-muted/30 border border-border p-4">
                        <p className="text-sm text-foreground leading-relaxed">{offer.decisionReason}</p>
                      </div>
                    )}
                    <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                      <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                        Back to Dashboard
                      </Link>
                      <button
                        onClick={resetToAmount}
                        className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                      >
                        {OFFER.lapsedAgain}
                      </button>
                    </div>
                  </div>
                ) : (
                  // withdrawn, or anything else that is no longer live
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.notNowNote}</p>
                    <button
                      onClick={resetToAmount}
                      className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                    >
                      {OFFER.lapsedAgain}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ============ 4. TRANSFER ============ */}
            {stage === 'transfer' && offer && (
              lapsed ? (
                <div className="rounded-2xl border-2 border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-6 space-y-3">
                  <h2 className="text-xl font-bold text-amber-800 dark:text-amber-300">{OFFER.lapsedTitle}</h2>
                  <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">{OFFER.lapsedBody}</p>
                  <button
                    onClick={resetToAmount}
                    className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                  >
                    {OFFER.lapsedAgain}
                  </button>
                </div>
              ) : (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-1">{OFFER.transferTitle}</h2>
                  <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{OFFER.transferBody}</p>

                  <div className="rounded-xl bg-muted/30 border border-border p-4 space-y-2 text-sm mb-5">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">From</span>
                      <span className="font-mono text-foreground truncate">{shortAddress(offer.senderWallet)}</span>
                    </div>
                    {systemParams?.buybackWalletId && (
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">Treasury wallet</span>
                        <span className="font-mono text-foreground truncate">{shortAddress(systemParams.buybackWalletId)}</span>
                      </div>
                    )}
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                      <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                        {offer.lanaAmount.toLocaleString()} LANA
                      </span>
                    </div>
                    <div className="border-t border-border pt-2 flex min-w-0 items-center justify-between gap-3">
                      <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                      <span className="font-mono font-bold text-primary flex-shrink-0 whitespace-nowrap">
                        {sym(offer.currency)}{(offer.purchasePrice ?? 0).toFixed(2)} {offer.currency}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                      <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(offer.settlementDueAt)}</span>
                    </div>
                  </div>

                  {msLeft !== null && (
                    <div className="mb-5 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
                      <span className="text-xs text-muted-foreground">{OFFER.timeLeftLabel}</span>
                      <span className={`font-mono text-sm font-bold flex-shrink-0 whitespace-nowrap ${
                        msLeft < 120000 ? 'text-red-600' : 'text-foreground'
                      }`}>
                        {formatLeft(msLeft)}
                      </span>
                    </div>
                  )}

                  {/* Private key */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">{OFFER.keyLabel}</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={privateKey}
                        onChange={e => setPrivateKey(e.target.value)}
                        placeholder="Enter your WIF private key"
                        className={`min-w-0 flex-1 rounded-lg border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-colors ${
                          privateKeyValid === true
                            ? 'border-green-500 focus:ring-green-500/30 focus:border-green-500'
                            : privateKeyValid === false
                              ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                              : 'border-border focus:ring-primary/30 focus:border-primary'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowQrScanner(true)}
                        className="shrink-0 rounded-lg border border-border bg-background px-4 py-3 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                        title="Scan QR code"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75zM6.75 16.5h.75v.75h-.75v-.75zM16.5 6.75h.75v.75h-.75v-.75zM13.5 13.5h.75v.75h-.75v-.75zM13.5 19.5h.75v.75h-.75v-.75zM19.5 13.5h.75v.75h-.75v-.75zM19.5 19.5h.75v.75h-.75v-.75zM16.5 16.5h3v3h-3v-3z" />
                        </svg>
                        <span className="text-sm font-medium hidden sm:inline">Scan</span>
                      </button>
                    </div>
                    {validatingKey && (
                      <p className="mt-1.5 text-xs text-muted-foreground animate-pulse">Checking private key…</p>
                    )}
                    {!validatingKey && privateKeyValid === true && (
                      <p className="mt-1.5 text-xs text-green-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Private key matches the wallet you offered from
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === false && (
                      <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        {privateKeyError}
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === null && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{OFFER.keyNote}</p>
                    )}
                  </div>

                  {showQrScanner && (
                    <Suspense fallback={
                      <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center">
                        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                      </div>
                    }>
                      <QrScanner
                        onScan={(value) => {
                          setPrivateKey(value);
                          setShowQrScanner(false);
                          toast.success('QR code scanned successfully');
                        }}
                        onClose={() => setShowQrScanner(false)}
                      />
                    </Suspense>
                  )}

                  {/* A refusal here is not a failed acquisition: the offer is
                      still ours to honour, so the key can be corrected and the
                      transfer tried again. */}
                  {transferError && (
                    <div className="mt-5 rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-2">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                        {transferError.code === 'WALLET_FROZEN' ? 'This wallet is frozen' : 'The transfer did not go through'}
                      </p>
                      <p className="text-xs text-red-600 dark:text-red-500 leading-relaxed">{transferError.error}</p>
                      {transferError.unfreezeUrl && (
                        <a
                          href={transferError.unfreezeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                        >
                          Go to unfreeze.lanapays.us
                        </a>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                    Back to Dashboard
                  </Link>
                  <button
                    onClick={transfer}
                    disabled={transferring || !privateKey.trim() || privateKeyValid !== true}
                    className={`rounded-xl px-8 py-3 font-semibold text-white transition-all ${
                      transferring || !privateKey.trim() || privateKeyValid !== true
                        ? 'bg-muted-foreground/30 cursor-not-allowed'
                        : 'bg-primary hover:bg-primary/90 shadow-lg'
                    }`}
                  >
                    {transferring ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        {OFFER.transferring}
                      </span>
                    ) : OFFER.transferConfirm}
                  </button>
                </div>
              </div>
              )
            )}

            {/* ============ 5. DONE ============ */}
            {stage === 'done' && result && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-green-200 dark:border-green-800 bg-green-50/30 dark:bg-green-950/20 p-6 sm:p-8">
                  <div className="text-center">
                    <div className="h-16 w-16 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center mx-auto mb-4">
                      <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-foreground mb-2">{OFFER.completedTitle}</h2>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">{OFFER.completedBody}</p>
                  </div>

                  <div className="mt-6 rounded-xl border border-green-200 dark:border-green-800 bg-card p-4 space-y-2.5 text-sm max-w-md mx-auto">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.completedAcquiredLabel}</span>
                      <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                        {result.lanaAmount.toLocaleString()} LANA
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                      <span className="font-mono font-bold text-primary flex-shrink-0 whitespace-nowrap">
                        {sym(result.currency)}{(result.purchasePrice ?? 0).toFixed(2)} {result.currency}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                      <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(result.settlementDueAt)}</span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                      <span className="font-mono text-xs text-foreground flex-shrink-0 whitespace-nowrap">{result.offerRef}</span>
                    </div>
                    <div className="border-t border-border pt-2.5">
                      <span className="text-xs text-muted-foreground">{OFFER.transferHashLabel}</span>
                      <div className="font-mono text-xs text-foreground break-all mt-0.5 select-all">{result.txHash}</div>
                    </div>
                  </div>

                  <p className="mt-5 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                    {OFFER.settlementTiming}
                  </p>
                </div>

                <div className="flex flex-col-reverse sm:flex-row sm:justify-center gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                    Back to Dashboard
                  </Link>
                  <Link
                    to="/obligations"
                    className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-center text-white hover:bg-primary/90 transition-colors"
                  >
                    {LANDING.settlementsLink}
                  </Link>
                </div>
              </div>
            )}
            </>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        {BRAND} — {LANDING.heroEyebrow}
      </footer>
    </div>
  );
};

export default SubmitOffer;
