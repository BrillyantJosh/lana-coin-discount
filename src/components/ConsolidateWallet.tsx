import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { convertWifToIds } from '@/lib/crypto';
import { CONSOLIDATE } from '@/copy';
import { fill } from '@/components/MandatePanel';
import {
  buildConsolidationPlan, type PlanUtxo,
} from '../../server/lib/consolidationPlan';
import { buildTargetPlan, topUpToFit } from '../../server/lib/consolidationTarget';

const QrScanner = lazy(() => import('@/components/QrScanner'));

/**
 * CONSOLIDATING A WALLET, WITHOUT LEAVING THE OFFER PAGE.
 *
 * A transfer carries at most twenty of a wallet's pieces. A seller whose wallet
 * held more was told to go and consolidate it with Registrar, and came back —
 * or did not. The owner, 13 Sept 2026: "naredi možnost konsolidacije kar na
 * Lana.discount … skopiraj rešitev iz MejmoSeFajn".
 *
 * This is MejmoSeFajn's Consolidate page (src/pages/WalletConsolidate.tsx),
 * made a panel: the same batches from the same planning module, the same key
 * check before anything is sent, the same guard against a double press. What
 * differs is what the server knows, and one case MejmoSeFajn never had:
 *
 *   - the server names the pieces a consolidation already on its way has
 *     spent, so the NEXT batch can go at once instead of a block later, and
 *     the panel can tell the page when the wallet fits one transfer;
 *   - while an OFFER from this wallet is open, merging everything would spend
 *     more fee than the offer allows (a 20-piece merge costs 546,600
 *     lanoshis; a wallet may come up only 500,000 short of what it promised).
 *     Then only the cheapest consolidation that makes the wallet fit is
 *     offered, and only when its fee fits in the room the server reports —
 *     otherwise the panel says so instead of showing a button.
 */

interface Available { tx_hash: string; tx_pos: number; value: number; height: number }
interface Pending { txid: string; inputCount: number; feeLanoshis: number; netLanoshis: number; createdAt: string }
interface WalletRead {
  success: boolean;
  maxInputs: number;
  utxoCount: number;
  piecesAfterPending: number;
  totalLanoshis: number;
  /** confirmed + unconfirmed, or null when electrum's balance could not be read. */
  balanceLanoshis: number | null;
  /** Negative: a spend is on its way. Positive: only money arriving (as far as the net figure shows). */
  unconfirmedLanoshis: number | null;
  /** Fee consolidating may still spend while offers from this wallet are open; null when none is. */
  feeRoomLanoshis: number | null;
  /** The same, not clamped at zero — below it when the offers already exceed what the wallet backs. */
  feeRoomUnclampedLanoshis: number | null;
  inFlight: 'none' | 'ours' | 'other' | 'unknown';
  available: Available[];
  confirmingCount: number;
  pending: Pending[];
}

const lana8 = (lanoshis: number) => (lanoshis / 100_000_000).toFixed(8);
/** Whole LANA grouped, all eight decimals kept — a piece is money to the lanoshi. */
const lanaGrouped = (lanoshis: number) => {
  const [whole, frac] = lana8(lanoshis).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
};
const piecesWord = (count: number) => (count === 1 ? CONSOLIDATE.piece : CONSOLIDATE.pieces);
const POLL_MS = 30_000;

export interface ConsolidateWalletProps {
  address: string;
  hexId: string;
  /** A key the page already holds; used when it belongs to this wallet. */
  initialKey?: string;
  /**
   * The wallet fits one transfer now, with nothing on its way — the page should
   * read it again. Called each time a read turns that way, whoever consolidated,
   * with the piece count that read found: the page can take it even if its own
   * re-read then fails.
   */
  onSettled?: (utxoCount: number) => void;
  /** Whether a consolidation of this wallet is still on its way (or may be). */
  onPendingChange?: (pending: boolean) => void;
}

export default function ConsolidateWallet({ address, hexId, initialKey, onSettled, onPendingChange }: ConsolidateWalletProps) {
  const [wallet, setWallet] = useState<WalletRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [working, setWorking] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /** A consolidation whose broadcast went unanswered: which one, and the read it was sent after. */
  const [sendNote, setSendNote] = useState<{ txid: string; pieces: string[]; afterRead: number; message: string } | null>(null);
  const [readCount, setReadCount] = useState(0);
  // Synchronous lock: the button's `disabled` lands on the next render, so a
  // fast double tap can reach the handler twice before it greys out.
  const sendingRef = useRef(false);
  const reportedFitRef = useRef(false);

  const read = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch('/api/wallets/consolidation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'unreadable');
      setWallet(data);
      setReadCount(n => n + 1);
      setReadFailed(false);
    } catch {
      setReadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void read(); }, [read]);

  // A key the page already has, if it is this wallet's.
  useEffect(() => {
    if (!initialKey || privateKey) return;
    try {
      const ids = convertWifToIds(initialKey.trim());
      if (ids.walletIdCompressed === address || ids.walletIdUncompressed === address) setPrivateKey(initialKey.trim());
    } catch { /* not a key; the seller types one */ }
  }, [initialKey, address]);

  // The key is checked here before anything is sent; the server checks again.
  useEffect(() => {
    const trimmed = privateKey.trim();
    if (!trimmed) { setKeyValid(null); return; }
    const t = setTimeout(() => {
      try {
        const ids = convertWifToIds(trimmed);
        setKeyValid(ids.walletIdCompressed === address || ids.walletIdUncompressed === address);
      } catch {
        setKeyValid(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [privateKey, address]);

  const pendingCount = wallet?.pending.length ?? 0;
  // Merging waits for ANY unconfirmed movement — the server refuses otherwise.
  const blockedByOther = wallet?.inFlight === 'other' || wallet?.inFlight === 'unknown';
  // The transfer, and "does it fit", wait only for a SPEND on its way: ours, an
  // unreadable balance, or a figure that is not plainly incoming. A customer's
  // payment arriving is no reason to hold the button (review of the fixes,
  // 13 Sept 2026).
  const spendInFlight = !!wallet && (pendingCount > 0 || wallet.inFlight === 'unknown'
    || (wallet.inFlight === 'other' && !((wallet.unconfirmedLanoshis ?? -1) > 0)));
  const fits = !!wallet && !spendInFlight && wallet.piecesAfterPending <= wallet.maxInputs;
  const waiting = (!!wallet && (pendingCount > 0 || blockedByOther)) || !!sendNote;

  useEffect(() => { onPendingChange?.(spendInFlight); }, [spendInFlight]);

  // An unanswered broadcast, followed up on every later read: still pending →
  // the note stands beside it; its pieces offered again → it did not go
  // through, and the note says so; neither → it confirmed, and the note goes.
  useEffect(() => {
    if (!sendNote || !wallet || readCount <= sendNote.afterRead) return;
    if (wallet.pending.some(p => p.txid === sendNote.txid)) return;
    const offeredAgain = wallet.available.some(u => sendNote.pieces.includes(`${u.tx_hash}:${u.tx_pos}`));
    if (offeredAgain) {
      if (sendNote.message !== CONSOLIDATE.uncertainFailed) setSendNote({ ...sendNote, message: CONSOLIDATE.uncertainFailed });
    } else {
      setSendNote(null);
    }
  }, [readCount, wallet, sendNote]);

  // Told once each time the wallet comes to fit — not only after a
  // consolidation this panel watched, because the read that would have shown it
  // pending can be missed, and a consolidation made elsewhere counts the same.
  useEffect(() => {
    if (!wallet) return;
    if (fits && !reportedFitRef.current) {
      reportedFitRef.current = true;
      onSettled?.(wallet.utxoCount);
    } else if (!fits) {
      reportedFitRef.current = false;
    }
  }, [fits, wallet]);

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => { void read(true); }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, read]);

  // Which consolidations to offer. With an offer open: only the cheapest that
  // makes the wallet fit, and only if its fee fits the room. Without: MejmoSeFajn's.
  const room = wallet?.feeRoomLanoshis ?? null;
  const targetMode = room !== null;
  const targetPlan = wallet && targetMode ? buildTargetPlan(wallet.available as PlanUtxo[], wallet.piecesAfterPending, wallet.maxInputs) : null;
  const plan = !wallet ? null : targetPlan ?? buildConsolidationPlan(wallet.available as PlanUtxo[]);
  const tight = !!targetPlan && targetPlan.batches.length > 0 && (!targetPlan.reachesTarget || targetPlan.totalFee > (room ?? 0));
  // What adding LANA would take — from the plan itself, never guessed, and not
  // offered at all when the balance behind the room could not be read.
  const topUp = tight && wallet && wallet.inFlight !== 'unknown' && wallet.balanceLanoshis !== null && wallet.feeRoomUnclampedLanoshis !== null
    ? topUpToFit(wallet.available as PlanUtxo[], wallet.piecesAfterPending, wallet.feeRoomUnclampedLanoshis, wallet.maxInputs)
    : null;
  const cannotReach = !!targetPlan && targetPlan.batches.length === 0 && !targetPlan.reachesTarget && !waiting;
  const offered = plan && !tight && !fits ? plan.batches : [];

  const consolidate = async (batchId: number) => {
    const batch = offered.find(b => b.id === batchId);
    if (!batch || sendingRef.current) return;
    if (keyValid !== true) { toast.error(CONSOLIDATE.batchNeedsKey); return; }
    sendingRef.current = true;
    setWorking(batchId);
    setSendError(null);
    setSendNote(null);
    const readsBefore = readCount;
    try {
      const res = await fetch('/api/wallets/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hexId,
          address,
          privateKey: privateKey.trim(),
          // The pieces by name only — the server prices them from the chain.
          inputs: batch.utxos.map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos })),
        }),
      });
      const data = await res.json();
      if (data.code === 'BROADCAST_UNCERTAIN') {
        // Not a failure and not a success: the server remembers it and holds its pieces back.
        setSendNote({
          txid: String(data.txid || ''), afterRead: readsBefore, message: data.error,
          pieces: batch.utxos.map(u => `${u.tx_hash}:${u.tx_pos}`),
        });
      } else if (!res.ok || !data.success) {
        setSendError(data.error || 'The consolidation did not go through. Nothing was sent.');
      } else {
        toast.success(CONSOLIDATE.sentToast);
      }
      // Safe to read at once: the server holds back the pieces a consolidation
      // on its way has spent, so the batches rebuilt from the answer never
      // offer them again — and a refusal may be about a list that has moved on.
      await read(true);
    } catch {
      setSendError('Network error. It is not known whether this consolidation was sent — this page reads the wallet again before offering anything more.');
      await read(true);
    } finally {
      sendingRef.current = false;
      setWorking(null);
    }
  };

  const removedByPlan = offered.reduce((s, b) => s + b.removes, 0);
  const leftoverTotal = plan ? plan.leftovers.reduce((s, u) => s + u.value, 0) : 0;

  return (
    <div className="rounded-xl border border-border bg-background p-4 space-y-4 text-left">
      <div>
        <p className="text-sm font-semibold text-foreground">{CONSOLIDATE.title}</p>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{CONSOLIDATE.intro}</p>
        {targetMode && !fits && <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{CONSOLIDATE.targetIntro}</p>}
      </div>

      {loading && !wallet ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent inline-block" />
          {CONSOLIDATE.checking}
        </p>
      ) : !wallet ? (
        <div className="text-xs text-red-600 dark:text-red-400 space-y-2">
          <p>{CONSOLIDATE.unreadable}</p>
          <button type="button" onClick={() => void read()} className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-muted">
            {CONSOLIDATE.checkAgain}
          </button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{CONSOLIDATE.piecesLabel}</dt>
            <dd className="text-right font-mono text-foreground">{wallet.utxoCount}</dd>
            <dt className="text-muted-foreground">{CONSOLIDATE.limitLabel}</dt>
            <dd className="text-right font-mono text-foreground">{wallet.maxInputs}</dd>
            {(pendingCount > 0 || removedByPlan > 0) && (
              <>
                <dt className="text-muted-foreground">{CONSOLIDATE.afterLabel}</dt>
                <dd className="text-right font-mono text-foreground">{Math.max(0, wallet.piecesAfterPending - removedByPlan)}</dd>
              </>
            )}
          </dl>

          {fits && (
            <p className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-3 py-2 text-xs text-green-700 dark:text-green-400">
              {CONSOLIDATE.fitsNow}
            </p>
          )}

          {/* On its way — sent from here, confirmed by the network later. */}
          {wallet.pending.map(p => (
            <div key={p.txid} className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 px-3 py-2 text-xs space-y-1">
              <p className="font-semibold text-blue-700 dark:text-blue-300">{CONSOLIDATE.pendingTitle}</p>
              <p className="text-blue-700/90 dark:text-blue-300/90">{fill(CONSOLIDATE.pendingBody, { count: p.inputCount })}</p>
              <a href={`https://chainz.cryptoid.info/lana/tx.dws?${p.txid}`} target="_blank" rel="noopener noreferrer"
                className="font-mono text-blue-700 dark:text-blue-300 hover:underline break-all">
                {p.txid.slice(0, 24)}…
              </a>
            </div>
          ))}

          {sendNote && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
              <p className="font-semibold">{CONSOLIDATE.uncertainTitle}</p>
              <p>{sendNote.message}</p>
            </div>
          )}

          {blockedByOther && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {wallet.inFlight === 'unknown' ? CONSOLIDATE.unreadable : CONSOLIDATE.otherInFlight} {CONSOLIDATE.autoCheck}
            </p>
          )}
          {!blockedByOther && pendingCount > 0 && (
            <p className="text-xs text-muted-foreground">{CONSOLIDATE.autoCheck}</p>
          )}

          {/* An open offer the fees would break: said, with the way out, not offered as a button. */}
          {tight && targetPlan && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs space-y-1">
              <p className="font-semibold text-amber-700 dark:text-amber-400">{CONSOLIDATE.tightTitle}</p>
              {targetPlan.reachesTarget && (
                <p className="text-amber-700/90 dark:text-amber-400/90">
                  {fill(CONSOLIDATE.tightBody, { fee: lana8(targetPlan.totalFee), room: lana8(room ?? 0) })}
                </p>
              )}
              <p className="text-amber-700/90 dark:text-amber-400/90">
                {topUp !== null ? fill(CONSOLIDATE.tightTopUp, { amount: lana8(topUp) }) : CONSOLIDATE.tightCannot}
              </p>
            </div>
          )}
          {cannotReach && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {CONSOLIDATE.tightCannot}
            </p>
          )}

          {/* The key — only if there is something to sign. */}
          {offered.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">{CONSOLIDATE.keyLabel}</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={privateKey}
                  onChange={e => setPrivateKey(e.target.value)}
                  placeholder={CONSOLIDATE.keyPlaceholder}
                  className={`min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 ${
                    keyValid === true ? 'border-green-500 focus:ring-green-500/30'
                      : keyValid === false ? 'border-red-400 focus:ring-red-400/30'
                      : 'border-border focus:ring-primary/30'
                  }`}
                />
                <button type="button" onClick={() => setShowScanner(true)}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted flex-shrink-0">
                  {CONSOLIDATE.scan}
                </button>
              </div>
              {keyValid === false && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{CONSOLIDATE.keyMismatch}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{CONSOLIDATE.keyNote}</p>
              {showScanner && (
                <Suspense fallback={null}>
                  <QrScanner
                    onScan={value => { setPrivateKey(value.trim()); setShowScanner(false); }}
                    onClose={() => setShowScanner(false)}
                  />
                </Suspense>
              )}
            </div>
          )}

          {sendError && (
            <p className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-400">{sendError}</p>
          )}

          {offered.map(b => (
            <div key={`${b.id}:${b.utxos[0]?.tx_hash}`} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {fill(CONSOLIDATE.batchTitle, { n: b.id })}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{fill(CONSOLIDATE.batchPieces, { count: b.utxos.length })}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {CONSOLIDATE.batchFee}: <span className="font-mono">{lana8(b.fee)} LANA</span>
                    {' · '}
                    {CONSOLIDATE.batchKeeps} <span className="font-mono text-green-700 dark:text-green-400">{lanaGrouped(b.net)} LANA</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void consolidate(b.id)}
                  disabled={working !== null || keyValid !== true || blockedByOther}
                  className={`rounded-lg px-4 py-2 text-xs font-semibold text-white flex-shrink-0 ${
                    working !== null || keyValid !== true || blockedByOther
                      ? 'bg-muted-foreground/30 cursor-not-allowed'
                      : 'bg-primary hover:bg-primary/90'
                  }`}
                >
                  {working === b.id ? CONSOLIDATE.batchWorking : CONSOLIDATE.batchButton}
                </button>
              </div>
            </div>
          ))}

          {!targetMode && plan && offered.length === 0 && pendingCount === 0 && !blockedByOther && !fits && plan.leftovers.length === 0 && (
            <p className="text-xs text-muted-foreground">{CONSOLIDATE.nothingToDo}</p>
          )}

          {wallet.confirmingCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {fill(CONSOLIDATE.confirmingPieces, { count: wallet.confirmingCount, pieces: piecesWord(wallet.confirmingCount) })}
            </p>
          )}

          {/* Leftovers, in MejmoSeFajn's mode only (the target plan leaves the rest
              alone on purpose). "Cannot be consolidated" only when no batch at all
              is possible — decided by the plan, not by a total. */}
          {!targetMode && !fits && plan && plan.leftovers.length > 0 && (
            offered.length === 0 && pendingCount === 0 && !blockedByOther ? (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs space-y-1">
                <p className="font-semibold text-amber-700 dark:text-amber-400">
                  {fill(CONSOLIDATE.leftoverTitle, { count: plan.leftovers.length, pieces: piecesWord(plan.leftovers.length) })}
                </p>
                <p className="text-amber-700/90 dark:text-amber-400/90">
                  {fill(CONSOLIDATE.leftoverBody, { amount: lana8(leftoverTotal) })}
                </p>
                {plan.depositToUnstick > 0 && (
                  <p className="text-amber-700/90 dark:text-amber-400/90">{fill(CONSOLIDATE.leftoverDeposit, { amount: lana8(plan.depositToUnstick) })}</p>
                )}
              </div>
            ) : (offered.length > 0 || pendingCount > 0) ? (
              <p className="text-xs text-muted-foreground">
                {fill(CONSOLIDATE.leftoverLater, { count: plan.leftovers.length, pieces: piecesWord(plan.leftovers.length) })}
              </p>
            ) : null
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => void read()} disabled={loading || working !== null}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">
              {loading ? CONSOLIDATE.checking : CONSOLIDATE.checkAgain}
            </button>
            <a href="https://youtu.be/kBi4MKcc4qM?si=bIeWS_dlgHjFproo" target="_blank" rel="noopener noreferrer"
              className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
              {CONSOLIDATE.video}
            </a>
          </div>
          {readFailed && <p className="text-xs text-red-600 dark:text-red-400">{CONSOLIDATE.unreadable}</p>}
        </>
      )}
    </div>
  );
}
