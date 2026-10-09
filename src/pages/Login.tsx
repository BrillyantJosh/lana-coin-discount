import { useState, useEffect, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, SignInRefused, type SignInRefusal } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { SellingMovedNotice, NOTICE_TEXT, useNoticeLang } from '@/components/SellingMovedNotice';
import { SELLING_CLOSED } from '@/lib/sellingClosed';
import { landingFor } from '@/lib/sessionRole';
import { SIGN_IN_GATE_TEXT, type SignInGateText } from '@/copy';

const QrScanner = lazy(() => import('@/components/QrScanner'));

/** The signature gate's reasons for a device clock more than a minute off (server/lib/nip98Auth.ts), as nip98Fetch's explainSignatureFailure reads them. */
const CLOCK_REASONS = ['STALE', 'BAD_TIME'];

/** What the page says about a key that was not kept, in the reader's language. */
function refusedText(gate: SignInGateText, refusal: SignInRefusal, reason: string | null): { title: string; body: string } {
  if (refusal === 'NOT_ALLOWED') return { title: gate.notAllowedTitle, body: gate.notAllowed };
  if (refusal === 'SIGNATURE') {
    return { title: gate.signatureTitle, body: CLOCK_REASONS.includes(reason ?? '') ? gate.clock : gate.signature };
  }
  return { title: gate.uncheckedTitle, body: gate.unchecked };
}

const Login = () => {
  const [wif, setWif] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [relays, setRelays] = useState<string[]>([]);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const { login, session, refusal, refusalReason } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  // Where to go once signed in: a financer to /financer, an administrator where
  // they always went (?next= only when it names a page in AFTER_SIGN_IN).
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next');
  // One language for the notice and the form under it. Before sign-in there is
  // no profile to read it from, so it starts from the browser.
  const [lang, setLang] = useNoticeLang();
  const t = NOTICE_TEXT[lang];
  const gate = SIGN_IN_GATE_TEXT[lang];
  const refused = refusal ? refusedText(gate, refusal, refusalReason) : null;

  // If already logged in, go where that key lands
  useEffect(() => {
    if (session) navigate(landingFor(session, next));
  }, [session, navigate, next]);

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
      const signedIn = await login(wif, relays, rememberMe);
      toast({ title: "Welcome!", description: "Login successful." });
      navigate(landingFor(signedIn, next));
    } catch (error) {
      // Said on the page itself, in the reader's language (below), not in a toast that goes away.
      if (error instanceof SignInRefused) {
        setWif('');
        return;
      }
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
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 dark:invert" />
            <span>Lana<span className="text-gold">.Discount</span></span>
          </a>
        </div>
      </nav>

      {/* Where selling went (8 Oct 2026). Above the form, because most people
          who arrive here came to sell — and the form below no longer leads to
          a sale: it is for sellers who are still owed, and for the admins. */}
      {SELLING_CLOSED && (
        <div className="px-4 sm:px-6 pt-8 sm:pt-12">
          <div className="w-full max-w-2xl mx-auto">
            <SellingMovedNotice lang={lang} onLangChange={setLang} signInNote={false} />
          </div>
        </div>
      )}

      {/* Login form */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-8">
          {/* Why the key just given — or the session kept from before — was not kept (9 Oct 2026). */}
          {refused && (
            <div
              role="alert"
              data-testid="sign-in-refused"
              lang={lang}
              className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-5 text-left space-y-2"
            >
              <p className="font-semibold text-foreground">{refused.title}</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{refused.body}</p>
            </div>
          )}

          <div className="text-center space-y-2">
            <img src="/lana-logo.png" alt="Lana" className="h-16 w-16 mx-auto dark:invert" />
            {SELLING_CLOSED ? (
              <>
                <h2 className="text-3xl font-bold text-foreground">{t.signInTitle}</h2>
                <p className="text-muted-foreground">{t.signInIntro}</p>
                <p className="text-muted-foreground">{t.signInKeyIntro}</p>
              </>
            ) : (
              <>
                <h1 className="text-3xl font-bold text-foreground">Sign In</h1>
                <p className="text-muted-foreground">
                  Enter your LanaCoin WIF private key to access your account.
                </p>
              </>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="wif" className="text-sm font-medium text-foreground">
                {t.signInKeyLabel}
              </label>
              <div className="flex gap-2">
                <input
                  id="wif"
                  type="password"
                  placeholder={t.signInKeyPlaceholder}
                  value={wif}
                  onChange={(e) => setWif(e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowQrScanner(true)}
                  className="rounded-lg border border-border bg-background px-3 py-3 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title="Scan QR code"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </button>
              </div>
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
                {t.signInRemember}
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
                  {t.signInSubmitting}
                </span>
              ) : t.signInSubmit}
            </button>
          </form>

          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              {t.signInKeyLocal}
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

      {/* QR Scanner Modal */}
      {showQrScanner && (
        <Suspense fallback={null}>
          <QrScanner
            onScan={(value: string) => {
              setWif(value);
              setShowQrScanner(false);
              toast({ title: "QR Scanned", description: "WIF key captured from QR code." });
            }}
            onClose={() => setShowQrScanner(false)}
          />
        </Suspense>
      )}
    </div>
  );
};

export default Login;
