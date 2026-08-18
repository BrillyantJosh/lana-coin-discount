/**
 * THE VOCABULARY.
 *
 * Every public and counterparty-facing phrase this site uses about what we do
 * lives here, in one file, because it is the artifact a compliance reviewer
 * will actually read. Scattered across thirty components it cannot be checked;
 * here it can.
 *
 * The wording is not decoration. Lana.discount acquires LANA as principal,
 * with its own capital, for its own treasury and at its own risk — and the
 * Proprietary Treasury Acquisition Framework v1.0 (18 Aug 2026) is explicit
 * that this cannot be achieved by relabelling: if the facts become a standing
 * service to clients, no word on this page cures it. What the words CAN do is
 * stop describing something we do not do, and stop promising something we
 * cannot promise.
 *
 * The mapping the framework prescribes (§9), which the rest of this file obeys:
 *
 *   USE                          NOT
 *   Proprietary Treasury         Crypto Exchange
 *   Treasury Acquisition         Cash Out
 *   Purchase / Acquire           Convert LANA to EUR
 *   Seller / Counterparty        Exchange Customer / Client
 *   Submit an Offer              Place Sell Order
 *   Purchase Offer               Exchange Quote
 *   Purchase Price               Exchange Rate
 *   Treasury Wallet              Customer Wallet
 *   Settlement                   Withdrawal
 *   Own Capital / Own Account    Liquidity Service
 *   Accept / Reject / Counter    Guaranteed Execution
 *   Acquisition Window           Always-on Off-ramp
 *
 * Two words are banned outright from anything a counterparty sees, because
 * each carries the whole wrong model with it: **queue** (a place in line for a
 * service that is owed to you) and **payout** as a thing we do for sellers
 * (we settle a purchase price we owe, which is not the same act).
 * `npm test` enforces this — see src/copy.test.ts.
 */

/** The company, written the same way everywhere. */
export const BRAND = 'Lana.discount';

// ─── the paragraphs from the framework, used verbatim ─────────────────────
// §14. These are the sentences the framework itself recommends; they are
// reproduced word for word rather than paraphrased, deliberately.

export const FRAMEWORK_COPY = {
  website:
    'Lana.discount Treasury acquires selected LANA for its own proprietary treasury using its own capital. ' +
    'Holders may submit an offer to sell LANA to Lana.discount. Submission of an offer does not create an ' +
    'obligation for Lana.discount to transact. Each proposed acquisition is reviewed independently and may be ' +
    'accepted, rejected or subject to a counteroffer. If an acquisition is agreed, LANA is transferred directly ' +
    'to a Lana.discount treasury wallet and Lana.discount pays the agreed purchase price from its own funds. ' +
    'Lana.discount does not hold seller crypto-assets on behalf of sellers, manage seller wallets, execute ' +
    'orders for sellers or act as a broker.',

  provenance:
    'Lana.discount acquires only assets that meet its internal treasury eligibility and provenance criteria. ' +
    'Lana.discount may decline any proposed acquisition where available transaction history, ownership ' +
    'information or other risk factors do not meet those criteria.',

  pricing:
    'Any purchase price offered by Lana.discount is determined case by case according to its treasury strategy, ' +
    'reference market information, transaction size, provenance, liquidity, timing and other commercial factors. ' +
    'A previous or indicative price does not create a right to the same price in any future transaction.',
} as const;

// ─── the UI element names the framework prescribes (§8) ───────────────────

export const UI = {
  header: 'Lana.discount Treasury Acquisitions',
  intro: 'Lana.discount periodically acquires selected LANA for its proprietary treasury using its own capital.',
  primaryAction: 'Submit an Offer',
  quantityField: 'LANA offered for sale',
  reviewState: 'Under Treasury Review',
  purchaseOffer: 'Lana.discount Purchase Offer',
  transfer: 'Transfer to Lana.discount Treasury Wallet',
  settlement: 'Purchase Price Settlement',
  history: 'Completed Treasury Acquisitions',
  accepted: 'Accepted',
  rejected: 'Rejected',
  counteroffer: 'Counteroffer',
} as const;

// ─── landing page ─────────────────────────────────────────────────────────

export const LANDING = {
  metaTitle: 'Lana.discount — Treasury Acquisitions',
  metaDescription:
    'Lana.discount acquires selected LANA for its own proprietary treasury, using its own capital. ' +
    'Holders may submit an offer.',

  heroEyebrow: 'Proprietary treasury',
  heroTitle: 'We acquire selected LANA',
  heroTitleSecond: 'for our own treasury.',
  heroBody:
    'Lana.discount buys LANA as principal, with its own capital and at its own risk. Holders may submit an ' +
    'offer; each proposal is reviewed on its own merits and may be accepted, declined or met with a ' +
    'counteroffer. Submitting an offer does not oblige us to transact.',
  heroBodySecond:
    'Everything we have already acquired, and every purchase price we still owe, is published below.',
  heroPrimaryCta: 'Submit an Offer',
  heroSecondaryCta: 'See what we owe',

  // The sections. Same data as before, named for what it actually is.
  settlementsTitle: 'Outstanding purchase-price settlements',
  settlementsIntro:
    'Every purchase price we have agreed and not yet paid, and the order in which we settle them: those who ' +
    'finance the Lana economy first, in financing order, then crowd-funding project owners, then the rest, ' +
    'separately for each currency. Each line is money Lana.discount owes for LANA it has already bought.',
  settlementsLink: 'Open the full list →',

  completedTitle: 'Completed treasury acquisitions',
  completedIntro:
    'Purchase prices we have settled, most recent first. Published so anyone can check what we say against ' +
    'what we have done.',
  completedLink: 'View the last 100 →',

  flowsTitle: 'Daily FIAT flows',
  flowsIntro: 'Purchase prices settled to counterparties, and FIAT received from investors, by day.',

  positionTitle: 'Net FIAT position',
  positionIntro:
    'The same money, added up. Received minus settled, day by day, since the first day — above the line means ' +
    'more has come in than has gone out by that day.',

  frameworkTitle: 'How we acquire',
  frameworkPricingTitle: 'How a purchase price is set',
  frameworkProvenanceTitle: 'What we will acquire',
} as const;

// ─── how it works, on the landing page ────────────────────────────────────
// The old four steps described selling the counterparty's coins onward for
// them, which is the one thing the framework says we must not do (§4).

export const HOW_IT_WORKS = {
  title: 'How an acquisition works',
  intro: 'Four steps. We decide before anything moves.',
  steps: [
    {
      title: 'Submit an offer',
      body:
        'Sign in with your LanaCoin wallet and tell us how much LANA you are offering. A submission is a ' +
        'proposal, not an instruction, and it creates no right to a transaction.',
    },
    {
      title: 'We review it',
      body:
        'We look at provenance, treasury demand, available capital, size, price, timing and transaction risk — ' +
        'and decide whether we want to own this LANA, from this counterparty, at this moment.',
    },
    {
      title: 'You accept our purchase offer',
      body:
        'If we want it, we make a purchase offer: a specific price, from our own funds, with the date we owe it ' +
        'by. You may accept it, or not. We may also decline, or counter with a different price.',
    },
    {
      title: 'Transfer, then settlement',
      body:
        'Only after you accept do you transfer the LANA to our treasury wallet. It becomes our property and our ' +
        'risk, and we owe you the agreed purchase price.',
    },
  ],
} as const;

export const ELIGIBILITY = {
  title: 'What we acquire',
  intro: 'We do not acquire every LANA in circulation. These are our own criteria, applied to our own treasury.',
  cards: [
    {
      title: 'Clean provenance',
      body:
        'We may review the history and status of the LANA offered before deciding. Unexplained breaks, ' +
        'conflicting ownership information or risk indicators are reasons to decline, reduce or reprice.',
    },
    {
      title: 'No open obligations',
      body: 'A counterparty must have no open obligations of their own for us to consider a proposal.',
    },
    {
      title: 'Our appetite, at that moment',
      body:
        'Treasury demand, available capital and concentration limits all bear on the answer. We may pause ' +
        'acquisitions in any currency, or for any class of holding, at any time.',
    },
  ],
} as const;

// ─── the offer flow, for the counterparty ─────────────────────────────────

export const OFFER = {
  pageTitle: UI.header,
  pageIntro: UI.intro,

  selectWallet: 'Select the wallet you are offering from',
  amountTitle: 'How much LANA are you offering?',
  amountLabel: UI.quantityField,
  amountHint:
    'We will review this proposal and, if we want the asset, make you a purchase offer. No price is fixed ' +
    'until then.',
  submit: UI.primaryAction,
  submitting: 'Submitting…',

  // The three outcomes.
  offeredTitle: UI.purchaseOffer,
  offeredBody:
    'This is what Lana.discount will pay for the LANA you offered, from its own funds. It stands until the ' +
    'time shown; after that it lapses and you may submit a new offer.',
  offeredPriceLabel: 'Purchase price',
  offeredDueLabel: 'We settle by',
  offeredExpiryLabel: 'Offer stands until',
  offeredAccept: 'Accept this purchase offer',
  offeredDecline: 'Not now',

  reviewTitle: UI.reviewState,
  reviewBody:
    'Your proposal is with our treasury. We will make a purchase offer, decline, or come back with a ' +
    'counteroffer. Nothing has been transferred and nothing is owed either way.',
  reviewRef: 'Your reference',

  declinedTitle: 'Not acquiring this at the moment',
  declinedBody:
    'Lana.discount has decided not to acquire this holding right now. Nothing has been transferred. This says ' +
    'nothing about the LANA itself — only about what our treasury wants today.',

  // After acceptance.
  transferTitle: UI.transfer,
  transferBody:
    'You have accepted our purchase offer. Transfer the LANA to our treasury wallet to complete the ' +
    'acquisition; the purchase price is then owed to you and settled by the date shown.',
  transferConfirm: 'Transfer and complete',
  transferring: 'Transferring…',

  completedTitle: 'Acquisition complete',
  completedBody:
    'The LANA is now Lana.discount property and risk. We owe you the agreed purchase price and settle it by ' +
    'the date shown.',

  keyLabel: 'WIF private key',
  // Deliberately narrower than it used to be. The old line read as a promise
  // that the key never leaves the device; it is used to sign this one transfer
  // and then discarded, and the copy should not claim more than that.
  keyNote: 'Used once to sign this transfer, then discarded. It is never stored.',

  settlementTiming:
    'We settle purchase prices in the order shown on our public list. The date on your offer is the date we ' +
    'owe by.',

  // ── before a proposal can even be made ──────────────────────────────────
  // Refusals the counterparty meets at the wallet step. Said there, in full,
  // rather than after a private key has been typed.

  blockedTitle: 'We cannot consider an offer from you right now',
  blockedBody:
    'A counterparty must have no open obligations of their own before Lana.discount will consider a proposal. ' +
    'Settle what is outstanding and this page opens again.',
  walletFrozen: 'A frozen wallet cannot transfer LANA. Unfreeze it first, then come back.',
  walletOutOfScopeTitle: 'We are not acquiring from this wallet',
  consolidateTitle: 'This wallet needs consolidating first',
  consolidateBody:
    'It holds more separate inputs than a single transfer can carry, so a transfer to our treasury wallet ' +
    'would fail. Consolidate it, then submit an offer.',
  settlementCurrencyLabel: 'Settlement currency',
  noSettlementAccountTitle: 'No account we could settle to',
  noSettlementAccountBody:
    'Your profile carries no payment details in {currency}, so a purchase price in that currency could not be ' +
    'settled to you. Add them to your profile, then submit an offer.',

  // ── an offer stands for a limited time ──────────────────────────────────
  // It can lapse while the counterparty is still reading it, and it lapses in
  // the same way whether they have accepted it or not.

  timeLeftLabel: 'Time left to accept',
  lapsedTitle: 'This purchase offer has lapsed',
  lapsedBody:
    'It stood for a fixed time and that time has passed, so it is no longer open. Nothing has been ' +
    'transferred. You may submit a new offer and we will look at it again.',
  lapsedAgain: 'Submit a new offer',
  notNowNote:
    'That purchase offer is closed and nothing has been transferred. You may submit a new one at any time.',

  // ── the counterparty's own record ───────────────────────────────────────
  myOffersTitle: 'Your offers',
  myOffersIntro:
    'Proposals you have submitted and what we did with each one. Nothing is owed either way until you accept ' +
    'a purchase offer.',
  completedAcquiredLabel: 'LANA acquired',
  transferHashLabel: 'Transfer',
} as const;

// ─── the two status vocabularies ──────────────────────────────────────────
// The status strings these are keyed by are a wire protocol: they appear in
// atomic SQL, in a public external API and as Nostr KIND 30936 tag values, so
// they are never renamed. Only the labels below change.

/** The life of an offer, as the counterparty reads it. */
export const OFFER_STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  under_review: UI.reviewState,
  offered: 'Purchase offer open',
  accepted: UI.accepted,
  declined: UI.rejected,
  expired: 'Lapsed',
  withdrawn: 'Closed',
  settled: 'Acquired',
};

/** An acquisition already on our books, and how far its settlement has got. */
export const ACQUISITION_STATUS_LABELS: Record<string, string> = {
  broadcast: 'Transfer confirming',
  pending_verification: 'In verification',
  completed: 'Settlement due',
  paid: 'Settled',
  failed: 'Not completed',
  /** Not a stored status — a purchase price we have started to settle. */
  part_settled: 'Part-settled',
};

// ─── terms shown before a counterparty accepts ────────────────────────────

export const TERMS = {
  title: 'Before you accept',
  points: [
    'Lana.discount is buying this LANA for its own treasury, as principal and with its own capital. It is not ' +
      'selling it on your behalf and is not acting as your broker.',
    'The purchase price shown is what Lana.discount will pay. It is our offer for this proposal, not a market ' +
      'rate and not a price you can rely on in future.',
    'Once you transfer, the LANA is ours, along with any later gain or loss on it.',
    'We owe you the purchase price by the date shown on the offer. Settlements follow the published order.',
    'Lana.discount does not hold your keys, does not hold balances for you, and does not execute orders for you.',
  ],
  agree: 'I have read this and accept the purchase offer.',
  continue: 'Accept',
} as const;

// ─── how we settle what we owe, on the landing page ───────────────────────
// The block this replaces promised "a fair, public queue" and printed a
// standing two-rate formula. Together those are exactly the automatic
// conversion entitlement §6 says we must not publish: every holder, any time,
// at a rate they can read off the page. The ordering itself is true, the owner
// wants it visible, and it survives; the entitlement and the rates do not.

export const SETTLEMENT_ORDER = {
  title: UI.settlement,
  intro: OFFER.settlementTiming,
  points: [
    {
      title: 'Financiers first, then crowd-funding',
      body:
        'Those who finance the Lana economy — who fund the budgets that drive real spending — are settled ' +
        'first, in the order they financed: round 1 before round 2 before round 3, first come first served ' +
        'inside a round. Then crowd-funding project owners who have raised support this cycle. Then everyone ' +
        'else we owe.',
    },
    {
      title: 'Each currency on its own',
      body:
        'EUR, GBP and every other currency are settled independently. An obligation we have not yet settled ' +
        'in one currency never holds up one in another.',
    },
    {
      title: 'From our own funds, as revenue arrives',
      body:
        'We settle purchase prices out of our own capital, as the spending economy generates it. Your accepted ' +
        'offer carries the date we owe by. What we do afterwards with LANA we have acquired is our own risk ' +
        'and is not a step in paying you.',
    },
    {
      title: 'Published, so it can be checked',
      body:
        'Every purchase price we owe and have not yet settled is listed above, with its position and amount, ' +
        'and every one we have settled is in the acquisitions list. Nothing about the order is decided out of ' +
        'sight.',
    },
  ],
} as const;

// ─── words that must never reach a counterparty ───────────────────────────
// Enforced by src/copy.test.ts across the public and counterparty surfaces.
// Each one carries a model of the business that is not ours.

export const FORBIDDEN_PUBLIC_TERMS = [
  'cash out',
  'cash-out',
  'exchange rate',
  'sell order',
  'best price',
  'best execution',
  'guaranteed',
  'payout queue',
  'withdrawal',
  'liquidity service',
  'off-ramp',
] as const;
