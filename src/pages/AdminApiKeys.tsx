import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface ApiKey {
  id: number;
  app_name: string;
  label: string | null;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  is_active: number;
}

const AdminApiKeys = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [appName, setAppName] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchKeys();
  }, [session, isAdmin]);

  const fetchKeys = async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/admin/api-keys', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setApiKeys(data.apiKeys || []);
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
      toast.error('Failed to load API keys');
    } finally {
      setLoading(false);
    }
  };

  const createKey = async () => {
    if (!session || !appName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/admin/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({ appName: appName.trim(), label: label.trim() || null }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setNewKey(data.apiKey.key);
      setAppName('');
      setLabel('');
      await fetchKeys();
      toast.success(`API key created for "${data.apiKey.appName}"`);
    } catch (err) {
      console.error('Create API key error:', err);
      toast.error('Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const toggleKey = async (id: number, currentActive: number) => {
    if (!session) return;
    setTogglingId(id);
    try {
      const res = await fetch(`/api/admin/api-keys/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({ isActive: !currentActive }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setApiKeys(data.apiKeys || []);
      toast.success(`API key ${currentActive ? 'deactivated' : 'activated'}`);
    } catch (err) {
      toast.error('Failed to update API key');
    } finally {
      setTogglingId(null);
    }
  };

  const deleteKey = async (id: number) => {
    if (!session) return;
    try {
      const res = await fetch(`/api/admin/api-keys/${id}`, {
        method: 'DELETE',
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setApiKeys(data.apiKeys || []);
      setConfirmDeleteId(null);
      toast.success('API key deleted');
    } catch (err) {
      toast.error('Failed to delete API key');
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return '\u2014';
    try {
      return new Date(iso + 'Z').toLocaleDateString('sl-SI', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
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
            <Link to="/admin/payouts" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Payouts
            </Link>
            <Link to="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Settings
            </Link>
            <Link to="/admin/api-keys" className="text-sm text-foreground font-medium">
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
      <div className="flex-1 container mx-auto px-6 py-12 max-w-4xl">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold text-foreground">API Keys</h1>
          <p className="text-muted-foreground">
            Manage API keys for external applications to submit sale transactions.
          </p>
        </div>

        {/* New key reveal modal */}
        {newKey && (
          <div className="rounded-2xl border-2 border-green-300 bg-green-50 p-6 mb-8">
            <div className="flex items-start gap-3">
              <svg className="h-6 w-6 text-green-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-green-800 mb-1">API Key Created</h3>
                <p className="text-sm text-green-700 mb-3">
                  Copy this key now. It will <span className="font-bold">not be shown again</span>.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white border border-green-200 rounded-lg px-4 py-3 font-mono text-sm text-green-900 break-all select-all">
                    {newKey}
                  </code>
                  <button
                    onClick={() => copyToClipboard(newKey)}
                    className={`rounded-lg px-4 py-3 text-sm font-bold transition-colors flex-shrink-0 ${
                      copied
                        ? 'bg-green-600 text-white'
                        : 'bg-green-100 text-green-700 hover:bg-green-200'
                    }`}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <button
                  onClick={() => setNewKey(null)}
                  className="mt-3 text-sm text-green-600 hover:text-green-800 font-medium"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Create key form */}
        <div className="rounded-2xl border-2 border-border bg-card p-6 mb-8">
          <h2 className="text-lg font-semibold text-foreground mb-4">Create New API Key</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Application Name *</label>
              <input
                type="text"
                value={appName}
                onChange={e => setAppName(e.target.value)}
                placeholder="e.g. Lana Direct Fund, Trading Bot"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Production key, Test key"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
              />
            </div>
            <button
              onClick={createKey}
              disabled={creating || !appName.trim()}
              className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                creating || !appName.trim()
                  ? 'bg-muted-foreground/30 cursor-not-allowed'
                  : 'bg-primary hover:bg-primary/90 shadow-lg hover:shadow-xl'
              }`}
            >
              {creating ? 'Creating...' : 'Generate API Key'}
            </button>
          </div>
        </div>

        {/* API keys list */}
        <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Active Keys</h2>
            <span className="text-sm text-muted-foreground">{apiKeys.length} key(s)</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : apiKeys.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No API keys created yet.</div>
          ) : (
            <div className="divide-y divide-border/50">
              {apiKeys.map(key => {
                const isConfirming = confirmDeleteId === key.id;
                const isToggling = togglingId === key.id;

                return (
                  <div key={key.id} className={`px-6 py-4 hover:bg-muted/20 transition-colors ${!key.is_active ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-foreground">{key.app_name}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            key.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {key.is_active ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {key.label && (
                            <span><span className="font-medium text-foreground/70">Label:</span> {key.label}</span>
                          )}
                          <span><span className="font-medium text-foreground/70">Created:</span> {formatDate(key.created_at)}</span>
                          <span>
                            <span className="font-medium text-foreground/70">Last used:</span>{' '}
                            {key.last_used_at ? formatDate(key.last_used_at) : 'Never'}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => toggleKey(key.id, key.is_active)}
                          disabled={isToggling}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                            key.is_active
                              ? 'border-amber-200 text-amber-600 hover:bg-amber-50'
                              : 'border-green-200 text-green-600 hover:bg-green-50'
                          }`}
                        >
                          {isToggling ? '...' : key.is_active ? 'Disable' : 'Enable'}
                        </button>

                        {isConfirming ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => deleteKey(key.id)}
                              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(key.id)}
                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* API usage docs */}
        <div className="mt-8 rounded-2xl border-2 border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">API Usage</h2>
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="font-medium text-foreground mb-1">Submit a sale</h3>
              <pre className="bg-muted/50 rounded-lg p-4 text-xs font-mono overflow-x-auto text-foreground/80">
{`POST /api/external/sale
Authorization: Bearer ldk_your_key_here
Content-Type: application/json

{
  "tx_hash": "abc123...",
  "sender_wallet_id": "Lxxx...",
  "buyback_wallet_id": "Lyyy...",
  "lana_amount": 500000,
  "currency": "EUR",
  "exchange_rate": 0.000008,
  "commission_percent": 30,
  "user_hex_id": "optional_64char_hex",
  "tx_fee_lanoshis": 0
}`}
              </pre>
            </div>
            <div>
              <h3 className="font-medium text-foreground mb-1">Check sale status</h3>
              <pre className="bg-muted/50 rounded-lg p-4 text-xs font-mono overflow-x-auto text-foreground/80">
{`GET /api/external/sale/:transactionId
Authorization: Bearer ldk_your_key_here`}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminApiKeys;
