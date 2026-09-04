import { OFFER_ERRORS } from '@/copy';
import { fill, fmtUtc } from '@/components/MandatePanel';

/**
 * A refusal from the acquisitions API, in the counterparty's words. The
 * server's `code` picks the sentence; `detail` refines a signature refusal;
 * an unknown code falls back to the server's own `error` text.
 */
export function describeOfferError(
  data: { error?: string; code?: string; detail?: string; opensAt?: string | null } | null | undefined,
  extra: { round?: number | null; opensAt?: string | null } = {},
): string {
  const code = data?.code || '';
  if (code === 'SIGNATURE_REQUIRED' && data?.detail === 'STALE') return OFFER_ERRORS.SIGNATURE_STALE;
  if (code === 'MANDATE_NOT_OPEN') {
    return fill(OFFER_ERRORS.MANDATE_NOT_OPEN, {
      round: extra.round ?? '—',
      date: fmtUtc(extra.opensAt ?? data?.opensAt ?? null),
    });
  }
  return OFFER_ERRORS[code] || data?.error || 'This proposal could not be submitted right now.';
}
