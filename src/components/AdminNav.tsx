import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** The one screen that carries a count, so the badge knows where it belongs. */
const OFFERS_PATH = '/admin/offers';

/** How that screen tells the nav what it just saw, without a second request. */
export const OFFERS_COUNT_EVENT = 'lana:offers-awaiting';

const sections = [
  {
    label: 'Treasury Acquisitions',
    items: [
      { to: '/admin', label: 'Dashboard', desc: 'Stats & recent transactions' },
      { to: OFFERS_PATH, label: 'Offers', desc: 'Acquisitions awaiting a decision' },
      { to: '/admin/verify-tx', label: 'Verify TX', desc: 'Pending verifications' },
      { to: '/admin/payouts', label: 'Payouts', desc: 'Record & manage payouts' },
    ],
  },
  {
    label: 'Lana Sales',
    items: [
      { to: '/admin/incoming-payments', label: 'Incoming Payments', desc: 'FIAT from investors' },
      { to: '/admin/expecting-cashout', label: 'Expecting Cash Out', desc: 'EUR owed to prev-split investors' },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/admin/overview', label: 'Overview', desc: 'Rough feel: bought · paid · earned' },
      { to: '/admin/analytics', label: 'Analytics', desc: 'FIAT in · LANA out · reconciliation' },
    ],
  },
  {
    label: 'Admin Settings',
    items: [
      { to: '/admin/settings', label: 'Settings', desc: 'Wallet & currencies' },
      { to: '/admin/api-keys', label: 'API Keys', desc: 'External integrations' },
      { to: '/admin/admins', label: 'Admins', desc: 'Manage admin users' },
    ],
  },
];

const AdminNav = () => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // How many acquisitions a person still has to decide. This app has no
  // notification channel of any kind, and an offer that nobody looks at is a
  // counterparty left waiting — so the nav asks, cheaply: one small request a
  // minute, only while the tab is actually being looked at, and silent on
  // failure (a missing badge must never interrupt the work on the page).
  const [awaitingDecision, setAwaitingDecision] = useState(0);

  useEffect(() => {
    const hexId = session?.nostrHexId;
    if (!hexId) return;

    let alive = true;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const res = await fetch('/api/acquisitions/admin/queue', {
          headers: { 'x-admin-hex-id': hexId },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data.offers)) setAwaitingDecision(data.offers.length);
      } catch {
        // A badge is not worth a toast.
      }
    };

    // The Offers screen already knows the count after every decision, and it
    // says so — a decided offer must not sit in the badge for another minute.
    const onCount = (event: Event) => {
      const count = (event as CustomEvent<number>).detail;
      if (typeof count === 'number') setAwaitingDecision(count);
    };

    load();
    const timer = setInterval(load, 60_000);
    // Coming back to the tab is the moment the count is most likely stale.
    document.addEventListener('visibilitychange', load);
    window.addEventListener(OFFERS_COUNT_EVENT, onCount);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
      window.removeEventListener(OFFERS_COUNT_EVENT, onCount);
    };
  }, [session?.nostrHexId]);

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between h-14 sm:h-16">
        {/* Left: Logo + Admin badge */}
        <div className="flex items-center gap-3">
          <Link to="/admin" className="flex items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-7 w-7 sm:h-8 sm:w-8 dark:invert" />
            <span className="hidden sm:inline">Lana<span className="text-gold">.Discount</span></span>
          </Link>
          <span className="rounded-lg bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white uppercase tracking-wider">
            Admin
          </span>
        </div>

        {/* Right: Menu dropdown */}
        <div className="flex items-center gap-2">
          <Link
            to="/dashboard"
            className="hidden sm:inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mr-2"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
            </svg>
            User
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
                <span className="hidden sm:inline">Menu</span>
                {awaitingDecision > 0 && (
                  <span
                    title={`${awaitingDecision} acquisition offer${awaitingDecision !== 1 ? 's' : ''} awaiting a decision`}
                    className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-[10px] font-bold text-white flex-shrink-0 whitespace-nowrap"
                  >
                    {awaitingDecision}
                  </span>
                )}
                <svg className="h-3 w-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {sections.map((section, si) => (
                <div key={section.label}>
                  {si > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {section.label}
                  </DropdownMenuLabel>
                  {section.items.map(item => {
                    const isActive = location.pathname === item.to;
                    return (
                      <DropdownMenuItem key={item.to} asChild>
                        <Link
                          to={item.to}
                          className={`flex flex-col gap-0 cursor-pointer ${isActive ? 'bg-primary/5' : ''}`}
                        >
                          <span className={`flex items-center gap-2 min-w-0 text-sm ${isActive ? 'font-semibold text-primary' : 'font-medium'}`}>
                            <span className="truncate">{item.label}</span>
                            {item.to === OFFERS_PATH && awaitingDecision > 0 && (
                              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-[10px] font-bold text-white flex-shrink-0 whitespace-nowrap">
                                {awaitingDecision}
                              </span>
                            )}
                          </span>
                          <span className="text-[11px] text-muted-foreground leading-tight">{item.desc}</span>
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => { logout(); navigate('/'); }}
                className="text-red-600 focus:text-red-600 cursor-pointer"
              >
                <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3H15" />
                </svg>
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </nav>
  );
};

export default AdminNav;
