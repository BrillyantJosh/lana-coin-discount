/**
 * KIND 30961 — WHERE ONE FINANCING BUDGET STANDS WITH THE TREASURY.
 *
 * Owner, 13 Sept 2026: "poskrbi da bo tudi lana.discount začela objavljati
 * poplačila na relayje … vsak budget, vsa izplačila zelo natančno objavi in
 * poveže z budgeti … tako, da lahko druge aplikacije to spremljajo."
 *
 * The pieces were already public, but nothing tied them together: KIND 30936
 * says a sale happened and KIND 30937 that a payment was recorded, and neither
 * says which budget, which round or which mandate it belonged to. This event
 * is that link — one replaceable event per budget, d = "<split>:<round>:<fund
 * setting id>", republished whenever anything in it changes:
 *
 *   the budget      a 30938 (Direct.Fund), its wallet, the LANA it received
 *   the mandate     a 30960, the round's payout date and sell fee (KIND 38888)
 *   every sale      under that mandate from that budget's wallet, a 30936
 *   every payment   recorded against those sales, a 30937
 *   the totals      acquired and paid, in LANA, in money and as percentages
 *
 * Everything here is pure: the rows come in, the tags go out. What the caller
 * reads from the database, and when it publishes, lives next door.
 *
 * ── Rules this is built on ────────────────────────────────────────────────
 *
 * 1. A SALE BELONGS TO A BUDGET THROUGH ITS MANDATE AND WALLET. The
 *    offer records the mandate (d tag) and the wallet it came from; the
 *    mandate records which budget holds LANA in which wallet. A wallet the
 *    budget used to have still counts (a lost key replaced mid-split must not
 *    orphan the sales already made).
 *
 * 2. ONE WALLET, TWO BUDGETS: FILL THE SALE'S OWN CURRENCY FIRST. Several
 *    mandates hold two budgets in one wallet, and the chain cannot tell whose
 *    LANA a transfer moved. In Split 8 three financers held a EUR and a GBP
 *    budget in one wallet and sold all of it in EUR — read by currency alone,
 *    the EUR budget showed 200% and the GBP budget 0% for ever, though its LANA
 *    was gone. So, sale by sale in the order they were agreed: the budgets in
 *    the sale's currency take it first, up to what each still has; what is
 *    left goes to the other budgets in that wallet, up to what they still
 *    have; anything beyond all of that stays with the sale's currency. Within
 *    a tier the split follows what each budget still has, by largest
 *    remainder in lanoshis and cents, so the parts add up exactly to the
 *    whole. Each sale tag carries both the whole and this budget's part, and
 *    money is always reported in the currency it was agreed and paid in —
 *    a GBP budget sold in EUR says EUR.
 *
 * 3. ACQUIRED MEANS TRANSFERRED; PAID MEANS RECORDED. A sale counts as acquired
 *    once its LANA was sent (offer settled), in progress while it is only
 *    agreed. Money counts as paid when a payment was entered in the records —
 *    `recorded_at`, never a bank value date.
 *
 * 4. NO BANK ACCOUNT, NO NAME, NO NOTE. The financer is the hex already public
 *    in 30960; what the operator typed about a payment stays in the database.
 */
import crypto from 'crypto';

export const BUDGET_SETTLEMENT_KIND = 30961;

export const BUDGET_SETTLEMENT_NOTE =
  'Treasury acquisitions under a KIND 30960 mandate, and the payments recorded for them, for ONE financing budget. ' +
  'Tags are authoritative; this content mirrors them. Money is per currency, in the currency it was agreed and paid in; LANA to 8 decimals. ' +
  'recorded_at is when a payment was entered in lana.discount records, not a bank value date. ' +
  'A record of what happened — not a price, rate or promise (BEF P08 §4).';

export interface BudgetDefinition {
  split: number;
  round: number;
  financerHex: string;
  fundSettingId: string;
  currency: string;
  /** The budget's wallet as its mandate names it now. */
  wallet: string;
  /** Every address the mandate has named for this budget, the current one included. */
  walletHistory: string[];
  lanaReceivedLanoshis: number;
  /** "<split>:<round>:<financer hex>" */
  mandateDTag: string;
  /** "30960:<pubkey>:<d>" */
  mandateAddress: string;
  /** "30938:<pubkey>:<fund setting id>", as the mandate event carries it; null when it does not. */
  budgetAddress: string | null;
  /** 'not_in_mandate' = the mandate is still announced but no longer names this budget. */
  mandateStatus: 'announced' | 'closed' | 'not_in_mandate';
}

export interface SaleInput {
  offerRef: string;
  mandateRef: string;
  senderWallet: string;
  currency: string;
  offerStatus: 'accepted' | 'settled';
  lanaLanoshis: number;
  referenceRate: number | null;
  discountPercent: number | null;
  grossFiat: number | null;
  /** The purchase price — what the payments are measured against. */
  netFiat: number | null;
  acceptedAt: number | null;
  transactionId: number | null;
  txHash: string | null;
  txStatus: string | null;
  lanaMovedLanoshis: number | null;
  completedAt: number | null;
  blockHeight: number | null;
}

export interface PayoutInput {
  payoutId: string;
  transactionId: number;
  amount: number;
  currency: string;
  recordedAt: number | null;
}

export interface RoundTermsEcho {
  opensAt: number | null;
  sellFeePercent: number | null;
}

export interface BuildInput {
  budgets: BudgetDefinition[];
  sales: SaleInput[];
  payouts: PayoutInput[];
  /** Keyed "<split>:<round>". */
  terms: Map<string, RoundTermsEcho>;
  /** The key that signs 30936/30937 — this event's own signer. */
  signerPubkey: string;
  /** The crumb rule: could this much LANA, in this currency, still be sold at all? */
  sellable: (lana: number, currency: string) => boolean;
  now: number;
}

export type SaleStatus = 'accepted' | 'transferred' | 'confirmed';

export interface BudgetTotals {
  lanaReceivedLanoshis: bigint;
  lanaAcquiredLanoshis: bigint;
  lanaInProgressLanoshis: bigint;
  lanaRemainingLanoshis: bigint;
  lanaPaidLanoshis: bigint;
  /** Per currency the money was agreed / recorded in. */
  agreedCents: Map<string, bigint>;
  paidCents: Map<string, bigint>;
  acquisition: 'none' | 'partly' | 'full';
  payment: 'none' | 'partly' | 'full';
}

export interface BudgetSettlementEvent {
  dTag: string;
  fundSettingId: string;
  tags: string[][];
  content: string;
  /** sha256 over the tags without snapshot_at — changes only when something real did. */
  hash: string;
  totals: BudgetTotals;
}

export interface BuildResult {
  events: BudgetSettlementEvent[];
  /** Sales under a mandate that no budget definition claims — logged, never guessed. */
  unattributed: string[];
}

// ─── arithmetic ────────────────────────────────────────────────────────────

const LANOSHIS = 100_000_000n;

export function lana8(lanoshis: bigint): string {
  const sign = lanoshis < 0n ? '-' : '';
  const abs = lanoshis < 0n ? -lanoshis : lanoshis;
  return `${sign}${abs / LANOSHIS}.${String(abs % LANOSHIS).padStart(8, '0')}`;
}

export function money2(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

const toCents = (v: number | null | undefined): bigint => BigInt(Math.round((Number(v) || 0) * 100));

/** part ÷ whole as a percent with two decimals, rounded half up; "0.00" when there is no whole. */
export function percent2(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0.00';
  const hundredths = (part * 10_000n * 2n + whole) / (whole * 2n);
  return money2(hundredths);
}

/**
 * Divide `total` in proportion to `weights` so the parts add up to exactly
 * `total`: floors first, then the leftover units one each to the largest
 * remainders, earlier index first on a tie. All-zero weights share equally.
 */
export function largestRemainder(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const w = weights.every(x => x <= 0n) ? weights.map(() => 1n) : weights.map(x => (x > 0n ? x : 0n));
  const sum = w.reduce((a, b) => a + b, 0n);
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const parts = w.map(x => (abs * x) / sum);
  const remainders = w.map((x, i) => ({ i, r: (abs * x) % sum }));
  let left = abs - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left <= 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return negative ? parts.map(p => -p) : parts;
}

// ─── the build ─────────────────────────────────────────────────────────────

export function saleStatusOf(s: SaleInput): SaleStatus {
  if (s.txStatus === 'completed' || s.txStatus === 'paid') return 'confirmed';
  if (s.offerStatus === 'settled' || s.transactionId !== null) return 'transferred';
  return 'accepted';
}

const str = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : String(v));

interface BudgetSaleLine {
  sale: SaleInput;
  status: SaleStatus;
  budgetLanoshis: bigint;
  budgetNetCents: bigint;
  wholePaidCents: bigint;
  payouts: Array<{ payout: PayoutInput; budgetCents: bigint }>;
}

export function buildBudgetSettlements(input: BuildInput): BuildResult {
  const budgets = [...input.budgets].sort((a, b) =>
    a.split - b.split || a.round - b.round || Number(a.fundSettingId) - Number(b.fundSettingId) || a.fundSettingId.localeCompare(b.fundSettingId));

  const lines = new Map<string, BudgetSaleLine[]>(budgets.map(b => [b.fundSettingId + '@' + b.mandateDTag, []]));
  const keyOf = (b: BudgetDefinition) => b.fundSettingId + '@' + b.mandateDTag;
  const unattributed: string[] = [];

  const payoutsByTx = new Map<number, PayoutInput[]>();
  for (const p of input.payouts) {
    const list = payoutsByTx.get(p.transactionId) ?? [];
    list.push(p);
    payoutsByTx.set(p.transactionId, list);
  }

  const sales = [...input.sales].sort((a, b) =>
    (a.acceptedAt ?? a.completedAt ?? 0) - (b.acceptedAt ?? b.completedAt ?? 0) || a.offerRef.localeCompare(b.offerRef));

  // What each budget has already taken, in the order the sales were agreed.
  const taken = new Map<string, bigint>(budgets.map(b => [keyOf(b), 0n]));
  const receivedOf = (b: BudgetDefinition) => BigInt(Math.max(0, Math.round(b.lanaReceivedLanoshis)));

  for (const sale of sales) {
    const owners = budgets.filter(b => b.mandateDTag === sale.mandateRef && b.walletHistory.includes(sale.senderWallet));
    if (owners.length === 0) { unattributed.push(sale.offerRef); continue; }

    const saleCurrency = sale.currency.toUpperCase();
    const same = owners.filter(b => b.currency.toUpperCase() === saleCurrency);
    const other = owners.filter(b => b.currency.toUpperCase() !== saleCurrency);
    const parts = new Map<string, bigint>(owners.map(b => [keyOf(b), 0n]));
    let left = BigInt(Math.round(sale.lanaLanoshis));

    for (const tier of [same, other]) {
      if (left <= 0n || tier.length === 0) continue;
      const room = tier.map(b => {
        const r = receivedOf(b) - (taken.get(keyOf(b)) ?? 0n);
        return r > 0n ? r : 0n;
      });
      const roomTotal = room.reduce((a, c) => a + c, 0n);
      if (roomTotal <= 0n) continue;
      const take = left < roomTotal ? left : roomTotal;
      largestRemainder(take, room).forEach((v, i) => parts.set(keyOf(tier[i]), parts.get(keyOf(tier[i]))! + v));
      left -= take;
    }
    if (left > 0n) {
      // More than every budget in the wallet still had: it stays with the sale's currency.
      const home = same.length > 0 ? same : owners;
      largestRemainder(left, home.map(receivedOf)).forEach((v, i) => parts.set(keyOf(home[i]), parts.get(keyOf(home[i]))! + v));
    }

    const holders = owners.filter(b => parts.get(keyOf(b))! > 0n);
    const share = holders.length > 0 ? holders : [same[0] ?? owners[0]];
    const weights = share.map(b => parts.get(keyOf(b))!);
    const netParts = largestRemainder(toCents(sale.netFiat), weights);

    const txPayouts = (sale.transactionId === null ? [] : payoutsByTx.get(sale.transactionId) ?? [])
      .sort((a, b) => (a.recordedAt ?? 0) - (b.recordedAt ?? 0) || a.payoutId.localeCompare(b.payoutId));
    const payoutParts = txPayouts.map(p => largestRemainder(toCents(p.amount), weights));
    // Paid against the price is only counted in the price's own currency.
    const wholePaidCents = txPayouts
      .filter(p => p.currency.toUpperCase() === saleCurrency)
      .reduce((acc, p) => acc + toCents(p.amount), 0n);

    share.forEach((b, i) => {
      taken.set(keyOf(b), (taken.get(keyOf(b)) ?? 0n) + parts.get(keyOf(b))!);
      lines.get(keyOf(b))!.push({
        sale,
        status: saleStatusOf(sale),
        budgetLanoshis: parts.get(keyOf(b))!,
        budgetNetCents: netParts[i],
        wholePaidCents,
        payouts: txPayouts.map((payout, j) => ({ payout, budgetCents: payoutParts[j][i] })),
      });
    });
  }

  const events = budgets.map(b => buildOne(b, lines.get(keyOf(b)) ?? [], input));
  return { events, unattributed };
}

function buildOne(b: BudgetDefinition, saleLines: BudgetSaleLine[], input: BuildInput): BudgetSettlementEvent {
  const received = BigInt(Math.max(0, Math.round(b.lanaReceivedLanoshis)));
  let acquired = 0n, inProgress = 0n, lanaPaid = 0n;
  const agreed = new Map<string, bigint>();
  const paid = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, cur: string, v: bigint) => m.set(cur, (m.get(cur) ?? 0n) + v);

  for (const l of saleLines) {
    if (l.status === 'accepted') { inProgress += l.budgetLanoshis; continue; }
    acquired += l.budgetLanoshis;
    add(agreed, l.sale.currency.toUpperCase(), l.budgetNetCents);
    for (const p of l.payouts) add(paid, p.payout.currency.toUpperCase(), p.budgetCents);
    // The LANA this budget has been paid for: its part of the sale, times the
    // share of the sale's price recorded as paid (never more than all of it).
    const wholeNet = toCents(l.sale.netFiat);
    if (wholeNet > 0n) {
      const covered = l.wholePaidCents > wholeNet ? wholeNet : l.wholePaidCents;
      lanaPaid += (l.budgetLanoshis * covered) / wholeNet;
    }
  }

  let remaining = received - acquired - inProgress;
  if (remaining < 0n) remaining = 0n;

  const acquisition: BudgetTotals['acquisition'] =
    acquired === 0n && inProgress === 0n ? 'none'
      : inProgress === 0n && !input.sellable(Number(remaining) / 1e8, b.currency) ? 'full'
        : 'partly';
  // The currencies money is reported in: the budget's own always, plus any a sale or payment used.
  const currencies = [...new Set([b.currency.toUpperCase(), ...agreed.keys(), ...paid.keys()])]
    .sort((x, y) => (x === b.currency.toUpperCase() ? -1 : y === b.currency.toUpperCase() ? 1 : x.localeCompare(y)));
  const totalPaid = [...paid.values()].reduce((a, c) => a + c, 0n);
  const totalAgreed = [...agreed.values()].reduce((a, c) => a + c, 0n);
  const payment: BudgetTotals['payment'] =
    totalPaid <= 0n ? 'none'
      : totalAgreed > 0n && currencies.every(c => (paid.get(c) ?? 0n) >= (agreed.get(c) ?? 0n)) ? 'full'
        : 'partly';

  const terms = input.terms.get(`${b.split}:${b.round}`);
  const dTag = `${b.split}:${b.round}:${b.fundSettingId}`;

  const tags: string[][] = [
    ['d', dTag],
    ['p', b.financerHex],
  ];
  if (b.budgetAddress) tags.push(['a', b.budgetAddress]);
  tags.push(
    ['a', b.mandateAddress],
    ['split', String(b.split)],
    ['round', String(b.round)],
    ['budget', b.fundSettingId],
    ['currency', b.currency],
    ['wallet', b.wallet],
    ['mandate_status', b.mandateStatus],
    ['lana_received', lana8(received)],
    ['lana_received_lanoshis', String(received)],
    ['lana_acquired', lana8(acquired)],
    ['lana_acquired_lanoshis', String(acquired)],
    ['lana_in_progress_lanoshis', String(inProgress)],
    ['lana_remaining_lanoshis', String(remaining)],
    ['lana_paid_lanoshis', String(lanaPaid)],
    ...currencies.map(c => ['fiat_agreed', c, money2(agreed.get(c) ?? 0n)]),
    ...currencies.map(c => ['fiat_paid', c, money2(paid.get(c) ?? 0n)]),
    ...currencies.map(c => ['fiat_outstanding', c, money2((agreed.get(c) ?? 0n) - (paid.get(c) ?? 0n))]),
    ['acquired_percent', percent2(acquired, received)],
    ['paid_percent', percent2(lanaPaid, received)],
    ['acquisition', acquisition],
    ['payment', payment],
  );
  if (terms?.opensAt != null) tags.push(['opens_at', String(terms.opensAt)]);
  if (terms?.sellFeePercent != null) tags.push(['sell_fee_percent', String(terms.sellFeePercent)]);

  for (const l of saleLines) {
    const s = l.sale;
    tags.push(['sale', s.offerRef, l.status, s.currency.toUpperCase(),
      String(Math.round(s.lanaLanoshis)), money2(toCents(s.netFiat)),
      String(l.budgetLanoshis), money2(l.budgetNetCents),
      s.txHash || '', str(s.completedAt)]);
    tags.push(['sale_price', s.offerRef, str(s.referenceRate), str(s.discountPercent),
      s.grossFiat === null ? '' : money2(toCents(s.grossFiat)),
      str(s.lanaMovedLanoshis), str(s.acceptedAt), str(s.blockHeight)]);
    if (s.transactionId !== null) tags.push(['a', `30936:${input.signerPubkey}:${s.transactionId}`]);
  }
  for (const l of saleLines) {
    for (const { payout, budgetCents } of l.payouts) {
      tags.push(['payout', payout.payoutId, l.sale.offerRef, payout.currency.toUpperCase(),
        money2(toCents(payout.amount)), money2(budgetCents), str(payout.recordedAt)]);
      tags.push(['a', `30937:${input.signerPubkey}:${payout.payoutId}`]);
    }
  }

  const hash = crypto.createHash('sha256').update(JSON.stringify(tags)).digest('hex');
  tags.push(['snapshot_at', String(input.now)]);

  const content = JSON.stringify({
    note: BUDGET_SETTLEMENT_NOTE,
    budget: {
      split: b.split, round: b.round, budget: b.fundSettingId, currency: b.currency,
      financer_hex: b.financerHex, wallet: b.wallet, mandate: b.mandateDTag, mandate_status: b.mandateStatus,
      opens_at: terms?.opensAt ?? null, sell_fee_percent: terms?.sellFeePercent ?? null,
    },
    totals: {
      lana_received: lana8(received), lana_acquired: lana8(acquired),
      lana_in_progress: lana8(inProgress), lana_remaining: lana8(remaining), lana_paid: lana8(lanaPaid),
      fiat_agreed: Object.fromEntries(currencies.map(c => [c, money2(agreed.get(c) ?? 0n)])),
      fiat_paid: Object.fromEntries(currencies.map(c => [c, money2(paid.get(c) ?? 0n)])),
      fiat_outstanding: Object.fromEntries(currencies.map(c => [c, money2((agreed.get(c) ?? 0n) - (paid.get(c) ?? 0n))])),
      acquired_percent: percent2(acquired, received), paid_percent: percent2(lanaPaid, received),
      acquisition, payment,
    },
    sales: saleLines.map(l => ({
      offer_ref: l.sale.offerRef, status: l.status, currency: l.sale.currency.toUpperCase(),
      lana: lana8(BigInt(Math.round(l.sale.lanaLanoshis))), net_fiat: money2(toCents(l.sale.netFiat)),
      budget_lana: lana8(l.budgetLanoshis), budget_net_fiat: money2(l.budgetNetCents),
      reference_rate: l.sale.referenceRate, discount_percent: l.sale.discountPercent,
      gross_fiat: l.sale.grossFiat === null ? null : money2(toCents(l.sale.grossFiat)),
      lana_moved: l.sale.lanaMovedLanoshis === null ? null : lana8(BigInt(l.sale.lanaMovedLanoshis)),
      tx_hash: l.sale.txHash, accepted_at: l.sale.acceptedAt, completed_at: l.sale.completedAt,
      block_height: l.sale.blockHeight,
    })),
    payouts: saleLines.flatMap(l => l.payouts.map(({ payout, budgetCents }) => ({
      payout_id: payout.payoutId, offer_ref: l.sale.offerRef, currency: payout.currency.toUpperCase(),
      amount: money2(toCents(payout.amount)), budget_amount: money2(budgetCents), recorded_at: payout.recordedAt,
    }))),
    snapshot_at: input.now,
  });

  return {
    dTag,
    fundSettingId: b.fundSettingId,
    tags,
    content,
    hash,
    totals: {
      lanaReceivedLanoshis: received, lanaAcquiredLanoshis: acquired, lanaInProgressLanoshis: inProgress,
      lanaRemainingLanoshis: remaining, lanaPaidLanoshis: lanaPaid, agreedCents: agreed, paidCents: paid,
      acquisition, payment,
    },
  };
}
