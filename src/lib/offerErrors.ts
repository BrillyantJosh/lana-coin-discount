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

/**
 * The `decisionReason` on an offer, in the counterparty's words.
 *
 * Two kinds of thing land in that column. Most are sentences a person wrote —
 * an admin's decline, a void reason — and those are shown as written. Some are
 * CODES the server writes at an ending: TRANSFER_NOT_COMPLETED from the
 * sweeper, REFERENCE_MOVED when the reference moved under a standing offer.
 * Until 10 Sep 2026 a seller was shown the literal token TRANSFER_NOT_COMPLETED
 * as the explanation for their own lapsed offer, because nothing had ever
 * translated it — and the REFERENCE_MOVED path wrote a sentence naming two
 * reference rates, which is a rate history on a counterparty's own record.
 *
 * So the code stays in the column, where an audit reads it, and the sentence
 * lives in copy.ts, where the vocabulary test can see it.
 */
export function describeDecisionReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return OFFER_ERRORS[reason] || reason;
}
