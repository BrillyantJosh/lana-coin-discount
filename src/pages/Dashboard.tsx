import { useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

const Dashboard = () => {
  const { session, isAdmin, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  if (!session) return null;

  const displayName = session.profileDisplayName || session.profileName || 'User';
  const shortHex = session.nostrHexId.slice(0, 8) + '...' + session.nostrHexId.slice(-8);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <a href="/" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            Lana<span className="text-gold">.discount</span>
          </a>
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2">
              {session.profilePicture && (
                <img src={session.profilePicture} alt="" className="h-8 w-8 rounded-full object-cover" />
              )}
              <span className="text-sm font-medium text-foreground">{displayName}</span>
            </div>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      {/* Dashboard content */}
      <div className="flex-1 container mx-auto px-6 py-12">
        {/* Welcome */}
        <div className="mb-12 text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            Welcome, {displayName}
          </h1>
          <p className="text-muted-foreground text-sm font-mono">{shortHex}</p>
          {session.walletId && (
            <p className="text-muted-foreground text-xs">
              Wallet: <span className="font-mono">{session.walletId}</span>
            </p>
          )}
        </div>

        {/* Two main options */}
        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Option 1: Sell Registered Lana */}
          <div className="group relative rounded-2xl border-2 border-border bg-card p-8 hover:border-primary transition-colors cursor-pointer">
            <div className="space-y-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center">
                <svg className="h-7 w-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground">Sell Registered Lana</h2>
              <p className="text-muted-foreground leading-relaxed">
                Sell your registered LanaCoins and receive an instant 70% cash payout.
                Fast, secure, and straightforward.
              </p>
              <div className="pt-2">
                <span className="inline-flex items-center gap-1 text-primary font-semibold group-hover:gap-2 transition-all">
                  Get Started
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </div>
          </div>

          {/* Option 2: Register Wallets for Monitoring */}
          <Link to="/wallets" className="group relative rounded-2xl border-2 border-border bg-card p-8 hover:border-primary transition-colors cursor-pointer block">
            <div className="space-y-4">
              <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center">
                <svg className="h-7 w-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground">Register Wallets</h2>
              <p className="text-muted-foreground leading-relaxed">
                Submit wallet addresses you'd like us to monitor for buyback opportunities.
                We'll notify you when your coins are ready for instant payout.
              </p>
              <div className="pt-2">
                <span className="inline-flex items-center gap-1 text-primary font-semibold group-hover:gap-2 transition-all">
                  Register Wallets
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </div>
          </Link>
        </div>

        {/* Admin panel link — only visible to admins */}
        {isAdmin && (
          <div className="max-w-4xl mx-auto mt-8">
            <Link to="/admin" className="group relative rounded-2xl border-2 border-dashed border-red-300 bg-red-50/30 p-6 hover:border-red-400 transition-colors block">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-red-100 flex items-center justify-center">
                  <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-red-700">Admin Panel</h3>
                  <p className="text-sm text-red-600/80">View buyback stats, manage admins</p>
                </div>
                <svg className="h-5 w-5 text-red-400 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.discount — Instant LanaCoin Buyback
      </footer>
    </div>
  );
};

export default Dashboard;
