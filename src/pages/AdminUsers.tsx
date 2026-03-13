import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface AdminUser {
  hex_id: string;
  label: string | null;
  added_by: string | null;
  created_at: string;
}

const AdminUsers = () => {
  const { session, isLoading: authLoading, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newHexId, setNewHexId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchAdmins();
  }, [session, isAdmin]);

  const fetchAdmins = async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/admin/users', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAdmins(data.admins || []);
    } catch (err) {
      console.error('Failed to fetch admins:', err);
      toast.error('Failed to load admin list');
    } finally {
      setLoading(false);
    }
  };

  const addAdmin = async () => {
    if (!session) return;
    const hexId = newHexId.trim().toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(hexId)) {
      toast.error('Invalid HEX ID — must be exactly 64 lowercase hex characters');
      return;
    }

    setAdding(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({ hexId, label: newLabel.trim() || null }),
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }

      setAdmins(data.admins || []);
      setNewHexId('');
      setNewLabel('');
      toast.success('Admin added successfully');
    } catch (err) {
      console.error('Add admin error:', err);
      toast.error('Failed to add admin');
    } finally {
      setAdding(false);
    }
  };

  const removeAdmin = async (hexId: string) => {
    if (!session) return;
    setRemovingId(hexId);

    try {
      const res = await fetch(`/api/admin/users/${hexId}`, {
        method: 'DELETE',
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });

      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }

      setAdmins(data.admins || []);
      toast.success('Admin removed');
    } catch (err) {
      console.error('Remove admin error:', err);
      toast.error('Failed to remove admin');
    } finally {
      setRemovingId(null);
      setConfirmRemoveId(null);
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
            Lana<span className="text-gold">.Discount</span>
            <span className="ml-2 text-xs font-mono bg-red-100 text-red-700 px-2 py-0.5 rounded-full uppercase tracking-wider">Admin</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              User Dashboard
            </Link>
            <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Admin
            </Link>
            <Link to="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Settings
            </Link>
            <Link to="/admin/admins" className="text-sm text-foreground font-medium">
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
          <h1 className="text-3xl font-bold text-foreground">Manage Administrators</h1>
          <p className="text-muted-foreground">
            Add or remove admin access. Admins can view buyback stats and manage other admins.
          </p>
        </div>

        {/* Add admin form */}
        <div className="rounded-2xl border-2 border-border bg-card p-6 mb-8">
          <h2 className="text-lg font-semibold text-foreground mb-4">Add New Admin</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Nostr HEX ID *</label>
              <input
                type="text"
                value={newHexId}
                onChange={e => setNewHexId(e.target.value)}
                placeholder="64-character hex public key"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                maxLength={64}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {newHexId.length}/64 characters
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Label (optional)</label>
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. John Doe, Team Lead"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
              />
            </div>
            <button
              onClick={addAdmin}
              disabled={adding || newHexId.trim().length !== 64}
              className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                adding || newHexId.trim().length !== 64
                  ? 'bg-muted-foreground/30 cursor-not-allowed'
                  : 'bg-primary hover:bg-primary/90 shadow-lg hover:shadow-xl'
              }`}
            >
              {adding ? 'Adding...' : 'Add Admin'}
            </button>
          </div>
        </div>

        {/* Admin list */}
        <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Current Admins</h2>
            <span className="text-sm text-muted-foreground">{admins.length} admin(s)</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : admins.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No admins found.</div>
          ) : (
            <div className="divide-y divide-border/50">
              {admins.map(admin => {
                const isMe = admin.hex_id === session.nostrHexId;
                const shortHex = admin.hex_id.slice(0, 10) + '...' + admin.hex_id.slice(-8);
                const isConfirming = confirmRemoveId === admin.hex_id;
                const isRemoving = removingId === admin.hex_id;

                return (
                  <div key={admin.hex_id} className="px-6 py-4 flex items-center gap-4 hover:bg-muted/20 transition-colors">
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm font-medium text-foreground">{shortHex}</span>
                        {isMe && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                            You
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {admin.label && (
                          <span>
                            <span className="font-medium text-foreground/70">Label:</span> {admin.label}
                          </span>
                        )}
                        <span>
                          <span className="font-medium text-foreground/70">Added by:</span> {admin.added_by === 'system' ? 'System' : (admin.added_by?.slice(0, 8) + '...' || '—')}
                        </span>
                        <span>
                          <span className="font-medium text-foreground/70">Since:</span> {new Date(admin.created_at + 'Z').toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex-shrink-0">
                      {isMe ? (
                        <span className="text-xs text-muted-foreground italic">Cannot remove self</span>
                      ) : isConfirming ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => removeAdmin(admin.hex_id)}
                            disabled={isRemoving}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
                          >
                            {isRemoving ? 'Removing...' : 'Confirm'}
                          </button>
                          <button
                            onClick={() => setConfirmRemoveId(null)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRemoveId(admin.hex_id)}
                          disabled={admins.length <= 1}
                          className={`rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium transition-colors ${
                            admins.length <= 1
                              ? 'text-muted-foreground/30 cursor-not-allowed'
                              : 'text-red-600 hover:bg-red-50 hover:border-red-300'
                          }`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminUsers;
