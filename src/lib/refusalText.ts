/**
 * The sentence an admin page shows when a call comes back refused.
 *
 * Since 2 Oct 2026 every admin call is signed (nip98Fetch.ts), and a refusal by
 * the signature gate carries code SIGNATURE_REQUIRED plus a reason. A stale
 * device clock and a session without its key need different fixes, so that
 * reason is explained; any other refusal shows the server's own error text.
 */
import { explainSignatureFailure } from './nip98Fetch';

export function refusalText(data: { error?: string; code?: string; reason?: string } | null | undefined, fallback: string): string {
  if (data?.code === 'SIGNATURE_REQUIRED') return explainSignatureFailure(data.reason);
  return data?.error || fallback;
}
