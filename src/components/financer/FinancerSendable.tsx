/**
 * »Za pošiljanje« — the purchases a financer may send now, by purchase, with
 * what they add up to, what the wallet holds, and what it lacks.
 *
 * Owner, 8 Oct 2026: "Financer plača vse, tudi vračilo kupcu." Every leg of a
 * confirmed purchase goes from the financer's Lana.Discount wallet: the
 * purchase, the caretaker, the commissions, the customer's cashback and their
 * own budget's investor_lana. The server lists only legs that may go now —
 * theirs, approved by the brain, pending, in no send (GET /api/financer/
 * sendable) — so a purchase appears here about ten minutes after its batch is
 * confirmed, and the page says so.
 *
 * A purchase is chosen WHOLE (the server refuses part of one: PARTIAL_PURCHASE),
 * so the boxes are per purchase, and all are chosen until the financer says
 * otherwise. The figures are the chosen ones: how many, to how many wallets
 * (at most 98 in one send), in how many payments (legs: at most 400 in one
 * send, sends.ts MAX_ORDER_IDS), the LANA, the confirmed balance, and the least
 * the wallet lacks for them — the legs plus the fee of the smallest such send
 * (payoutView.ts leastShortfall). Whether the wallet's coins really cover it is
 * the plan's to say, at »Pripravi pošiljanje«; this figure only says early when
 * they cannot. A financer moves LANA in before they send; the shortfall is how
 * much.
 *
 * ONE SEND HAS LIMITS (review C18/C21). A financer with repeat customers has
 * hundreds of purchases, all chosen by default, sharing the budget, merchant
 * and caretaker wallets — so the 400 payments fill before the 98 wallets do.
 * Over either, »Pripravi pošiljanje« is off and one sentence says why, and
 * »Izberi, kar gre v eno pošiljanje« keeps, of the purchases CHOSEN, those in
 * the order listed (the server's, oldest first) for as long as the next one
 * still fits. It never ticks again a purchase the financer unticked BY HAND —
 * their own box (review N11: the oldest are the ones a refused send holds back,
 * and ticking them again sent the financer round in a circle); with nothing
 * chosen it chooses from all the others. Those are kept apart from the ones a
 * button took out (review M8, `Choice`): after a send, what a button left out
 * is chosen again for the next one, and what the financer unticked by hand
 * stays out, round after round.
 */
import type { FinancerText } from '@/copy';
import type { SendableAnswer, SendablePurchase } from '@/lib/financer/financerApi';
import { leastShortfall, readLanoshis } from '@/lib/financer/payoutView';
import { codeText, fill, lanaText, shortWallet } from './financerText';

/**
 * The financer's choice, as the page keeps it (review M8): the purchases they unticked by hand — their own box — apart
 * from those a button took out (»Počisti izbiro«, »Izberi, kar gre v eno pošiljanje«). Every other one is chosen.
 */
export interface Choice {
  byHand: ReadonlySet<string>;
  byButton: ReadonlySet<string>;
}

/** Every purchase chosen: the page's first choice. */
export const ALL_CHOSEN: Choice = { byHand: new Set(), byButton: new Set() };

/** These purchases ticked (`on`) or unticked, by hand or by a button. A tick, either way, chooses one again. */
export function choose(choice: Choice, refs: readonly string[], on: boolean, byHand: boolean): Choice {
  const hand = new Set(choice.byHand);
  const button = new Set(choice.byButton);
  for (const ref of refs) {
    if (on) {
      hand.delete(ref);
      button.delete(ref);
    } else (byHand ? hand : button).add(ref);
  }
  return { byHand: hand, byButton: button };
}

/** The purchases not chosen, however they were taken out. */
export function unchosenOf(choice: Choice): ReadonlySet<string> {
  return new Set([...choice.byHand, ...choice.byButton]);
}

/** After a send: what a button left out is chosen again for the next one; what the financer unticked by hand stays out. */
export function choiceAfterSend(choice: Choice): Choice {
  return { byHand: choice.byHand, byButton: new Set() };
}

/** The chosen purchases' figures; `over` when they do not fit in one send (too many wallets or payments). */
export function chosenFigures(answer: SendableAnswer, unchosen: ReadonlySet<string>) {
  const chosen = answer.purchases.filter((p) => !unchosen.has(p.transactionRef));
  let lanoshis = 0n;
  let legs = 0;
  const wallets = new Set<string>();
  for (const p of chosen) {
    lanoshis += readLanoshis(p.lanoshis) ?? 0n;
    legs += p.legs.length;
    for (const l of p.legs) wallets.add(l.toWallet);
  }
  const balance = answer.balance ? readLanoshis(answer.balance.confirmed) : null;
  const shortfall = balance === null ? null : leastShortfall(lanoshis, balance, wallets.size);
  const overWallets = wallets.size > answer.limits.maxWallets;
  const overLegs = legs > answer.limits.maxLegs;
  return { chosen, lanoshis, legs, wallets: wallets.size, balance, shortfall, overWallets, overLegs, over: overWallets || overLegs };
}

/**
 * The purchases one send can carry, in the order listed (the server's: oldest first), taken while the next one still
 * fits — at most `maxWallets` wallets and `maxLegs` payments. It stops at the first that does not: a later purchase is
 * never sent before an older one only because it is smaller.
 */
export function fittingRefs(purchases: readonly SendablePurchase[], limits: Pick<SendableAnswer['limits'], 'maxWallets' | 'maxLegs'>): string[] {
  const taken: string[] = [];
  const wallets = new Set<string>();
  let legs = 0;
  for (const p of purchases) {
    const more = new Set(p.legs.map((l) => l.toWallet).filter((w) => !wallets.has(w)));
    if (legs + p.legs.length > limits.maxLegs || wallets.size + more.size > limits.maxWallets) break;
    legs += p.legs.length;
    for (const w of more) wallets.add(w);
    taken.push(p.transactionRef);
  }
  return taken;
}

export function FinancerSendable(props: {
  t: FinancerText;
  answer: SendableAnswer;
  choice: Choice;
  /** `byHand`: the financer's own box; false for the buttons. */
  onChoose: (transactionRefs: string[], on: boolean, byHand: boolean) => void;
  /** The plan is open (or a send is being made): the choice stands until »Nazaj«. */
  locked: boolean;
  /** Why nothing can be prepared now, in words; null when it can. */
  blocked: string | null;
  preparing: boolean;
  onPrepare: () => void;
}) {
  const { t, answer, choice, locked, blocked, preparing } = props;
  const unchosen = unchosenOf(choice);
  const f = chosenFigures(answer, unchosen);
  const allRefs = answer.purchases.map((p) => p.transactionRef);
  const missingAll = readLanoshis(answer.shortfallLanoshis) ?? 0n;
  // All of them do not fit in one send: »Choose what fits« is offered (any choice of fewer fits when all of them do).
  const allOver = chosenFigures(answer, new Set()).over;
  // Within the CURRENT choice (review N11): a purchase the financer unticked — one of an earlier refused send, say —
  // stays unticked; of the chosen ones, the oldest that fit stay chosen. With nothing chosen it chooses from all of
  // them but the ones unticked by hand (review M8): those stay out, this round and the next.
  const chooseFits = () => {
    const chosenNow = answer.purchases.filter((p) => !unchosen.has(p.transactionRef));
    const pool = chosenNow.length ? chosenNow : answer.purchases.filter((p) => !choice.byHand.has(p.transactionRef));
    const fits = new Set(fittingRefs(pool, answer.limits));
    if (chosenNow.length === 0) props.onChoose([...fits], true, false);
    props.onChoose(pool.map((p) => p.transactionRef).filter((ref) => !fits.has(ref)), false, false);
  };

  return (
    <section data-testid="financer-sendable" className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
      <h2 className="text-lg font-bold text-foreground">{t.sendTitle}</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t.sendLead}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t.approvalNote}</p>

      {answer.purchases.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t.sendNone}</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-foreground">
            {fill(t.waitingAll, { count: answer.purchases.length, amount: lanaText(answer.totalLanoshis) })}{' '}
            {missingAll > 0n && <span className="font-semibold text-red-700 dark:text-red-400">{fill(t.missingAll, { amount: lanaText(missingAll) })}</span>}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={locked} onClick={() => props.onChoose(allRefs, true, false)} className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
              {t.chooseAll}
            </button>
            <button type="button" disabled={locked} onClick={() => props.onChoose(allRefs, false, false)} className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
              {t.chooseNone}
            </button>
            {allOver && (
              <button type="button" disabled={locked} onClick={chooseFits} className="rounded-lg border border-primary/60 px-3 py-1 text-xs font-semibold text-primary hover:bg-accent disabled:opacity-50">
                {t.chooseFits}
              </button>
            )}
          </div>

          <ul className="mt-3 max-h-[28rem] overflow-y-auto space-y-2 pr-1">
            {answer.purchases.map((p) => (
              <PurchaseRow key={p.transactionRef} t={t} p={p} chosen={!unchosen.has(p.transactionRef)} locked={locked} onChoose={props.onChoose} />
            ))}
          </ul>

          <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl bg-muted/40 p-4" data-testid="financer-figures">
            <Figure label={t.chosen} value={String(f.chosen.length)} />
            <Figure label={t.walletsPaid} value={fill(t.walletsValue, { count: f.wallets, max: answer.limits.maxWallets })} warn={f.overWallets} />
            <Figure label={t.legsPaid} value={fill(t.walletsValue, { count: f.legs, max: answer.limits.maxLegs })} warn={f.overLegs} testId="financer-legs" />
            <Figure label={t.toSend} value={`${lanaText(f.lanoshis)} LANA`} testId="financer-to-send" />
            <Figure label={t.balance} value={f.balance === null ? '—' : `${lanaText(f.balance)} LANA`} />
            <Figure
              label={t.shortfall}
              value={f.shortfall === null ? '—' : `${lanaText(f.shortfall)} LANA`}
              warn={f.shortfall !== null && f.shortfall > 0n}
              testId="financer-shortfall"
            />
          </dl>
          {f.shortfall !== null && f.chosen.length > 0 && (
            <p className={`mt-2 text-sm ${f.shortfall > 0n ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}`} data-testid="financer-shortfall-hint">
              {f.shortfall > 0n ? fill(t.shortfallHint, { amount: lanaText(f.shortfall) }) : t.enough}
            </p>
          )}

          {/* Why nothing can be prepared is said even while the choice is locked (a send in doubt waits below). */}
          {blocked && <p className="mt-4 text-sm text-amber-700 dark:text-amber-400" role="status">{blocked}</p>}
          {f.over && (
            <p className="mt-4 text-sm text-amber-700 dark:text-amber-400" role="status" data-testid="financer-over-limits">
              {fill(t.overLimits, { wallets: answer.limits.maxWallets, legs: answer.limits.maxLegs, button: t.chooseFits })}
            </p>
          )}
          {!locked && (
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={props.onPrepare}
                disabled={!!blocked || preparing || f.chosen.length === 0 || f.over}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {preparing ? t.preparing : t.prepare}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Figure(props: { label: string; value: string; warn?: boolean; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{props.label}</dt>
      <dd data-testid={props.testId} className={`mt-0.5 text-sm font-bold tabular-nums break-words ${props.warn ? 'text-red-700 dark:text-red-400' : 'text-foreground'}`}>
        {props.value}
      </dd>
    </div>
  );
}

function PurchaseRow(props: { t: FinancerText; p: SendablePurchase; chosen: boolean; locked: boolean; onChoose: (refs: string[], on: boolean, byHand: boolean) => void }) {
  const { t, p, chosen, locked } = props;
  const id = `financer-purchase-${p.transactionRef}`;
  return (
    <li className={`rounded-lg border p-3 ${chosen ? 'border-primary/40 bg-background' : 'border-border bg-background/50 opacity-70'}`}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={chosen}
          disabled={locked}
          onChange={(e) => props.onChoose([p.transactionRef], e.target.checked, true)}
          aria-label={fill(t.choose, { ref: p.transactionRef })}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label htmlFor={id} className="font-mono text-xs font-semibold text-foreground break-all">
              {p.transactionRef}
              {p.batchRef && <span className="ml-2 font-sans font-normal text-muted-foreground">· {p.batchRef}</span>}
            </label>
            <span className="text-sm font-bold tabular-nums text-foreground">{lanaText(p.lanoshis)} LANA</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {p.legs.map((l) => (
              <li key={l.orderId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
                <span className="min-w-0">
                  {codeText(t.legTypes as Record<string, string>, l.orderType)}{' '}
                  <span className="font-mono" title={l.toWallet}>→ {shortWallet(l.toWallet)}</span>
                </span>
                <span className="tabular-nums">{lanaText(l.lanoshis)}</span>
              </li>
            ))}
          </ul>
          {p.belowDustAlone && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t.belowDust}</p>}
          {p.legs.some((l) => l.mustSpend) && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t.mustSpend}</p>}
        </div>
      </div>
    </li>
  );
}
