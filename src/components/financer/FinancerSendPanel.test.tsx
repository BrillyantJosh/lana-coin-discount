/**
 * THE KEY STEP SIGNS WITH THE FINANCER'S OWN WALLET, OR NOT AT ALL.
 *
 * Owner, 8 Oct 2026: the financer signs with the WIF of their Lana.Discount
 * wallet, in the browser. The key typed must open EXACTLY the wallet the send
 * spends: a key of another wallet — or the other form (T…/6…) of the same
 * secret, which opens another address — would sign coins that are not there,
 * or worse, coins of a wallet nobody meant to spend. So, pinned here:
 *   - »Podpiši in pošlji« is off until the key opens the wallet, and says what
 *     the typed text is instead (another wallet, named; an address; a typo);
 *   - a click on it then does nothing;
 *   - with the right key it hands the text on ONCE and the field is empty
 *     before anything else happens;
 *   - the plan shows the very figures the signer will sign.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FINANCER, FINANCER_SL } from '@/copy';
import { FinancerSendPanel, KeyStep, planProblemText } from './FinancerSendPanel';
import { fill } from './financerText';
import { coinsOf, lanoshisText, planOfPrepared } from '@/lib/financer/payoutView';
import { LANA, NOW_SEC, prepareOf, purchaseOf, throwawayAddress, throwawayWallet, wifOf } from '@/test/financerFixtures';
import { feeFor, MAX_INPUTS } from '../../../server/shared/lana-tx/fee.ts';

const t = FINANCER;
const keyField = () => screen.getByLabelText(t.keyLabel) as HTMLInputElement;
const signButton = () => screen.getByRole('button', { name: t.sign });

describe('the key step', () => {
  it('a key of another wallet blocks signing, and names the wallet it opens', () => {
    const mine = throwawayWallet(true);
    const stranger = throwawayWallet(true);
    const onSign = vi.fn();
    render(<KeyStep t={t} wallet={mine.address} busy={null} onBack={() => {}} onSign={onSign} />);

    expect(signButton()).toBeDisabled();
    fireEvent.change(keyField(), { target: { value: wifOf(stranger.privateKey, true) } });
    expect(screen.getByTestId('financer-key-check').textContent).toContain(stranger.address);
    expect(signButton()).toBeDisabled();
    fireEvent.click(signButton());
    expect(onSign).not.toHaveBeenCalled();
  });

  it('the other form of the SAME secret opens another wallet, and is refused too', () => {
    const mine = throwawayWallet(true);
    const otherForm = throwawayWallet(false, mine.privateKey);
    const onSign = vi.fn();
    render(<KeyStep t={t} wallet={mine.address} busy={null} onBack={() => {}} onSign={onSign} />);

    fireEvent.change(keyField(), { target: { value: wifOf(mine.privateKey, false) } });
    expect(screen.getByTestId('financer-key-check').textContent).toContain(otherForm.address);
    expect(signButton()).toBeDisabled();
    fireEvent.click(signButton());
    expect(onSign).not.toHaveBeenCalled();
  });

  it('an address, a Nostr key or a typo is said for what it is, and signs nothing', () => {
    const mine = throwawayWallet(true);
    const onSign = vi.fn();
    render(<KeyStep t={t} wallet={mine.address} busy={null} onBack={() => {}} onSign={onSign} />);
    const said = (value: string) => {
      fireEvent.change(keyField(), { target: { value } });
      return screen.getByTestId('financer-key-check').textContent;
    };
    expect(said(mine.address)).toBe(t.keyStates.address);
    expect(said(`npub1${'q'.repeat(58)}`)).toBe(t.keyStates.npub);
    const wif = wifOf(mine.privateKey, true);
    const typo = wif.slice(0, 10) + (wif[10] === 'z' ? 'y' : 'z') + wif.slice(11);
    expect([t.keyStates.checksum, t.keyStates.notAKey]).toContain(said(typo));
    expect(signButton()).toBeDisabled();
    fireEvent.click(signButton());
    expect(onSign).not.toHaveBeenCalled();
  });

  it('the key that opens the wallet signs once, and the field is emptied before anything else', () => {
    const mine = throwawayWallet(true);
    const wif = wifOf(mine.privateKey, true);
    let fieldWhenSigned: string | null = null;
    const onSign = vi.fn(() => {
      fieldWhenSigned = keyField().value;
    });
    render(<KeyStep t={t} wallet={mine.address} busy={null} onBack={() => {}} onSign={onSign} />);

    fireEvent.change(keyField(), { target: { value: wif } });
    expect(screen.getByTestId('financer-key-check').textContent).toContain(t.keyStates.opens);
    expect(signButton()).toBeEnabled();
    fireEvent.click(signButton());
    expect(onSign).toHaveBeenCalledTimes(1);
    expect(onSign).toHaveBeenCalledWith(wif);
    expect(keyField().value).toBe('');
    // A second click: the field is empty, nothing opens, nothing more is signed.
    fireEvent.click(signButton());
    expect(onSign).toHaveBeenCalledTimes(1);
    // Emptied BEFORE the signing started, not after it.
    expect(fieldWhenSigned).toBe('');
  });

  it('is never a field a browser offers to remember', () => {
    const mine = throwawayWallet(true);
    render(<KeyStep t={t} wallet={mine.address} busy={null} onBack={() => {}} onSign={() => {}} />);
    const field = keyField();
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    // Masked: a CSS-masked text field, or a password field where the browser cannot mask text.
    const style = field.getAttribute('style') || '';
    expect(field.type === 'password' || /text-security:\s*disc/.test(style)).toBe(true);
  });
});

describe('the plan before the key', () => {
  it('shows what the signer will sign: paid, fee, change, what stays, coins spent', () => {
    const wallet = throwawayWallet(true);
    const [buyer, caretaker] = [throwawayAddress(), throwawayAddress()];
    const purchases = [
      purchaseOf('TX-1', [
        { id: 'leg-1', type: 'customer_cashback', to: buyer, lanoshis: 1_004_492_188n },
        { id: 'leg-2', type: 'caretaker_commission', to: caretaker, lanoshis: 3_446_289_063n },
      ]),
    ];
    const answer = prepareOf(wallet, purchases, [100n * LANA, 3n * LANA]);
    const receivedAt = Date.now();
    render(
      <FinancerSendPanel t={t} lang="en" prepared={{ answer, receivedAt }} step="plan" busy={null} problem={null} onBack={() => {}} onContinue={() => {}} onSign={() => {}} />,
    );
    const coins = coinsOf(answer);
    if (coins.ok === false) throw new Error('coins');
    const planned = planOfPrepared(answer, coins.coins, NOW_SEC);
    if (planned.ok === false) throw new Error('plan');
    const plan = screen.getByTestId('financer-plan').textContent || '';
    expect(plan).toContain(`${lanoshisText(planned.plan.paying)} LANA`);
    expect(plan).toContain(`${lanoshisText(planned.plan.fee)} LANA`);
    expect(plan).toContain(`${lanoshisText(planned.plan.change)} LANA`);
    expect(plan).toContain(`${lanoshisText(planned.left)} LANA`);
    // The brain's amounts to the lanoshi, never rounded: 10.04492188 and 34.46289063 LANA.
    const recipients = screen.getByTestId('financer-plan-recipients').textContent || '';
    expect(recipients).toContain('10.04492188 LANA');
    expect(recipients).toContain('34.46289063 LANA');
    // No key field before »Naprej na podpis«.
    expect(screen.queryByLabelText(t.keyLabel)).toBeNull();
  });

  it('a send the wallet cannot cover says by how much, and offers no way to the key', () => {
    const wallet = throwawayWallet(true);
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 50n * LANA }])];
    const answer = prepareOf(wallet, purchases, [10n * LANA]);
    render(
      <FinancerSendPanel t={t} lang="en" prepared={{ answer, receivedAt: Date.now() }} step="key" busy={null} problem={null} onBack={() => {}} onContinue={() => {}} onSign={() => {}} />,
    );
    expect(screen.getByTestId('financer-plan-problem').textContent).toMatch(/LANA more is needed/);
    expect(screen.queryByRole('button', { name: t.continue })).toBeNull();
    expect(screen.queryByLabelText(t.keyLabel)).toBeNull();
  });

  it('a wallet of many small coins, more than the server listed, is told to merge them — not to move in a wrong figure', () => {
    // Review C20: 60 coins of 10 LANA; the 40 listed (400 LANA) do not cover 450, the other 20 are counted.
    const wallet = throwawayWallet(true);
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 450n * LANA }])];
    const answer = { ...prepareOf(wallet, purchases, Array.from({ length: 40 }, () => 10n * LANA)), unlisted: { count: 20, value: String(200n * LANA) } };
    render(
      <FinancerSendPanel t={t} lang="en" prepared={{ answer, receivedAt: Date.now() }} step="plan" busy={null} problem={null} onBack={() => {}} onContinue={() => {}} onSign={() => {}} />,
    );
    const said = screen.getByTestId('financer-plan-problem').textContent;
    // And what to do (review N15/M6): LANA in larger payments, or the administrator — never a send to its own address.
    expect(said).toBe(`${fill(t.planProblem.TOO_MANY_INPUTS_MORE, { listed: 40, max: 20 })} ${t.mergeHow}`);
    expect(said).not.toMatch(/more is needed|move at least/);
    expect(screen.queryByRole('button', { name: t.continue })).toBeNull();
  });

  it('every »too many small coins« says what to do: LANA in larger payments, or the administrator — never a send to its own address (review N15/M6)', () => {
    for (const tt of [FINANCER, FINANCER_SL]) {
      const merge = [
        planProblemText(tt, { code: 'TOO_MANY_INPUTS', needed: 23, max: 20 }),
        planProblemText(tt, { code: 'TOO_MANY_INPUTS', needed: 41, max: 20, atLeast: true }),
        planProblemText(tt, { code: 'INSUFFICIENT', shortBy: 19n * LANA, merge: true }),
      ];
      for (const text of merge) expect(text.endsWith(tt.mergeHow)).toBe(true);
      // Short AND spread: the figure to move in, and the merge — both, in one sentence each.
      expect(merge[2]).toContain(fill(tt.planProblem.INSUFFICIENT_MERGE, { amount: '19.00' }));
      // Short only: no merge advice.
      expect(planProblemText(tt, { code: 'INSUFFICIENT', shortBy: LANA })).not.toContain(tt.mergeHow);
    }
    expect(FINANCER.mergeHow).toMatch(/in one or a few larger payments, not in many small ones/);
    expect(FINANCER.mergeHow).toMatch(/administrator/);
    expect(FINANCER.mergeHow).not.toMatch(/own address|wallet app/);
    expect(FINANCER_SL.mergeHow).toMatch(/v enem ali nekaj večjih plačilih, ne v veliko majhnih/);
    expect(FINANCER_SL.mergeHow).toMatch(/administratorja Lana\.Discount/);
    expect(FINANCER_SL.mergeHow).not.toMatch(/lastni naslov|aplikacij/);
  });

  it('the wallet short even counting the coins not listed says the figure from the whole wallet, and to merge too (review N12)', () => {
    // 40 coins of 7 LANA listed, one of 0.5 not: 280.5 LANA in all, for 300 LANA of purchases.
    const wallet = throwawayWallet(true);
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 300n * LANA }])];
    const listed = prepareOf(wallet, purchases, Array.from({ length: 40 }, () => 7n * LANA));
    const answer = { ...listed, unlisted: { count: 1, value: String(LANA / 2n) }, balance: { confirmed: String(280n * LANA + LANA / 2n), unconfirmed: '0' } };
    render(
      <FinancerSendPanel t={t} lang="en" prepared={{ answer, receivedAt: Date.now() }} step="plan" busy={null} problem={null} onBack={() => {}} onContinue={() => {}} onSign={() => {}} />,
    );
    const short = 300n * LANA + feeFor(MAX_INPUTS, 1) - (280n * LANA + LANA / 2n);
    expect(screen.getByTestId('financer-plan-problem').textContent).toBe(`${fill(t.planProblem.INSUFFICIENT_MERGE, { amount: lanoshisText(short) })} ${t.mergeHow}`);
  });

  it('»Stays in your wallet« is the whole confirmed balance less the send, not only what the coins offered leave (review N13)', () => {
    const wallet = throwawayWallet(true);
    const purchases = [purchaseOf('TX-1', [{ id: 'leg-1', type: 'customer_cashback', to: throwawayAddress(), lanoshis: 20n * LANA }])];
    // Only the 30 LANA coin of an earlier refused send is offered; the wallet holds 5,030 LANA.
    const answer = { ...prepareOf(wallet, purchases, [30n * LANA]), balance: { confirmed: String(5_030n * LANA), unconfirmed: '0' } };
    render(
      <FinancerSendPanel t={t} lang="en" prepared={{ answer, receivedAt: Date.now() }} step="plan" busy={null} problem={null} onBack={() => {}} onContinue={() => {}} onSign={() => {}} />,
    );
    const coins = coinsOf(answer);
    if (coins.ok === false) throw new Error('coins');
    const planned = planOfPrepared(answer, coins.coins, NOW_SEC);
    if (planned.ok === false) throw new Error('plan');
    expect(screen.getByTestId('financer-plan').textContent).toContain(`${lanoshisText(5_030n * LANA - 20n * LANA - planned.plan.fee)} LANA`);
  });
});
