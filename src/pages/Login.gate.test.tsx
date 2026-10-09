/**
 * ONLY THE FINANCING COMPANIES AND THE ADMINISTRATORS SIGN IN (owner, 9 Oct 2026).
 *
 * "Torej imamo po novem samo dva uporabnika direct.lana.fund in lana.discount"
 * — and the administrators, who watch from behind. The sign-in page asks the
 * server who the key is (GET /api/session/role, signed with that very key)
 * before it keeps anything:
 *   - 'none': no session, nothing registered, the reason on the page in
 *     Slovenian and English — and no dashboard;
 *   - 'financer': to /financer;
 *   - 'admin': where an administrator always landed (the dashboard, or ?next=);
 *   - no answer: no session, "could not be checked";
 *   - the signature refused: no session, and why — a device clock off is
 *     told to fix the clock, never to "try again shortly".
 * A session kept from before (up to 90 days) is asked again on load: 'none'
 * signs it out with the same words, before any page uses it.
 *
 * The real AuthProvider, Login and Dashboard; fetch is stubbed; the key is a
 * throwaway one drawn in this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { verifyEvent } from 'nostr-tools/pure';
import { AuthProvider } from '@/contexts/AuthContext';
import Login from './Login';
import Dashboard from './Dashboard';
import { convertWifToIds } from '@/lib/crypto';
import { SIGN_IN_GATE, SIGN_IN_GATE_SL, SIGN_IN_GATE_TEXT, SELLING_MOVED } from '@/copy';
import { NOTICE_TEXT } from '@/components/SellingMovedNotice';
import { TWO_FIRMS } from '@/test/buyingDealersFixture';
import { throwawayWallet, wifOf } from '@/test/financerFixtures';

const SESSION_KEY = 'lana_discount_session';

type Reply = { status: number; body: unknown } | 'no-answer';
let roleReply: Reply = { status: 200, body: { role: 'none' } };
let calls: Array<{ url: string; method: string; authorization: string | null }> = [];

/** The browser's storage, one per test (the test runner's own global is not a whole Storage). */
let store = new Map<string, string>();

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any = {}) => {
      const u = String(url);
      const method = String(init.method || 'GET').toUpperCase();
      calls.push({ url: u, method, authorization: new Headers(init.headers).get('authorization') });
      const answer = (r: Reply) => {
        if (r === 'no-answer') throw new TypeError('Failed to fetch');
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
      };
      if (u === '/api/session/role') return answer(roleReply);
      if (u.includes('/api/buying-dealers')) return answer({ status: 200, body: TWO_FIRMS });
      if (u === '/api/relays') return answer({ status: 200, body: { relays: [] } });
      if (u === '/api/login' && method === 'POST') return answer({ status: 200, body: { success: true } });
      // The dashboard an administrator lands on reads their own record.
      if (/^\/api\/user\/[0-9a-f]{64}\/sales$/.test(u)) return answer({ status: 200, body: { sales: [] } });
      if (u.startsWith('/api/acquisitions/mine/')) return answer({ status: 200, body: { offers: [] } });
      throw new TypeError(`offline: ${method} ${u}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const key = () => {
  const wif = wifOf(throwawayWallet(true).privateKey, true);
  return { wif, ids: convertWifToIds(wif) };
};

const draw = (entry: string) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/financer" element={<p>FINANCER PAGE</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const signIn = async (wif: string) => {
  // The relays are read first; the form signs in with them.
  await waitFor(() => expect(calls.some((c) => c.url === '/api/relays')).toBe(true));
  fireEvent.change(screen.getByLabelText('WIF Private Key'), { target: { value: wif } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
};

const roleCalls = () => calls.filter((c) => c.url === '/api/session/role');
const stored = () => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
};

/** The signed event a role request carried: who signed it, for which address, and whether the signature holds. */
const signedBy = (authorization: string | null) => {
  expect(authorization).toMatch(/^Nostr /);
  const ev = JSON.parse(atob(String(authorization).slice('Nostr '.length)));
  return { pubkey: ev.pubkey as string, u: ev.tags.find((t: string[]) => t[0] === 'u')?.[1] as string, valid: verifyEvent(ev) };
};

describe('signing in with a key that is neither a financer nor an administrator', () => {
  it('keeps no session, registers nothing, opens no dashboard, and says why — asked with that key', async () => {
    const { wif, ids } = key();
    roleReply = { status: 200, body: { role: 'none' } };
    draw('/login');
    await signIn(wif);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SIGN_IN_GATE.notAllowedTitle);
    expect(alert).toHaveTextContent(SIGN_IN_GATE.notAllowed);
    expect(SIGN_IN_GATE.notAllowed).toMatch(/only for the companies that finance purchases and for the administrators/);

    expect(stored()).toBeNull();
    expect(calls.some((c) => c.url === '/api/login')).toBe(false);
    expect(screen.queryByText('FINANCER PAGE')).toBeNull();
    expect(screen.queryByText(/Welcome,/)).toBeNull();
    expect((screen.getByLabelText('WIF Private Key') as HTMLInputElement).value).toBe('');

    // Signed by the key being signed in, for this address — the server learns nobody else's role.
    expect(roleCalls()).toHaveLength(1);
    const ev = signedBy(roleCalls()[0].authorization);
    expect(ev).toEqual({ pubkey: ids.nostrHexId, u: '/api/session/role', valid: true });
  });

  it('says it in Slovenian too, with the page’s language toggle', async () => {
    const { wif } = key();
    roleReply = { status: 200, body: { role: 'none' } };
    draw('/login');
    await signIn(wif);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'SL' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(SIGN_IN_GATE_SL.notAllowedTitle);
    expect(alert).toHaveTextContent(SIGN_IN_GATE_SL.notAllowed);
    expect(SIGN_IN_GATE_SL.notAllowed).toMatch(/samo za podjetja, ki financirajo nakupe, in za administratorje/);
    expect(stored()).toBeNull();
  });

  it('a server that cannot say (Direct.Fund away, or no answer): no session, "could not be checked", in both languages', async () => {
    for (const reply of [{ status: 502, body: { code: 'DF_UNAVAILABLE' } }, 'no-answer'] as Reply[]) {
      const { wif } = key();
      roleReply = reply;
      const view = draw('/login');
      await signIn(wif);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(SIGN_IN_GATE.unchecked);
      fireEvent.click(screen.getByRole('button', { name: 'SL' }));
      expect(screen.getByRole('alert')).toHaveTextContent(SIGN_IN_GATE_SL.unchecked);
      expect(stored()).toBeNull();
      expect(calls.some((c) => c.url === '/api/login')).toBe(false);
      view.unmount();
    }
  });
});

describe('a sign-in whose signature the server refuses (SIGNATURE_REQUIRED)', () => {
  // The role request is signed and good for a minute either way. A phone whose clock is two minutes off fails it
  // every time — "try again shortly" would send a financer or an administrator round in circles; the page must
  // say to fix the clock. Any other reason is not "could not be checked" either: retrying unchanged cannot mend it.
  const refuse = (reason: string) => ({
    status: 403,
    body: { error: 'This request must be signed with your Nostr key.', code: 'SIGNATURE_REQUIRED', reason },
  });

  it('a device clock off by more than a minute (STALE, BAD_TIME): says to fix the clock, in both languages — no session', async () => {
    for (const reason of ['STALE', 'BAD_TIME']) {
      const { wif } = key();
      roleReply = refuse(reason);
      const view = draw('/login');
      await signIn(wif);

      const alert = await screen.findByTestId('sign-in-refused');
      expect(alert).toHaveTextContent(SIGN_IN_GATE.signatureTitle);
      expect(alert).toHaveTextContent(SIGN_IN_GATE.clock);
      expect(SIGN_IN_GATE.clock).toMatch(/clock is more than a minute off/);
      expect(alert).not.toHaveTextContent(SIGN_IN_GATE.unchecked);
      expect(alert.textContent).not.toMatch(/try again shortly/);

      fireEvent.click(screen.getByRole('button', { name: 'SL' }));
      expect(screen.getByTestId('sign-in-refused')).toHaveTextContent(SIGN_IN_GATE_SL.clock);
      expect(screen.getByTestId('sign-in-refused')).not.toHaveTextContent(SIGN_IN_GATE_SL.unchecked);

      expect(stored()).toBeNull();
      expect(calls.some((c) => c.url === '/api/login')).toBe(false);
      expect(screen.queryByText('FINANCER PAGE')).toBeNull();
      expect(screen.queryByText(/Welcome,/)).toBeNull();
      view.unmount();
    }
  });

  it('any other reason: says the signature was not accepted, not "try again shortly", in both languages', async () => {
    const { wif } = key();
    roleReply = refuse('HOST_MISMATCH');
    draw('/login');
    await signIn(wif);

    const alert = await screen.findByTestId('sign-in-refused');
    expect(alert).toHaveTextContent(SIGN_IN_GATE.signatureTitle);
    expect(alert).toHaveTextContent(SIGN_IN_GATE.signature);
    expect(alert).not.toHaveTextContent(SIGN_IN_GATE.clock);
    expect(alert.textContent).not.toMatch(/try again shortly/);
    fireEvent.click(screen.getByRole('button', { name: 'SL' }));
    expect(screen.getByTestId('sign-in-refused')).toHaveTextContent(SIGN_IN_GATE_SL.signature);
    expect(stored()).toBeNull();
  });
});

describe('the two who sign in', () => {
  it('a financer lands on /financer, the session knowing what they are', async () => {
    const { wif, ids } = key();
    roleReply = { status: 200, body: { role: 'financer' } };
    draw('/login');
    await signIn(wif);
    expect(await screen.findByText('FINANCER PAGE')).toBeInTheDocument();
    expect(stored()).toMatchObject({ nostrHexId: ids.nostrHexId, role: 'financer', isAdmin: false });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an administrator lands where they always did: the dashboard, or the page ?next= names', async () => {
    const first = key();
    roleReply = { status: 200, body: { role: 'admin' } };
    const view = draw('/login');
    await signIn(first.wif);
    expect(await screen.findByText(/Welcome,/)).toBeInTheDocument();
    expect(stored()).toMatchObject({ nostrHexId: first.ids.nostrHexId, role: 'admin', isAdmin: true });
    view.unmount();

    localStorage.clear();
    const second = key();
    draw('/login?next=/financer');
    await signIn(second.wif);
    expect(await screen.findByText('FINANCER PAGE')).toBeInTheDocument();
  });
});

describe('a session kept from before 9 Oct 2026', () => {
  const keep = (role?: string) => {
    const { ids } = key();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      ...ids, lanaPrivateKey: 'kept', profileDisplayName: 'Kept Seller', isAdmin: false, ...(role ? { role } : {}),
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    }));
    return ids;
  };

  it("of a key that is neither: signed out before any page uses it, and told why — no seller dashboard", async () => {
    const ids = keep();
    roleReply = { status: 200, body: { role: 'none' } };
    draw('/dashboard');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SIGN_IN_GATE.notAllowed);
    expect(screen.queryByText(/Welcome,/)).toBeNull();
    expect(screen.queryByText(/Kept Seller/)).toBeNull();
    expect(stored()).toBeNull();
    // Asked with the kept key, and nothing of the seller's was read.
    expect(signedBy(roleCalls()[0].authorization).pubkey).toBe(ids.nostrHexId);
    expect(calls.some((c) => c.url.includes('/sales') || c.url.includes('/acquisitions'))).toBe(false);
  });

  it("of a financer: kept, now knowing it is one, and taken to /financer from the sign-in page", async () => {
    const ids = keep();
    roleReply = { status: 200, body: { role: 'financer' } };
    draw('/login');
    expect(await screen.findByText('FINANCER PAGE')).toBeInTheDocument();
    expect(stored()).toMatchObject({ nostrHexId: ids.nostrHexId, role: 'financer', isAdmin: false });
  });

  it('when the server cannot be asked: kept as it was (every route still decides for itself), asked again on the next load', async () => {
    const ids = keep();
    roleReply = 'no-answer';
    draw('/login');
    expect(await screen.findByText(/Welcome,/)).toBeInTheDocument();
    expect(stored()).toMatchObject({ nostrHexId: ids.nostrHexId });
    expect(stored().role).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the words, in both languages', () => {
  it('every sentence in both, none left in English', () => {
    expect(Object.keys(SIGN_IN_GATE_SL).sort()).toEqual(Object.keys(SIGN_IN_GATE).sort());
    expect(SIGN_IN_GATE_TEXT).toEqual({ sl: SIGN_IN_GATE_SL, en: SIGN_IN_GATE });
    for (const k of Object.keys(SIGN_IN_GATE) as Array<keyof typeof SIGN_IN_GATE>) expect(SIGN_IN_GATE_SL[k], k).not.toBe(SIGN_IN_GATE[k]);
  });

  it('the Slovenian administrator is "administrator", never "skrbnik" (the caretaker) — on the sign-in page and the notice too', () => {
    const pairs: Array<[string, string, string]> = [
      ...(Object.keys(SIGN_IN_GATE) as Array<keyof typeof SIGN_IN_GATE>).map((k): [string, string, string] => [k, SIGN_IN_GATE[k], SIGN_IN_GATE_SL[k]]),
      ['signInIntro', SELLING_MOVED.signInIntro, NOTICE_TEXT.sl.signInIntro],
      ['signInOnly', SELLING_MOVED.signInOnly, NOTICE_TEXT.sl.signInOnly],
    ];
    for (const [key, en, sl] of pairs) {
      expect(sl, key).not.toMatch(/skrbnik/i);
      if (/administrator/i.test(en)) expect(sl, key).toMatch(/administrator/i);
    }
    expect(NOTICE_TEXT.en.signInIntro).toBe(SELLING_MOVED.signInIntro);
  });
});
