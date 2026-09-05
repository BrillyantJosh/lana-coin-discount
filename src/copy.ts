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
    'Every purchase price we have agreed and not yet paid, and the order in which we settle them: acquisitions ' +
    'from financing budgets by round — round 1, then 2, then 3, each opened on its published date — then ' +
    'acquisitions outside a round, separately for each currency. Each line is money Lana.discount owes for ' +
    'LANA it has already bought.',
  settlementsLink: 'Open the full list →',

  completedTitle: 'Completed treasury acquisitions',
  completedIntro:
    'Purchase prices we have settled, most recent first. Published so anyone can check what we say against ' +
    'what we have done.',
  completedLink: 'View the last 100 →',

  flowsTitle: 'Daily FIAT flows',
  flowsIntro: 'Purchase prices settled to counterparties, and FIAT received from financers, by day.',

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
    'Acquisitions from financing budgets follow the published round order — round 1, then 2, then 3. The date ' +
    'on your offer is the date we owe by.',

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

  // ── financing-round mandates (BEF P08) ──────────────────────────────────
  // An indicative figure is a projection from public parameters. It is shown
  // only where a mandate exists, under a heading that says what it is not,
  // because the one thing a public page must never do is read as a standing
  // rate (P08 §4). Only a purchase price on an accepted offer binds.
  indicativeLabel: 'Indicative figure — not a price, not a rate, not a guarantee.',
  indicativeBasisProjected: 'Basis: projected next-Split reference',
  indicativeBasisCurrent: 'Basis: live Split reference',
  indicativeNote:
    'A projection from the round discount and the reference shown, for the amount you enter. It is not an ' +
    'offer. If the treasury wants the LANA, its purchase offer carries the price — and only that price binds.',
  indicativeForLabel: 'For',
  indicativeAmountLabel: 'Indicative amount',
  indicativeReferenceLabel: 'Reference',
  indicativeDiscountLabel: 'Round discount',

  // A proposal above the remaining mandate is met with a counteroffer for
  // what is left (P08 §2), not a refusal.
  counterTitle: 'Counteroffer — for your remaining mandate',
  counterBody:
    'You proposed {proposed} LANA; the treasury can acquire {allowed} LANA now — your remaining mandate. ' +
    'Accept {allowed} LANA or not now.',
  counterTag: UI.counteroffer,

  // A proposal before the round date. The date opens a mandate; it creates no
  // right to sell, so this is a "not yet", with the date, and nothing more.
  notOpenTitle: 'The treasury is not accepting proposals from this round yet',
  notOpenBody:
    'From {date} the treasury accepts proposals from financing round {round}. Nothing has been transferred. ' +
    'Please propose again then.',

  // How much may be proposed under the open round, next to the amount field.
  capHint: 'Under round {round} the treasury can acquire up to {remaining} LANA from this wallet now.',
  capHintAbove: 'Anything above that is met with a counteroffer for what remains.',
  proposeNotYet: 'Proposals open on the round date',
} as const;

// ─── the mandate panel: what a financer sees about their own rounds ───────
// The event on the relays and the dates here are evidence of a treasury
// mandate (P08 §2). None of it is a right to sell (P08 §8), and the wording
// says so: "the treasury accepts proposals from…", never "you may sell".

export const MANDATE = {
  title: 'Your financing-round mandate',
  intro:
    'The treasury acquires from financing budgets round by round — round 1, then 2, then 3 — each from its ' +
    'published date, and from each budget up to the LANA it received. This is what applies to the wallet ' +
    'you selected.',
  roundLabel: 'Round {round}',
  expectedLabel: 'Received by this budget',
  remainingLabel: 'Remaining under the mandate',
  proposedLabel: 'Proposed',
  acceptedLabel: 'Accepted',
  settledLabel: 'Settled',
  stateLabel: 'State',

  // The timing line, one per state (server/lib/roundMandate.ts RoundState).
  upcomingSplit: 'This Split is still running; your mandate opens after the Split, on the round date',
  notOpen: 'Round {round} opens on {date}',
  open: 'Round {round} is open — you may propose up to {remaining} LANA',
  released: 'Opened early by the treasury',
  fullyAcquired: 'Fully acquired',
  termsMissing: 'The treasury has not yet published its terms for this round',
  windowPassed: 'The window for this mandate has passed',
  closed: 'This mandate has been closed',
  splitUnknown: 'The current Split could not be read right now',

  // Short chips for the same states.
  states: {
    upcoming_split: 'After the Split',
    not_open: 'Opens later',
    open: 'Open',
    released: 'Opened early',
    fully_acquired: 'Fully acquired',
    terms_missing: 'Terms pending',
    window_passed: 'Window passed',
    closed: 'Closed',
    split_unknown: 'Unknown',
  } as Record<string, string>,

  noMandateTitle: 'No financing-round mandate for this wallet',
  noMandateBody:
    'The treasury has published no mandate for this wallet. A proposal from it is not judged against a round: ' +
    'it goes to a person to decide, with no automatic offer either way.',
  loading: 'Reading your mandate…',
  unavailable: 'Your mandate could not be read right now. You may still propose; the treasury judges it on receipt.',
  openNoRight: 'A round date opens a treasury mandate. It creates no right to sell (BEF P08 §8).',
  eventLabel: 'Mandate event',
} as const;

// ─── what a refusal from the mandate path means, in words ─────────────────
// Keyed by the server's `code`. Every code has a sentence; an unknown one
// falls back to the server's own `error` text.

export const OFFER_ERRORS: Record<string, string> = {
  MANDATE_NOT_OPEN: OFFER.notOpenBody,
  TERMS_MISSING: 'The treasury has not yet published its terms for this round. Please try again later.',
  SPLIT_WINDOW: 'This mandate is not in the window the treasury acquires from right now.',
  FULLY_ACQUIRED: 'The treasury has already acquired the full amount this mandate covers.',
  WALLET_NOT_OWNED: 'This wallet is not on the signed wallet list of your account, so a proposal from it cannot be made.',
  WALLET_OWNERSHIP_UNVERIFIABLE: 'Wallet ownership could not be verified right now. Please try again shortly.',
  SIGNATURE_REQUIRED: 'This proposal must be signed with the key of your account. Please sign in again and retry.',
  SIGNATURE_REPLAYED: 'This signed request was already used. Please submit it again.',
  SIGNATURE_STALE: 'Your device clock differs from ours by more than five minutes. Please correct it and retry.',
  REFERENCE_MOVED: 'The reference moved while this offer stood, so it lapsed. Please propose again.',
  EMPTY_WALLET_EXCEEDS_MANDATE:
    'This wallet holds more than the amount the treasury agreed to acquire, so it cannot be emptied into this ' +
    'acquisition. Transfer the agreed amount only.',
  BALANCE_UNVERIFIABLE: 'The wallet balance could not be read right now. Please try again shortly.',
  BELOW_MINIMUM: 'This proposal is below the minimum acquisition value.',
  MANDATE_EXHAUSTED: 'This mandate has been used up: the treasury has acquired everything it covers. Nothing more can be proposed under it.',
  ALREADY_SETTLED: 'This acquisition has already been settled. Nothing is outstanding on it.',
};

// ─── admin screens for the rounds ─────────────────────────────────────────
// Read by us, not by counterparties — but they say the same true thing.

export const ADMIN_ROUNDS = {
  title: 'Round dates & discounts',
  intro:
    'One date and one discount per financing round, per Split. From its date the treasury accepts proposals ' +
    'from that round, up to the LANA each budget received.',
  banner: 'A date OPENS a mandate; it grants no right to sell (BEF P08 §8).',
  splitLabel: 'Split',
  liveSplit: 'Split {split} — live window',
  upcomingSplit: 'Split {split} — upcoming (opens after the Split)',
  opensLabel: 'Opens (UTC)',
  discountLabel: 'Acquisition discount %',
  prefill: 'Prefill from Direct Fund',
  prefillNone: 'Direct Fund suggests nothing for the empty fields.',
  prefillUnreachable: 'Direct Fund could not be reached; no suggestions.',
  bandWarning: 'Outside the BEF P08 §4 orientation band of {min}–{max} %.',
  save: 'Save round terms',
  saved: 'Round terms saved',
} as const;

export const ADMIN_MANDATES = {
  title: 'Mandates — financer × round',
  intro:
    'Every financing budget the treasury may acquire from this Split, from the signed KIND 30960 events, with ' +
    'what was received, what remains, and what has been proposed, accepted and settled.',
  tiles: { expected: 'Expected', remaining: 'Remaining', proposed: 'Proposed', accepted: 'Accepted', settled: 'Settled' },
  sync: 'Sync now',
  syncing: 'Syncing…',
  releaseNow: 'Release now',
  releaseWithdraw: 'Withdraw release',
  releaseTitle: 'Release this mandate ahead of its date',
  releaseBody: 'The financer may propose from this budget immediately. A reason is required and is recorded.',
  releaseRound1Confirm: 'I understand this opens a round-1 mandate before the published date.',
  releaseReason: 'Reason',
  degraded: {
    noEvents: 'No mandate events for this Split. Nothing has been published, or the sync has not run.',
    noTerms: 'No round dates or discounts are set for this Split — no round can open.',
    splitUnknown: 'The current Split is unknown (no KIND 38888). No window can be judged.',
    staleSync: 'The last verified relay sync is older than 24 hours.',
    balancesPartial: 'Some on-chain balances could not be read.',
    paidInUnavailable: 'direct.lana.fund did not answer, so the paid-in column is empty. The LANA figures are unaffected.',
    paidInStale: 'The paid-in figures are the last ones direct.lana.fund gave; it did not answer just now.',
  },
  acceptedExceedsReceived: 'Accepted exceeds received — a re-allocation shrank this budget after acceptance.',
  money: {
    paidIn: 'Paid in',
    payout: 'Will receive',
    paidInRound: 'Financers paid in',
    model: 'the discount implies +{model}%',
    offModel:
      'This budget paid in more than the LANA on the mandate accounts for (the discount implies +{model}%). ' +
      'Part of the money is not in settled purchases — a re-allocation, or purchases still in flight.',
  },
  funding: {
    heading: 'What round {round} still has to pay',
    stillToPay: 'still to pay',
    wholeRound: 'Whole round',
    agreed: 'Agreed, not yet paid',
    paid: 'Already paid',
    perLana: 'Per LANA',
    mandateCount: '{count} mandates',
    noDate: 'no date',
    none: 'No mandates in this round, so nothing to pay.',
    filteredOut: 'No mandates in this round match the filter above.',
    splitTotal: 'Still to pay across all rounds of this Split',
    projection:
      'A projection at today\'s reference, not a price: only an accepted purchase price binds. ' +
      'Money already agreed or paid is taken from the offers themselves.',
  },
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
    'We owe you the purchase price by the date shown on the offer. Acquisitions from financing budgets follow ' +
      'the published round order — round 1, then 2, then 3.',
    'Lana.discount does not hold your keys, does not hold balances for you, and does not execute orders for you.',
  ],
  agree: 'I have read this and accept the purchase offer.',
  continue: 'Accept',
} as const;

// ─── how we settle what we owe, on the landing page ───────────────────────
// The block this replaces promised "a fair, public queue" and printed a
// standing two-rate formula. Together those are exactly the automatic
// conversion entitlement §6 says we must not publish: every holder, any time,
// at a rate they can read off the page. What survives is the ONE order the
// owner set on 4 Sep 2026 — by financing round — and nothing else ranks a
// counterparty: no external rank, no crowd-funding band. The entitlement and
// the rates do not survive.

export const SETTLEMENT_ORDER = {
  title: UI.settlement,
  intro: OFFER.settlementTiming,
  points: [
    {
      title: 'Round 1, then round 2, then round 3',
      body:
        'Acquisitions from financing budgets are settled by financing round — round 1, then round 2, then ' +
        'round 3 — each opened on a published date. Earlier acquisitions come first inside a round. ' +
        'Acquisitions outside a round come after them.',
    },
    {
      title: 'Per financer, up to the LANA their budget received',
      body:
        'Within a round, a treasury mandate names each financer and the amount their financing budget ' +
        'received. That amount is the most the treasury acquires from that budget under the mandate — a ' +
        'ceiling on what we buy, not a right to sell.',
    },
    {
      title: 'Each currency on its own',
      body:
        'EUR, GBP and every other currency are settled independently. An obligation we have not yet settled ' +
        'in one currency never holds up one in another.',
    },
    {
      title: 'From our own funds, by the date on the offer',
      body:
        'We settle purchase prices out of our own capital. Your accepted offer carries the date we owe by, ' +
        'and that date is the promise. What we do afterwards with LANA we have acquired is our own risk and ' +
        'is not a step in paying you.',
    },
    {
      title: 'Published, so it can be checked',
      body:
        'The round dates are published, every purchase price we owe and have not yet settled is listed above ' +
        'with its round and amount, and every one we have settled is in the acquisitions list. Nothing about ' +
        'the order is decided out of sight.',
    },
  ],
} as const;

// ─── the public settlement board ──────────────────────────────────────────
// A line says who we owe, how much, and which financing round settles it.
// It never says who is "next": the round dates and the date on each offer
// are the only timing anyone is given.

export const BOARD = {
  roundBadge: 'Round {round}',
  roundTitle: 'Financing round {round} of Split {split}',
  outsideRoundBadge: 'Outside a round',
  nothingOutstanding: 'Nothing outstanding',
  nothingOutstandingBody: 'Every agreed purchase price has been settled.',
  loadFailed: 'Could not load outstanding settlements. Please try again.',
  footer:
    'Round 1, then 2, then 3, then acquisitions outside a round · earliest first inside each · per currency · ' +
    'updates every 30s',
} as const;

// ─── the round dates, on the landing page ─────────────────────────────────
// Dates, states and LANA totals from the public /api/treasury/rounds. The
// round discount is NOT shown here on purpose: a percentage beside a date on
// a public page reads as a standing rate (P08 §4).

export const ROUND_DATES = {
  title: 'Financing rounds — Split {split}',
  intro:
    'The treasury acquires from financing budgets round by round. Each round opens on the date below; from ' +
    'then on the treasury accepts proposals from that round, up to the LANA each budget received. A date ' +
    'opens a mandate — it is not a right to sell, and no price is fixed by it.',
  opensLabel: 'Opens',
  noDate: 'No date published yet',
  mandates: 'Mandates',
  noMandates: 'No mandates published',
  expectedLabel: 'Received by budgets in this round',
  remainingLabel: 'Remaining in this round',
  acceptedLabel: 'Accepted in this round',
  settledLabel: 'Settled in this round',
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
  // We acquire for our treasury; a "buyback" is a promise to take coins back,
  // and an "investor" is someone we owe a return. Neither is what happens here:
  // the people whose budgets we acquire from are financers.
  'buyback',
  'buy-back',
  'investor',
] as const;
