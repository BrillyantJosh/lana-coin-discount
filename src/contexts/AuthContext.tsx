import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import { SimplePool } from 'nostr-tools';

declare global {
  interface Document {
    wasDiscarded?: boolean;
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
  expiresAt: number;
}

interface AuthContextType {
  session: UserSession | null;
  isLoading: boolean;
  isAdmin: boolean;
  login: (wif: string, relays?: string[], rememberMe?: boolean) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SESSION_KEY = 'lana_discount_session';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  useEffect(() => {
    const s = loadSessionFromStorage();
    if (s) setSession(s);
    setIsLoading(false);
  }, [loadSessionFromStorage]);

  useEffect(() => {
    if (document.wasDiscarded) {
      const s = loadSessionFromStorage();
      if (s) setSession(s);
    }
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

  const login = async (wif: string, relays?: string[], rememberMe = false) => {
    const derivedIds = convertWifToIds(wif);

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

    // Check admin status
    let adminStatus = false;
    try {
      const adminRes = await fetch(`/api/admin/check/${derivedIds.nostrHexId}`);
      const adminData = await adminRes.json();
      adminStatus = adminData.isAdmin === true;
    } catch {
      // Admin check is non-blocking
    }

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
      expiresAt: Date.now() + expirationDays * 24 * 60 * 60 * 1000,
    };

    setSession(userSession);
    localStorage.setItem(SESSION_KEY, JSON.stringify(userSession));
  };

  const logout = () => {
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
  };

  const isAdmin = session?.isAdmin === true;

  return (
    <AuthContext.Provider value={{ session, isLoading, isAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
