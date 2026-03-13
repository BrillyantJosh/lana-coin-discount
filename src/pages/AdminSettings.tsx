import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

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

const AdminSettings = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Settings state
  const [walletId, setWalletId] = useState('');
  const [activeCurrencies, setActiveCurrencies] = useState<string[]>([]);
  const [availableCurrencies, setAvailableCurrencies] = useState<string[]>([]);

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

  const hasChanges = (() => {
    if (walletId !== initialWalletId) return true;
    if (activeCurrencies.length !== initialCurrencies.length) return true;
    if (activeCurrencies.some(c => !initialCurrencies.includes(c))) return true;
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
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({
          buyback_wallet_id: walletId.trim(),
          active_currencies: activeCurrencies,
        }),
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }

      setInitialWalletId(walletId.trim());
      setInitialCurrencies([...activeCurrencies]);
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
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/admin" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            Lana<span className="text-gold">.discount</span>
            <span className="ml-2 text-xs font-mono bg-red-100 text-red-700 px-2 py-0.5 rounded-full uppercase tracking-wider">Admin</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              User Dashboard
            </Link>
            <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Admin
            </Link>
            <Link to="/admin/settings" className="text-sm text-foreground font-medium">
              Settings
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
      <div className="flex-1 container mx-auto px-6 py-12 max-w-4xl">
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
        Lana.discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminSettings;
