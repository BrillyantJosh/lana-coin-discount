/**
 * »Moja Lana.Discount denarnica« — the wallet a financer sends from, as
 * Direct.Fund names it and as the LANA Registrar judges it now.
 *
 * Owner, 8 Oct 2026: before every prepare, announce and rebroadcast the wallet
 * is checked strictly at the Registrar — registered, type Lana.Discount, this
 * financer's Nostr key, not frozen — because a send from an unregistered
 * wallet freezes the wallets it pays (`frozen_unreg_Lanas`). The server does
 * that (server/lib/financer/registrarWallet.ts, fail closed); this card says
 * the same verdict before anyone types a key, and why, so a financer whose
 * wallet would be refused learns it here and not at the last step.
 *
 * The wallet is chosen on Direct.Fund (one place of truth there), so the card
 * links there and never edits it. Owner, 9 Oct 2026: ONE PER CURRENCY — a
 * purchase's LANA go from the wallet of its currency — so the page draws one
 * card per currency, titled with it (`currency`); null: the single wallet of a
 * server or Direct.Fund from before wallets per currency.
 */
import type { FinancerText } from '@/copy';
import type { SendableAnswer, WalletCheck } from '@/lib/financer/financerApi';
import { DIRECT_FUND_URL } from '@/lib/financer/financerApi';
import { readLanoshis } from '@/lib/financer/payoutView';
import { codeText, fill, lanaText } from './financerText';

export function FinancerWalletCard(props: {
  t: FinancerText;
  /** The currency this wallet sends; null: the one wallet of a page from before wallets per currency. */
  currency: string | null;
  walletId: string | null;
  walletCheck: WalletCheck;
  balance: SendableAnswer['balance'] | undefined;
}) {
  const { t, currency, balance } = props;
  const wallet = props.walletId;
  const check = props.walletCheck;
  const unconfirmed = balance ? readLanoshis(balance.unconfirmed.replace(/^-/, '')) : null;
  const moving = balance && balance.unconfirmed !== '0' && unconfirmed !== null;

  return (
    <section data-testid="financer-wallet" data-currency={currency ?? undefined} className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
      <h2 className="text-lg font-bold text-foreground">{currency ? fill(t.walletTitleCurrency, { currency }) : t.walletTitle}</h2>
      {!wallet ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{currency ? fill(t.walletNoneCurrency, { currency }) : t.walletNone}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{currency ? fill(t.walletNoneHintCurrency, { currency }) : t.walletNoneHint}</p>
          <a
            href={DIRECT_FUND_URL}
            rel="noopener"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {t.walletChoose}
          </a>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="font-mono text-sm break-all text-foreground" data-testid="financer-wallet-id">{wallet}</p>
          {check.ok ? (
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400" role="status">✓ {t.walletOk}</p>
          ) : (
            <div className="rounded-lg border border-red-300/60 bg-red-50/60 dark:bg-red-500/10 p-3 space-y-1" role="alert">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                {fill(codeText(t.walletReasons as Record<string, string>, check.reason || 'REGISTRAR_UNKNOWN'), { type: check.walletType || '?' })}
              </p>
              {check.freezeReason && <p className="text-xs text-red-700/80 dark:text-red-400/80">{fill(t.freezeReason, { reason: check.freezeReason })}</p>}
              {(check.reason === 'WRONG_WALLET_TYPE' || check.reason === 'NO_WALLET') && (
                <a href={DIRECT_FUND_URL} rel="noopener" className="inline-block text-sm font-semibold text-primary hover:underline">
                  {t.walletChoose}
                </a>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.balanceLabel}</span>
            {balance ? (
              <span className="text-xl font-bold tabular-nums text-foreground" data-testid="financer-balance">
                {lanaText(balance.confirmed)} <span className="text-xs font-medium text-muted-foreground">LANA</span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">{t.balanceUnknown}</span>
            )}
          </div>
          {moving && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {fill(t.unconfirmedNote, { amount: `${balance.unconfirmed.startsWith('-') ? '−' : '+'}${lanaText(unconfirmed)}` })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
