/**
 * SELLING LANA ON LANA.DISCOUNT IS CLOSED (8 Oct 2026).
 *
 * Brilly, in his own words: "Prosim dodelaj tako, da nihče več ne more tam
 * prodajati Lan" — make it so that nobody can sell LANA there any more. The
 * purchase of LANA has been taken over by the BEF dealers that buy it (today
 * Krog menjave and Ravena Plus, read from the relays: ./buyingDealers.ts), and
 * a person who wants to sell registers with one of them.
 *
 * A CONSTANT IN CODE, NOT A SETTING. Nobody reopens selling from an admin page
 * or a database row; it takes a commit that changes this line, and the client
 * mirror in src/lib/sellingClosed.ts with it. The routers take it as an
 * injectable dependency only so the tests of the old flow keep running
 * against it (they pass `sellingClosed: false`).
 *
 * WHAT IS CLOSED — every step that is a person selling LANA to lana.discount,
 * up to the moment their LANA would move:
 *
 *   POST /api/acquisitions/offers            a new proposal
 *   POST /api/acquisitions/:ref/accept       accepting our purchase offer (the contract moment)
 *   POST /api/acquisitions/:ref/transfer     the only place a seller's LANA moves
 *   POST /api/acquisitions/admin/:ref/decide accept and counter (an admin making a purchase offer);
 *                                            decline stays open
 *   POST /api/external/sale                  a partner app booking a person's sale (API key;
 *                                            being3's registerExternalSale is its last caller)
 *   POST /api/wallets/consolidate            merging a wallet so a transfer can carry it — its
 *                                            only purpose was a sale, and it takes a private key
 *   POST /api/sell/execute, /sell/preview    retired before; now they say where selling went
 *
 * The read-only helpers the old /offer page called (GET /acquisitions/mandate,
 * /wallets/consolidation, /wallets/balances, /wallets/utxo-info,
 * /sell/split-check, /user/:hex/wallets) stay as they are: they change nothing
 * and other pages read some of them.
 *
 * WHAT STAYS OPEN, because none of it is a person selling LANA here:
 *   - everything owed for sales already made — settlements (POST
 *     /api/admin/payouts), obligations, history, the seller's own dashboard,
 *     sign-in, and the KIND 30936/30937/30961 publishing;
 *   - a seller withdrawing their own proposal, an admin declining or voiding
 *     one, and the sweeper lapsing what is left;
 *   - the brain's routes (LANA going OUT of the treasury to buyers) and the
 *     treasury round routes the brain pushes to.
 *
 * 410 Gone, as the retired /sell/execute already answers: the flow is gone,
 * not broken. The body carries a full sentence in `error`, because an old page
 * still cached in someone's browser shows exactly that text and nothing else
 * (src/lib/offerErrors.ts falls back to it) — so the sentence itself names the
 * firms.
 */
import type { Response } from 'express';
import type { BuyingDealer, BuyingDealersAnswer } from './buyingDealers.js';

export const SELLING_CLOSED = true;
export const SELLING_MOVED_CODE = 'SELLING_MOVED';
export const SELLING_MOVED_STATUS = 410;

export interface SellingMovedBody {
  error: string;
  code: typeof SELLING_MOVED_CODE;
  /** The firms that buy LANA, as GET /api/buying-dealers names them — empty when none can be named. */
  buyers: BuyingDealer[];
  directoryUrl: string;
}

function listOfNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sentence, naming each firm with the page where a person registers with it. */
export function sellingMovedSentence(answer: Pick<BuyingDealersAnswer, 'buyers' | 'directoryUrl'>): string {
  const closed = 'LANA can no longer be sold on Lana.discount.';
  if (answer.buyers.length === 0) {
    return `${closed} The purchase of LANA has been taken over by the companies listed at ${answer.directoryUrl}: ` +
      'to sell your LANA, register with one of them.';
  }
  const named = listOfNames(answer.buyers.map((b) => `${b.name} (${b.registerUrl})`));
  const whom = answer.buyers.length === 1 ? 'with it' : answer.buyers.length === 2 ? 'with one of the two' : 'with one of them';
  return `${closed} The purchase of LANA has been taken over by ${named}: to sell your LANA, register ${whom}.`;
}

export function sellingMovedBody(answer: Pick<BuyingDealersAnswer, 'buyers' | 'directoryUrl'>): SellingMovedBody {
  return {
    error: sellingMovedSentence(answer),
    code: SELLING_MOVED_CODE,
    buyers: answer.buyers,
    directoryUrl: answer.directoryUrl,
  };
}

/** Answer the request with the refusal. Always returns true, so a route can `if (refuse…) return;`. */
export function refuseSelling(res: Response, answer: Pick<BuyingDealersAnswer, 'buyers' | 'directoryUrl'>): true {
  res.status(SELLING_MOVED_STATUS).json(sellingMovedBody(answer));
  return true;
}
