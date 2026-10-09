/**
 * »Za potrditev« — a financer's Lana Discount batches on Direct.Fund, and what
 * each one needs from them now.
 *
 * Owner, 8 Oct 2026: the financer confirms the batch on Direct.Fund as before
 * (»I Have Paid This Batch«), then here; from then on the LANA of its purchases
 * is theirs to send. A company with many budgets has many batches, so there is
 * »Potrdi vse« beside each »Potrdi«. What a row says comes from two places —
 * Direct.Fund's status (open → closed → paid) and what this site holds — and the
 * server already joined them (GET /api/financer/batches, `canConfirm`); the
 * page only words it:
 *   - paid on Direct.Fund and nobody's here yet → Confirm;
 *   - not paid there yet → close and pay it on Direct.Fund first (a link);
 *   - confirmed by them → how far its LANA has got: waiting for the approval
 *     (once every part of a purchase is paid on Direct.Fund, bank payouts to
 *     merchants included — review C19), ready below, on its way, sent; while
 *     it waits, the parts Direct.Fund does not have as paid yet are named, one
 *     line per Direct.Fund batch (`ld.waitingOn`, owner 9 Oct 2026), or said
 *     all paid — the general sentence only when Direct.Fund could not be asked;
 *   - the treasury's, or another financer's in part → said, never confirmable;
 *   - held (`held`: it may already have been paid to the treasury's bank
 *     account, server/lib/financer/confirm.ts heldBatches) → the administrator
 *     decides it; said, never confirmable (a confirm is refused BATCH_HELD).
 * A batch they confirmed counts only THEIR purchases (review N7). One Direct.Fund
 * did not count at their confirmation (moved by a reallocation, say) is owned
 * by nobody here — `ld.purchases.unclaimed`, said by reference; one cancelled
 * for good is only counted, `ld.purchases.cancelled`, and said to need nothing
 * (review M5) — and when a repeat confirmation would change something
 * (`canConfirmAgain`: take such a purchase in, `retakeable`, or send again the
 * stopped notice to the brain that the batch is paid, `resendStopped` — review
 * N7/N9) the row offers »Potrdi znova«, the same confirm call for the same
 * reference, with a sentence for each reason that holds: both when both do
 * (review M7).
 * Batches whose LANA is all sent, and the treasury's, fold away under one line:
 * the list is for what still needs someone — never one »Potrdi znova« waits on.
 *
 * Confirming sends ONLY the batch references. The server builds every batch
 * from Direct.Fund's own fresh answer (server/lib/financer/confirm.ts) and
 * answers per batch; a refusal is shown under its row in the reader's words.
 */
import type { FinancerText } from '@/copy';
import type { ConfirmResult, FinancerBatch, WaitingPart } from '@/lib/financer/financerApi';
import { DIRECT_FUND_URL } from '@/lib/financer/financerApi';
import { codeText, dayText, fiatText, fill } from './financerText';

type Row = { batch: FinancerBatch; state: keyof FinancerText['batchState'] };

/** What a batch needs, or where it stands. */
export function batchStateOf(b: FinancerBatch): Row['state'] {
  const legs = b.ld.legs;
  if (b.ld.confirmed) {
    // Something to do first: approved legs wait below. Then what waits on others: the approval, the chain. The legs
    // are those of YOUR purchases (review N7): none arrived yet for one of them is waiting too — a purchase nobody
    // settles here waits for no approval of yours, and is said apart (unclaimed).
    if (legs.authorized > 0) return 'ready';
    if (legs.pending > 0 || (legs.total === 0 && (b.ld.purchases?.mine ?? b.transactionRefs.length) > 0)) return 'awaitingApproval';
    if (legs.sending > 0) return 'sending';
    return 'done';
  }
  if (b.ld.settledBy === 'treasury') return 'treasury';
  // Decided by the administrator, not by whoever confirms first: no Confirm, whatever Direct.Fund shows.
  if (b.held) return 'held';
  if (b.ld.purchases.other > 0) return 'other';
  if (b.canConfirm) return 'canConfirm';
  return 'notPaid';
}

/** A label from one of the copy's maps; one the page does not know is undefined (never an Object property). */
const labelOf = (map: Record<string, string>, key: string | null): string | undefined =>
  key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/**
 * What a confirmed batch's approval still waits on at Direct.Fund (owner, 9 Oct 2026: batch 2026002432 confirmed, and
 * nothing said that the purchase's €0.25 merchant's commission by bank sat unpaid in batch 2026002433). One sentence
 * per Direct.Fund batch, its parts named in it; one per part in no batch yet; `[]` is every part paid. null when
 * Direct.Fund could not be asked (or a server before `waitingOn`): the row keeps its general sentence.
 */
export function waitingLines(t: FinancerText, waitingOn: WaitingPart[] | null | undefined): string[] | null {
  if (!waitingOn) return null;
  const w = t.waitingOn;
  if (waitingOn.length === 0) return [w.allPaid];
  const partText = (p: WaitingPart) => {
    const what = labelOf(w.orderTypes, p.orderType) ?? w.orderTypes.other;
    const how = labelOf(w.destinations, p.destinationType);
    return `${fiatText(p.amount, p.currency)} — ${what}${how ? `, ${how}` : ''}`;
  };
  const byBatch = new Map<string, WaitingPart[]>();
  const inNoBatch: string[] = [];
  for (const p of waitingOn) {
    if (p.batchRef) byBatch.set(p.batchRef, [...(byBatch.get(p.batchRef) ?? []), p]);
    else inNoBatch.push(fill(w.noBatch, { part: partText(p) }));
  }
  const inBatch = [...byBatch].map(([batch, parts]) => fill(w.inBatch, { batch, parts: parts.map(partText).join('; ') }));
  return [...inBatch, ...inNoBatch];
}

const FOLDED: ReadonlyArray<Row['state']> = ['done', 'treasury'];

export function FinancerBatches(props: {
  t: FinancerText;
  lang: 'sl' | 'en';
  batches: FinancerBatch[];
  /** The batches a confirm is running for. */
  confirming: ReadonlySet<string>;
  /** Each batch's answer from the last confirm, by reference. */
  results: Readonly<Record<string, ConfirmResult>>;
  /** `again`: a repeat confirmation of a batch already confirmed (»Potrdi znova«). */
  onConfirm: (batchRefs: string[], again?: boolean) => void;
}) {
  const { t, lang, batches, confirming, results, onConfirm } = props;
  const rows: Row[] = batches.map((batch) => ({ batch, state: batchStateOf(batch) }));
  // A batch »Potrdi znova« waits on is never folded away, whatever its legs say.
  const isFolded = (r: Row) => FOLDED.includes(r.state) && !r.batch.canConfirmAgain;
  const open = rows.filter((r) => !isFolded(r));
  const folded = rows.filter(isFolded);
  const confirmable = rows.filter((r) => r.state === 'canConfirm').map((r) => r.batch.batchRef);
  const busy = confirming.size > 0;

  return (
    <section data-testid="financer-batches" className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-bold text-foreground">{t.batchesTitle}</h2>
        {confirmable.length > 1 && (
          <button
            type="button"
            onClick={() => onConfirm(confirmable)}
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {busy ? t.confirming : fill(t.confirmAll, { count: confirmable.length })}
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t.batchesLead}</p>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t.batchesNone}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {open.map((r) => (
            <BatchRow key={r.batch.batchRef} row={r} t={t} lang={lang} busy={busy} confirming={confirming.has(r.batch.batchRef)} result={results[r.batch.batchRef]} onConfirm={onConfirm} />
          ))}
        </ul>
      )}

      {folded.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            {fill(t.doneToggle, { count: folded.length })}
          </summary>
          <ul className="mt-3 space-y-3">
            {folded.map((r) => (
              <BatchRow key={r.batch.batchRef} row={r} t={t} lang={lang} busy={busy} confirming={false} result={results[r.batch.batchRef]} onConfirm={onConfirm} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const TONE: Record<Row['state'], string> = {
  canConfirm: 'text-primary',
  notPaid: 'text-amber-700 dark:text-amber-400',
  awaitingApproval: 'text-amber-700 dark:text-amber-400',
  ready: 'text-primary',
  sending: 'text-blue-700 dark:text-blue-400',
  done: 'text-emerald-700 dark:text-emerald-400',
  treasury: 'text-muted-foreground',
  held: 'text-amber-700 dark:text-amber-400',
  other: 'text-red-700 dark:text-red-400',
};

function BatchRow(props: {
  row: Row;
  t: FinancerText;
  lang: 'sl' | 'en';
  busy: boolean;
  confirming: boolean;
  result: ConfirmResult | undefined;
  onConfirm: (batchRefs: string[], again?: boolean) => void;
}) {
  const { row, t, lang, busy, confirming, result } = props;
  const b = row.batch;
  const legs = b.ld.legs;
  const day = dayText(b.paidAt || b.closedAt || b.createdAt, lang);
  // Purchases of a batch you confirmed that nobody settles here (review N7): how many, and which (the server lists 50).
  const unclaimed = b.ld.confirmed ? b.ld.purchases?.unclaimed ?? 0 : 0;
  const unclaimedRefs = b.ld.unclaimedRefs ?? [];
  const refsText = unclaimedRefs.join(', ') + (unclaimed > unclaimedRefs.length ? (unclaimedRefs.length ? ', …' : '…') : '');
  // Cancelled for good (review M5): counted, never »not sent by you yet«, never a reason to confirm again.
  const cancelled = b.ld.confirmed ? b.ld.purchases?.cancelled ?? 0 : 0;
  // Why »Potrdi znova« is offered, each reason its own sentence (review M7): a purchase it could take, the stopped notice
  // to the brain, or both. A server that does not say `retakeable` and `resendStopped` yet: the old reading.
  const again = b.ld.confirmed && b.canConfirmAgain;
  const retakeable = b.ld.purchases?.retakeable ?? unclaimed;
  const againResend = again && (b.resendStopped ?? retakeable === 0);
  const againTake = again && (retakeable > 0 || !againResend);
  // Waiting for the approval: what Direct.Fund does not have as paid yet, when it could say.
  const waiting = row.state === 'awaitingApproval' ? waitingLines(t, b.ld.waitingOn) : null;
  return (
    <li data-testid={`financer-batch-${b.batchRef}`} className="rounded-xl border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-foreground">{b.batchRef}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fill(t.purchasesCount, { count: b.transactionRefs.length })}
            {day && <> · {day}</>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tabular-nums text-foreground">{fiatText(b.totalAmount, b.currency)}</span>
          {row.state === 'canConfirm' && (
            <button
              type="button"
              onClick={() => props.onConfirm([b.batchRef])}
              disabled={busy}
              className="rounded-lg border-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {confirming ? t.confirming : t.confirm}
            </button>
          )}
          {b.ld.confirmed && b.canConfirmAgain && (
            <button
              type="button"
              onClick={() => props.onConfirm([b.batchRef], true)}
              disabled={busy}
              className="rounded-lg border-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {confirming ? t.confirming : t.confirmAgain}
            </button>
          )}
        </div>
      </div>
      {waiting ? (
        <div className={`mt-2 space-y-1 text-sm ${TONE[row.state]}`} data-testid={`financer-batch-waiting-${b.batchRef}`}>
          {waiting.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      ) : (
        <p className={`mt-2 text-sm ${TONE[row.state]}`}>{t.batchState[row.state]}</p>
      )}
      {row.state === 'notPaid' && (
        <a href={DIRECT_FUND_URL} rel="noopener" className="mt-1 inline-block text-sm font-semibold text-primary hover:underline">
          {t.openDf}
        </a>
      )}
      {b.ld.confirmed && legs.total > 0 && (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">{fill(t.recipientsSent, { sent: legs.sent, total: legs.total - legs.cancelled })}</p>
      )}
      {unclaimed > 0 && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400" data-testid={`financer-batch-unclaimed-${b.batchRef}`}>
          {fill(t.unclaimed, { count: unclaimed, refs: refsText })}
        </p>
      )}
      {cancelled > 0 && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid={`financer-batch-cancelled-${b.batchRef}`}>
          {fill(t.cancelledPurchases, { count: cancelled })}
        </p>
      )}
      {again && (
        <div className="mt-1 space-y-1 text-sm text-amber-700 dark:text-amber-400" data-testid={`financer-batch-again-${b.batchRef}`}>
          {againTake && <p>{fill(t.againUnclaimed, { button: t.confirmAgain })}</p>}
          {againResend && <p>{fill(t.againResend, { button: t.confirmAgain })}</p>}
        </div>
      )}
      {result && result.ok === false && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">
          {codeText(t.confirmCodes as Record<string, string>, result.code)}
        </p>
      )}
    </li>
  );
}
