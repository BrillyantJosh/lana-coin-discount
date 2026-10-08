/**
 * What /api/heartbeat-status (server/index.ts) says about the financers' side:
 * the calls owed to the brain and the signed sends. Kept here, apart from the
 * route, so a test can pin every field the admin page reads.
 *
 * /api/heartbeat-status needs no login, so it carries COUNTS only (recheck of
 * 9. 10. 2026, M4) — and the txids of stuck sends, public on the chain anyway.
 * Which calls and which purchases they are (batch and purchase references) is
 * the administrator's: GET /api/admin/brain-callbacks, signed (financerAdminLists).
 *
 *   brainCallbacksOpen / brainCallbacksGaveUp — still owed; given up after 7
 *     days without a 2xx (the admin's »Re-send to brain« takes a key: gaveUpKeys).
 *   brainCallbacksWaitingOver7d — fiat-received the brain TOOK, still not
 *     approved after 7 days. Never given up (posted hourly), so without this
 *     nobody would ever see them (review N8): a merchant payout very late, a
 *     purchase the brain never released a leg of, one cancelled before any
 *     leg came (waitingOver7dKeys).
 *   lanaSendsInFlight / lanaSendsStuck (+ Txids) — signed sends not in a block
 *     yet, and those unconfirmed for a day.
 *   ownerMismatchPurchases — a financer's purchase whose investor leg the brain
 *     has since moved to another investor: nothing sends it, and only a person
 *     can sort it out (review N5; ownerMismatchRefs). Read defensively: absent
 *     from sendsHealth, it is 0 and [].
 */
import type { OutboxHealth } from './brainOutbox.js';

/** sendsHealth (lib/financer/sends.ts) as this reads it; the owner-mismatch fields may be missing. */
export interface SendsHealthLike {
  inFlight: number;
  stuck: number;
  stuckTxids: string[];
  ownerMismatchPurchases?: unknown;
  ownerMismatchRefs?: unknown;
}

/** On the public /api/heartbeat-status: counts, and txids that are on the chain anyway. */
export interface FinancerHeartbeatFields {
  brainCallbacksOpen: number;
  brainCallbacksGaveUp: number;
  brainCallbacksWaitingOver7d: number;
  lanaSendsInFlight: number;
  lanaSendsStuck: number;
  lanaSendsStuckTxids: string[];
  ownerMismatchPurchases: number;
}

/** On the signed GET /api/admin/brain-callbacks only: which calls and purchases those counts are. */
export interface FinancerAdminLists {
  gaveUpKeys: string[];
  waitingOver7dKeys: string[];
  ownerMismatchRefs: string[];
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export function financerHeartbeatFields(callbacks: OutboxHealth, sends: SendsHealthLike): FinancerHeartbeatFields {
  return {
    brainCallbacksOpen: callbacks.open,
    brainCallbacksGaveUp: callbacks.gaveUp,
    brainCallbacksWaitingOver7d: count(callbacks.waitingOver7d),
    lanaSendsInFlight: sends.inFlight,
    lanaSendsStuck: sends.stuck,
    lanaSendsStuckTxids: sends.stuckTxids,
    ownerMismatchPurchases: count(sends.ownerMismatchPurchases),
  };
}

export function financerAdminLists(callbacks: OutboxHealth, sends: SendsHealthLike): FinancerAdminLists {
  return {
    gaveUpKeys: strings(callbacks.gaveUpKeys),
    waitingOver7dKeys: strings(callbacks.waitingOver7dKeys),
    ownerMismatchRefs: strings(sends.ownerMismatchRefs),
  };
}
