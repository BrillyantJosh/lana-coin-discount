/**
 * /financer — a financer settles their own purchases (owner, 8 Oct 2026).
 *
 * "DF in LD sta samo še primarni trg za večja podjetja … Mi smo zgolj
 * infrastruktura." Until now every Lana Discount share went to ONE treasury
 * bank account, an administrator confirmed it, and the treasury sent all the
 * LANA from one wallet. Now the Lana Discount shares of a financer's budgets
 * are internal — they pay themselves — and the financer does both steps here:
 *
 *   1. MY WALLET — the Lana.Discount wallet they chose on Direct.Fund, what the
 *      LANA Registrar says of it now, and its confirmed balance — one per
 *      currency (owner, 9 Oct 2026, below);
 *   2. TO CONFIRM — their Lana Discount batches, paid on Direct.Fund first
 *      (»I Have Paid This Batch«), then »Potrdi« / »Potrdi vse« here — and
 *      »Potrdi znova« on one they confirmed, when a repeat would change
 *      something (FinancerBatches.tsx);
 *   3. TO SEND — every leg of the purchases they confirmed, approved by the
 *      brain once every part of a purchase is paid on Direct.Fund (bank payouts
 *      to merchants included), about ten minutes after that: chosen by purchase,
 *      at most what one send carries, the totals,
 *      the balance, what is missing; then the plan of the send and their
 *      wallet's key, signed IN THIS BROWSER (src/lib/financer/payoutKey.ts) —
 *      the key never reaches lana.discount, only the signed transaction does;
 *   4. ON THE WAY AND SENT — each send, with its transaction on the explorer.
 *
 * ONE WALLET PER CURRENCY (owner, 9 Oct 2026). A financer chooses a
 * Lana.Discount wallet on Direct.Fund for each currency of their budgets, and
 * a purchase's LANA go from the wallet of its currency. So 1 and 3 come once
 * per currency (GET /api/financer/me `wallets`: each currency with a wallet or
 * a purchase still to send): its wallet card, then its purchases to send — read
 * with GET /sendable?currency= against that currency's wallet — and the send of
 * them, signed with THAT wallet's key (the key check names any other wallet).
 * The batches stay one list. One send is open on the page at a time: while a
 * plan or a send in doubt is open in one currency, the others wait for it. A
 * server or Direct.Fund from before wallets per currency gives one part, as it
 * was (`currency` null, /sendable asked without one).
 *
 * NEVER TWICE. A signed send whose announce got no answer (a timeout, a server
 * error, too many requests — payoutView.ts announceInDoubt) may already be
 * recorded and broadcast. Its SIGNED bytes are kept in this page's memory
 * (public once sent) and offered again as they are — the server answers a
 * transaction it holds with its state — and nothing new can be prepared while
 * they wait. A new signature over the same legs could pay every wallet twice.
 * A refusal the server gave (4xx) stored nothing; the send is prepared anew.
 * The coins and the server's clock are read again before the key is asked for
 * when they are older than ten minutes, and nothing is signed with ones older
 * than half an hour (payoutView.ts FRESH_BEFORE_KEY_MS, STALE_MS).
 *
 * Every request is signed (nip98Fetch.ts): the signer is the financer, and the
 * server answers only about them. Words are src/copy.ts FINANCER (English) and
 * FINANCER_SL, chosen by the browser's language with the same SL/EN toggle as
 * the selling-closed notice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { FINANCER_TEXT } from '@/copy';
import { LangToggle, useNoticeLang } from '@/components/SellingMovedNotice';
import {
  DIRECT_FUND_URL, financerApi,
  type Answer, type ConfirmResult, type FinancerBatch, type FinancerMe, type SendableAnswer, type SendView, type WalletCheck,
} from '@/lib/financer/financerApi';
import { signPayoutWithKey } from '@/lib/financer/payoutKey';
import {
  FRESH_BEFORE_KEY_MS, POLL_MS, STALE_MS,
  announceInDoubt, checkOwnSend, coinsOf, planOfPrepared, serverNowSec,
} from '@/lib/financer/payoutView';
import { FinancerWalletCard } from '@/components/financer/FinancerWalletCard';
import { FinancerBatches, batchStateOf } from '@/components/financer/FinancerBatches';
import { ALL_CHOSEN, FinancerSendable, choiceAfterSend, choose, unchosenOf, type Choice } from '@/components/financer/FinancerSendable';
import { FinancerSendPanel, keyCheckText, planProblemText, type PreparedView } from '@/components/financer/FinancerSendPanel';
import { FinancerSends } from '@/components/financer/FinancerSends';
import { codeText, fill, refusalText } from '@/components/financer/financerText';

type Loaded<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'failed'; text: string };

/**
 * One currency's part of the page: its wallet, its purchases to send and their send. `key` is the currency — '' for the
 * one part of a server or Direct.Fund from before wallets per currency (`currency` null).
 */
export interface Section {
  key: string;
  currency: string | null;
  walletId: string | null;
  walletCheck: WalletCheck;
}

/** The page's parts, one per currency /me lists — or, listing none (or a server before them), its single wallet. */
export function sectionsOf(me: FinancerMe): Section[] {
  if (Array.isArray(me.wallets) && me.wallets.length > 0) {
    return me.wallets.map((w) => ({ key: w.currency, currency: w.currency, walletId: w.walletId, walletCheck: w.walletCheck }));
  }
  return [{ key: '', currency: null, walletId: me.lanaDiscountWallet, walletCheck: me.walletCheck }];
}

/** A send signed here whose announce has no answer yet: the very bytes, sent again as they are — never signed anew. */
interface PendingSend {
  rawTx: string;
  txid: string;
  orderIds: string[];
  /** The part (currency) it was signed in. */
  key: string;
}

type Busy = 'prepare' | 'sign' | 'send' | null;

/** Batches per confirm request: server/routes/financer.ts MAX_CONFIRM_BATCHES. */
export const CONFIRM_CHUNK = 100;

const Financer = () => {
  const { session, isLoading, logout } = useAuth();
  const navigate = useNavigate();
  const [lang, setLang] = useNoticeLang();
  const t = FINANCER_TEXT[lang];

  const [me, setMe] = useState<Loaded<FinancerMe>>({ kind: 'loading' });
  const [batches, setBatches] = useState<Loaded<FinancerBatch[]>>({ kind: 'loading' });
  /** Each part's purchases to send and its wallet (by Section.key); a part not read yet is loading. */
  const [sendable, setSendable] = useState<Record<string, Loaded<SendableAnswer>>>({});
  const [sends, setSends] = useState<SendView[]>([]);
  /** The parts as /me last said them — read by the loaders, which outlive a render. */
  const sectionsRef = useRef<Section[]>([]);

  const [confirming, setConfirming] = useState<ReadonlySet<string>>(new Set());
  const [confirmResults, setConfirmResults] = useState<Record<string, ConfirmResult>>({});
  const [batchNotice, setBatchNotice] = useState<{ tone: 'ok' | 'problem'; lines: string[] } | null>(null);

  /**
   * Purchases the financer took out of the send — by hand, or by a button, kept apart (review M8); every other one is
   * chosen. After a send only the hand-unticked ones stay out.
   */
  const [choice, setChoice] = useState<Choice>(ALL_CHOSEN);
  const unchosen = useMemo(() => unchosenOf(choice), [choice]);
  /** The plan open on the page — one at a time — and the part (currency) it is in. */
  const [prepared, setPrepared] = useState<(PreparedView & { orderIds: string[]; key: string }) | null>(null);
  const [step, setStep] = useState<'plan' | 'key'>('plan');
  const [busy, setBusy] = useState<Busy>(null);
  /** Held apart from the state: a second click lands before the state has changed. */
  const busyRef = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * A send step's answer, said above the list. A refusal keeps its `code` and when it came (`at`): one for a payment
   * waiting for a block (WALLET_UNCONFIRMED) is taken down by the first read of the wallet started after it that finds
   * the balance confirmed (review N14) — never left in red beside a »Pripravi pošiljanje« that is on again.
   */
  const [sendNotice, setSendNotice] = useState<{ tone: 'ok' | 'problem'; text: string; key: string; code?: string | null; at?: number } | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const mounted = useRef(true);
  /** Each send's state as last read: one that moved on reads the batches and the wallet again. */
  const seen = useRef(new Map<string, string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoading && !session) navigate('/login?next=/financer');
  }, [isLoading, session, navigate]);

  const failed = useCallback((r: Answer<unknown>, codes: Record<string, string>) => ({ kind: 'failed' as const, text: refusalText(t, r, codes) }), [t]);

  const loadBatches = useCallback(async () => {
    const r = await financerApi.batches();
    if (!mounted.current) return;
    if (r.data) setBatches({ kind: 'ready', data: r.data.batches ?? [] });
    else setBatches((b) => (b.kind === 'ready' ? b : failed(r, t.confirmCodes as Record<string, string>)));
  }, [failed, t]);

  /** Every part's purchases and wallet, each read against its own currency's wallet. */
  const loadSendable = useCallback(async () => {
    await Promise.all(
      sectionsRef.current.map(async (section) => {
        const startedAt = Date.now();
        const r = await financerApi.sendable(section.currency);
        if (!mounted.current) return;
        if (r.data) {
          const data = r.data;
          setSendable((all) => ({ ...all, [section.key]: { kind: 'ready', data } }));
          const confirmed = !!data.balance && data.balance.unconfirmed === '0';
          if (confirmed) setSendNotice((n) => (n?.key === section.key && n.code === 'WALLET_UNCONFIRMED' && (n.at ?? 0) <= startedAt ? null : n));
        } else {
          setSendable((all) => {
            const before = all[section.key];
            return { ...all, [section.key]: before?.kind === 'ready' ? before : failed(r, t.sendCodes as Record<string, string>) };
          });
        }
      }),
    );
  }, [failed, t]);

  const loadSends = useCallback(async () => {
    const r = await financerApi.sends();
    if (!mounted.current || !r.data) return;
    const list = r.data.sends ?? [];
    let moved = false;
    for (const s of list) {
      const before = seen.current.get(s.txid);
      if (before !== undefined && before !== s.state) moved = true;
      seen.current.set(s.txid, s.state);
    }
    setSends(list);
    if (moved) {
      // Confirmed, released: the batches' progress and the wallet have changed.
      void loadBatches();
      void loadSendable();
    }
  }, [loadBatches, loadSendable]);

  /**
   * Who the signer is and their wallet per currency: the page's parts. False: not read, or no financer. Not read, it is
   * said in place of the page — or, `keep`, the page stays as it was (a read again after a confirm).
   */
  const loadMe = useCallback(async (keep = false): Promise<boolean> => {
    setMe((m) => (m.kind === 'ready' ? m : { kind: 'loading' }));
    const r = await financerApi.me();
    if (!mounted.current) return false;
    if (!r.data) {
      setMe((m) => (keep && m.kind === 'ready' ? m : failed(r, {})));
      return false;
    }
    sectionsRef.current = sectionsOf(r.data);
    setMe({ kind: 'ready', data: r.data });
    return r.data.isFinancer;
  }, [failed]);

  const loadAll = useCallback(async () => {
    if (!(await loadMe(false))) return;
    await Promise.all([loadBatches(), loadSendable(), loadSends()]);
  }, [loadMe, loadBatches, loadSendable, loadSends]);

  useEffect(() => {
    if (session) void loadAll();
    // Once per signer; the language toggle must not read everything again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.nostrHexId]);

  // ── what is on its way is asked about again, while the page is in view ──
  const meData = me.kind === 'ready' ? me.data : null;
  const sections = useMemo(() => (meData ? sectionsOf(meData) : []), [meData]);
  const dataOf = (key: string): SendableAnswer | null => {
    const s = sendable[key];
    return s?.kind === 'ready' ? s.data : null;
  };
  const batchList = batches.kind === 'ready' ? batches.data : [];
  const awaitingApproval = batchList.some((b) => batchStateOf(b) === 'awaitingApproval');
  // A payment into or out of the wallet waiting for a block blocks the next send (WALLET_UNCONFIRMED); nothing else
  // may be on its way then (a top-up, a send the reading server has not caught up with), so the wallet is read again
  // until it is confirmed — the block lifts by itself, never only on »Osveži« (review C22).
  const walletMoving = sections.some((section) => {
    const balance = dataOf(section.key)?.balance;
    return !!balance && balance.unconfirmed !== '0';
  });
  const live = pending !== null || sends.some((s) => s.state === 'announced' || s.state === 'mempool') || awaitingApproval || walletMoving;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadSends();
      void loadSendable();
      if (awaitingApproval) void loadBatches();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, awaitingApproval, loadSends, loadSendable, loadBatches]);

  // An announce with no answer that the server does hold: it was recorded — nothing to send again.
  useEffect(() => {
    if (pending && sends.some((s) => s.txid === pending.txid)) {
      setPending(null);
      setPrepared(null);
      setStep('plan');
      setProblem(null);
      setSendNotice({ tone: 'ok', text: t.sentOk, key: pending.key });
      setChoice(choiceAfterSend);
    }
  }, [pending, sends, t]);

  // ── confirming batches ──
  /** `again`: »Potrdi znova« — the same confirm call for a batch already confirmed (review N7/N9), worded as such. */
  const confirm = useCallback(
    async (batchRefs: string[], again = false) => {
      if (batchRefs.length === 0 || confirming.size > 0) return;
      setConfirming(new Set(batchRefs));
      setBatchNotice(null);
      // At most CONFIRM_CHUNK per request (the server's MAX_CONFIRM_BATCHES): a company with many budgets has many
      // batches, and »Potrdi vse« must not be refused whole for being long. Each request is answered per batch.
      const results: ConfirmResult[] = [];
      let failure: string | null = null;
      for (let i = 0; i < batchRefs.length; i += CONFIRM_CHUNK) {
        const r = await financerApi.confirm(batchRefs.slice(i, i + CONFIRM_CHUNK));
        if (!mounted.current) return;
        if (!r.data) {
          failure = refusalText(t, r, t.confirmCodes as Record<string, string>);
          break;
        }
        results.push(...(r.data.results ?? []));
      }
      setConfirming(new Set());
      setConfirmResults((prev) => ({ ...prev, ...Object.fromEntries(results.map((x) => [x.batchRef, x])) }));
      const done = results.filter((x) => x.ok && !x.alreadyConfirmed).map((x) => x.batchRef);
      const already = results.filter((x) => x.ok && x.alreadyConfirmed).map((x) => x.batchRef);
      const refused = results.filter((x) => !x.ok);
      // Purchases Direct.Fund no longer counts (cancelled, moved by a reallocation): left out, said by batch.
      const skipped = results.filter((x) => x.ok && x.skippedRefs?.length);
      const lines = [
        ...(done.length ? [fill(t.confirmDone, { refs: done.join(', ') })] : []),
        ...(already.length ? [fill(again ? t.confirmAgainDone : t.confirmAlready, { refs: already.join(', ') })] : []),
        ...skipped.map((x) => fill(t.confirmSkipped, { ref: x.batchRef, count: x.skippedRefs.length, refs: x.skippedRefs.join(', ') })),
        ...refused.map((x) => fill(t.confirmRefused, { ref: x.batchRef, why: codeText(t.confirmCodes as Record<string, string>, x.code) })),
        ...(failure ? [failure] : []),
      ];
      setBatchNotice({ tone: refused.length || failure ? 'problem' : 'ok', lines });
      if (results.length) {
        void loadBatches();
        // A batch confirmed may bring purchases of a currency the page has no part for yet: /me first, then each part
        // (the parts as they were, when /me could not be read).
        if (done.length) void loadMe(true).then(() => loadSendable());
        else void loadSendable();
      }
    },
    [confirming, t, loadBatches, loadMe, loadSendable],
  );

  // ── preparing, signing, announcing ──
  const sendRefusal = useCallback(
    (r: Answer<unknown>, key: string): string => {
      // What a refusal names: the wallet of an earlier refused send (MUST_SPEND_OTHER_WALLET), the payments one send
      // carries and the button that chooses what fits (BAD_ORDER_IDS), the currency without a wallet (NO_WALLET).
      const answer = sendable[key];
      const text = fill(refusalText(t, r, t.sendCodes as Record<string, string>), {
        wallet: typeof r.refusal?.wallet === 'string' ? r.refusal.wallet : '?',
        max: answer?.kind === 'ready' ? answer.data.limits.maxLegs : '?',
        button: t.chooseFits,
        currency: typeof r.refusal?.currency === 'string' ? r.refusal.currency : key || '?',
      });
      const reason = r.refusal?.code === 'WALLET_REFUSED' ? String(r.refusal.reason || '') : '';
      if (!reason) return text;
      return `${text} ${fill(codeText(t.walletReasons as Record<string, string>, reason), { type: String(r.refusal?.walletType ?? '?') })}`;
    },
    [t, sendable],
  );

  /** Read the wallet and the legs for these purchases of the part `key`; `why` says why it is read again, when it is. */
  const prepare = useCallback(
    async (key: string, orderIds: string[], why: string | null = null) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy('prepare');
      setSendNotice(null);
      setProblem(null);
      try {
        const r = await financerApi.prepare(orderIds);
        if (!mounted.current) return;
        if (r.data) {
          setPrepared({ answer: r.data, receivedAt: Date.now(), orderIds: (r.data.legs ?? []).map((l) => l.orderId), key });
          setStep('plan');
          setProblem(why);
        } else {
          setPrepared(null);
          setStep('plan');
          setSendNotice({ tone: 'problem', text: sendRefusal(r, key), key, code: r.refusal?.code ?? null, at: Date.now() });
          // The list and the wallet as they are now: a purchase gone, a payment waiting for a block (polled from here).
          void loadSendable();
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [sendRefusal, loadSendable],
  );

  /** The legs of a part's chosen purchases: what »Pripravi pošiljanje« in it prepares. */
  const chosenOrderIds = (data: SendableAnswer): string[] =>
    data.purchases.filter((p) => !unchosen.has(p.transactionRef)).flatMap((p) => p.legs.map((l) => l.orderId));

  const announce = useCallback(
    async (next: PendingSend) => {
      setBusy('send');
      const r = await financerApi.announce(next.orderIds, next.rawTx);
      if (!mounted.current) return;
      const send = r.data?.send;
      if (send) {
        seen.current.set(send.txid, send.state);
        setPending(null);
        setPrepared(null);
        setStep('plan');
        setProblem(null);
        setSendNotice({ tone: 'ok', text: t.sentOk, key: next.key });
        // The next round starts from all but what the financer unticked by hand (review M8).
        setChoice(choiceAfterSend);
        setSends((list) => [send, ...list.filter((s) => s.txid !== send.txid)]);
        void loadSendable();
        void loadBatches();
        return;
      }
      if (announceInDoubt(r.status)) {
        // It may be recorded and on its way: the same bytes wait for »Znova pošlji« — never a new signature.
        setPending(next);
        setProblem(t.inDoubt);
        return;
      }
      // Refused before anything was stored: this plan is spent. It is prepared again from what the server holds now.
      setPending(null);
      setPrepared(null);
      setStep('plan');
      setProblem(null);
      setSendNotice({ tone: 'problem', text: sendRefusal(r, next.key), key: next.key, code: r.refusal?.code ?? null, at: Date.now() });
      void loadSendable();
    },
    [t, sendRefusal, loadSendable, loadBatches],
  );

  /** Sign with the key typed, in this browser, then announce the signed bytes. The key goes no further than here. */
  const sign = useCallback(
    async (typed: string) => {
      if (busyRef.current || pending || !prepared) return;
      if (Date.now() - prepared.receivedAt > STALE_MS) {
        void prepare(prepared.key, prepared.orderIds, t.stale);
        return;
      }
      const coins = coinsOf(prepared.answer);
      if (coins.ok === false) {
        setProblem(t.coinsUnverified);
        return;
      }
      busyRef.current = true;
      setBusy('sign');
      setProblem(null);
      try {
        // The send's nTime: the server's clock (never this device's), as much later as time passed here since it was read.
        const nowSec = serverNowSec(prepared.answer.nowSec, prepared.receivedAt, Date.now());
        const planned = planOfPrepared(prepared.answer, coins.coins, nowSec);
        if (planned.ok === false) {
          setProblem(planProblemText(t, planned.problem));
          return;
        }
        const signed = await signPayoutWithKey(typed, { from: prepared.answer.wallet, pay: planned.plan.pay, coins: planned.plan.coins, nowSec });
        if (signed.ok === false) {
          setProblem('check' in signed ? keyCheckText(t, signed.check) : t.signFailed);
          return;
        }
        // The page's own look at what it signed, by the rule the server will run (against the allocations, not the outputs).
        const own = checkOwnSend(signed.rawTx, prepared.answer, planned.plan.coins, nowSec);
        if (own.ok === false) {
          setProblem(t.ownCheckFailed);
          return;
        }
        if (own.txid !== signed.txid) {
          setProblem(t.ownCheckFailed);
          return;
        }
        // Kept only if the answer does not come (announce); a second click meanwhile meets busyRef.
        await announce({ rawTx: signed.rawTx, txid: signed.txid, orderIds: prepared.orderIds, key: prepared.key });
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [pending, prepared, prepare, announce, t],
  );

  const resend = useCallback(async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setProblem(null);
    try {
      await announce(pending);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [pending, announce]);

  /** Before the key: coins read longer ago than FRESH_BEFORE_KEY_MS are read again, and the send shown again. */
  const toKey = useCallback(() => {
    if (!prepared) return;
    if (Date.now() - prepared.receivedAt > FRESH_BEFORE_KEY_MS) {
      void prepare(prepared.key, prepared.orderIds, t.refreshed);
      return;
    }
    setProblem(null);
    setStep('key');
  }, [prepared, prepare, t]);

  if (isLoading || !session) return null;

  /** The part a plan or a send in doubt is open in: the others wait for it (one send at a time on the page). */
  const openKey = pending?.key ?? prepared?.key;
  /** Why nothing can be prepared in this part now, in words; null when it can. */
  const blockedOf = (section: Section, data: SendableAnswer): string | null => {
    if (openKey !== undefined && openKey !== section.key) return fill(t.otherSendOpen, { currency: openKey || '?' });
    if (pending) return t.pendingBlock;
    if (data.inFlight.length > 0) return t.inFlightBlock;
    if (!section.walletId || !section.walletCheck.ok) return t.walletBlock;
    if (data.balance && data.balance.unconfirmed !== '0') return t.sendCodes.WALLET_UNCONFIRMED;
    return null;
  };
  /** The open send — in doubt, or its plan and key — drawn in its part (or after them all, its part gone meanwhile). */
  const openSend = () =>
    pending ? (
      <section className="rounded-2xl border-2 border-amber-400/60 bg-card p-5 sm:p-6 space-y-3" data-testid="financer-in-doubt" role="alert">
        <p className="text-sm text-foreground">{t.inDoubt}</p>
        <p className="font-mono text-xs text-muted-foreground break-all">{pending.txid}</p>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={busy !== null}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy === 'send' ? t.announcing : t.resend}
        </button>
      </section>
    ) : (
      prepared && (
        <FinancerSendPanel
          t={t}
          lang={lang}
          prepared={prepared}
          step={step}
          busy={busy}
          problem={problem}
          onBack={() => {
            setPrepared(null);
            setStep('plan');
            setProblem(null);
          }}
          onContinue={toKey}
          onSign={(typed) => void sign(typed)}
        />
      )
    );
  const unknownRefs = meData?.unknownCurrencyRefs ?? [];

  return (
    <div className="min-h-screen bg-background flex flex-col" lang={lang}>
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between gap-3 h-14 sm:h-16">
          <a href="/" className="flex min-w-0 items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 shrink-0 dark:invert" />
            <span className="truncate">Lana<span className="text-gold">.Discount</span></span>
          </a>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <LangToggle lang={lang} onChange={setLang} />
            <a href="/dashboard" className="hidden sm:inline text-sm font-medium text-muted-foreground hover:text-foreground">
              {t.dashboard}
            </a>
            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/');
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors whitespace-nowrap"
            >
              {t.signOut}
            </button>
          </div>
        </div>
      </nav>

      <main className="flex-1 container mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-10 space-y-5">
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">{t.eyebrow}</p>
              <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{t.title}</h1>
            </div>
            <button
              type="button"
              onClick={() => void loadAll()}
              disabled={busy !== null}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t.refresh}
            </button>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{t.intro}</p>
          <p className="text-xs text-muted-foreground">{t.walletsPerCurrency}</p>
          <p className="text-xs text-muted-foreground">{t.keyStays}</p>
        </header>

        {me.kind === 'loading' && <p className="text-sm text-muted-foreground" role="status">{t.loading}</p>}
        {me.kind === 'failed' && (
          <p className="rounded-xl border border-red-300/60 bg-red-50/60 dark:bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400" role="alert">
            {me.text}
          </p>
        )}
        {meData && !meData.isFinancer && (
          <section className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-3" data-testid="financer-not-financer">
            <p className="font-semibold text-foreground">{t.notFinancer}</p>
            <p className="text-sm text-muted-foreground">{t.notFinancerHint}</p>
            <a href={DIRECT_FUND_URL} rel="noopener" className="inline-block text-sm font-semibold text-primary hover:underline">
              {t.openDf}
            </a>
          </section>
        )}

        {meData?.isFinancer && (
          <>
            {sections.map((section) => (
              <FinancerWalletCard
                key={`wallet-${section.key}`}
                t={t}
                currency={section.currency}
                walletId={section.walletId}
                walletCheck={section.walletCheck}
                balance={dataOf(section.key)?.balance}
              />
            ))}
            {unknownRefs.length > 0 && (
              <p className="rounded-xl border border-amber-300/60 p-3 text-sm text-amber-800 dark:text-amber-300" role="status" data-testid="financer-unknown-currency">
                {fill(t.unknownCurrency, { count: unknownRefs.length, refs: unknownRefs.join(', ') })}
              </p>
            )}

            {batchNotice && (
              <div
                role={batchNotice.tone === 'problem' ? 'alert' : 'status'}
                data-testid="financer-batch-notice"
                className={`rounded-xl border p-3 text-sm space-y-1 ${batchNotice.tone === 'ok' ? 'border-emerald-300/60 bg-emerald-50/60 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-red-300/60 bg-red-50/60 text-red-700 dark:bg-red-500/10 dark:text-red-400'}`}
              >
                {batchNotice.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
            {batches.kind === 'failed' ? (
              <p className="rounded-xl border border-red-300/60 p-4 text-sm text-red-700 dark:text-red-400" role="alert">{batches.text}</p>
            ) : batches.kind === 'loading' ? (
              <p className="text-sm text-muted-foreground">{t.loading}</p>
            ) : (
              <FinancerBatches t={t} lang={lang} batches={batches.data} confirming={confirming} results={confirmResults} onConfirm={(refs, again) => void confirm(refs, again)} />
            )}

            {sections.map((section) => {
              const loaded = sendable[section.key];
              const data = loaded?.kind === 'ready' ? loaded.data : null;
              const notice = sendNotice?.key === section.key ? sendNotice : null;
              return (
                <div key={`send-${section.key}`} className="space-y-5" data-testid={`financer-part-${section.key || 'one'}`}>
                  {notice && (
                    <p
                      role={notice.tone === 'problem' ? 'alert' : 'status'}
                      data-testid="financer-send-notice"
                      className={`rounded-xl border p-3 text-sm ${notice.tone === 'ok' ? 'border-emerald-300/60 bg-emerald-50/60 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-red-300/60 bg-red-50/60 text-red-700 dark:bg-red-500/10 dark:text-red-400'}`}
                    >
                      {notice.text}
                    </p>
                  )}
                  {loaded?.kind === 'failed' ? (
                    <p className="rounded-xl border border-red-300/60 p-4 text-sm text-red-700 dark:text-red-400" role="alert">{loaded.text}</p>
                  ) : !data ? (
                    <p className="text-sm text-muted-foreground">{t.loading}</p>
                  ) : (
                    <FinancerSendable
                      t={t}
                      answer={data}
                      choice={choice}
                      onChoose={(refs, on, byHand) => setChoice((prev) => choose(prev, refs, on, byHand))}
                      locked={prepared !== null || pending !== null}
                      blocked={blockedOf(section, data)}
                      preparing={busy === 'prepare'}
                      onPrepare={() => void prepare(section.key, chosenOrderIds(data))}
                    />
                  )}
                  {openKey === section.key && openSend()}
                </div>
              );
            })}
            {openKey !== undefined && !sections.some((section) => section.key === openKey) && openSend()}

            <FinancerSends t={t} lang={lang} sends={sends} />
          </>
        )}
      </main>
    </div>
  );
};

export default Financer;
