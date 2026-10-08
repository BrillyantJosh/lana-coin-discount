/**
 * How /financer writes what the server says: LANA to the lanoshi, money as the
 * rest of this site writes it, a refusal's code in the reader's language.
 *
 * Amounts are the brain's legs, whole lanoshis (1,004,492,188 is 10.04492188
 * LANA). They are shown EXACT (payoutView.ts lanoshisText), never rounded to
 * two places: a financer compares them with what their wallet will sign, and
 * a figure rounded on the page that differs from the one signed is a figure
 * nobody can check.
 */
import { fill } from '@/components/MandatePanel';
import { formatFiat } from '@/lib/money';
import { lanoshisText, readLanoshis } from '@/lib/financer/payoutView';
import type { FinancerText } from '@/copy';
import type { Answer } from '@/lib/financer/financerApi';

export { fill };

/** Lanoshis (as the server sends them, or a bigint) as exact LANA: "1,004.492188". "—" when it does not read. */
export function lanaText(value: string | number | bigint | null | undefined): string {
  if (typeof value === 'bigint') return lanoshisText(value);
  const v = readLanoshis(value);
  return v === null ? '—' : lanoshisText(v);
}

const SYMBOLS: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };

/** A batch's amount, written as the dashboard writes a purchase price. */
export function fiatText(amount: number, currency: string): string {
  const code = String(currency || '').toUpperCase();
  return formatFiat(SYMBOLS[code] ?? (code ? `${code} ` : ''), Number(amount) || 0);
}

/** "LKs7QqC2…ZqB": a wallet that fits a row, the whole one in its title. */
export function shortWallet(wallet: string): string {
  return wallet.length > 18 ? `${wallet.slice(0, 8)}…${wallet.slice(-6)}` : wallet;
}

/** A clock time in the reader's language. */
export function timeText(ms: number, lang: 'sl' | 'en'): string {
  return new Date(ms).toLocaleTimeString(lang === 'sl' ? 'sl-SI' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** A day as SQLite writes it (UTC, no zone) or ISO, in the reader's language; "" when it does not read. */
export function dayText(stamp: string | null | undefined, lang: 'sl' | 'en'): string {
  if (!stamp) return '';
  const s = String(stamp).trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'sl' ? 'sl-SI' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A code from a map of codes in the reader's language; one the page does not know is named, never hidden. */
export function codeText(map: Record<string, string>, code: string | null | undefined): string {
  if (code && map[code]) return map[code];
  return fill(map.other ?? '{code}', { code: code || '?' });
}

/**
 * Why a call came back without what it asked for: the signature gate (a clock off, a session without its key), no
 * answer at all, or the server's code from `codes`.
 */
export function refusalText(t: FinancerText, answer: Answer<unknown>, codes: Record<string, string>): string {
  if (answer.status === null) return t.readFailed;
  const r = answer.refusal;
  if (r?.code === 'SIGNATURE_REQUIRED') {
    const reason = String(r.reason || '');
    if (reason === 'STALE' || reason === 'BAD_TIME') return t.signature.STALE;
    if (reason === 'REPLAYED') return t.signature.REPLAYED;
    if (['MISSING', 'MALFORMED', 'BAD_BASE64', 'BAD_EVENT'].includes(reason)) return t.signature.MISSING;
    return t.signature.other;
  }
  if (r?.code === 'DF_UNAVAILABLE') return t.dfUnavailable;
  if (r?.code) return codeText(codes, r.code);
  return t.readFailed;
}
