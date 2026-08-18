/**
 * A seller who has just transferred lands on /obligations from the completion
 * screen. Their own acquisition is not on the settlements board yet — the board
 * counts only sales the chain has confirmed — so if the page showed nothing but
 * that board, the seller would read it as "my sale is gone" while looking at
 * someone else's debt. It happened, on the first real sale through the new flow.
 *
 * So the page must show BOTH: the transfers still awaiting confirmation, and the
 * purchase prices already owed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Obligations from './Obligations';

const PENDING = {
  count: 1,
  updated_at: '2026-08-18T18:09:00Z',
  items: [{
    name: 'Joshua Andrej Brilly',
    hex_short: '56e8670a',
    amount: 573.22,
    currency: 'EUR',
    status: 'broadcast',
    rpc_confirmations: 0,
    created_at: '2026-08-18 18:03:01',
  }],
};

/** Somebody else's settled obligation — the only thing the page showed before. */
const OBLIGATIONS = {
  updated_at: '2026-08-18T18:09:00Z',
  total_currencies: 1,
  currencies: {
    GBP: {
      count: 1,
      total_outstanding: 24.12,
      financier_count: 0,
      settlements: [{
        position: 1, name: 'Lewis Sykes', hex_short: 'b1131b9c',
        outstanding: 24.12, is_financier: false, finance_rank: null,
        is_crowdfunder: false, blocked: false, frozen: false,
      }],
    },
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = String(url).includes('pending-verification') ? PENDING
      : String(url).includes('obligations') ? OBLIGATIONS
      : {};
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the page a seller lands on after transferring', () => {
  it('shows the transfer that is still awaiting on-chain confirmation', async () => {
    render(<Obligations />);
    // The seller's own name and the price we will owe once the chain confirms.
    await waitFor(() => expect(screen.getByText('Joshua Andrej Brilly')).toBeInTheDocument());
    expect(screen.getByText(/In verification/i)).toBeInTheDocument();
  });

  it('still shows the purchase prices already owed', async () => {
    render(<Obligations />);
    await waitFor(() => expect(screen.getByText('Lewis Sykes')).toBeInTheDocument());
  });

  it('asks the server for both lists, not just the board', async () => {
    render(<Obligations />);
    await waitFor(() => {
      const called = (fetch as any).mock.calls.map((c: any[]) => String(c[0]));
      expect(called.some(u => u.includes('/api/pending-verification'))).toBe(true);
      expect(called.some(u => u.includes('/api/obligations'))).toBe(true);
    });
  });
});
