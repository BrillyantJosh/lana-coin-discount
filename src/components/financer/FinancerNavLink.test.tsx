/**
 * THE WAY TO /financer IS SHOWN TO A FINANCER, AND ONLY TO ONE.
 *
 * Since 9 Oct 2026 only financers and administrators sign in here; to an
 * administrator who is not a financer, a link to a page that only says "this
 * is not for you" is noise. So it is drawn on a clear yes
 * from GET /api/financer/me (Direct.Fund's word, asked about the signer), and
 * a no, a refusal or Direct.Fund being away draws nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FinancerNavLink, forgetFinancerAnswers } from './FinancerNavLink';

const auth = vi.hoisted(() => ({ session: { nostrHexId: 'f1'.repeat(32) } as { nostrHexId: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

let reply: { status: number; body: unknown } | 'no-answer' = { status: 200, body: {} };
let asked = 0;

beforeEach(() => {
  forgetFinancerAnswers();
  asked = 0;
  auth.session = { nostrHexId: 'f1'.repeat(32) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(url).toBe('/api/financer/me');
      asked++;
      if (reply === 'no-answer') throw new TypeError('Failed to fetch');
      const r = reply;
      return { ok: r.status < 300, status: r.status, json: async () => r.body } as any;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const draw = () => render(<MemoryRouter><FinancerNavLink label="Financer" /></MemoryRouter>);

describe('the financer link in the signed-in header', () => {
  it('is drawn when Direct.Fund says the signer is a financer', async () => {
    reply = { status: 200, body: { isFinancer: true } };
    draw();
    expect(await screen.findByRole('link', { name: 'Financer' })).toHaveAttribute('href', '/financer');
  });

  it('is not drawn for anyone else, nor when Direct.Fund is away', async () => {
    for (const r of [{ status: 200, body: { isFinancer: false } }, { status: 503, body: { code: 'DF_UNAVAILABLE' } }, 'no-answer' as const]) {
      forgetFinancerAnswers();
      reply = r;
      const before = asked;
      const view = draw();
      await waitFor(() => expect(asked).toBe(before + 1));
      expect(screen.queryByRole('link', { name: 'Financer' })).toBeNull();
      view.unmount();
    }
  });

  it('asks nothing without a session', () => {
    auth.session = null;
    draw();
    expect(asked).toBe(0);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
