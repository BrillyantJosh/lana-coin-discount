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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmitOffer from './SubmitOffer';
import { UI, OFFER } from '@/copy';

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
/** What POST /transfer answers, so a test can hand back a refusal. */
let transferReply: Record<string, unknown> = { success: true };
/** What the page actually sent to POST /transfer. */
let transferSent: any = null;
/** What /wallets/balances reports for the seller's wallet. */
let walletBalance = 22775;

beforeEach(() => {
  mine = [];
  transferReply = { success: true };
  transferSent = null;
  walletBalance = 22775;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    const u = String(url);
    if (u.includes('/transfer') && init?.body) transferSent = JSON.parse(init.body);
    const body =
      u.includes('/transfer') ? transferReply
      : u.includes('/payment-score') ? { score: 10 }
      : u.includes('/wallets/balances') ? { balances: [{ wallet_id: WALLET, balance: walletBalance, status: 'active' }] }
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
    /**
     * The row carries the sentence the OLD code stored, because
     * `decision_reason` is a stored column and rows written before 10 Sept 2026
     * still hold it until the one-off UPDATE runs. The state the seller reads
     * is computed here, so it must be this release's words whatever the row
     * says — that is the half of this with teeth: with the field empty, the
     * absence below would hold whether the rename happened or not.
     */
    mine = [offer({
      status: 'under_review', purchasePrice: null, offerExpiresAt: null, actionDueAt: null,
      decisionReason: 'This proposal is under treasury review.',
    })];
    show();
    const state = await screen.findByTestId('review-state');
    expect(state.textContent).toBe(UI.reviewState);
    expect(state.textContent).not.toMatch(/treasury/i);
    expect(state.textContent).not.toMatch(/ministr/i);
  });
});

/**
 * THE BUTTON THAT COULD NOT WORK, AND STAYED ON.
 *
 * The route already answered both ways round — `retryable: false` for a
 * refusal that is arithmetic, `repeated: true` when it recognised an unchanged
 * wallet and did not even attempt the broadcast — and the browser threw both
 * away, keeping only {error, code}. So Confirm stayed lit under a sentence
 * saying the wallet is short, and each press wrote another failed row. Eight
 * of them, on the day this was found.
 */
describe('a refusal that pressing again cannot cure', () => {
  const reachTransfer = async () => {
    mine = [offer({ status: 'accepted', offerExpiresAt: sqliteUtc(7 * DAY), actionDueAt: sqliteUtc(19 * HOUR) })];
    show();
    await screen.findByText(UI.transfer);
    const key = screen.getByPlaceholderText(/private key/i);
    fireEvent.change(key, { target: { value: 'T'.repeat(52) } });
    const confirm = await screen.findByRole('button', { name: new RegExp(OFFER.transferConfirm, 'i') });
    await waitFor(() => expect(confirm).toBeEnabled());
    return confirm;
  };

  it('switches the button off and says so', async () => {
    transferReply = {
      success: false,
      error: 'This wallet holds about 3,261.79 LANA — less than the 3,261.80 LANA this acquisition is for.',
      code: 'INSUFFICIENT_BALANCE',
      retryable: false,
    };
    const confirm = await reachTransfer();
    fireEvent.click(confirm);
    await screen.findByText(/Pressing again cannot change this answer/i);
    expect(confirm).toBeDisabled();
    // And there is a way forward that is not the same press.
    expect(screen.getByRole('button', { name: /Check the wallet again/i })).toBeInTheDocument();
  });

  it('says plainly when nothing was even sent, because the wallet had not changed', async () => {
    transferReply = {
      success: false,
      error: 'This wallet holds about 3,261.79 LANA — less than the 3,261.80 LANA this acquisition is for.',
      code: 'INSUFFICIENT_BALANCE',
      retryable: false,
      repeated: true,
    };
    const confirm = await reachTransfer();
    fireEvent.click(confirm);
    expect(await screen.findByText(/nothing was sent this time/i)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('leaves the button on where the refusal might come out differently', async () => {
    // TOO_MANY_UTXOS is the case that was dressed as permanent and is not: its
    // own sentence asks for a consolidation, after which the press works.
    transferReply = {
      success: false,
      error: 'This wallet holds its LANA in too many pieces. Consolidate them with Registrar and try again.',
      code: 'TOO_MANY_UTXOS',
      retryable: true,
    };
    const confirm = await reachTransfer();
    fireEvent.click(confirm);
    await screen.findByText(/too many pieces/i);
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(/Pressing again cannot change this answer/i)).toBeNull();
  });

  it('leaves the button on when the route says nothing either way', async () => {
    // Unknown is not permanent. The safe direction to be wrong in is "let them
    // try" — an older server, or a refusal from a path that does not classify.
    transferReply = { success: false, error: 'The transfer did not go through.', code: 'SOMETHING_ELSE' };
    const confirm = await reachTransfer();
    fireEvent.click(confirm);
    // Heading and body say the same thing here, so both come back.
    expect((await screen.findAllByText(/The transfer did not go through/i)).length).toBeGreaterThan(0);
    expect(confirm).toBeEnabled();
  });
});

/**
 * THE FLAG THAT ONLY EVER WENT ONE WAY.
 *
 * "Max" means the transfer has to empty the wallet, and that flag lives in the
 * page — lost with the tab — so the page re-derives it from the balance when an
 * offer is resumed. It re-derived it in one direction only: once true, nothing
 * could make it false again. A wallet that GREW while the offer waited kept
 * telling the server "empty me" about a wallet the treasury may no longer
 * empty, which the server answers with EMPTY_WALLET_EXCEEDS_MANDATE — and no
 * amount of pressing, or of putting the wallet right, could clear it. Only a
 * reload could.
 */
describe('whether this transfer empties the wallet follows the wallet', () => {
  const pressTransfer = async () => {
    show();
    await screen.findByText(UI.transfer);
    fireEvent.change(screen.getByPlaceholderText(/private key/i), { target: { value: 'T'.repeat(52) } });
    const confirm = await screen.findByRole('button', { name: new RegExp(OFFER.transferConfirm, 'i') });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(transferSent).not.toBeNull());
  };

  it('says so when the offer covers essentially the whole wallet', async () => {
    mine = [offer({ status: 'accepted', lanaAmount: 20070, offerExpiresAt: sqliteUtc(7 * DAY), actionDueAt: sqliteUtc(19 * HOUR) })];
    walletBalance = 20070;
    await pressTransfer();
    expect(transferSent.emptyWallet).toBe(true);
  });

  it('and stops saying so when the wallet turns out to hold more', async () => {
    mine = [offer({ status: 'accepted', lanaAmount: 20070, offerExpiresAt: sqliteUtc(7 * DAY), actionDueAt: sqliteUtc(19 * HOUR) })];
    walletBalance = 25000;   // a payment arrived while the offer waited
    await pressTransfer();
    expect(transferSent.emptyWallet).toBe(false);
  });
});
