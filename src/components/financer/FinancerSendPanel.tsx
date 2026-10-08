/**
 * THE SEND, before the key and at it — what the chosen purchases will be on the
 * chain, then the financer's Lana.Discount wallet key, checked as it is typed.
 *
 * Owner, 8 Oct 2026: "Podpis v brskalniku. Financer podpiše z WIF svoje
 * Lana.Discount denarnice. Ključ nikoli ne pride do nas; strežnik transakcijo
 * samo odda in preveri na verigi." Krog Menjave's »Poplačaj več naenkrat«
 * (src/components/admin/PayoutBatch.tsx, origin/main a46f618) is the model:
 *
 *   1. THE PLAN, from the server's prepare answer (the wallet's coins, each with
 *      the raw transaction that made it; what each wallet gets, merged from the
 *      legs as the database holds them; the server's clock) and the very
 *      functions that sign it (payoutView.ts planOfPrepared → shared/lana-tx
 *      planPayout): paid to the recipients, the network fee, what goes back to
 *      the wallet, what stays in it, how many coins it spends. The figures are
 *      the ones that will be signed. A plan that cannot be made says why, and
 *      offers no key field.
 *   2. »Naprej na podpis«: coins read more than ten minutes ago are read again
 *      first (FRESH_BEFORE_KEY_MS), so the key is asked for against a fresh view.
 *   3. THE KEY: typed or scanned into a field masked with CSS where the browser
 *      can (a password field is what a browser offers to save into a synced
 *      password manager; a browser that cannot mask text gets one anyway).
 *      Read as it is typed (payoutKey.ts checkPayoutKey: read, compared, wiped):
 *      it must open EXACTLY the wallet the send spends — the other form of the
 *      same secret opens another wallet and is refused, named. Only then is
 *      »Podpiši in pošlji« on. Pressing it empties the field FIRST, then hands
 *      the text to the page, which signs in this browser (payoutKey.ts
 *      signPayoutWithKey — the key's bytes wiped in a `finally`) and sends only
 *      the signed transaction.
 *
 * Drawn from props: the page (src/pages/Financer.tsx) reads the server, signs
 * and announces; a test draws every state of this on its own.
 */
import { Suspense, lazy, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { FinancerText } from '@/copy';
import type { PrepareAnswer } from '@/lib/financer/financerApi';
import { checkPayoutKey, type PayoutKeyCheck } from '@/lib/financer/payoutKey';
import { coinsOf, planOfPrepared, serverNowSec, type PagePlan, type PlanProblem } from '@/lib/financer/payoutView';
import { MAX_INPUTS } from '../../../server/shared/lana-tx/fee.ts';
import { codeText, fill, lanaText, shortWallet, timeText } from './financerText';

// jsQR loads only when someone opens the scanner.
const QrScanner = lazy(() => import('@/components/QrScanner'));

/**
 * The key is masked with CSS on a plain text field where the browser can: a password field is what a browser offers
 * to remember, and this wallet's key must never be offered there. A browser that cannot mask text gets a password field.
 */
const CAN_MASK_TEXT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc'));

export interface PreparedView {
  answer: PrepareAnswer;
  /** When the answer came (this device's clock): its age, and the server's clock now (serverNowSec). */
  receivedAt: number;
}

/**
 * A plan's problem in the reader's words. Where the wallet must be merged, the sentence ends with how — a step the
 * financer can take in their own wallet app, or the administrator's help (review N15): /financer has no merge of its own.
 */
export function planProblemText(t: FinancerText, problem: PlanProblem): string {
  const text = codeText(t.planProblem as Record<string, string>, problem.code);
  switch (problem.code) {
    case 'TOO_MANY_WALLETS':
      return fill(text, { max: problem.max });
    case 'INSUFFICIENT':
      // Short even counting every coin, and in too many small ones besides (review N12): move LANA in AND merge.
      if (problem.merge) return `${fill(t.planProblem.INSUFFICIENT_MERGE, { amount: lanaText(problem.shortBy) })} ${t.mergeHow}`;
      return fill(text, { amount: lanaText(problem.shortBy) });
    case 'TOO_MANY_INPUTS':
      // Only the least it needs is known (more coins than were listed): "more than" the coins it was shown.
      if (problem.atLeast) return `${fill(t.planProblem.TOO_MANY_INPUTS_MORE, { listed: problem.needed - 1, max: problem.max })} ${t.mergeHow}`;
      return `${fill(text, { needed: problem.needed, max: problem.max })} ${t.mergeHow}`;
    default:
      return text;
  }
}

/** What the typed text is, in the reader's words. */
export function keyCheckText(t: FinancerText, check: PayoutKeyCheck): string {
  const text = t.keyStates[check.state] ?? t.keyStates.notAKey;
  return check.state === 'other' ? fill(text, { address: check.opens }) : text;
}

/** The plan the prepare answer makes now, at the server's clock — or why there is none. */
export function planOf(prepared: PreparedView, nowMs: number): { plan: PagePlan; coinsOk: boolean } {
  const coins = coinsOf(prepared.answer);
  if (coins.ok === false) return { plan: { ok: false, problem: { code: 'UNREADABLE' } }, coinsOk: false };
  const nowSec = serverNowSec(prepared.answer.nowSec, prepared.receivedAt, nowMs);
  return { plan: planOfPrepared(prepared.answer, coins.coins, nowSec), coinsOk: true };
}

export function FinancerSendPanel(props: {
  t: FinancerText;
  lang: 'sl' | 'en';
  prepared: PreparedView;
  step: 'plan' | 'key';
  busy: 'prepare' | 'sign' | 'send' | null;
  problem: string | null;
  onBack: () => void;
  onContinue: () => void;
  onSign: (typed: string) => void;
}) {
  const { t, lang, prepared, step, busy, problem } = props;
  const { answer } = prepared;
  // Planned when the answer came; the signature plans again at the server's clock of that moment (the page).
  const { plan, coinsOk } = useMemo(() => planOf(prepared, Date.now()), [prepared]);
  const legType = useMemo(() => new Map(answer.legs.map((l) => [l.orderId, l.orderType])), [answer]);
  const skippedLanoshis = answer.skipped?.value ?? '0';

  return (
    <section data-testid="financer-send-panel" className="rounded-2xl border-2 border-primary/40 bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-foreground">{t.planTitle}</h2>
        <span className="text-xs text-muted-foreground">{fill(t.planRead, { time: timeText(prepared.receivedAt, lang) })}</span>
      </div>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.recipients}</h3>
      <ul className="mt-2 space-y-1" data-testid="financer-plan-recipients">
        {answer.allocations.map((a) => (
          <li key={a.wallet} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0">
              <span className="font-mono text-xs text-foreground" title={a.wallet}>{shortWallet(a.wallet)}</span>{' '}
              <span className="text-xs text-muted-foreground">
                {[...new Set(a.orderIds.map((id) => codeText(t.legTypes as Record<string, string>, legType.get(id))))].join(' · ')}
              </span>
            </span>
            <span className="font-semibold tabular-nums text-foreground">{lanaText(a.lanoshis)} LANA</span>
          </li>
        ))}
      </ul>

      {plan.ok === true ? (
        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl bg-muted/40 p-4" data-testid="financer-plan">
          <PlanFigure label={t.paying} value={`${lanaText(plan.plan.paying)} LANA`} strong />
          <PlanFigure label={t.fee} value={`${lanaText(plan.plan.fee)} LANA`} />
          <PlanFigure label={t.change} value={`${lanaText(plan.plan.change)} LANA`} />
          <PlanFigure label={t.left} value={`${lanaText(plan.left)} LANA`} />
          <PlanFigure label={t.inputs} value={fill(t.inputsValue, { count: plan.inputs, max: answer.limits?.maxInputs ?? MAX_INPUTS })} />
        </dl>
      ) : (
        <p className="mt-4 rounded-lg border border-red-300/60 bg-red-50/60 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="financer-plan-problem">
          {coinsOk ? planProblemText(t, plan.problem) : t.coinsUnverified}
        </p>
      )}
      {(answer.skipped?.count ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{fill(t.skipped, { count: answer.skipped.count, amount: lanaText(skippedLanoshis) })}</p>
      )}

      {problem && (
        <p className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300" role="alert" data-testid="financer-send-problem">
          {problem}
        </p>
      )}

      {step === 'key' && plan.ok === true ? (
        <KeyStep t={t} wallet={answer.wallet} busy={busy} onBack={props.onBack} onSign={props.onSign} />
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          {plan.ok === true && (
            <button
              type="button"
              onClick={props.onContinue}
              disabled={busy !== null}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {busy === 'prepare' ? t.preparing : t.continue}
            </button>
          )}
          <button
            type="button"
            onClick={props.onBack}
            disabled={busy !== null}
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {t.back}
          </button>
        </div>
      )}
    </section>
  );
}

function PlanFigure(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{props.label}</dt>
      <dd className={`mt-0.5 tabular-nums break-words ${props.strong ? 'text-base font-bold' : 'text-sm font-semibold'} text-foreground`}>{props.value}</dd>
    </div>
  );
}

/** The key: typed or scanned, checked against the wallet as it is typed, emptied before anything is signed. */
export function KeyStep(props: {
  t: FinancerText;
  /** The financer's Lana.Discount wallet: the only wallet whose key signs. */
  wallet: string;
  busy: 'prepare' | 'sign' | 'send' | null;
  onBack: () => void;
  onSign: (typed: string) => void;
}) {
  const { t, wallet, busy } = props;
  const uid = useId();
  const [typed, setTyped] = useState('');
  const [visible, setVisible] = useState(false);
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const working = busy !== null;
  // Read, compared with the wallet and wiped at once (payoutKey.ts); only what is public comes back.
  const check = useMemo(() => checkPayoutKey(typed, wallet), [typed, wallet]);
  const opens = check.state === 'opens';

  const submit = () => {
    if (!opens || working) return;
    const value = typed;
    // Out of the field before anything else — drawn empty NOW, not after the signing that follows: whatever happens
    // next, the page no longer shows or holds it.
    flushSync(() => {
      setTyped('');
      setVisible(false);
    });
    props.onSign(value);
  };

  const masked = !visible && CAN_MASK_TEXT;
  return (
    <div className="mt-5 rounded-xl border border-border bg-background/60 p-4" role="group" aria-labelledby={`${uid}-title`} data-testid="financer-key-step">
      <h3 id={`${uid}-title`} className="text-base font-bold text-foreground">{t.keyTitle}</h3>
      <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{fill(t.keyLead, { wallet })}</p>
      <label htmlFor={`${uid}-key`} className="mt-3 block text-sm font-medium text-foreground">{t.keyLabel}</label>
      <div className="mt-1 flex gap-2">
        {/* Masked text, not a password field, where the browser can: nothing for a password manager to offer to keep. */}
        <input
          ref={inputRef}
          id={`${uid}-key`}
          name="lana-discount-wallet-key"
          type={visible || CAN_MASK_TEXT ? 'text' : 'password'}
          style={masked ? ({ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as unknown as CSSProperties) : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          value={typed}
          aria-invalid={typed && !opens ? true : undefined}
          aria-describedby={`${uid}-check`}
          onChange={(e) => setTyped(e.target.value)}
          disabled={working}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          className="rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {visible ? t.hide : t.show}
        </button>
        <button
          type="button"
          onClick={() => setScanning(true)}
          disabled={working}
          className="rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t.scan}
        </button>
      </div>
      <p
        id={`${uid}-check`}
        role="status"
        data-testid="financer-key-check"
        className={`mt-2 text-sm ${opens ? 'text-emerald-700 dark:text-emerald-400' : check.state === 'empty' ? 'text-muted-foreground' : 'text-red-700 dark:text-red-400'}`}
      >
        {opens ? '✓ ' : ''}
        {keyCheckText(t, check)}
      </p>
      {scanning && (
        <Suspense fallback={null}>
          <QrScanner
            onClose={() => setScanning(false)}
            onScan={(text: string) => {
              // What the camera read goes into the masked field — never shown, signed with only on »Podpiši in pošlji«.
              setTyped(text);
              setScanning(false);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
        </Suspense>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!opens || working}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {busy === 'sign' ? t.signing : busy === 'send' ? t.announcing : t.sign}
        </button>
        <button
          type="button"
          onClick={() => {
            setTyped('');
            props.onBack();
          }}
          disabled={working}
          className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t.back}
        </button>
      </div>
    </div>
  );
}
