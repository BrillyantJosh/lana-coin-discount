/**
 * "Frozen" marker for the public transparency board.
 *
 * Deliberately says WHICH kind of freeze it is. On live data nobody has an
 * account-level freeze; three people have a single wallet capped
 * (`frozen_max_cap`). Printing "Frozen account" over a capped wallet would be a
 * public accusation the data does not support, so a wallet-level freeze reads
 * "1/9 wallets frozen" instead.
 *
 * `frozen === null` means we have not resolved that person yet — render
 * nothing rather than implying they are clear.
 */
const REASON_LABEL: Record<string, string> = {
  frozen: 'account frozen',
  frozen_l8w: 'Lana8Wonder',
  frozen_max_cap: 'max cap',
  frozen_too_wild: 'too wild',
  frozen_unreg_Lanas: 'unregistered LANA',
};

export interface FreezeInfo {
  frozen: boolean | null;
  freeze_level?: 'account' | 'wallet' | 'none' | null;
  frozen_wallets?: number | null;
  total_wallets?: number | null;
  freeze_reasons?: string[];
}

export function FrozenBadge({ info, className = '' }: { info: FreezeInfo; className?: string }) {
  if (!info?.frozen) return null;

  const account = info.freeze_level === 'account';
  const reasons = (info.freeze_reasons || []).map(r => REASON_LABEL[r] || r).join(', ');
  const label = account
    ? 'Frozen account'
    : `${info.frozen_wallets}/${info.total_wallets} wallets frozen`;

  return (
    <span
      title={
        (account
          ? 'The registrar has frozen this whole account.'
          : 'The registrar has frozen some of this account’s wallets; the account itself is active.') +
        (reasons ? ` Reason: ${reasons}.` : '')
      }
      className={
        `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ` +
        (account
          ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
          : 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400') +
        (className ? ` ${className}` : '')
      }
    >
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <path strokeLinecap="round" d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />
      </svg>
      {label}
    </span>
  );
}
