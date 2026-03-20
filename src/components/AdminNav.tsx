import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

interface AdminNavProps {
  active: 'admin' | 'verify-tx' | 'payouts' | 'settings' | 'api-keys' | 'admins';
}

const links = [
  { to: '/admin', key: 'admin', label: 'Admin' },
  { to: '/admin/verify-tx', key: 'verify-tx', label: 'Verify TX' },
  { to: '/admin/payouts', key: 'payouts', label: 'Payouts' },
  { to: '/admin/settings', key: 'settings', label: 'Settings' },
  { to: '/admin/api-keys', key: 'api-keys', label: 'API Keys' },
  { to: '/admin/admins', key: 'admins', label: 'Admins' },
] as const;

const AdminNav = ({ active }: AdminNavProps) => {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between h-14 sm:h-16">
        {/* Logo */}
        <Link to="/admin" className="flex items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
          <img src="/lana-logo.png" alt="Lana" className="h-7 w-7 sm:h-8 sm:w-8 dark:invert" />
          <span>Lana<span className="text-gold">.Discount</span></span>
        </Link>
        <Link
          to="/admin"
          className="rounded-lg bg-red-600 px-2.5 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-bold text-white uppercase tracking-wider hover:bg-red-700 transition-colors"
        >
          Admin
        </Link>

        {/* Desktop links */}
        <div className="hidden lg:flex items-center gap-4">
          <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            User Dashboard
          </Link>
          {links.map(l => (
            <Link
              key={l.key}
              to={l.to}
              className={`text-sm transition-colors ${active === l.key ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {l.label}
            </Link>
          ))}
          <button
            onClick={() => { logout(); navigate('/'); }}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Sign Out
          </button>
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="lg:hidden p-2 -mr-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Menu"
        >
          {menuOpen ? (
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="lg:hidden border-t border-border bg-background px-4 pb-4 pt-2 space-y-1">
          <Link
            to="/dashboard"
            onClick={() => setMenuOpen(false)}
            className="block px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            User Dashboard
          </Link>
          {links.map(l => (
            <Link
              key={l.key}
              to={l.to}
              onClick={() => setMenuOpen(false)}
              className={`block px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active === l.key
                  ? 'bg-primary/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {l.label}
            </Link>
          ))}
          <button
            onClick={() => { logout(); navigate('/'); }}
            className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
          >
            Sign Out
          </button>
        </div>
      )}
    </nav>
  );
};

export default AdminNav;
