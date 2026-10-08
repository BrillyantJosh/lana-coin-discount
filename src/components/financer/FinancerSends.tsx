/**
 * »Na poti in poslano« — a financer's sends, newest first, each with a link to
 * the transaction on the LANA block explorer.
 *
 * A send is recorded BEFORE it is broadcast (server/lib/financer/sends.ts), and
 * its purchases count as sent only once it is in a block — proved by two
 * Electrum servers — never when a server merely said "yes". So the states a
 * financer sees are the machine's own: recorded and going out, in the network
 * waiting for a block, confirmed (in which block), or released — refused by
 * the network, or a coin it spent went elsewhere — with its purchases free to
 * be sent again. A send unconfirmed for a day whose coins are unspent is never
 * released without proof and never sent twice: it is flagged for the
 * administrator, and this list says so. One held because the Registrar refused
 * the wallet before a rebroadcast says that too.
 *
 * The link is to the transaction ON THE CHAIN (`chainTxid`): a send can be
 * mined as a copy of itself — the same payment, a signature re-encoded by a
 * relay, another id — and the explorer knows only the copy's id then. The id
 * the financer signed is said beside it.
 */
import type { FinancerText } from '@/copy';
import type { SendView } from '@/lib/financer/financerApi';
import { txUrl } from '@/lib/financer/financerApi';
import { codeText, dayText, fill, lanaText } from './financerText';

const STATE_TONE: Record<SendView['state'], string> = {
  announced: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  mempool: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  confirmed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  released: 'bg-muted text-muted-foreground',
};

export function FinancerSends(props: { t: FinancerText; lang: 'sl' | 'en'; sends: SendView[] }) {
  const { t, lang, sends } = props;
  return (
    <section data-testid="financer-sends" className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
      <h2 className="text-lg font-bold text-foreground">{t.sendsTitle}</h2>
      {sends.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t.sendsNone}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {sends.map((s) => {
            const held = s.state !== 'confirmed' && s.state !== 'released' && String(s.lastOutcome || '').startsWith('held:');
            const onChain = s.chainTxid || s.txid;
            return (
              <li key={s.txid} data-testid={`financer-send-${s.txid}`} className="rounded-xl border border-border bg-background/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATE_TONE[s.state] ?? 'bg-muted text-muted-foreground'}`}>
                    {t.sendState[s.state] ?? s.state}
                    {s.state === 'confirmed' && s.blockHeight ? ` ${fill(t.confirmedIn, { height: s.blockHeight })}` : ''}
                  </span>
                  <span className="text-xs text-muted-foreground">{dayText(s.createdAt, lang)}</span>
                </div>
                <a
                  href={txUrl(onChain)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t.viewTx}
                  className="mt-2 block font-mono text-xs text-primary hover:underline break-all"
                >
                  {onChain}
                </a>
                {onChain !== s.txid && <p className="mt-1 text-xs text-muted-foreground break-all">{fill(t.copyNote, { txid: s.txid })}</p>}
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {fill(t.sendFigures, { amount: lanaText(s.payingLanoshis), fee: lanaText(s.feeLanoshis), count: s.transactionRefs.length })}
                </p>
                {s.state === 'released' && s.releaseReason && (
                  <p className="mt-1 text-xs text-muted-foreground">{codeText(t.releaseReason as Record<string, string>, s.releaseReason)}</p>
                )}
                {held && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t.held}</p>}
                {s.stuck && <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400" role="alert">{t.stuck}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
