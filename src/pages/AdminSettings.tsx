import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import {
  WALLET_CLASSES, CLASS_LABELS, DEFAULT_DUE_DAYS,
  currencyEnabledKey, classEnabledKey, autoCapKey, dueDaysKey,
  type WalletClass,
} from '../../server/lib/treasuryMandate';

const CURRENCY_LABELS: Record<string, string> = {
  EUR: 'Euro (EUR)',
  USD: 'US Dollar (USD)',
  GBP: 'British Pound (GBP)',
  CHF: 'Swiss Franc (CHF)',
  CZK: 'Czech Koruna (CZK)',
  PLN: 'Polish Złoty (PLN)',
  HRK: 'Croatian Kuna (HRK)',
  RSD: 'Serbian Dinar (RSD)',
  HUF: 'Hungarian Forint (HUF)',
  BAM: 'Bosnian Mark (BAM)',
};

/**
 * What the auto-cap field currently means, in the words of the person who has
 * to live with it. Kept in exact step with `readCap` in treasuryMandate.ts —
 * including its cautious reading of a typo as 0 — because the gap between
 * empty and zero is where this screen can do real damage: empty removes the
 * ceiling, zero removes the automation, and they look almost the same.
 */
function capMeaning(raw: string, currency: string): { text: string; tone: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      text: 'No ceiling — every offer of this class is priced and offered automatically, whatever its size.',
      tone: 'text-amber-700 dark:text-amber-400',
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    return {
      text: 'Not a number — the server reads this as 0, so nothing would be automatic.',
      tone: 'text-red-600',
    };
  }
  if (n === 0) {
    return {
      text: 'Never automatic — every offer of this class goes to a person to decide.',
      tone: 'text-muted-foreground',
    };
  }
  return {
    text: `Automatic up to ${n} ${currency}. Anything larger goes to a person to decide.`,
    tone: 'text-muted-foreground',
  };
}

/** A yes/no the size of a word, in the visual language of the currency grid. */
const MandateToggle = ({ on, onChange, labelOn, labelOff }: {
  on: boolean;
  onChange: (next: boolean) => void;
  labelOn: string;
  labelOff: string;
}) => (
  <button
    onClick={() => onChange(!on)}
    className={`inline-flex items-center gap-2 rounded-lg border-2 px-3 py-1.5 text-xs font-bold transition-all flex-shrink-0 whitespace-nowrap ${
      on
        ? 'border-primary bg-primary/5 text-primary'
        : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/30'
    }`}
  >
    <span className={`h-3.5 w-3.5 flex-shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
      on ? 'bg-primary border-primary' : 'border-muted-foreground/40'
    }`}>
      {on && (
        <svg className="h-2 w-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </span>
    {on ? labelOn : labelOff}
  </button>
);

const AdminSettings = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Bank accounts state
  interface BankAccount { currency: string; recipientName: string; bankName: string; bankSwift: string; bankAccount: string }
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [savingBanks, setSavingBanks] = useState(false);

  // Settings state
  const [walletId, setWalletId] = useState('');
  const [activeCurrencies, setActiveCurrencies] = useState<string[]>([]);
  const [availableCurrencies, setAvailableCurrencies] = useState<string[]>([]);

  // Commission state
  const [commissionLanapays, setCommissionLanapays] = useState('21');
  const [commissionOther, setCommissionOther] = useState('30');
  const [initialCommissionLanapays, setInitialCommissionLanapays] = useState('21');
  const [initialCommissionOther, setInitialCommissionOther] = useState('30');

  // Minimum sell amounts per currency
  const [minSellAmounts, setMinSellAmounts] = useState<Record<string, string>>({});
  const [initialMinSellAmounts, setInitialMinSellAmounts] = useState<Record<string, string>>({});

  // Treasury mandate — the raw `acq_*` app_settings, held as the flat map the
  // server stores rather than a shaped object, so the key builders in
  // treasuryMandate.ts stay the single definition of what a setting is called.
  const [mandate, setMandate] = useState<Record<string, string>>({});
  const [initialMandate, setInitialMandate] = useState<Record<string, string>>({});

  // Track initial values for dirty check
  const [initialWalletId, setInitialWalletId] = useState('');
  const [initialCurrencies, setInitialCurrencies] = useState<string[]>([]);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchSettings();
  }, [session, isAdmin]);

  const fetchSettings = async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/admin/settings', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const bwId = data.settings.buyback_wallet_id || '';
      let currencies: string[] = [];
      try { currencies = JSON.parse(data.settings.active_currencies || '[]'); } catch {}

      setWalletId(bwId);
      setActiveCurrencies(currencies);
      setAvailableCurrencies(data.availableCurrencies || []);
      setInitialWalletId(bwId);
      setInitialCurrencies(currencies);

      // Fallbacks match the server (priceAcquisition: lanapays 21, other 30).
      // They used to be the other way round here.
      const cLp = data.settings.commission_lanapays || '21';
      const cOt = data.settings.commission_other || '30';
      setCommissionLanapays(cLp);
      setCommissionOther(cOt);
      setInitialCommissionLanapays(cLp);
      setInitialCommissionOther(cOt);

      // Load minimum sell amounts per currency
      const mins: Record<string, string> = {};
      for (const key of Object.keys(data.settings)) {
        if (key.startsWith('min_sell_')) {
          const curr = key.replace('min_sell_', '').toUpperCase();
          mins[curr] = data.settings[key] || '0';
        }
      }
      setMinSellAmounts(mins);
      setInitialMinSellAmounts({ ...mins });

      // Every acquisition setting the server actually has. Keys it does not
      // have are left absent on purpose: the fallbacks below reproduce what
      // the mandate would do with a missing row, so the screen shows the
      // behaviour rather than a guess at it.
      const acq: Record<string, string> = {};
      for (const key of Object.keys(data.settings)) {
        if (key.startsWith('acq_')) acq[key] = data.settings[key] ?? '';
      }
      setMandate(acq);
      setInitialMandate({ ...acq });

      // Fetch bank accounts
      try {
        const bankRes = await fetch('/api/admin/bank-accounts', {
          headers: { 'x-admin-hex-id': session.nostrHexId },
        });
        const bankData = await bankRes.json();
        setBankAccounts(bankData.accounts || []);
      } catch {}
    } catch (err) {
      console.error('Failed to load settings:', err);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const toggleCurrency = (code: string) => {
    setActiveCurrencies(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    );
  };

  // ─── treasury mandate helpers ───────────────────────────────────────────
  // The fallbacks are not house preferences; they are what readMandateSettings
  // does with an absent row: closed unless told otherwise, no ceiling on an
  // unset cap, and the framework's outer horizon for an unset due date.

  const mandateValue = (key: string, fallback: string) =>
    mandate[key] !== undefined ? mandate[key] : fallback;

  const setMandateValue = (key: string, value: string) =>
    setMandate(prev => ({ ...prev, [key]: value }));

  const currencyOpen = (currency: string) =>
    mandateValue(currencyEnabledKey(currency), 'false') === 'true';

  const classOpen = (currency: string, cls: WalletClass) =>
    mandateValue(classEnabledKey(currency, cls), 'false') === 'true';

  /**
   * The full mandate for every active currency, including the rows the server
   * has never had. Saving the effective state (rather than only the fields
   * that were touched) means a currency switched on today gets a real mandate
   * written for it instead of inheriting whatever an absent row means.
   */
  const mandatePayload = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const currency of activeCurrencies) {
      out[currencyEnabledKey(currency)] = mandateValue(currencyEnabledKey(currency), 'false');
      for (const cls of WALLET_CLASSES) {
        out[classEnabledKey(currency, cls)] = mandateValue(classEnabledKey(currency, cls), 'false');
        out[autoCapKey(currency, cls)] = mandateValue(autoCapKey(currency, cls), '').trim();
        out[dueDaysKey(currency, cls)] = mandateValue(dueDaysKey(currency, cls), String(DEFAULT_DUE_DAYS));
      }
    }
    return out;
  };

  const hasChanges = (() => {
    if (walletId !== initialWalletId) return true;
    if (activeCurrencies.length !== initialCurrencies.length) return true;
    if (activeCurrencies.some(c => !initialCurrencies.includes(c))) return true;
    if (commissionLanapays !== initialCommissionLanapays) return true;
    if (commissionOther !== initialCommissionOther) return true;
    for (const curr of activeCurrencies) {
      if ((minSellAmounts[curr] || '0') !== (initialMinSellAmounts[curr] || '0')) return true;
    }
    // A mandate row the server has never had counts as a change too — writing
    // it is what turns an implied default into a decision someone made.
    for (const [key, value] of Object.entries(mandatePayload())) {
      if ((initialMandate[key] ?? '') !== value) return true;
    }
    return false;
  })();

  const saveSettings = async () => {
    if (!session) return;

    if (activeCurrencies.length === 0) {
      toast.error('Select at least one currency');
      return;
    }

    setSaving(true);
    try {
      const acq = mandatePayload();
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({
          buyback_wallet_id: walletId.trim(),
          active_currencies: activeCurrencies,
          commission_lanapays: commissionLanapays,
          commission_other: commissionOther,
          min_sell_amounts: minSellAmounts,
          mandate_settings: acq,
        }),
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }

      // The endpoint answers with the whole settings map, so we can check that
      // the mandate actually landed instead of trusting a 200. An endpoint
      // that quietly ignores a field it does not know would otherwise leave
      // this screen showing a green "Saved" over a treasury mandate that never
      // changed — the one lie a settings page must never tell. Absent and ''
      // are compared as equal because the mandate reads them the same way.
      const dropped = Object.entries(acq)
        .filter(([key, value]) => (data.settings?.[key] ?? '') !== value)
        .map(([key]) => key);
      if (dropped.length > 0) {
        console.error('Mandate settings not persisted:', dropped);
        toast.error(
          `Treasury mandate NOT saved — the server ignored ${dropped.length} setting(s). Everything else was saved.`,
        );
        return;
      }

      setInitialWalletId(walletId.trim());
      setInitialCurrencies([...activeCurrencies]);
      setInitialCommissionLanapays(commissionLanapays);
      setInitialCommissionOther(commissionOther);
      setInitialMinSellAmounts({ ...minSellAmounts });
      setInitialMandate({ ...mandate, ...acq });
      toast.success('Settings saved');
    } catch (err) {
      console.error('Save settings error:', err);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || !session || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-4xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">App Settings</h1>
          <p className="text-muted-foreground">
            Configure the buyback wallet and supported currencies for the discount service.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading settings...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Buyback Wallet ID */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Buyback Wallet</h2>
              <p className="text-sm text-muted-foreground mb-4">
                The main LanaCoin wallet address used to receive and send LANA for the buyback service.
              </p>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Wallet Address</label>
                <input
                  type="text"
                  value={walletId}
                  onChange={e => setWalletId(e.target.value)}
                  placeholder="LxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxX"
                  className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Must be a valid LanaCoin address starting with <span className="font-mono font-medium">L</span>.
                  Leave empty if not yet configured.
                </p>
              </div>
            </div>

            {/* Active Currencies */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Active Currencies</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Select which fiat currencies the buyback service accepts for payout. At least one currency must be active.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {availableCurrencies.map(code => {
                  const isActive = activeCurrencies.includes(code);
                  return (
                    <button
                      key={code}
                      onClick={() => toggleCurrency(code)}
                      className={`rounded-xl border-2 px-4 py-3 text-left transition-all ${
                        isActive
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-background hover:border-muted-foreground/30'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`h-4 w-4 flex-shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
                          isActive ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                        }`}>
                          {isActive && (
                            <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <span className="text-sm font-bold text-foreground">{code}</span>
                          <p className="text-[10px] text-muted-foreground leading-tight">{CURRENCY_LABELS[code]?.replace(` (${code})`, '') || code}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {activeCurrencies.length} of {availableCurrencies.length} currencies active
              </p>
            </div>

            {/* Commission Rates */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Commission Rates</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Set the buyback commission percentage per wallet type. The commission is deducted from the gross FIAT payout.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    Fallback for LanaPays.Us proposals without a mandate (admin review only)
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={commissionLanapays}
                      onChange={e => setCommissionLanapays(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-4 py-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-bold">%</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Financer wallets under a financing-round mandate are priced at the <span className="font-medium">round discount</span> (Round dates &amp; discounts).
                    This value applies only to a LanaPays.Us proposal with no mandate, which always goes to a person to decide.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Other Wallets</label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={commissionOther}
                      onChange={e => setCommissionOther(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-4 py-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-bold">%</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Applied for all other wallet types (personal wallets, etc.).
                  </p>
                </div>
              </div>
            </div>

            {/* Treasury mandate — the decision to buy, made before anyone
                offers. Commission above says what we pay; this says whether
                we are buying at all, from whom, and how large an acquisition
                goes through without a person looking at it. */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Treasury Mandate</h2>
              <p className="text-sm text-muted-foreground mb-4">
                What Lana.discount acquires, per currency and per wallet class, and how large an acquisition
                is priced automatically. Anything above the ceiling waits for a person on the Offers screen.
              </p>

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-5">
                <p className="text-xs text-amber-800 leading-relaxed">
                  <strong className="font-bold">An empty ceiling is not a ceiling of 0.</strong> Leave the field
                  empty and there is <strong className="font-bold">no limit</strong> — every offer of that class is
                  priced and offered automatically, however large. Type <span className="font-mono font-bold">0</span> and
                  <strong className="font-bold"> nothing is automatic</strong> — every offer waits for a person.
                  Getting these two the wrong way round either removes the limit or stops the business.
                </p>
              </div>

              {activeCurrencies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active currencies. Enable currencies above first.</p>
              ) : (
                <div className="space-y-4">
                  {activeCurrencies.map(currency => {
                    const open = currencyOpen(currency);
                    // A currency switched on since the last deploy has no rows
                    // of its own yet; the fields below show what the mandate
                    // would do meanwhile, and saving makes it a real decision.
                    const unwritten = initialMandate[currencyEnabledKey(currency)] === undefined;

                    return (
                      <div key={currency} className="rounded-xl border border-border p-4 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm font-bold text-foreground flex-shrink-0">{currency}</span>
                          <span className="text-xs text-muted-foreground min-w-0 truncate">
                            {CURRENCY_LABELS[currency]?.replace(` (${currency})`, '') || currency}
                          </span>
                          {unwritten && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 flex-shrink-0 whitespace-nowrap">
                              Not written yet
                            </span>
                          )}
                          <div className="ml-auto flex-shrink-0">
                            <MandateToggle
                              on={open}
                              onChange={next => setMandateValue(currencyEnabledKey(currency), next ? 'true' : 'false')}
                              labelOn={`Acquiring in ${currency}`}
                              labelOff={`Closed in ${currency}`}
                            />
                          </div>
                        </div>

                        {!open && (
                          <p className="text-xs text-muted-foreground">
                            Every offer settled in {currency} is declined, whatever the classes below say.
                          </p>
                        )}

                        <div className={`space-y-3 ${open ? '' : 'opacity-50'}`}>
                          {WALLET_CLASSES.map(cls => {
                            const capRaw = mandateValue(autoCapKey(currency, cls), '');
                            const meaning = capMeaning(capRaw, currency);
                            const classIsOpen = classOpen(currency, cls);

                            return (
                              <div key={cls} className="rounded-lg border border-border/70 bg-background/40 p-3 space-y-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-semibold text-foreground min-w-0 truncate">
                                    {CLASS_LABELS[cls]}
                                  </span>
                                  <div className="ml-auto flex-shrink-0">
                                    <MandateToggle
                                      on={classIsOpen}
                                      onChange={next => setMandateValue(classEnabledKey(currency, cls), next ? 'true' : 'false')}
                                      labelOn="Acquiring"
                                      labelOff="Not acquiring"
                                    />
                                  </div>
                                </div>

                                {!classIsOpen ? (
                                  <p className="text-xs text-muted-foreground">
                                    Offers of {CLASS_LABELS[cls]} LANA settled in {currency} are declined.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="min-w-0">
                                      <label className="block text-xs font-medium text-foreground mb-1">
                                        Automatic up to ({currency})
                                      </label>
                                      {/* Text, not number: an empty number input is
                                          easy to produce by accident, and here empty
                                          means the opposite of zero. */}
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        value={capRaw}
                                        onChange={e => setMandateValue(autoCapKey(currency, cls), e.target.value)}
                                        placeholder="empty = no ceiling"
                                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                                      />
                                      <p className={`mt-1 text-[11px] leading-snug ${meaning.tone}`}>{meaning.text}</p>
                                    </div>

                                    <div className="min-w-0">
                                      <label className="block text-xs font-medium text-foreground mb-1">
                                        Settle within (days)
                                      </label>
                                      <input
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={mandateValue(dueDaysKey(currency, cls), String(DEFAULT_DUE_DAYS))}
                                        onChange={e => setMandateValue(dueDaysKey(currency, cls), e.target.value)}
                                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                                      />
                                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                        Days from acceptance by which we owe the purchase price. Blank or 0 falls back
                                        to {DEFAULT_DUE_DAYS}.
                                      </p>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Buyback window — stated, never editable. The whole settlement
                model rests on it: only the Split before the current one is
                bought back. Changing it is a code change, reviewed and
                deployed, not a click on an admin screen. */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Buyback Window</h2>
              <p className="text-sm text-muted-foreground">
                LANA is bought back from wallets registered in <strong className="text-foreground">the Split before the current one</strong>, and
                from no other. The current Split is still running, and older Splits have already passed.
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                This is fixed and cannot be changed here — the rest of the settlement model depends on it.
              </p>
            </div>

            {/* Minimum Sell Amount per Currency */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Minimum Sell Amount</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Set the minimum FIAT payout value per currency. If the gross value of a sale is below this amount, the user cannot proceed. Set to 0 to allow any amount.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {activeCurrencies.map(curr => (
                  <div key={curr}>
                    <label className="block text-sm font-medium text-foreground mb-1.5">{curr}</label>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={minSellAmounts[curr] || '0'}
                        onChange={e => setMinSellAmounts(prev => ({ ...prev, [curr]: e.target.value }))}
                        className="w-full rounded-lg border border-border bg-background px-4 py-3 pr-14 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold">{curr}</span>
                    </div>
                  </div>
                ))}
              </div>
              {activeCurrencies.length === 0 && (
                <p className="text-sm text-muted-foreground">No active currencies. Enable currencies above first.</p>
              )}
            </div>

            {/* Bank Accounts per Currency */}
            <div className="rounded-2xl border-2 border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-1">Bank Accounts</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Bank accounts where investors send FIAT payments to Lana Discount. Each active currency should have its own bank account.
              </p>
              <div className="space-y-4">
                {bankAccounts.map((a, i) => (
                  <div key={i} className="rounded-xl border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <select value={a.currency}
                        onChange={e => { const arr = [...bankAccounts]; arr[i] = { ...arr[i], currency: e.target.value }; setBankAccounts(arr); }}
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/30">
                        {activeCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button onClick={() => setBankAccounts(prev => prev.filter((_, j) => j !== i))}
                        className="text-sm text-destructive hover:text-destructive/80 transition-colors">Remove</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Recipient Name</label>
                        <input value={a.recipientName}
                          onChange={e => { const arr = [...bankAccounts]; arr[i] = { ...arr[i], recipientName: e.target.value }; setBankAccounts(arr); }}
                          placeholder="Company Name"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Bank Name</label>
                        <input value={a.bankName || ''}
                          onChange={e => { const arr = [...bankAccounts]; arr[i] = { ...arr[i], bankName: e.target.value }; setBankAccounts(arr); }}
                          placeholder="Revolut Bank UAB"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">SWIFT / BIC</label>
                        <input value={a.bankSwift || ''}
                          onChange={e => { const arr = [...bankAccounts]; arr[i] = { ...arr[i], bankSwift: e.target.value }; setBankAccounts(arr); }}
                          placeholder="REVOLT21"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">IBAN / Account</label>
                        <input value={a.bankAccount || ''}
                          onChange={e => { const arr = [...bankAccounts]; arr[i] = { ...arr[i], bankAccount: e.target.value }; setBankAccounts(arr); }}
                          placeholder="LT98 3250 0089 3025 3738"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={() => setBankAccounts(prev => [...prev, { currency: activeCurrencies[0] || 'EUR', recipientName: '', bankName: '', bankSwift: '', bankAccount: '' }])}
                  className="rounded-xl border-2 border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  + Add Bank Account
                </button>
                <button
                  onClick={async () => {
                    setSavingBanks(true);
                    try {
                      await fetch('/api/admin/bank-accounts', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'x-admin-hex-id': session!.nostrHexId },
                        body: JSON.stringify({ accounts: bankAccounts }),
                      });
                      toast.success('Bank accounts saved');
                    } catch { toast.error('Failed to save bank accounts'); }
                    setSavingBanks(false);
                  }}
                  disabled={savingBanks}
                  className={`rounded-xl px-6 py-2.5 font-semibold text-white transition-all ${
                    savingBanks ? 'bg-muted-foreground/30 cursor-not-allowed' : 'bg-primary hover:bg-primary/90'
                  }`}
                >
                  {savingBanks ? 'Saving...' : 'Save Bank Accounts'}
                </button>
              </div>
            </div>

            {/* Save button */}
            <div className="flex items-center justify-between">
              <div>
                {hasChanges && (
                  <p className="text-sm text-amber-600 font-medium">You have unsaved changes</p>
                )}
              </div>
              <button
                onClick={saveSettings}
                disabled={saving || !hasChanges}
                className={`rounded-xl px-8 py-3 font-semibold text-white transition-all ${
                  saving || !hasChanges
                    ? 'bg-muted-foreground/30 cursor-not-allowed'
                    : 'bg-primary hover:bg-primary/90 shadow-lg hover:shadow-xl'
                }`}
              >
                {saving ? 'Saving...' : hasChanges ? 'Save Settings' : 'Saved'}
              </button>
            </div>
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

export default AdminSettings;
