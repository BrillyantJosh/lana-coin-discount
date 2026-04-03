import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { convertWifToIds } from '@/lib/crypto';

const QrScanner = lazy(() => import('@/components/QrScanner'));

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

interface SystemParams {
  exchangeRates: Record<string, number>;
  split: string | null;
  activeCurrencies: string[];
  buybackWalletId: string;
  commissionPercent: number;
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

interface PreviewResult {
  lanaAmount: number;
  currency: string;
  exchangeRate: number;
  split: string | null;
  grossFiat: number;
  commissionPercent: number;
  commissionFiat: number;
  netFiat: number;
  buybackWalletId: string;
  estimatedFee: number;
  minSellAmountFiat: number;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF', CZK: 'CZK',
  PLN: 'PLN', HRK: 'HRK', RSD: 'RSD', HUF: 'HUF', BAM: 'BAM',
};

const SCHEME_LABELS: Record<string, string> = {
  'EU.IBAN': 'SEPA / IBAN',
  'UK.ACCT_SORT': 'UK Account',
  'US.ACH': 'US ACH',
};

const SellLana = () => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);

  // Rating check
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingChecked, setRatingChecked] = useState(false);

  // Step 1 state
  const [wallets, setWallets] = useState<RegisteredWallet[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('');

  // Step 2 state (currency auto-set from profile)
  const [systemParams, setSystemParams] = useState<SystemParams | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState('');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [legacyBank, setLegacyBank] = useState<any>(null);

  // UTXO check
  const [utxoCount, setUtxoCount] = useState<number | null>(null);
  const [utxoLoading, setUtxoLoading] = useState(false);
  const MAX_UTXOS = 20;
  const tooManyUtxos = utxoCount !== null && utxoCount > MAX_UTXOS;

  // Step 3 state
  const [lanaAmount, setLanaAmount] = useState('');
  const [isEmptyWallet, setIsEmptyWallet] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Step 4 state
  const [privateKey, setPrivateKey] = useState('');
  const [privateKeyValid, setPrivateKeyValid] = useState<boolean | null>(null); // null = not yet checked
  const [privateKeyError, setPrivateKeyError] = useState('');
  const [validatingKey, setValidatingKey] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

  // Step 5 state
  const [txResult, setTxResult] = useState<any>(null);

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  // Load wallets + balances + system params on mount
  useEffect(() => {
    if (!session) return;
    loadInitialData();
  }, [session]);

  const loadInitialData = async () => {
    if (!session) return;
    setLoading(true);
    try {
      // Fetch rating, wallets, system params, and profile in parallel
      const [ratingRes, walletsRes, paramsRes, profileRes] = await Promise.all([
        fetch(`/api/user/${session.nostrHexId}/payment-score`),
        fetch(`/api/user/${session.nostrHexId}/wallets`),
        fetch('/api/system-params'),
        fetch(`/api/user/${session.nostrHexId}/profile`),
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

      // Parse payment methods from KIND 0 profile
      if (profileData.profile) {
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

      // Fetch live balances for all wallets
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

      // Auto-set currency from user's KIND 0 profile
      const profileCurrency = profileData.profile?.currency;
      if (profileCurrency && paramsData.activeCurrencies?.includes(profileCurrency)) {
        setSelectedCurrency(profileCurrency);
      } else if (paramsData.activeCurrencies?.length > 0) {
        setSelectedCurrency(paramsData.activeCurrencies[0]);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
      toast.error('Failed to load wallet data');
    } finally {
      setLoading(false);
    }
  };

  // Check UTXO count when wallet is selected
  useEffect(() => {
    if (!selectedWallet) { setUtxoCount(null); return; }
    const checkUtxos = async () => {
      setUtxoLoading(true);
      try {
        const res = await fetch('/api/wallets/utxo-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: selectedWallet }),
        });
        const data = await res.json();
        if (data.success) setUtxoCount(data.utxoCount || 0);
      } catch (e) { console.error('UTXO check failed:', e); }
      finally { setUtxoLoading(false); }
    };
    checkUtxos();
  }, [selectedWallet]);

  const getSenderAddress = () => selectedWallet;

  const getPayoutInfo = () => {
    if (!selectedCurrency) return null;

    // Try modern payment_methods first
    const payoutMethod = paymentMethods.find(
      pm => (pm.scope === 'payout' || pm.scope === 'both') && pm.currency === selectedCurrency
    );
    if (payoutMethod) return { type: 'modern', method: payoutMethod };

    // Fallback to any payment method with matching currency
    const anyMatch = paymentMethods.find(pm => pm.currency === selectedCurrency);
    if (anyMatch) return { type: 'modern', method: anyMatch };

    // Legacy fallback
    if (legacyBank && (legacyBank.bankName || legacyBank.bankAccount)) {
      return { type: 'legacy', bank: legacyBank };
    }

    return null;
  };

  const fetchPreview = async () => {
    const amount = parseFloat(lanaAmount);
    if (isNaN(amount) || amount <= 0 || !selectedCurrency) return;

    setPreviewLoading(true);
    try {
      const res = await fetch('/api/sell/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lanaAmount: amount,
          currency: selectedCurrency,
          walletType: wallets.find(w => w.walletId === selectedWallet)?.walletType || '',
        }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        setPreview(null);
      } else {
        setPreview(data);
      }
    } catch {
      toast.error('Failed to calculate preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  // Auto-calculate preview after 1.5s of no typing
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const amount = parseFloat(lanaAmount);
    if (isNaN(amount) || amount <= 0 || !selectedCurrency) return;

    debounceRef.current = setTimeout(() => {
      fetchPreview();
    }, 1500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [lanaAmount, selectedCurrency, selectedWallet]);

  const executeSell = async () => {
    if (!session || !preview) return;
    const sender = getSenderAddress();
    if (!sender || !privateKey.trim()) {
      toast.error('Please fill in all fields');
      return;
    }

    setExecuting(true);
    try {
      const res = await fetch('/api/sell/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hexId: session.nostrHexId,
          senderAddress: sender,
          lanaAmount: parseFloat(lanaAmount),
          currency: selectedCurrency,
          privateKey: privateKey.trim(),
          emptyWallet: isEmptyWallet,
          walletType: wallets.find(w => w.walletId === selectedWallet)?.walletType || '',
        }),
      });

      const data = await res.json();
      setTxResult(data);

      if (data.success) {
        toast.success('Transaction successful!');
        setStep(5);
      } else {
        toast.error(data.error || 'Transaction failed');
        setStep(5);
      }
    } catch (err) {
      setTxResult({ success: false, error: 'Network error. Please try again.' });
      toast.error('Network error');
      setStep(5);
    } finally {
      setExecuting(false);
    }
  };

  // Validate private key against selected wallet address (debounced)
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
        const sender = getSenderAddress();
        if (ids.walletIdCompressed === sender || ids.walletIdUncompressed === sender) {
          setPrivateKeyValid(true);
          setPrivateKeyError('');
        } else {
          setPrivateKeyValid(false);
          setPrivateKeyError('This private key does not match the selected wallet address');
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
  }, [privateKey, selectedWallet]);

  if (!session) return null;

  const senderAddr = getSenderAddress();
  const walletBalance = senderAddr ? (balances[senderAddr] || 0) : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/dashboard" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 dark:invert" />
            <span>Lana<span className="text-gold">.Discount</span></span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Dashboard
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
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-3xl">
        {/* Header */}
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Sell LanaCoin</h1>
          <p className="text-muted-foreground">
            Sell your registered LanaCoins and receive an instant cash payout.
          </p>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 3, 4, 5].map(s => (
            <div key={s} className="flex items-center gap-2">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                s === step ? 'bg-primary text-white' :
                s < step ? 'bg-primary/20 text-primary' :
                'bg-muted text-muted-foreground'
              }`}>
                {s < step ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : s}
              </div>
              {s !== 5 && <div className={`w-8 h-0.5 ${s < step ? 'bg-primary/40' : 'bg-border'}`} />}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {/* Rating status — always shown at top */}
            {ratingChecked && (userRating !== null && userRating >= 9) ? (
              <div className="flex items-center gap-3 rounded-xl border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-4 py-3 mb-4">
                <svg className="h-5 w-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                <span className="text-sm text-green-700 dark:text-green-400">
                  Payment Rating: <strong>{userRating}/10</strong> — Selling enabled
                </span>
              </div>
            ) : ratingChecked ? (
              <div className="rounded-2xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-6 text-center space-y-4 mb-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                  <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </div>
                <h2 className="text-xl font-bold text-red-700 dark:text-red-400">Selling Not Available</h2>
                <p className="text-sm text-red-600 dark:text-red-400 max-w-md mx-auto leading-relaxed">
                  Selling registered LanaCoins is only available to users who have fully paid their subscriptions and achieved a rating of 9 or above. Please settle any outstanding payments to unlock this feature.
                </p>
                {userRating !== null ? (
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-100 dark:bg-red-900/40">
                    <span className="text-sm font-medium text-red-700 dark:text-red-400">
                      Your current rating: {userRating}/10
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-red-500/70">No payment rating found for your account.</p>
                )}
              </div>
            ) : null}

            {/* Steps only shown when rating is OK */}
            {(!ratingChecked || (userRating !== null && userRating >= 9)) && (
            <>
            {/* ============ STEP 1: Select Wallet ============ */}
            {step === 1 && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">Select Wallet to Sell From</h2>

                  {wallets.length > 0 ? (
                    <div className="space-y-3 mb-6">
                      {wallets.map(w => {
                        const shortAddr = w.walletId.slice(0, 10) + '...' + w.walletId.slice(-6);
                        const isFrozen = !!w.freezeStatus;
                        return (
                          <button
                            key={w.walletId}
                            onClick={() => setSelectedWallet(w.walletId)}
                            className={`w-full rounded-xl border-2 px-5 py-4 text-left transition-all ${
                              selectedWallet === w.walletId
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-muted-foreground/30'
                            } ${isFrozen ? 'opacity-60' : ''}`}
                          >
                            <div className="flex items-start gap-4">
                              {/* Wallet info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-mono text-sm font-medium text-foreground">{shortAddr}</span>
                                  {isFrozen && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                                      Frozen
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  <span className="inline-flex items-center gap-1">
                                    <span className="font-medium text-foreground/70">Type:</span>
                                    {w.walletType}
                                  </span>
                                  {w.note && (
                                    <span className="inline-flex items-center gap-1">
                                      <span className="font-medium text-foreground/70">Note:</span>
                                      {w.note}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Balance */}
                              <div className="text-right flex-shrink-0">
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

                {/* Payout currency from profile */}
                {selectedCurrency && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Payout Currency</p>
                      <p className="text-sm font-semibold">{selectedCurrency}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Exchange Rate</p>
                      <p className="text-sm font-mono">1 LANA = {systemParams?.exchangeRates?.[selectedCurrency] || '...'} {selectedCurrency}</p>
                    </div>
                  </div>
                )}

                {/* UTXO consolidation warning */}
                {selectedWallet && tooManyUtxos && (
                  <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-2">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                      Wallet Consolidation Required
                    </p>
                    <p className="text-xs text-red-600 dark:text-red-500">
                      This wallet has <strong>{utxoCount} UTXOs</strong> which exceeds the maximum of {MAX_UTXOS} inputs per transaction.
                      You must consolidate your wallet before you can sell LANA.
                    </p>
                    <a href="https://youtu.be/kBi4MKcc4qM?si=bIeWS_dlgHjFproo" target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline">
                      Watch: How to consolidate your wallet
                    </a>
                  </div>
                )}

                {selectedWallet && utxoLoading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent inline-block" />
                    Checking wallet UTXOs...
                  </p>
                )}

                {/* Missing payout account warning */}
                {selectedCurrency && !getPayoutInfo() && (
                  <div className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                      Payout Account Required
                    </p>
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      No payout account found for <strong>{selectedCurrency}</strong> in your profile.
                      You must add your bank account details (IBAN, SWIFT/BIC) before you can sell LANA.
                    </p>
                    <a href="https://app.mejmosefajn.org/profile" target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline">
                      Go to Lana HUB Profile to add payment details
                    </a>
                  </div>
                )}

                <div className="flex justify-between">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Cancel
                  </Link>
                  <button
                    onClick={() => setStep(3)}
                    disabled={!getSenderAddress() || tooManyUtxos || utxoLoading || !selectedCurrency || !getPayoutInfo()}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      getSenderAddress() && !tooManyUtxos && !utxoLoading && selectedCurrency && getPayoutInfo()
                        ? 'bg-primary hover:bg-primary/90 shadow-lg'
                        : 'bg-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {/* ============ STEP 2: Select Currency ============ */}
            {step === 2 && systemParams && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">Select Payout Currency</h2>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                    {systemParams.activeCurrencies.map(code => {
                      const rate = systemParams.exchangeRates[code];
                      return (
                        <button
                          key={code}
                          onClick={() => setSelectedCurrency(code)}
                          className={`rounded-xl border-2 px-4 py-3 text-left transition-all ${
                            selectedCurrency === code
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-muted-foreground/30'
                          }`}
                        >
                          <div className="text-lg font-bold text-foreground">{code}</div>
                          {rate && (
                            <div className="text-xs text-muted-foreground">
                              1 LANA = {rate} {code}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Payout Account Info */}
                  {selectedCurrency && (
                    <div className="border-t border-border pt-4">
                      <h3 className="text-sm font-semibold text-foreground mb-2">Your Payout Account</h3>
                      {(() => {
                        const info = getPayoutInfo();
                        if (!info) {
                          return (
                            <div className="rounded-lg border border-red-200 bg-red-50/50 p-4">
                              <p className="text-sm text-red-700 font-medium mb-1">
                                No payout account found for {selectedCurrency}
                              </p>
                              <p className="text-xs text-red-600">
                                Your Nostr profile does not contain payment information for this currency.
                                Please update your profile with payout details (e.g. IBAN) before proceeding.
                              </p>
                            </div>
                          );
                        }
                        if (info.type === 'modern') {
                          const pm = info.method!;
                          return (
                            <div className="rounded-lg border border-green-200 bg-green-50/50 p-3 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">{pm.label || pm.scheme}</span>
                                {pm.verified && (
                                  <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">VERIFIED</span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">{SCHEME_LABELS[pm.scheme] || pm.scheme}</div>
                              {Object.entries(pm.fields).map(([key, val]) => (
                                <div key={key} className="text-xs">
                                  <span className="text-muted-foreground">{key}:</span>{' '}
                                  <span className="font-mono text-foreground">{String(val)}</span>
                                </div>
                              ))}
                            </div>
                          );
                        }
                        // Legacy
                        const bank = info.bank;
                        return (
                          <div className="rounded-lg border border-green-200 bg-green-50/50 p-3 space-y-1">
                            {bank.bankName && <div className="text-sm font-medium text-foreground">{bank.bankName}</div>}
                            {bank.bankAccount && (
                              <div className="text-xs"><span className="text-muted-foreground">Account:</span> <span className="font-mono">{bank.bankAccount}</span></div>
                            )}
                            {bank.bankSWIFT && (
                              <div className="text-xs"><span className="text-muted-foreground">SWIFT:</span> <span className="font-mono">{bank.bankSWIFT}</span></div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Exchange info */}
                  {systemParams.split && (
                    <div className="mt-4 text-xs text-muted-foreground">
                      Current SPLIT: {systemParams.split}
                    </div>
                  )}
                </div>

                <div className="flex justify-between">
                  <button onClick={() => setStep(1)} className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    disabled={!selectedCurrency || !getPayoutInfo()}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      selectedCurrency && getPayoutInfo() ? 'bg-primary hover:bg-primary/90 shadow-lg' : 'bg-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {/* ============ STEP 3: Enter Amount ============ */}
            {step === 3 && systemParams && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">Enter LANA Amount</h2>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Amount (LANA)</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={lanaAmount}
                          onChange={e => { setLanaAmount(e.target.value); setIsEmptyWallet(false); }}
                          placeholder="e.g. 100000"
                          min="1"
                          className="flex-1 rounded-lg border border-border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                        />
                        {walletBalance > 0 && (
                          <button
                            onClick={() => {
                              // Estimate fee: assume 1 input, 1 output (empty wallet = no change output)
                              const estimatedFeeLanoshis = Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5);
                              const feeLana = estimatedFeeLanoshis / 100000000;
                              const maxSendable = Math.max(0, walletBalance - feeLana);
                              setLanaAmount(String(maxSendable));
                              setIsEmptyWallet(true);
                            }}
                            className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/10 transition-colors"
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
                    </div>

                    {previewLoading && (
                      <p className="text-xs text-muted-foreground animate-pulse">Calculating payout...</p>
                    )}

                    {/* Minimum amount warning */}
                    {preview && preview.minSellAmountFiat > 0 && preview.grossFiat < preview.minSellAmountFiat && (
                      <div className="rounded-xl border-2 border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-4 flex items-center gap-3">
                        <svg className="h-5 w-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <p className="text-sm text-red-700 dark:text-red-400 font-medium">
                          Minimum sell value is <span className="font-mono font-bold">{CURRENCY_SYMBOLS[preview.currency] || ''}{preview.minSellAmountFiat} {preview.currency}</span>
                        </p>
                      </div>
                    )}

                    {/* Preview breakdown */}
                    {preview && (
                      <div className="rounded-xl border-2 border-primary/20 bg-primary/5 p-5 space-y-3">
                        <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Payout Breakdown</h3>

                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">LANA Amount</span>
                            <span className="font-mono font-bold text-foreground">{preview.lanaAmount.toLocaleString()} LANA</span>
                          </div>
                          {isEmptyWallet && preview.estimatedFee > 0 && (
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Network Fee (deducted)</span>
                              <span className="font-mono text-muted-foreground">{(preview.estimatedFee / 100000000).toFixed(8)} LANA</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Exchange Rate</span>
                            <span className="font-mono text-foreground">1 LANA = {preview.exchangeRate} {preview.currency}</span>
                          </div>
                          <div className="border-t border-border/50 pt-2 flex justify-between">
                            <span className="text-muted-foreground">Gross Value</span>
                            <span className="font-mono text-foreground">{CURRENCY_SYMBOLS[preview.currency] || ''}{preview.grossFiat.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-red-600">
                            <span>Commission ({preview.commissionPercent}%)</span>
                            <span className="font-mono">-{CURRENCY_SYMBOLS[preview.currency] || ''}{preview.commissionFiat.toFixed(2)}</span>
                          </div>
                          <div className="border-t-2 border-primary/30 pt-2 flex justify-between">
                            <span className="font-bold text-foreground">Your Payout</span>
                            <span className="font-mono font-bold text-lg text-primary">
                              {CURRENCY_SYMBOLS[preview.currency] || ''}{preview.netFiat.toFixed(2)} {preview.currency}
                            </span>
                          </div>
                        </div>

                        <div className="text-xs text-muted-foreground pt-1 space-y-0.5">
                          <div>From: <span className="font-mono font-medium text-foreground">{senderAddr.slice(0, 12)}...{senderAddr.slice(-8)}</span>
                            {(() => { const wt = wallets.find(w => w.walletId === selectedWallet)?.walletType; return wt ? <span className="ml-1 text-muted-foreground">({wt})</span> : null; })()}
                          </div>
                          <div>To buyback: <span className="font-mono">{preview.buybackWalletId.slice(0, 12)}...{preview.buybackWalletId.slice(-8)}</span></div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-between">
                  <button onClick={() => setStep(1)} className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back
                  </button>
                  <button
                    onClick={() => setStep(4)}
                    disabled={!preview || (preview.minSellAmountFiat > 0 && preview.grossFiat < preview.minSellAmountFiat)}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      preview && !(preview.minSellAmountFiat > 0 && preview.grossFiat < preview.minSellAmountFiat)
                        ? 'bg-primary hover:bg-primary/90 shadow-lg'
                        : 'bg-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    Proceed to Confirm
                  </button>
                </div>
              </div>
            )}

            {/* ============ STEP 4: Confirm + Private Key ============ */}
            {step === 4 && preview && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">Confirm Transaction</h2>

                  {/* Summary */}
                  <div className="rounded-xl bg-muted/30 p-4 space-y-2 text-sm mb-6">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">From Wallet</span>
                      <span className="font-mono text-foreground">{getSenderAddress().slice(0, 12)}...{getSenderAddress().slice(-8)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">To Buyback Wallet</span>
                      <span className="font-mono text-foreground">{preview.buybackWalletId.slice(0, 12)}...{preview.buybackWalletId.slice(-8)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount</span>
                      <span className="font-mono font-bold text-foreground">{preview.lanaAmount.toLocaleString()} LANA</span>
                    </div>
                    <div className="border-t border-border pt-2 flex justify-between">
                      <span className="font-bold text-foreground">Your Payout</span>
                      <span className="font-mono font-bold text-primary">
                        {CURRENCY_SYMBOLS[preview.currency] || ''}{preview.netFiat.toFixed(2)} {preview.currency}
                      </span>
                    </div>
                  </div>

                  {/* Private Key Input */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      WIF Private Key
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={privateKey}
                        onChange={e => setPrivateKey(e.target.value)}
                        placeholder="Enter your WIF private key"
                        className={`flex-1 rounded-lg border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-colors ${
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
                        className="rounded-lg border border-border bg-background px-4 py-3 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
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
                      <p className="mt-1.5 text-xs text-muted-foreground animate-pulse">Validating private key...</p>
                    )}
                    {!validatingKey && privateKeyValid === true && (
                      <p className="mt-1.5 text-xs text-green-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Private key matches the selected wallet
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === false && (
                      <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        {privateKeyError}
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === null && (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Your private key is used only to sign this transaction. It is never stored.
                      </p>
                    )}
                  </div>

                  {/* QR Scanner Modal */}
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
                </div>

                <div className="flex justify-between">
                  <button onClick={() => setStep(3)} className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back
                  </button>
                  <button
                    onClick={executeSell}
                    disabled={executing || !privateKey.trim() || privateKeyValid !== true}
                    className={`rounded-xl px-8 py-3 font-semibold text-white transition-all ${
                      executing || !privateKey.trim() || privateKeyValid !== true
                        ? 'bg-muted-foreground/30 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-700 shadow-lg'
                    }`}
                  >
                    {executing ? (
                      <span className="flex items-center gap-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Sending Transaction...
                      </span>
                    ) : 'Confirm & Send'}
                  </button>
                </div>
              </div>
            )}

            {/* ============ STEP 5: Result ============ */}
            {step === 5 && txResult && (
              <div className="space-y-6">
                <div className={`rounded-2xl border-2 p-8 text-center ${
                  txResult.success
                    ? 'border-green-200 bg-green-50/30'
                    : 'border-red-200 bg-red-50/30'
                }`}>
                  {txResult.success ? (
                    <>
                      <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                        <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <h2 className="text-2xl font-bold text-foreground mb-2">Transaction Broadcast!</h2>
                      <p className="text-muted-foreground mb-6">
                        Your LanaCoins have been sent to the network. Payout will be processed after blockchain confirmation.
                      </p>

                      <div className="rounded-xl bg-white/50 border border-green-200 p-4 space-y-2 text-sm text-left max-w-md mx-auto">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Amount Sold</span>
                          <span className="font-mono font-bold">{txResult.lanaAmount?.toLocaleString()} LANA</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Your Payout</span>
                          <span className="font-mono font-bold text-primary">
                            {CURRENCY_SYMBOLS[txResult.currency] || ''}{txResult.netFiat?.toFixed(2)} {txResult.currency}
                          </span>
                        </div>
                        <div className="border-t border-green-200 pt-2">
                          <span className="text-muted-foreground text-xs">TX Hash</span>
                          <div className="font-mono text-xs text-foreground break-all mt-0.5 select-all cursor-pointer" title="Click to copy">
                            {txResult.txHash}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="h-16 w-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                        <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </div>
                      <h2 className="text-2xl font-bold text-foreground mb-2">Transaction Failed</h2>
                      <p className="text-red-600 mb-4">{txResult.error}</p>
                    </>
                  )}
                </div>

                <div className="flex justify-center gap-4">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back to Dashboard
                  </Link>
                  {!txResult.success && (
                    <button
                      onClick={() => { setStep(4); setPrivateKey(''); setPrivateKeyValid(null); setPrivateKeyError(''); setTxResult(null); }}
                      className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                    >
                      Try Again
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
          )}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Instant LanaCoin Buyback
      </footer>
    </div>
  );
};

export default SellLana;
