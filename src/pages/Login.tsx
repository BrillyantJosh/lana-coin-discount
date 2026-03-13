import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

const Login = () => {
  const [wif, setWif] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [relays, setRelays] = useState<string[]>([]);
  const { login, session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  // If already logged in, redirect to dashboard
  useEffect(() => {
    if (session) navigate('/dashboard');
  }, [session, navigate]);

  // Fetch relays on mount
  useEffect(() => {
    fetch('/api/relays')
      .then(r => r.json())
      .then(data => setRelays(data.relays || []))
      .catch(() => setRelays(['wss://relay.lanavault.space', 'wss://relay.lanacoin-eternity.com']));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wif.trim()) {
      toast({ title: "Error", description: "Please enter your WIF private key", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      await login(wif, relays, rememberMe);
      toast({ title: "Welcome!", description: "Login successful." });
      navigate('/dashboard');
    } catch (error) {
      toast({
        title: "Login failed",
        description: error instanceof Error ? error.message : "Invalid WIF key",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-6 flex items-center h-16">
          <a href="/" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8" />
            Lana<span className="text-gold">.Discount</span>
          </a>
        </div>
      </nav>

      {/* Login form */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-2">
            <img src="/lana-logo.png" alt="Lana" className="h-16 w-16 mx-auto" />
            <h1 className="text-3xl font-bold text-foreground">Sign In</h1>
            <p className="text-muted-foreground">
              Enter your LanaCoin WIF private key to access your account.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="wif" className="text-sm font-medium text-foreground">
                WIF Private Key
              </label>
              <input
                id="wif"
                type="password"
                placeholder="Enter your WIF key..."
                value={wif}
                onChange={(e) => setWif(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                autoComplete="off"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="remember"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <label htmlFor="remember" className="text-sm text-muted-foreground">
                Remember me for 90 days (otherwise 30 days)
              </label>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-lg bg-primary px-6 py-3 text-lg font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </span>
              ) : 'Sign In'}
            </button>
          </form>

          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              Your private key is processed locally in your browser and never sent to our servers.
            </p>
          </div>

          {/* Relay status */}
          <div className="text-center text-xs text-muted-foreground">
            {relays.length > 0 ? (
              <span className="text-green-500">Connected to {relays.length} relay{relays.length > 1 ? 's' : ''}</span>
            ) : (
              <span className="text-yellow-500">Connecting to relays...</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
