import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { convertWifToIds } from '@/lib/crypto';
import { SimplePool } from 'nostr-tools';
import { askSessionRole, type SessionRole } from '@/lib/sessionRole';
import { holdKey, forgetHeldKey, onHeldKeyChange, heldKeyHex } from '@/lib/heldKey';
import { VaultError, discardSavedRecord, saveVault, unlockVault, type VaultMethod } from '@/lib/keyVault';

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

/**
 * What this browser keeps of a session: everything EXCEPT the private key (Brilly, 25. 11. 2026 — the same as
 * LetsBalance.world). The key itself is only in this tab's memory (lib/heldKey.ts), or encrypted on this device
 * (lib/keyVault.ts), never in localStorage as it was until then (30 or 90 days, in plain text).
 */
export type StoredSession = Omit<UserSession, 'lanaPrivateKey' | 'nostrPrivateKey'>;

/** How a sign-in also saves the key encrypted on this device (only the sign-in page offers it). */
export interface SaveKeyChoice {
  method: VaultMethod;
  password?: string;
  repeat?: string;
}

/** The session without its key: what may be written to this browser's storage. */
const publicPart = (s: UserSession | StoredSession): StoredSession => {
  const { lanaPrivateKey: _wif, nostrPrivateKey: _key, ...rest } = s as UserSession;
  return rest;
};
const hasKey = (s: unknown): s is UserSession =>
  !!s && typeof (s as UserSession).nostrPrivateKey === 'string' && /^[0-9a-f]{64}$/i.test((s as UserSession).nostrPrivateKey);

interface AuthContextType {
  /** The signed-in session WITH its key — only while this tab holds the key. */
  session: UserSession | null;
  /** Someone is remembered on this device, but this tab does not hold their key: unlock, or sign in again. */
  locked: StoredSession | null;
  isLoading: boolean;
  isAdmin: boolean;
  /** Why the last key given was not kept, until the next sign-in. */
  refusal: SignInRefusal | null;
  /** With refusal 'SIGNATURE': the signature gate's reason (STALE, BAD_TIME, HOST_MISMATCH…), or null. */
  refusalReason: string | null;
  login: (wif: string, relays?: string[], rememberMe?: boolean, save?: SaveKeyChoice | null) => Promise<UserSession>;
  /** Unlock the key saved encrypted on this device (passkey, or its password) and sign in with it. */
  unlock: (password: string, relays?: string[]) => Promise<UserSession>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SESSION_KEY = 'lana_discount_session';

/** Write the session — never its key. */
function writeStoredSession(s: UserSession | StoredSession): void {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(publicPart(s))); } catch { /* private mode */ }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [locked, setLocked] = useState<StoredSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const sessionRef = useRef<UserSession | null>(null);
  sessionRef.current = session;
  const [refusal, setRefusal] = useState<SignInRefusal | null>(null);
  const [refusalReason, setRefusalReason] = useState<string | null>(null);

  const isSessionValid = (s: StoredSession): boolean => s.expiresAt > Date.now();

  /**
   * The remembered session. One saved before 25. 11. 2026 still carries the private key in plain text: it is
   * rewritten WITHOUT the key at once (the key stays in this tab's memory only); nothing else on the device has it.
   */
  const loadSessionFromStorage = useCallback((): UserSession | StoredSession | null => {
    try {
      const stored = localStorage.getItem(SESSION_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as UserSession | StoredSession;
        if (parsed && typeof parsed.nostrHexId === 'string' && isSessionValid(parsed)) {
          if ('lanaPrivateKey' in parsed || 'nostrPrivateKey' in parsed) writeStoredSession(parsed);
          return parsed;
        }
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
    // Without its key (every session written since 25. 11. 2026, after a reload) nothing can be asked or signed:
    // the person is remembered, LOCKED — unlock the saved key, or sign in again (both ask the server again).
    if (!hasKey(stored)) {
      setLocked(publicPart(stored));
      setIsLoading(false);
      return;
    }
    // A session from before, with its key: this tab carries it on in memory, asked about as before.
    try { holdKey(stored.nostrHexId, stored.nostrPrivateKey, false); } catch { setLocked(publicPart(stored)); setIsLoading(false); return; }
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
        forgetHeldKey();
        setSession(null);
        setRefusal('NOT_ALLOWED');
        setRefusalReason(null);
      } else if (role === 'admin' || role === 'financer') {
        const checked: UserSession = { ...stored, role, isAdmin: role === 'admin' };
        writeStoredSession(checked);
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

  // The held key went away by itself (lib/heldKey.ts: 15 minutes without use, page left, copy removed elsewhere):
  // keep who it was, and lock — every page needs the key, so the sign-in page unlocks it again.
  useEffect(() => onHeldKeyChange(() => {
    const current = sessionRef.current;
    if (current && heldKeyHex() !== current.nostrHexId) {
      setLocked(publicPart(current));
      setSession(null);
    }
  }), []);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden' && session) writeStoredSession(session);
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [session]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === SESSION_KEY) {
        if (event.newValue === null) { forgetHeldKey(); setSession(null); setLocked(null); return; }
        try {
          const updated = JSON.parse(event.newValue) as UserSession | StoredSession;
          if (!updated || typeof updated.nostrHexId !== 'string' || !isSessionValid(updated)) return;
          // A tab still running the version before 25. 11. wrote the key back: take it out again. Another tab's key
          // never comes across — this tab keeps its own, or is locked.
          if ('lanaPrivateKey' in updated || 'nostrPrivateKey' in updated) writeStoredSession(updated);
          const pub = publicPart(updated);
          const current = sessionRef.current;
          if (current && current.nostrHexId === pub.nostrHexId) {
            setSession({ ...current, ...pub, lanaPrivateKey: current.lanaPrivateKey, nostrPrivateKey: current.nostrPrivateKey });
            return;
          }
          if (current) forgetHeldKey();
          setSession(null);
          setLocked(pub);
        } catch {}
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const login = async (wif: string, relays?: string[], rememberMe = false, save: SaveKeyChoice | null = null): Promise<UserSession> => {
    const derivedIds = convertWifToIds(wif.trim());
    // Saving comes FIRST, right after the click: a passkey can only be created while the browser still counts the
    // person's click, and the checks below wait on the network. If the sign-in then fails or is refused, exactly
    // what was saved here is taken back.
    const savedRecord = save
      ? await saveVault(derivedIds.lanaPrivateKey, derivedIds.nostrHexId, save.method, save.password ?? '', save.repeat)
      : null;
    try {
      // a key saved just now is held like an unlocked one: forgotten after 15 minutes without use
      return await finishLogin(derivedIds, relays, rememberMe, !!save);
    } catch (error) {
      if (savedRecord) discardSavedRecord(savedRecord);
      throw error;
    }
  };

  const unlock = async (password: string, relays?: string[]): Promise<UserSession> => {
    const opened = await unlockVault(password);
    const derivedIds = convertWifToIds(opened.wif);
    opened.wif = '';
    // The record is bound to its id; a key that derives to another id is never used.
    if (derivedIds.nostrHexId !== opened.pubkey) throw new VaultError('other_identity');
    return finishLogin(derivedIds, relays, true, true);
  };

  const finishLogin = async (derivedIds: ReturnType<typeof convertWifToIds>, relays: string[] | undefined, rememberMe: boolean, fromVault: boolean): Promise<UserSession> => {
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
      forgetHeldKey();
      setSession(null);
      setLocked(null);
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

    holdKey(userSession.nostrHexId, userSession.nostrPrivateKey, fromVault);
    setSession(userSession);
    setLocked(null);
    writeStoredSession(userSession);
    return userSession;
  };

  /** Sign out: the key leaves this tab's memory. A copy saved encrypted on this device stays until removed there. */
  const logout = () => {
    forgetHeldKey();
    setSession(null);
    setLocked(null);
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  };

  const isAdmin = session?.isAdmin === true;

  return (
    <AuthContext.Provider value={{ session, locked, isLoading, isAdmin, refusal, refusalReason, login, unlock, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
