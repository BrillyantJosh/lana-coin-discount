/**
 * THE THREE THINGS A REAL SELLER HIT ON /offer.
 *
 * Dejan worked through a sale with someone on the phone and reported three
 * things, all of them true:
 *
 *   1. "Max" filled the field with his whole wallet — 22,775.139664 — on a
 *      page that printed "the treasury can acquire up to 3,251.48 LANA from
 *      this wallet now" two lines below the same field. He deleted it and
 *      typed the smaller number by hand.
 *   2. "How much LANA are you offering?" was asked ABOVE the mandate that
 *      answers it: «moraš dol gledat koliko lahko, potem pa gor, koliko boš».
 *   3. After submitting he got a spinning circle over the words "Under
 *      Treasury Review" and nothing else — no acknowledgement that the thing
 *      had happened, no word on whether he could close the window, and no
 *      hint of what would bring him back.
 *
 * These are rendered through the real page rather than asserted on strings,
 * because every one of the three was a fault of ARRANGEMENT — a number in the
 * wrong field, a section in the wrong order, a state where an event belonged —
 * and none of them would have been caught by a test that only read copy.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubmitOffer from './SubmitOffer';
import { OFFER, MANDATE, UI } from '@/copy';

const HEX = 'a'.repeat(64);
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';

/** His wallet and his round, to the lanoshi. */
const BALANCE = 22775.139664;
const CAP = 3251.48326612;

const hoisted = vi.hoisted(() => ({
  mandate: null as unknown,
  signed: [] as Array<{ path: string; init?: { method?: string; body?: unknown } }>,
  // ONE object, for the life of the file. The page reloads everything it knows
  // whenever `session` changes identity, so a hook that built a fresh literal
  // on every render would put it in a loop that never leaves "loading".
  auth: {
    session: { nostrHexId: 'a'.repeat(64), nostrPrivateKey: 'b'.repeat(64), walletId: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB' },
    isAdmin: false,
    logout: () => {},
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => hoisted.auth }));

// The signing key never leaves the browser and the signature is not what these
// tests are about — src/lib/signedRequest.test.ts cross-checks the scheme
// against the server's own verifier.
vi.mock('@/lib/signedRequest', () => ({
  signedFetch: (path: string, _key: unknown, init?: { method?: string; body?: unknown }) => {
    hoisted.signed.push({ path, init });
    const body = path.includes('/acquisitions/mandate') ? hoisted.mandate : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  },
}));

vi.mock('@/lib/crypto', () => ({
  convertWifToIds: () => ({ walletIdCompressed: WALLET, walletIdUncompressed: WALLET }),
}));

const round = (over: Record<string, unknown> = {}) => ({
  mandateRef: '8:1:' + 'c'.repeat(64),
  eventId: 'e'.repeat(64),
  split: 8,
  round: 1,
  state: 'open',
  opensAt: '2026-09-14T22:00:00.000Z',
  discountPercent: 22,
  released: false,
  inWindow: true,
  walletCurrency: 'EUR',
  walletShareLana: CAP,
  expectedLana: CAP,
  remainingLana: CAP,
  proposedLana: 0,
  acceptedLana: 0,
  settledLana: 0,
  basis: 'current_split',
  referenceRate: 0.256,
  indicativeFor: null,
  ...over,
});

const mandateWith = (mandates: unknown[]) => ({ nonBinding: true, note: '', currentSplit: 8, mandates });

const underReview = (over: Record<string, unknown> = {}) => ({
  offerRef: 'OFF-2026-057',
  status: 'under_review',
  lanaAmount: CAP,
  currency: 'EUR',
  purchasePrice: null,
  settlementDueAt: null,
  offerExpiresAt: null,
  actionDueAt: null,
  decisionReason: 'This proposal is above the current acquisition threshold and is under treasury review.',
  senderWallet: WALLET,
  createdAt: '2026-09-10 12:30:00',
  transactionId: null,
  mandateCode: 'ABOVE_AUTO_CAP',
  mandateRef: '8:1:' + 'c'.repeat(64),
  round: 1,
  ...over,
});

let mine: unknown[] = [];
let balance = BALANCE;

beforeEach(() => {
  mine = [];
  balance = BALANCE;
  hoisted.mandate = mandateWith([round()]);
  hoisted.signed = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url);
    const body =
      u.includes('/payment-score') ? { score: 10 }
      : u.includes('/wallets/balances') ? { balances: [{ wallet_id: WALLET, balance, status: 'active' }] }
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

const show = () => render(<MemoryRouter><SubmitOffer /></MemoryRouter>);

/** Wallet → Next → the amount step, the way a seller reaches it. */
async function reachAmountStep() {
  show();
  const wallet = await screen.findByRole('button', { name: new RegExp(WALLET.slice(0, 10)) });
  fireEvent.click(wallet);
  const next = await screen.findByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
  await screen.findByText(OFFER.amountTitle);
  // Let the signed mandate read settle before anything reads a cap off it.
  await act(async () => { await Promise.resolve(); });
}

const amountField = () => screen.getByRole('spinbutton') as HTMLInputElement;

describe('Max offers what the round will take, not what the wallet holds', () => {
  it('fills in the round cap when the round is the smaller of the two', async () => {
    await reachAmountStep();
    await waitFor(() => expect(screen.getByTestId('cap-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('max-button'));

    expect(amountField().value).toBe('3251.48326612');
    // The number he had to type by hand is now the number the button types.
    expect(amountField().value).not.toBe('22775.139327999997');
  });

  it('still empties the wallet when the round is not the binding limit', async () => {
    // The other reason the subtraction exists: a transfer that sweeps the
    // wallet keeps no change output, so the fee has to be left behind here.
    hoisted.mandate = mandateWith([round({ remainingLana: 999999, expectedLana: 999999 })]);
    await reachAmountStep();
    await waitFor(() => expect(screen.getByTestId('cap-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('max-button'));

    expect(amountField().value).toBe('22775.139327999997');
  });

  it('offers the whole wallet when no mandate caps it — the legacy path', async () => {
    hoisted.mandate = mandateWith([]);
    await reachAmountStep();
    await screen.findByText(MANDATE.noMandateTitle);

    fireEvent.click(screen.getByTestId('max-button'));

    expect(amountField().value).toBe('22775.139327999997');
  });

  it('declines to answer, rather than emptying the wallet, when nothing may be proposed', async () => {
    // A mandate that was read and has no open round is a real cap of zero.
    // There is no amount Max could truthfully fill in, and the amber line
    // under the field already says why.
    hoisted.mandate = mandateWith([round({ state: 'not_open' })]);
    await reachAmountStep();
    await waitFor(() => expect(screen.getByTestId('max-button')).toBeDisabled());

    expect(amountField().value).toBe('');
  });
});

describe('the mandate is read before the amount is asked for', () => {
  it('puts "Your financing-round mandate" above "How much LANA are you offering?"', async () => {
    await reachAmountStep();
    const panel = await screen.findByTestId('mandate-panel');

    const heading = screen.getByText(OFFER.amountTitle);
    // He looked down for the cap and back up to type. Now the answer is on the
    // way to the question.
    expect(panel.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByText(MANDATE.title)).toBeInTheDocument();
  });

  it('keeps the field and the cap hint together, so the figure is still beside the box', async () => {
    await reachAmountStep();
    const hint = await screen.findByTestId('cap-hint');
    expect(hint.textContent).toContain('3,251.48');
    expect(amountField().compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the moment a proposal lands on a person\'s desk', () => {
  beforeEach(() => { mine = [underReview()]; });

  it('says the thing happened, in the past tense, as the heading', async () => {
    show();
    expect(await screen.findByText('Your offer has been submitted')).toBeInTheDocument();
  });

  it('keeps the framework\'s review-state name, as the status and not as the acknowledgement', async () => {
    show();
    const chip = await screen.findByTestId('review-state');
    expect(chip.textContent).toBe(UI.reviewState);
    // Same words as the badge the dashboard shows for the same row — and the
    // heading above it is the event, not this.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(OFFER.reviewTitle);
  });

  it('does not spin. Nothing on this card is in progress in this browser', async () => {
    show();
    const card = await screen.findByTestId('submitted-card');
    expect(card.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('submitted-mark')).toBeInTheDocument();
  });

  it('tells him he may close the window, and that closing it keeps the proposal', async () => {
    show();
    const text = (await screen.findByTestId('what-happens-now')).textContent || '';
    expect(text).toContain('You may close this page');
    expect(text).toContain('closing it does not close the proposal');
    expect(text).toContain('nothing is waiting on you');
  });

  it('says outright that nothing will reach out to him, because nothing does', async () => {
    // Checked in the code before it was written: this app has no mailer, no
    // message and no push. "We will let you know" is the worst sentence this
    // page could carry, and this test is what stops it reappearing.
    show();
    const text = (await screen.findByTestId('what-happens-now')).textContent || '';
    expect(text).toContain('Nothing is sent to you when it is decided');
    expect(text).toMatch(/no email, no message/);
    expect(text).not.toMatch(/we will (let you know|be in touch|contact you)/i);
    expect(text).not.toMatch(/you will (hear|be notified)/i);
  });

  it('names the one route back: his own return, to his dashboard, by this reference', async () => {
    show();
    const text = (await screen.findByTestId('what-happens-now')).textContent || '';
    expect(text).toContain('open your dashboard');
    expect(screen.getByText('OFF-2026-057')).toBeInTheDocument();
    expect(screen.getByText(OFFER.reviewRefNote)).toBeInTheDocument();
  });

  it('promises no time the server does not keep', async () => {
    show();
    const card = await screen.findByTestId('submitted-card');
    const text = card.textContent || '';
    expect(text).toContain('There is no deadline on that decision');
    expect(text).not.toMatch(/\b(shortly|soon|typically|usually|within \d|\d+ (hours|days|minutes))\b/i);
  });

  it('says the page checks by itself, instead of miming it with a circle', async () => {
    show();
    expect(await screen.findByText(OFFER.reviewAutoCheck)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OFFER.reviewCheckNow })).toBeInTheDocument();
  });

  it('makes leaving the loudest control on a screen that tells him to leave', async () => {
    show();
    const leave = await screen.findByRole('link', { name: OFFER.reviewBack });
    expect(leave.className).toContain('bg-primary');
    expect(screen.getByRole('button', { name: OFFER.reviewCheckNow }).className).not.toContain('bg-primary');
  });

  it('shows the server\'s own reason a person is looking, and invents none of its own', async () => {
    show();
    const why = await screen.findByTestId('review-why');
    expect(why.textContent).toContain('above the current acquisition threshold');
  });

  it('says nothing about why when the server sent no reason', async () => {
    mine = [underReview({ decisionReason: null })];
    show();
    await screen.findByTestId('submitted-card');
    expect(screen.queryByTestId('review-why')).toBeNull();
  });
});

describe('withdrawing is no longer what a hopeful thumb lands on', () => {
  beforeEach(() => { mine = [underReview()]; });

  it('is a link under its own heading, not a button beside "check"', async () => {
    show();
    await screen.findByTestId('submitted-card');
    expect(screen.getByText(OFFER.reviewChangeTitle)).toBeInTheDocument();
    const withdraw = screen.getByRole('button', { name: OFFER.reviewWithdraw });
    const check = screen.getByRole('button', { name: OFFER.reviewCheckNow });
    // The exit and the check come first; the terminal act is below them.
    expect(check.compareDocumentPosition(withdraw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('asks first, and names the reference it is about to close', async () => {
    show();
    await screen.findByTestId('submitted-card');

    fireEvent.click(screen.getByRole('button', { name: OFFER.reviewWithdraw }));

    expect(screen.getByTestId('withdraw-confirm').textContent).toContain('OFF-2026-057');
    // Nothing has been sent yet: one click no longer destroys the proposal.
    expect(hoisted.signed.some(c => c.path.includes('/withdraw'))).toBe(false);
  });

  it('lets him back out of it', async () => {
    show();
    await screen.findByTestId('submitted-card');
    fireEvent.click(screen.getByRole('button', { name: OFFER.reviewWithdraw }));
    fireEvent.click(screen.getByRole('button', { name: OFFER.reviewWithdrawNo }));

    expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
    expect(screen.getByTestId('submitted-card')).toBeInTheDocument();
    expect(hoisted.signed.some(c => c.path.includes('/withdraw'))).toBe(false);
  });

  it('withdraws only on the second, deliberate click', async () => {
    show();
    await screen.findByTestId('submitted-card');
    fireEvent.click(screen.getByRole('button', { name: OFFER.reviewWithdraw }));
    fireEvent.click(screen.getByRole('button', { name: OFFER.reviewWithdrawYes }));

    await waitFor(() => expect(hoisted.signed.some(c => c.path.includes('/withdraw'))).toBe(true));
  });
});
