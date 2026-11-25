/**
 * Where the private key lives after a sign-in (Brilly, 25. 11. 2026 — the same as LetsBalance.world): in this tab's
 * memory, never in localStorage. Until that day the session kept it there in plain text for 30 or 90 days; a session
 * saved like that is rewritten without the key the first time this version reads it. Every key here is a fresh random
 * TEST key; the server is a stub that says "admin".
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // This runner's own localStorage has no methods (Node's, without a file): a plain one.
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' && typeof localStorage.clear === 'function') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
});
import { AuthProvider, useAuth } from './AuthContext';
import { convertWifToIds } from '@/lib/crypto';
import { forgetHeldKey, heldKeyHex } from '@/lib/heldKey';

const SESSION_KEY = 'lana_discount_session';

function testWallet() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return (async () => {
    const payload = new Uint8Array([0xb0, ...key, 0x01]);
    const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
    const full = new Uint8Array([...payload, ...h2.slice(0, 4)]);
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + Array.from(full, (b) => b.toString(16).padStart(2, '0')).join(''));
    let wif = '';
    while (n > 0n) { wif = alphabet[Number(n % 58n)] + wif; n /= 58n; }
    return { wif, ...convertWifToIds(wif) };
  })();
}

const server = vi.fn(async (url: any) => {
  if (String(url).includes('/api/session/role')) return { ok: true, status: 200, json: async () => ({ role: 'admin' }) };
  return { ok: true, status: 200, json: async () => ({}) };
}) as any;

let auth: ReturnType<typeof useAuth>;
const Probe = () => {
  auth = useAuth();
  return (
    <div>
      <span data-testid="session">{auth.session ? auth.session.nostrHexId : 'none'}</span>
      <span data-testid="locked">{auth.locked ? auth.locked.nostrHexId : 'none'}</span>
      <span data-testid="loading">{auth.isLoading ? 'yes' : 'no'}</span>
    </div>
  );
};
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(() => { localStorage.clear(); forgetHeldKey(); vi.stubGlobal('fetch', server); });
afterEach(() => { vi.unstubAllGlobals(); forgetHeldKey(); });

describe('the private key after a sign-in', () => {
  it('is held in this tab, and the browser keeps only the public part', async () => {
    const w = await testWallet();
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('no'));
    await act(async () => { await auth.login(w.wif); });
    expect(screen.getByTestId('session')).toHaveTextContent(w.nostrHexId);
    expect(auth.session?.nostrPrivateKey).toBe(w.nostrPrivateKey);
    const stored = localStorage.getItem(SESSION_KEY)!;
    expect(JSON.parse(stored).nostrHexId).toBe(w.nostrHexId);
    expect(JSON.parse(stored).role).toBe('admin');
    expect(stored).not.toContain(w.nostrPrivateKey);
    expect(stored).not.toContain(w.wif);
    expect(stored).not.toMatch(/PrivateKey/);
    expect(heldKeyHex()).toBe(w.nostrHexId);
  });

  it('is gone after a reload: the person is remembered, locked, and nothing is asked without the key', async () => {
    const w = await testWallet();
    const first = mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('no'));
    await act(async () => { await auth.login(w.wif); });
    first.unmount();
    forgetHeldKey(); // a reload empties the tab's memory
    server.mockClear();

    mount();
    await waitFor(() => expect(screen.getByTestId('locked')).toHaveTextContent(w.nostrHexId));
    expect(screen.getByTestId('session')).toHaveTextContent('none');
    expect(server).not.toHaveBeenCalled();
  });

  it('an old session with the key in plain text is rewritten without it at once', async () => {
    const w = await testWallet();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      lanaPrivateKey: w.wif, nostrPrivateKey: w.nostrPrivateKey, nostrHexId: w.nostrHexId, walletId: w.walletId,
      nostrNpubId: w.nostrNpubId, expiresAt: Date.now() + 86_400_000,
    }));
    mount();
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent(w.nostrHexId));
    const stored = localStorage.getItem(SESSION_KEY)!;
    expect(stored).not.toContain(w.nostrPrivateKey);
    expect(stored).not.toContain(w.wif);
    expect(heldKeyHex()).toBe(w.nostrHexId);
  });

  it('signing out takes the key out of memory too', async () => {
    const w = await testWallet();
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('no'));
    await act(async () => { await auth.login(w.wif); });
    act(() => auth.logout());
    expect(screen.getByTestId('session')).toHaveTextContent('none');
    expect(screen.getByTestId('locked')).toHaveTextContent('none');
    expect(heldKeyHex()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
