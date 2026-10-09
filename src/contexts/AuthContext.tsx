import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import { SimplePool } from 'nostr-tools';
import { askSessionRole, type SessionRole } from '@/lib/sessionRole';

/**
 * Why there is no session although a key was given (owner, 9 Oct 2026): NOT_ALLOWED — the server says the key is
 * neither an administrator nor a financer (lana.discount is now only for them); UNCHECKED — the server could not say,
 * so no new session was kept; SIGNATURE — the server refused the signature of the sign-in itself (SIGNATURE_REQUIRED;
 * the context's `refusalReason` says why — most often a device clock more than a minute off), which trying again
 * unchanged cannot mend. The sign-in page says it (src/copy.ts SIGN_IN_GATE).
 */
export type SignInRefusal = 'NOT_ALLOWED' | 'UNCHECKED' | 'SIGNATURE';

const REFUSED_MESSAGE: Record<SignInRefusal, string> = {
  NOT_ALLOWED: 'This key cannot sign in here.',
  UNCHECKED: 'Signing in could not be checked right now.',
  SIGNATURE: 'The signature of this sign-in was refused.',
};

/** Thrown by login() when the key may not sign in, or that could not be checked; the context's `refusal` says the same. */
export class SignInRefused extends Error {
  readonly code: SignInRefusal;
  constructor(code: SignInRefusal) {
    super(REFUSED_MESSAGE[code]);
    this.name = 'SignInRefused';
    this.code = code;
  }
}

export interface UserSession {
  lanaPrivateKey: string;
  walletId: string;
  walletIdCompressed?: string;
  walletIdUncompressed?: string;
  isCompressed?: boolean;
  nostrHexId: string;
  nostrNpubId: string;
  nostrPrivateKey: string;
  lanaWalletID?: string;
  profileName?: string;
  profileDisplayName?: string;
  profilePicture?: string;
  isAdmin?: boolean;
  /** What the server said this key is (GET /api/session/role). A session kept from before 9 Oct 2026 has none until asked. */
  role?: Exclude<SessionRole, 'none'>;
  expiresAt: number;
}

interface AuthContextType {
  session: UserSession | null;
  isLoading: boolean;
  isAdmin: boolean;
  /** Why the last key given was not kept, until the next sign-in. */
  refusal: SignInRefusal | null;
  /** With refusal 'SIGNATURE': the signature gate's reason (STALE, BAD_TIME, HOST_MISMATCH…), or null. */
  refusalReason: string | null;
  login: (wif: string, relays?: string[], rememberMe?: boolean) => Promise<UserSession>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SESSION_KEY = 'lana_discount_session';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refusal, setRefusal] = useState<SignInRefusal | null>(null);
  const [refusalReason, setRefusalReason] = useState<string | null>(null);

  const isSessionValid = (s: UserSession): boolean => s.expiresAt > Date.now();

  const loadSessionFromStorage = useCallback((): UserSession | null => {
    try {
      const stored = localStorage.getItem(SESSION_KEY);
      if (stored) {
        const parsed: UserSession = JSON.parse(stored);
        if (isSessionValid(parsed)) return parsed;
        localStorage.removeItem(SESSION_KEY);
      }
    } catch {}
    return null;
  }, []);

  // A session kept from before (up to 90 days; a tab the browser discarded and brought back loads here too) is asked
  // about again before it is used: since 9 Oct 2026 a key that is neither an administrator nor a financer is signed
  // out, and told why on the sign-in page. Until the answer, there is no session and isLoading stays true. No answer
  // (Direct.Fund or the network away) keeps it as it was, asked again on the next load: what it may read or move,
  // every route decides again on its own.
  useEffect(() => {
    const stored = loadSessionFromStorage();
    if (!stored) {
      setIsLoading(false);
      return;
    }
    let alive = true;
    void askSessionRole(stored.nostrPrivateKey).then((asked) => {
      if (!alive) return;
      // A sign-in in the meantime (this tab or another) is newer than this answer.
      if (loadSessionFromStorage()?.nostrHexId !== stored.nostrHexId) {
        setIsLoading(false);
        return;
      }
      const role = asked.ok === true ? asked.role : null;
      if (role === 'none') {
        try { localStorage.removeItem(SESSION_KEY); } catch {}
        setSession(null);
        setRefusal('NOT_ALLOWED');
        setRefusalReason(null);
      } else if (role === 'admin' || role === 'financer') {
        const checked: UserSession = { ...stored, role, isAdmin: role === 'admin' };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(checked)); } catch {}
        setSession(checked);
      } else {
        setSession(stored);
      }
      setIsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [loadSessionFromStorage]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden' && session) {
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [session]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === SESSION_KEY) {
        if (event.newValue === null) { setSession(null); return; }
        try {
          const updated: UserSession = JSON.parse(event.newValue);
          if (isSessionValid(updated)) setSession(updated);
        } catch {}
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const login = async (wif: string, relays?: string[], rememberMe = false): Promise<UserSession> => {
    const derivedIds = convertWifToIds(wif);
    setRefusal(null);
    setRefusalReason(null);

    // Who this key is here, asked before anything else and before anything is kept (owner, 9 Oct 2026): only an
    // administrator or a financer signs in. Anyone else — and anyone when the server cannot say — keeps no session;
    // one kept before is cleared too. A refused SIGNATURE is told apart from "could not be checked": a device clock
    // a minute off fails every retry the same way, and the page must say to fix the clock, not to try again later.
    const asked = await askSessionRole(derivedIds.nostrPrivateKey);
    if (asked.ok === false || asked.role === 'none') {
      const code: SignInRefusal =
        asked.ok === true ? 'NOT_ALLOWED' : asked.code === 'SIGNATURE_REQUIRED' ? 'SIGNATURE' : 'UNCHECKED';
      setSession(null);
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      setRefusal(code);
      setRefusalReason(asked.ok === false && code === 'SIGNATURE' ? asked.reason : null);
      throw new SignInRefused(code);
    }
    const role = asked.role;

    let profileName: string | undefined;
    let profileDisplayName: string | undefined;
    let profilePicture: string | undefined;
    let lanaWalletID: string | undefined;

    // Fetch KIND 0 from relays
    if (relays && relays.length > 0) {
      const pool = new SimplePool();
      try {
        const profileEvent = await Promise.race([
          pool.get(relays, { kinds: [0], authors: [derivedIds.nostrHexId], limit: 1 }),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
        ]);

        if (profileEvent && profileEvent.kind === 0) {
          try {
            const content = JSON.parse(profileEvent.content);
            profileName = content.name;
            profileDisplayName = content.display_name;
            profilePicture = content.picture;
            lanaWalletID = content.lanaWalletID;
          } catch {}
        } else {
          throw new Error('Profile not found. Please create your Lana profile first.');
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'TIMEOUT') {
          pool.close(relays);
          throw new Error('Network timeout. Please try again.');
        }
        throw err;
      } finally {
        pool.close(relays);
      }
    }

    // Register user on server
    try {
      await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nostrHexId: derivedIds.nostrHexId,
          npub: derivedIds.nostrNpubId,
          walletId: derivedIds.walletId,
          walletIdCompressed: derivedIds.walletIdCompressed,
          walletIdUncompressed: derivedIds.walletIdUncompressed,
        }),
      });
    } catch {
      // Server registration is non-blocking - user can still use the app
    }

    // An administrator is what the signed answer above says: the same roster the admin routes check.
    const adminStatus = role === 'admin';

    const expirationDays = rememberMe ? 90 : 30;
    const userSession: UserSession = {
      lanaPrivateKey: derivedIds.lanaPrivateKey,
      walletId: derivedIds.walletId,
      walletIdCompressed: derivedIds.walletIdCompressed,
      walletIdUncompressed: derivedIds.walletIdUncompressed,
      isCompressed: derivedIds.isCompressed,
      nostrHexId: derivedIds.nostrHexId,
      nostrNpubId: derivedIds.nostrNpubId,
      nostrPrivateKey: derivedIds.nostrPrivateKey,
      lanaWalletID,
      profileName,
      profileDisplayName,
      profilePicture,
      isAdmin: adminStatus,
      role,
      expiresAt: Date.now() + expirationDays * 24 * 60 * 60 * 1000,
    };

    setSession(userSession);
    localStorage.setItem(SESSION_KEY, JSON.stringify(userSession));
    return userSession;
  };

  const logout = () => {
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
  };

  const isAdmin = session?.isAdmin === true;

  return (
    <AuthContext.Provider value={{ session, isLoading, isAdmin, refusal, refusalReason, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
