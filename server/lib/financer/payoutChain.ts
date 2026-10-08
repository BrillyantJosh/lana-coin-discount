/**
 * The firm's payout wallet on the LANA chain, read and written by THIS server
 * through the Electrum servers the newest verified KIND 38888 lists — never a
 * server a request names, none written here (electrum.ts electrumServersOf).
 *
 * Brilly (6. 10. 2026): "The admin can pay them according to the balance of
 * that wallet. At the end the admin enters the private key before paying and
 * the transaction happens." The browser cannot reach Electrum (plain TCP on
 * 5097, no TLS: measured 6. 10. 2026), so this server reads the wallet for the
 * page and, once the admin's browser has built and signed the payout, sends it
 * to the network itself. Three things, each typed, none ever guessed:
 *
 *   state(address) — one server's word on the wallet: its balance
 *     (`blockchain.address.get_balance`, confirmed and unconfirmed lanoshis;
 *     unconfirmed is negative while a payment out waits in the mempool), its
 *     coins (`blockchain.address.listunspent`: {tx_hash, tx_pos, value, height},
 *     height 0 or below while unconfirmed — and these servers keep listing a
 *     coin an unconfirmed transaction already spends, the Lana8Wonder double
 *     cash-out of 12. 9. 2026) and its history (`get_history`: every
 *     transaction that pays or spends it). An answer that does not read in
 *     full is no answer; the next server is asked. Null: no server answered.
 *
 *   rawTxs(txids) — the raw transactions, each re-hashed here to its id: a
 *     server that answers other bytes is caught, never believed (a legacy
 *     signature does not cover the value of a coin it spends, so a lying server
 *     could otherwise turn a difference into fee). What one server lacks is
 *     asked of the next.
 *
 *   broadcast(rawTx, txid) — `blockchain.transaction.broadcast`, sent to
 *     EVERY listed server at once, each with its own timeout of
 *     BROADCAST_TIMEOUT_MS (45 s): lana.discount once cut off a slow reply after
 *     8 s while the network had taken the transaction (13. 9. 2026), and this
 *     site's read timeouts are 2.5–3 s. At once, because a server whose node is
 *     down keeps answering reads from its own index while its broadcast hangs:
 *     tried one after the other, such a first server would keep the bytes from
 *     the healthy second one at every send (review of 6. 10. 2026). Only a
 *     `result` that is exactly the 64-hex id computed here counts as sent. These
 *     servers put a refusal into `result` as a Python repr — "{u'message':
 *     u'TX rejected', u'code': -22}" — and PLAN15 once took such a text for an
 *     id and recorded LANA as delivered that never moved (28. 7. 2026, twice);
 *     so anything else is read only together with what the servers hold
 *     afterwards (holders): a server that holds it — in its mempool or in a
 *     block (it says so in words, never with the id) — makes it "known", as good
 *     as sent. A refusal is FINAL only when every listed server refused it in
 *     words and then every one of them said it does not know it (−5 on
 *     transaction.get), as chainPayment.ts's not_found: a server that was silent
 *     or could not be read may have taken it, and its node may still be sending
 *     it on — so the caller keeps it. No answer at all is "unknown": it may have
 *     gone through, and the caller keeps it. The −5 of these servers means two
 *     things ("no information about transaction" on transaction.get, "already in
 *     block" on broadcast), so a broadcast reply is never read by its code.
 *
 * Measured 6. 10. 2026 on electrum1/2.lanacoin.com: protocol "0.9", one
 * JSON-RPC object per line, answers out of order, errors as strings. Amounts
 * are lanoshis as BigInt, never a float.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's server/lib/payoutChain.ts
 * (origin/main a46f618), only its import paths changed. The "payout wallet" is
 * the financer's Lana.Discount wallet — and the treasury's, once its auto-send
 * records a transaction before sending it — and `servers` is
 * electrumServersFrom(getElectrumServersFromDb()) (electrumSession.ts).
 */
import type { ElectrumConnect, ElectrumReply, ElectrumServer, LanoshiBalance } from './electrumSession.ts';
import { electrumSession, readBalanceReply } from './electrumSession.ts';
import { isTxUnknownError } from './chainPayment.ts';
import { txidOfRaw } from '../../shared/lana-tx/codec.ts';

export const GET_BALANCE = 'blockchain.address.get_balance';
export const LIST_UNSPENT = 'blockchain.address.listunspent';
export const GET_HISTORY = 'blockchain.address.get_history';
export const GET_TRANSACTION = 'blockchain.transaction.get';
export const BROADCAST = 'blockchain.transaction.broadcast';

/** One server's time to read a wallet, connecting included. */
export const STATE_TIMEOUT_MS = 6000;
/** One server's time to send the raw transactions asked for. */
export const RAW_TIMEOUT_MS = 8000;
/** A broadcast's own wait, each server's: a slow "yes" is still a yes (lana.discount, 13. 9. 2026). */
export const BROADCAST_TIMEOUT_MS = 45_000;
/** One server's time to say whether it holds a transaction. */
const HOLDER_TIMEOUT_MS = 5000;
/** The raw transactions asked of one server in one connection, at most. */
const MAX_RAW_PER_SESSION = 60;
/** A raw transaction hex longer than this is no payout's coin: 500,000 bytes is the node's own limit. */
const MAX_RAW_HEX = 1_000_000;

const TXID = /^[0-9a-f]{64}$/;
const safeInt = (v: unknown, min = Number.MIN_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const hasError = (reply: ElectrumReply | undefined) => !reply || (reply.error !== undefined && reply.error !== null);

/** One coin of the wallet as listunspent lists it — its value a claim until its transaction is re-hashed (select.ts). */
export interface ListedOutput {
  txid: string;
  vout: number;
  value: bigint;
  /** ≤ 0: not confirmed yet. */
  height: number;
}

export interface WalletState {
  /** Which server said it ("host:port"). */
  server: string;
  balance: LanoshiBalance;
  /** Every coin listed, in the server's order. */
  unspent: ListedOutput[];
  /** Every transaction that pays or spends the wallet: its id → its height (0 or below: in the mempool). */
  history: Map<string, number>;
}

export type BroadcastOutcome =
  /** The server answered with exactly this transaction's id. */
  | { kind: 'accepted'; server: string }
  /** A server refused it in words, but a server holds it (in its mempool or in a block): as good as sent. */
  | { kind: 'known'; server: string; detail: string }
  /**
   * Refused in words, and no server holds it. `final`: every listed server refused it and every one then said it does
   * not know it — it did not go. Not final: a server was silent or could not be read — it may still have gone. `detail`
   * is a server's own text, cut short.
   */
  | { kind: 'refused'; detail: string; final: boolean }
  /** No answer that can be read: it may have gone through — keep it, send the same bytes again later. */
  | { kind: 'unknown'; detail: string };

export interface PayoutChain {
  state(address: string): Promise<WalletState | null>;
  rawTxs(txids: readonly string[]): Promise<Map<string, string>>;
  broadcast(rawTx: string, txid: string): Promise<BroadcastOutcome>;
}

export interface PayoutChainOptions {
  /** The servers, read at each question (the newest verified KIND 38888); none — nothing is asked. */
  servers: () => ElectrumServer[];
  stateTimeoutMs?: number;
  rawTimeoutMs?: number;
  broadcastTimeoutMs?: number;
  connect?: ElectrumConnect;
}

/** A server's own words, one line, no control characters, cut short: kept and shown, never a key or anything personal. */
export function replyText(reply: ElectrumReply | undefined): string {
  if (!reply) return 'no answer';
  const value = reply.error !== undefined && reply.error !== null ? reply.error : reply.result;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || 'empty answer';
}

/** A listunspent entry as a coin, or null when any part does not read. */
function listedOutputOf(raw: unknown): ListedOutput | null {
  const e = raw as { tx_hash?: unknown; tx_pos?: unknown; value?: unknown; height?: unknown } | null;
  if (!e || typeof e !== 'object') return null;
  const txid = typeof e.tx_hash === 'string' ? e.tx_hash.toLowerCase() : '';
  if (!TXID.test(txid) || !safeInt(e.tx_pos, 0) || !safeInt(e.value, 0) || !safeInt(e.height)) return null;
  return { txid, vout: e.tx_pos, value: BigInt(e.value), height: e.height };
}

export function createPayoutChain(options: PayoutChainOptions): PayoutChain {
  const stateTimeoutMs = options.stateTimeoutMs ?? STATE_TIMEOUT_MS;
  const rawTimeoutMs = options.rawTimeoutMs ?? RAW_TIMEOUT_MS;
  const broadcastTimeoutMs = options.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS;
  const nameOf = (s: ElectrumServer) => `${s.host}:${s.port}`;
  const servers = (): ElectrumServer[] => {
    try {
      return options.servers();
    } catch {
      return [];
    }
  };

  const stateFrom = async (server: ElectrumServer, address: string): Promise<WalletState | null> => {
    const replies = await electrumSession(
      server,
      [
        { id: 1, method: GET_BALANCE, params: [address] },
        { id: 2, method: LIST_UNSPENT, params: [address] },
        { id: 3, method: GET_HISTORY, params: [address] },
      ],
      stateTimeoutMs,
      options.connect,
    );
    const balance = readBalanceReply(replies.get(1));
    const listed = replies.get(2);
    const history = replies.get(3);
    if (!balance || hasError(listed) || hasError(history) || !Array.isArray(listed!.result) || !Array.isArray(history!.result)) return null;
    const unspent: ListedOutput[] = [];
    for (const raw of listed!.result as unknown[]) {
      const coin = listedOutputOf(raw);
      if (!coin) return null;
      unspent.push(coin);
    }
    const seen = new Map<string, number>();
    for (const raw of history!.result as unknown[]) {
      const h = raw as { tx_hash?: unknown; height?: unknown } | null;
      const txid = typeof h?.tx_hash === 'string' ? h.tx_hash.toLowerCase() : '';
      if (!TXID.test(txid) || !safeInt(h?.height)) return null;
      seen.set(txid, h!.height as number);
    }
    return { server: nameOf(server), balance, unspent, history: seen };
  };

  /**
   * Who holds this transaction now (its bytes hashing to the id): one server that does; or every listed server said
   * it does not know it (−5, its words read as chainPayment.ts reads them); or neither — a server was silent, closed,
   * or answered something else: nobody can say it did not go.
   */
  const holders = async (txid: string): Promise<{ kind: 'held'; server: string } | { kind: 'unknown_everywhere' } | { kind: 'unreadable' }> => {
    const list = servers();
    let unknown = 0;
    for (const server of list) {
      try {
        const replies = await electrumSession(server, [{ id: 1, method: GET_TRANSACTION, params: [txid] }], Math.min(rawTimeoutMs, HOLDER_TIMEOUT_MS), options.connect);
        const reply = replies.get(1);
        if (!reply) continue;
        if (hasError(reply)) {
          if (isTxUnknownError(reply.error)) unknown++;
          continue;
        }
        if (typeof reply.result === 'string' && reply.result.length <= MAX_RAW_HEX && txidOfRaw(reply.result.toLowerCase()) === txid) return { kind: 'held', server: nameOf(server) };
      } catch {
        // Not readable from this one: it cannot say it does not hold it.
      }
    }
    return list.length > 0 && unknown === list.length ? { kind: 'unknown_everywhere' } : { kind: 'unreadable' };
  };

  /** One server's reply to the broadcast; undefined — none (silent, closed, refused the connection). */
  const sendTo = async (server: ElectrumServer, rawTx: string): Promise<ElectrumReply | undefined> => {
    try {
      return (await electrumSession(server, [{ id: 1, method: BROADCAST, params: [rawTx] }], broadcastTimeoutMs, options.connect)).get(1);
    } catch {
      return undefined;
    }
  };

  return {
    async state(address) {
      for (const server of servers()) {
        try {
          const state = await stateFrom(server, address);
          if (state) return state;
        } catch {
          // The next server is asked.
        }
      }
      return null;
    },

    async rawTxs(txidsIn) {
      const wanted = [...new Set(txidsIn.map((t) => String(t).toLowerCase()).filter((t) => TXID.test(t)))];
      const found = new Map<string, string>();
      for (const server of servers()) {
        const missing = wanted.filter((t) => !found.has(t));
        if (missing.length === 0) break;
        for (let at = 0; at < missing.length; at += MAX_RAW_PER_SESSION) {
          const part = missing.slice(at, at + MAX_RAW_PER_SESSION);
          let replies: Map<number, ElectrumReply>;
          try {
            replies = await electrumSession(
              server,
              part.map((txid, i) => ({ id: i + 1, method: GET_TRANSACTION, params: [txid] })),
              rawTimeoutMs,
              options.connect,
            );
          } catch {
            break;
          }
          part.forEach((txid, i) => {
            const reply = replies.get(i + 1);
            if (hasError(reply) || typeof reply!.result !== 'string') return;
            const raw = reply!.result.toLowerCase();
            if (raw.length > MAX_RAW_HEX || !/^(?:[0-9a-f]{2})+$/.test(raw)) return;
            try {
              // Only the bytes of exactly this transaction count.
              if (txidOfRaw(raw) === txid) found.set(txid, raw);
            } catch {
              // Not a transaction: not believed.
            }
          });
        }
      }
      return found;
    },

    async broadcast(rawTx, txid) {
      const list = servers();
      if (list.length === 0) return { kind: 'unknown', detail: 'no Electrum server is listed' };
      const isOurs = (reply: ElectrumReply | undefined) =>
        !!reply && (reply.error === undefined || reply.error === null) && typeof reply.result === 'string' && reply.result.trim().toLowerCase() === txid;
      // Every server at once: the first that answers with exactly our id settles it; otherwise every one is waited for.
      const replies = await new Promise<{ replies: (ElectrumReply | undefined)[]; accepted: number }>((resolve) => {
        const out: (ElectrumReply | undefined)[] = new Array(list.length).fill(undefined);
        let left = list.length;
        let settled = false;
        list.forEach((server, i) => {
          void sendTo(server, rawTx).then((reply) => {
            out[i] = reply;
            left--;
            if (settled) return;
            if (isOurs(reply)) {
              settled = true;
              resolve({ replies: out, accepted: i });
            } else if (left === 0) {
              settled = true;
              resolve({ replies: out, accepted: -1 });
            }
          });
        });
      });
      if (replies.accepted >= 0) return { kind: 'accepted', server: nameOf(list[replies.accepted]) };
      // Refusals in words — never another 64-hex id: that is no refusal anyone can read, it may still have gone.
      let refusal: string | null = null;
      let silent: string | null = null;
      let everyRefused = true;
      list.forEach((server, i) => {
        const reply = replies.replies[i];
        const said = reply && typeof reply.result === 'string' ? reply.result.trim().toLowerCase() : null;
        if (!reply) {
          everyRefused = false;
          silent ??= `${nameOf(server)} gave no answer`;
        } else if ((reply.error === undefined || reply.error === null) && said !== null && TXID.test(said)) {
          everyRefused = false;
          silent ??= `${nameOf(server)} answered another id`;
        } else refusal ??= replyText(reply);
      });
      const held = await holders(txid);
      if (held.kind === 'held') return { kind: 'known', server: held.server, detail: refusal ?? silent ?? 'no answer' };
      if (refusal === null) return { kind: 'unknown', detail: silent ?? 'no answer' };
      return { kind: 'refused', detail: refusal, final: everyRefused && held.kind === 'unknown_everywhere' };
    },
  };
}
