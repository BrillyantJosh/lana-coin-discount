// @vitest-environment node
/**
 * "MAX" MUST NOT OFFER WHAT THE ROUND WILL NOT TAKE.
 *
 * A seller with 22,775.139664 LANA pressed Max and got all of it, on a page
 * that printed "the treasury can acquire up to 3,251.48 LANA from this wallet
 * now" two lines below the same field. He deleted it and typed the smaller
 * number by hand.
 *
 * Two things are pinned here, and the second is the one a later edit is most
 * likely to break: the button takes the smaller of the two limits, AND the
 * empty-the-wallet case still behaves to the lanoshi exactly as it did before
 * the cap existed — because the fee for that transfer has nowhere to come from
 * if anything is shaved off the top.
 */
import { describe, it, expect } from 'vitest';
import { maxProposable, ESTIMATED_TRANSFER_FEE_LANA } from './maxOffer';

const FEE = ESTIMATED_TRANSFER_FEE_LANA;
/** The wallet and the round from the report, to the lanoshi. */
const BALANCE = 22775.139664;
const CAP = 3251.48326612;

describe('the fee estimate', () => {
  it('is the one expression it always was: 1 input, 1 output, no change', () => {
    expect(FEE).toBe(Math.floor((1 * 180 + 1 * 34 + 10) * 100 * 1.5) / 100000000);
    expect(FEE).toBe(0.000336);
  });
});

describe('when the round is the binding limit', () => {
  it('offers the round cap, not the wallet', () => {
    expect(maxProposable(BALANCE, FEE, CAP).amountLana).toBe(3251.48326612);
  });

  it('does not empty the wallet — LANA stays behind and pays the fee from the change', () => {
    const max = maxProposable(BALANCE, FEE, CAP);
    expect(max.emptiesWallet).toBe(false);
    expect(max.cappedByRound).toBe(true);
  });

  it('never lands a hair above the cap, whatever the float did on the way here', () => {
    // The cap reaches the browser as lanoshis ÷ 1e8. Put back on the lanoshi
    // grid the same way the server converts it, so a proposal for exactly the
    // remainder is not met with a counteroffer for the rounding error.
    const cap = 3251483266 / 1e8;
    const max = maxProposable(BALANCE, FEE, cap);
    expect(Math.round(max.amountLana * 1e8)).toBe(3251483266);
    expect(max.amountLana).toBeLessThanOrEqual(cap);
  });
});

describe('when the wallet is the binding limit — the case that must not change', () => {
  it('offers the balance less the fee, to the last digit it always did', () => {
    // The literal string the old handler produced. Written out rather than
    // recomputed, because "the same formula" is what a regression would also
    // claim about itself.
    expect(String(maxProposable(BALANCE, FEE, 999999).amountLana)).toBe('22775.139327999997');
  });

  it('still says the transfer has to sweep the wallet empty', () => {
    const max = maxProposable(BALANCE, FEE, 999999);
    expect(max.emptiesWallet).toBe(true);
    expect(max.cappedByRound).toBe(false);
  });

  it('treats a cap equal to what is spendable as the wallet case, not the round case', () => {
    const spendable = BALANCE - FEE;
    const max = maxProposable(BALANCE, FEE, spendable);
    expect(max.amountLana).toBe(spendable);
    expect(max.emptiesWallet).toBe(true);
  });

  it('never goes negative when the fee is more than the balance', () => {
    const max = maxProposable(0.0001, FEE, null);
    expect(max.amountLana).toBe(0);
  });
});

describe('a cap that is not known is not a cap of zero', () => {
  it('offers the whole wallet when there is no cap at all — the legacy path', () => {
    // No mandate means the server judges the proposal on receipt. A page that
    // read that silence as "you may offer nothing" would empty the field of a
    // seller nobody has capped.
    const max = maxProposable(BALANCE, FEE, null);
    expect(String(max.amountLana)).toBe('22775.139327999997');
    expect(max.emptiesWallet).toBe(true);
  });

  it('offers nothing when the cap is known and really is zero', () => {
    const max = maxProposable(BALANCE, FEE, 0);
    expect(max.amountLana).toBe(0);
    expect(max.cappedByRound).toBe(true);
    expect(max.emptiesWallet).toBe(false);
  });
});
