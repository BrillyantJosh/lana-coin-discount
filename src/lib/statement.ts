/**
 * A STATEMENT OF ACCOUNT FOR ONE COUNTERPARTY, fit to hand to a bank.
 *
 * Owner, 12 Sept 2026: "uradni dokument, ki ga lahko pošljemo na banko, kjer se
 * rabi videti brand name, spletna stran, ime in priimek, vsi natančni podatki z
 * naslova prodaje Lan, vrednosti transakcije... tako res popolno poročilo za
 * vsako transakcijo v angleščini."
 *
 * ── WHY THIS IS HTML THE BROWSER PRINTS, AND NOT A PDF LIBRARY ────────────
 *
 * The counterparties are called Gašper, Boštjan, Primož, Šircelj, Čarman. The
 * built-in PDF fonts every writer reaches for first are WinAnsi-encoded, and
 * WinAnsi has š and ž but NOT č — so a hand-rolled PDF, and jsPDF on its
 * default fonts, both mangle a Slovenian name. Fixing that means embedding a
 * font, which is the heaviest part of making a PDF at all.
 *
 * The browser has already solved this. Printing to PDF from Chrome gives every
 * character, real pagination, a repeated table header, and a file the recipient
 * cannot tell from any other PDF. So this builds the document and the page
 * opens it and calls print(); "Save as PDF" is the default destination.
 *
 * ── WHAT THIS DOCUMENT MAY SAY ───────────────────────────────────────────
 *
 * It is read by someone who will act on it, so every figure is either a
 * recorded fact or labelled as what it is:
 *
 *   * "Recorded", never "Paid". `paid_at` is when an operator entered the
 *     payout, not when the transfer cleared — the bank knows the second date
 *     and we do not, and claiming it is the one thing they would check.
 *   * "Discount applied", never "commission". The column is called
 *     commission_percent in the database and is the acquisition discount; an
 *     accountant reading "commission" books a service fee never charged.
 *   * Confirmations are printed only beside the moment they were observed. The
 *     verifier visits a transaction once, so the count is frozen at that
 *     instant and would otherwise read as current.
 *   * The name is marked self-declared. There is no identity check anywhere in
 *     this system; the name comes from a profile the counterparty signs.
 *   * The destination account is the one RECORDED WITH THE PAYOUT, not the one
 *     on the profile today — a profile is cached for up to an hour and falls
 *     back to an arbitrarily old copy when a relay is quiet.
 *   * The operator's internal note is not on it. Those were written for
 *     colleagues, and the public board already withholds them for that reason.
 */

export interface StatementPayout {
  payoutId: string;
  amount: number;
  currency: string;
  paidAt: string;
  paidToAccount: string | null;
  reference: string | null;
}

export interface StatementSale {
  id: number;
  createdAt: string;
  acceptedAt?: string | null;
  completedAt?: string | null;
  settlementDueAt?: string | null;
  offerRef?: string | null;
  round?: number | null;
  mandateSplit?: number | null;
  lanaAmount: number;
  currency: string;
  exchangeRate: number;
  grossFiat: number;
  commissionPercent: number;
  netFiat: number;
  txHash: string | null;
  senderWalletId?: string | null;
  treasuryWalletId?: string | null;
  rpcVerified: boolean;
  rpcConfirmations: number;
  rpcBlockHeight: number | null;
  rpcVerifiedAt: string | null;
  payouts: StatementPayout[];
}

export interface StatementInput {
  /** As the counterparty published it. Never the string 'Anonymous'. */
  counterpartyName: string;
  counterpartyHex: string;
  sales: StatementSale[];
  /** ISO instant the document was produced. Passed in so a test can pin it. */
  issuedAt: string;
}

/** What each currency on the statement adds up to. */
export interface CurrencyTotal {
  currency: string;
  lana: number;
  agreed: number;
  recorded: number;
  outstanding: number;
}

const BRAND = 'Lana.discount P2P';
const SITE = 'https://lana.discount';

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (n: number, currency: string) =>
  `${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const lana = (n: number) =>
  `${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} LANA`;

/** SQLite writes UTC with no zone marker; say so rather than let a reader guess. */
const when = (ts: string | null | undefined) => {
  const s = String(ts || '').trim();
  if (!s) return '—';
  return `${s.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '')} UTC`;
};

const day = (ts: string | null | undefined) => {
  const s = String(ts || '').trim();
  return s ? s.slice(0, 10) : '—';
};

/**
 * Newest first, the order the owner asked for on the screen and here alike.
 * `createdAt` is the only date present on every sale.
 */
export function orderNewestFirst(sales: StatementSale[]): StatementSale[] {
  return [...sales].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '') || (b.id - a.id));
}

/**
 * Per currency, and never across them: adding EUR to GBP is a number nobody
 * owes. "Recorded" is the sum of the payouts entered against these sales, which
 * is the figure the owner asked to be treated as the payment.
 */
export function totalsByCurrency(sales: StatementSale[]): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  const cell = (c: string) => {
    if (!map.has(c)) map.set(c, { currency: c, lana: 0, agreed: 0, recorded: 0, outstanding: 0 });
    return map.get(c)!;
  };
  for (const s of sales) {
    const c = cell(s.currency);
    c.lana += s.lanaAmount;
    c.agreed += s.netFiat;
    // A payout in another currency is counted under ITS currency, so the
    // statement never quietly converts one into another.
    for (const p of s.payouts) cell(p.currency).recorded += p.amount;
  }
  for (const c of map.values()) {
    c.lana = Math.round(c.lana * 1e8) / 1e8;
    c.agreed = Math.round(c.agreed * 100) / 100;
    c.recorded = Math.round(c.recorded * 100) / 100;
    // Signed on purpose: an overpayment must read as a credit, not as zero.
    c.outstanding = Math.round((c.agreed - c.recorded) * 100) / 100;
  }
  return [...map.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1));
}

/** A reference the recipient can quote back. Stable for the same export. */
export function statementReference(hex: string, issuedAt: string): string {
  const stamp = issuedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `LDS-${stamp}-${hex.slice(0, 8).toUpperCase()}`;
}

function saleBlock(s: StatementSale): string {
  const rows: Array<[string, string]> = [
    ['Acquisition reference', s.offerRef || '— (sold before acquisition references were issued)'],
    ['Financing round', s.round ? `Round ${s.round}${s.mandateSplit ? ` · Split ${s.mandateSplit}` : ''}` : '— (outside a financing round)'],
    ['Offer accepted', when(s.acceptedAt)],
    ['Transaction recorded', when(s.createdAt)],
    ['Transfer completed', when(s.completedAt)],
    ['Purchase price due by', day(s.settlementDueAt)],
    ['LANA sold', lana(s.lanaAmount)],
    ['Reference rate', `${s.exchangeRate} ${s.currency} per LANA`],
    ['Value at reference rate', money(s.grossFiat, s.currency)],
    ['Discount applied', `${s.commissionPercent} %`],
    ['Agreed purchase price', money(s.netFiat, s.currency)],
  ];

  const chain: Array<[string, string]> = [
    ['Transaction hash', s.txHash || '— (not recorded)'],
    ['From wallet', s.senderWalletId || '—'],
    ['To wallet (treasury)', s.treasuryWalletId || '—'],
    ['Block height', s.rpcBlockHeight === null ? '—' : String(s.rpcBlockHeight)],
    [
      'Verified on chain',
      s.rpcVerified && s.rpcVerifiedAt
        // The count is what was seen at that moment and is never refreshed, so
        // it is printed only as part of that observation.
        ? `${when(s.rpcVerifiedAt)} — ${s.rpcConfirmations} confirmation${s.rpcConfirmations === 1 ? '' : 's'} at that time`
        : 'not yet verified',
    ],
  ];

  const payouts = s.payouts.length
    ? `<table class="pay">
        <thead><tr><th>Recorded</th><th>Reference</th><th class="r">Amount</th><th>Destination account</th></tr></thead>
        <tbody>${s.payouts.map(p => `<tr>
          <td>${esc(when(p.paidAt))}</td>
          <td class="mono">${esc(p.payoutId)}${p.reference ? ` · ${esc(p.reference)}` : ''}</td>
          <td class="r mono">${esc(money(p.amount, p.currency))}</td>
          <td class="mono">${esc(p.paidToAccount || '— (not recorded)')}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : '<p class="none">No payment recorded against this transaction.</p>';

  return `<section class="sale">
    <h3>${esc(day(s.createdAt))} · ${esc(s.offerRef || `Transaction #${s.id}`)}</h3>
    <table class="kv">${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join('')}</table>
    <h4>LanaCoin transfer</h4>
    <table class="kv">${chain.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td class="mono break">${esc(v)}</td></tr>`).join('')}</table>
    <h4>Payments recorded</h4>
    ${payouts}
  </section>`;
}

export function buildStatementHtml(input: StatementInput): string {
  const sales = orderNewestFirst(input.sales);
  const totals = totalsByCurrency(sales);
  const ref = statementReference(input.counterpartyHex, input.issuedAt);
  const first = sales.length ? day(sales[sales.length - 1].createdAt) : '—';
  const last = sales.length ? day(sales[0].createdAt) : '—';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(ref)} — Statement of Account</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
  .brand { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
  .site { color: #444; }
  h1 { font-size: 14px; margin: 10px 0 2px; text-transform: uppercase; letter-spacing: 0.06em; }
  h2 { font-size: 11.5px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.06em;
       border-bottom: 1px solid #bbb; padding-bottom: 3px; }
  h3 { font-size: 11.5px; margin: 0 0 6px; }
  h4 { font-size: 10px; margin: 9px 0 3px; text-transform: uppercase; letter-spacing: 0.05em; color: #444; }
  table { width: 100%; border-collapse: collapse; }
  .kv th { width: 34%; text-align: left; font-weight: 500; color: #444; padding: 1.5px 6px 1.5px 0; vertical-align: top; }
  .kv td { padding: 1.5px 0; vertical-align: top; }
  .mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9.5px; }
  .break { word-break: break-all; }
  .r { text-align: right; }
  .sum th, .sum td { border-bottom: 1px solid #ddd; padding: 4px 6px 4px 0; text-align: right; }
  .sum th:first-child, .sum td:first-child { text-align: left; }
  .sum thead th { border-bottom: 1px solid #111; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .pay th, .pay td { border-bottom: 1px solid #e5e5e5; padding: 3px 6px 3px 0; text-align: left; }
  .pay thead th { border-bottom: 1px solid #999; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: #444; }
  /* A transaction is read as one thing; splitting one across a page break is
     how a reader comes to attribute a payment to the wrong sale. */
  .sale { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ccc; border-radius: 3px;
          padding: 8px 10px; margin-bottom: 9px; }
  .none { color: #666; margin: 3px 0; }
  .note { color: #444; font-size: 9.5px; margin-top: 3px; }
  footer { margin-top: 16px; border-top: 1px solid #bbb; padding-top: 6px; color: #444; font-size: 9.5px; }
  .end { text-align: center; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
         margin: 14px 0 0; }
  @media print { .noprint { display: none; } }
</style></head><body>

<header>
  <div class="brand">${esc(BRAND)}</div>
  <div class="site">${esc(SITE)}</div>
  <h1>Statement of Account</h1>
  <table class="kv" style="margin-top:6px">
    <tr><th>Statement reference</th><td class="mono">${esc(ref)}</td></tr>
    <tr><th>Issued</th><td class="mono">${esc(when(input.issuedAt))}</td></tr>
    <tr><th>Period covered</th><td class="mono">${esc(first)} to ${esc(last)}</td></tr>
    <tr><th>Transactions</th><td class="mono">${sales.length}</td></tr>
  </table>
</header>

<h2>Counterparty</h2>
<table class="kv">
  <tr><th>Name</th><td>${esc(input.counterpartyName)}</td></tr>
  <tr><th>Public key</th><td class="mono break">${esc(input.counterpartyHex)}</td></tr>
</table>
<p class="note">The name is as published by the counterparty in their own profile.
${esc(BRAND)} operates as a principal buying LANA and does not verify identity documents.</p>

<h2>Summary</h2>
<table class="sum">
  <thead><tr>
    <th>Currency</th><th>LANA sold</th><th>Agreed purchase price</th>
    <th>Payments recorded</th><th>Outstanding</th>
  </tr></thead>
  <tbody>${totals.map(t => `<tr>
    <td>${esc(t.currency)}</td>
    <td class="mono">${esc(t.lana.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 8 }))}</td>
    <td class="mono">${esc(money(t.agreed, t.currency))}</td>
    <td class="mono">${esc(money(t.recorded, t.currency))}</td>
    <td class="mono">${esc(money(t.outstanding, t.currency))}</td>
  </tr>`).join('')}</tbody>
</table>
<p class="note">Outstanding is the agreed purchase price less the payments recorded, as at the issue time above.
"Recorded" is the date a payment was entered in our records; the date it cleared is held by the receiving bank.</p>

<h2>Transactions</h2>
<p class="note">Most recent first.</p>
${sales.length ? sales.map(saleBlock).join('') : '<p class="none">No transactions in this period.</p>'}

<p class="end">End of statement</p>
<footer>
  ${esc(BRAND)} · ${esc(SITE)} · Statement ${esc(ref)} · All times UTC.<br>
  Figures are stated in the currency of each transaction and are not converted between currencies.
  This statement is issued at the request of the counterparty named above.
</footer>
</body></html>`;
}
