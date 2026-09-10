/**
 * "PISALO JE 8 DNI, ZDAJ PIŠE 19 UR."
 *
 * The owner accepted a €6,498.88 purchase offer that said it stood for eight
 * days, and the very next screen said nineteen hours. Neither figure was a bug:
 * a purchase offer a person decided stands MANUAL_OFFER_VALIDITY_DAYS, and
 * accepting it closes that window and opens the ACCEPTED_TRANSFER_WINDOW_HOURS
 * one for the transfer, after which expireStaleOffers voids the row. Every
 * screen was correct about its own clock, and no screen said the clock had been
 * swapped — so the only way to find out was to accept and watch the number
 * collapse.
 *
 * These are rendered through the real page rather than asserted on copy.ts,
 * because the whole difficulty is WHICH SENTENCE this page picks. A test that
 * only read the strings would happily pass while /offer printed "there are 24
 * hours" over a thirty-minute automatic offer, which is the exact opposite
 * mistake — a deadline announced that is not the one about to arrive.
 *
 * The three rows that must each get their own answer:
 *
 *   manual, mandate-bound   8 days → the 24-hour sweep is what bites next
 *   automatic, 30 minutes   the sweep never gets near it; the window bites
 *   legacy, no mandate      never swept at all; the window is the whole story
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmitOffer from './SubmitOffer';
import { UI } from '@/copy';

const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';

const hoisted = vi.hoisted(() => ({
  // ONE object for the life of the file: the page reloads everything it knows
  // whenever `session` changes identity, so a fresh literal per render would
  // spin forever in "loading".
  auth: {
    session: { nostrHexId: 'a'.repeat(64), nostrPrivateKey: 'b'.repeat(64), walletId: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB' },
    isAdmin: false,
    logout: () => {},
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => hoisted.auth }));

// The signature scheme is not what these are about — src/lib/signedRequest.test.ts
// cross-checks it against the server's own verifier.
vi.mock('@/lib/signedRequest', () => ({
  signedFetch: (path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(path.includes('mandate') ? { nonBinding: true, currentSplit: 8, mandates: [] } : { ok: true }),
    } as Response),
}));

vi.mock('@/lib/crypto', () => ({
  convertWifToIds: () => ({ walletIdCompressed: WALLET, walletIdUncompressed: WALLET }),
}));

/** The shape SQLite writes: `YYYY-MM-DD HH:MM:SS`, always UTC. */
const sqliteUtc = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let mine: unknown[] = [];

beforeEach(() => {
  mine = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url);
    const body =
      u.includes('/payment-score') ? { score: 10 }
      : u.includes('/wallets/balances') ? { balances: [{ wallet_id: WALLET, balance: 22775, status: 'active' }] }
      : u.includes('/wallets/utxo-info') ? { success: true, utxoCount: 1 }
      : u.includes('/sell/split-check') ? { allowed: true, code: 'OK', reason: '', walletSplit: 8, currentSplit: 8, allowedSplits: [8] }
      : u.includes('/system-params') ? { split: '8', activeCurrencies: ['EUR'], treasuryWalletId: 'LTreasuryWalletAddress' }
      : u.includes('/profile') ? {
          profile: {
            currency: 'EUR',
            payment_methods: [{ id: 'pm1', scope: 'payout', scheme: 'EU.IBAN', currency: 'EUR', label: 'SEPA', fields: { iban: 'SI56' } }],
          },
        }
      : u.includes('/acquisitions/mine') ? { offers: mine }
      : u.includes('/wallets') ? { wallets: [{ walletId: WALLET, walletType: 'LanaPays.Us', status: 'active' }] }
      : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * A live offer outlives the page, and /offer resumes it from the server on
 * load — which is how these reach the offer and transfer screens without
 * walking the wallet and amount steps first.
 */
const offer = (over: Record<string, unknown> = {}) => ({
  offerRef: 'OFF-2026-059',
  status: 'offered',
  lanaAmount: 20070,
  currency: 'EUR',
  purchasePrice: 6498.88,
  settlementDueAt: sqliteUtc(15 * DAY),
  offerExpiresAt: sqliteUtc(8 * DAY),
  actionDueAt: sqliteUtc(8 * DAY),
  decisionReason: null,
  senderWallet: WALLET,
  createdAt: sqliteUtc(-HOUR),
  transactionId: null,
  mandateCode: 'ABOVE_AUTO_CAP',
  mandateRef: '8:1:' + 'c'.repeat(64),
  round: 1,
  ...over,
});

const show = () => render(<MemoryRouter><SubmitOffer /></MemoryRouter>);

describe('before he accepts, the page says what accepting starts', () => {
  it('names the 24 hours on the offer where 24 hours is what bites next', async () => {
    mine = [offer()]; // decided by a person, stands eight days
    show();
    const said = (await screen.findByTestId('accept-starts')).textContent ?? '';
    expect(said).toMatch(/24 hours/);
    expect(said).toMatch(/transferred out of your wallet/i);
    // The sentence that would have saved him: the short clock is his to start.
    expect(said).toMatch(/start when you accept, not now/i);
  });

  it('and it is said in front of the button, not after it was pressed', async () => {
    mine = [offer()];
    show();
    await screen.findByTestId('accept-starts');
    expect(screen.getByRole('button', { name: /Accept this purchase offer/i })).toBeInTheDocument();
  });

  it('claims no 24 hours over a thirty-minute automatic offer', async () => {
    // The sweep is a day away and the window is half an hour away, so
    // accepting does not move the deadline at all. "There are 24 hours" here
    // would name a deadline that is not the one arriving.
    mine = [offer({ offerExpiresAt: sqliteUtc(30 * 60_000), actionDueAt: sqliteUtc(30 * 60_000) })];
    show();
    const said = (await screen.findByTestId('accept-starts')).textContent ?? '';
    expect(said).not.toMatch(/24 hours/);
    expect(said).toMatch(/runs out at/i);
  });

  it('claims no 24 hours on a legacy row, which nothing sweeps', async () => {
    mine = [offer({ mandateRef: null, mandateCode: null, round: null })];
    show();
    expect((await screen.findByTestId('accept-starts')).textContent ?? '').not.toMatch(/24 hours/);
  });
});

describe('after he accepts, the page says the clock changed', () => {
  it('names both moments — the one he remembers and the one now running', async () => {
    // Accepted on day one of an eight-day offer: the sweep is 19 hours out.
    mine = [offer({ status: 'accepted', offerExpiresAt: sqliteUtc(7 * DAY), actionDueAt: sqliteUtc(19 * HOUR) })];
    show();
    const said = (await screen.findByTestId('window-changed')).textContent ?? '';
    expect(said).toMatch(/clock has changed/i);
    expect(said).toMatch(/Until you accepted/i);
    expect(said).toMatch(/transfer window/i);
    // And the clock beside it is labelled for the transfer, not the decision.
    expect(await screen.findByText(/Time left to transfer/i)).toBeInTheDocument();
  });

  it('says nothing where the deadline did not actually move', async () => {
    // Both moments equal: an automatic offer, or a legacy row. Announcing a
    // change here would be manufacturing one.
    const same = sqliteUtc(20 * 60_000);
    mine = [offer({ status: 'accepted', offerExpiresAt: same, actionDueAt: same })];
    show();
    await screen.findByText(UI.transfer);
    expect(screen.queryByTestId('window-changed')).toBeNull();
  });
});

describe('the state a proposal sits in, as the seller reads it', () => {
  it('no longer puts a government department over a private sale', async () => {
    mine = [offer({ status: 'under_review', purchasePrice: null, offerExpiresAt: null, actionDueAt: null })];
    show();
    expect((await screen.findByTestId('review-state')).textContent).toBe(UI.reviewState);
    expect(screen.getByTestId('submitted-card').textContent).not.toMatch(/treasury review/i);
  });
});
