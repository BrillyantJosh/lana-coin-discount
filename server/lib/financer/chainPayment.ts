/**
 * What one LANA transaction pays one wallet, read on this server from the
 * Electrum servers the newest verified KIND 38888 lists — the check behind
 * every payout an admin records (KIND 87070 lana_delivered).
 *
 * Brilly (6. 10. 2026): "make a new extra interface where those paid orders
 * move to payout — we transfer them the LANA — showing how much LANA they must
 * get and how much they already got." The admin pays from the firm's own
 * wallet outside this site and enters the transaction id; the specification
 * (KIND 87070 1.1.0 chain_verification) wants the dealer's site to read the
 * transaction on the chain BEFORE it signs the record. This is that read.
 *
 * HOW IT IS READ (measured against electrum1/2.lanacoin.com on 6. 10. 2026,
 * protocol "0.9", one JSON-RPC object per line; electrum.ts holds the session):
 *   1. one connection asks three things at once: the chain's tip
 *      (`blockchain.headers.subscribe`, its `block_height`), the wallet's history
 *      (`blockchain.address.get_history` — a list of {tx_hash, height}, NOT
 *      sorted, height 0 or −1 while in the mempool) and the raw transaction
 *      (`blockchain.transaction.get` — always the raw hex: the "verbose" flag is
 *      ignored there);
 *   2. the bytes are read here (lanaTx.ts) and must hash to the id asked for —
 *      a server that answers another transaction is caught, never believed;
 *   3. what the transaction pays the wallet is summed from its exact P2PKH
 *      outputs to the wallet's key hash, and its pay-to-public-key outputs of a
 *      key with that hash (lanoshisPaidToKey); nothing paid is a definite answer;
 *   4. the wallet's history must hold the transaction in a block (height > 0);
 *   5. a second connection to the SAME server asks that block's header and the
 *      transaction's merkle branch, and the branch must reach the header's
 *      merkle_root;
 *   6. ANOTHER server of KIND 38888, on another machine, must hold the same
 *      block: its header at that height has the same merkle_root. One server's header, branch and
 *      tip could all be made up together (a header whose merkle_root is the
 *      transaction's own id, with an empty branch, "proves" any transaction
 *      it likes — over plain TCP anyone on the way could answer so), so one
 *      server's word never confirms a payout; with no other server holding
 *      that block it is "unknown" — try again.
 * The transaction's bytes and what it pays cannot be made up (they hash to the
 * id asked); that it is in a block rests on two servers agreeing.
 * Confirmations = the lower of the two servers' tips − height + 1 (at least 1).
 *
 * FAIL CLOSED. Every server is asked in KIND 38888's order until one proves the
 * answer (and, for "confirmed", another holds its block). An error is a string on these servers (often a Python repr): the
 * "No information available about transaction" error (code −5) means that
 * server does not know it; "not_found" only when EVERY server said so. A
 * server that is silent, closes, or answers anything that does not check is
 * "unknown" — never "not paid": the admin is told to try again. These servers
 * do not check an address's checksum and answer a mistyped one with another
 * wallet's partial history, so the wallet must read in full
 * (lanaAddress.ts lanaAddressHash160) before anything is asked, and a
 * transaction missing from a history is "unconfirmed", never "not paid".
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's server/lib/chainPayment.ts
 * (origin/main a46f618), only its import paths changed. Here it is the proof
 * that a send recorded before it was broadcast is in a block — asked for one
 * of the wallets it pays — before its legs are marked sent; `servers` is
 * electrumServersFrom(getElectrumServersFromDb()) (electrumSession.ts).
 *
 * Changes after the review of 8. 10. 2026:
 *   - "another server" is another MACHINE: electrum1 and electrum3.lanacoin.com
 *     resolved to one address (193.164.140.162) that day, so two names of one
 *     node agreed with each other and one node's word confirmed a send. The
 *     machine is the address the session's socket ACTUALLY connected to — the
 *     proof's two sessions on one side, the vouching session on the other —
 *     never a name, never a port (an alias on another port of one node is that
 *     node), and never a lookup of its own (recheck of 9. 10. 2026: a separate
 *     DNS lookup that failed or timed out let a name stand for itself, and
 *     electrum3 then vouched for electrum1). A server that does not connect
 *     vouches for nothing. Not caught: one node reached at two addresses (an
 *     IPv4 and an IPv6 one, or two of either) counts as two — none of the KIND
 *     38888 servers has more than one (A records only, 9. 10. 2026);
 *   - what a transaction pays a wallet counts its pay-to-public-key outputs of
 *     the wallet's key as well (recheck of 9. 10. 2026): a coinstake of the LANA
 *     desktop wallet pays an empty first output and then <public key>
 *     OP_CHECKSIG, which the servers list under that key's address. Read only
 *     with P2PKH, a coinstake that spent a coin of a send "paid nothing", so it
 *     could never be proven in a block — and the send it killed was never
 *     released (sends.ts provenInBlock);
 *   - an "unknown" says `notFoundByAllReachable` when every server that
 *     answered said −5 and the rest were silent: no server holds the bytes.
 *     Never when one answered anything else — its bytes, an error, a branch
 *     that does not check. The send round (sends.ts) may then look for proof
 *     that a coin of the send went in ANOTHER transaction; that proof, not
 *     this flag, is what releases anything.
 */
import net from 'node:net';
import type { ElectrumConnect, ElectrumReply, ElectrumRequest, ElectrumServer } from './electrumSession.ts';
import { electrumSession } from './electrumSession.ts';
import { lanaAddressHash160 } from './lanaAddress.ts';
import { lanoshisPaidTo, merkleRootOf, parseLanaTx, txidOfRaw, TXID, type LanaTx } from './lanaTx.ts';
import { decodeTx, parseP2pkhScriptSig } from '../../shared/lana-tx/codec.ts';
import { addressOfPublicKey, hash160ToAddress, p2pkHash160 } from '../../shared/lana-tx/address.ts';
import { prevoutFromRawTx } from '../../shared/lana-tx/shape.ts';

export const GET_TIP = 'blockchain.headers.subscribe';
export const GET_HISTORY = 'blockchain.address.get_history';
export const GET_TRANSACTION = 'blockchain.transaction.get';
export const GET_HEADER = 'blockchain.block.get_header';
export const GET_MERKLE = 'blockchain.transaction.get_merkle';
/** One server's time for one question round, connecting included. */
export const CHAIN_TIMEOUT_MS = 3000;

export type PaymentRead =
  /**
   * In a block on the chain — its merkle branch reaches that block's root, and two servers hold the block: what it pays
   * the wallet (> 0). `inputs`: the address each input spends from — a P2PKH input read from its own signature
   * script (it names the key that signed it: in a block, the very key of the coin it spends), a pay-to-public-key
   * input (a staking reward of the LANA desktop wallet) from the coin it spends, read from its own previous
   * transaction (spentCoinAddresses); "" for any other input, or one whose coin could not be read. Absent from a
   * reader that does not say (a test's).
   */
  | { state: 'confirmed'; lanoshis: bigint; height: number; confirmations: number; nTime: number; blockTime: number; inputs?: string[] }
  /** The transaction exists and pays the wallet nothing (definite: read from its own bytes). */
  | { state: 'pays_nothing'; nTime: number }
  /** It pays the wallet, but no server shows it in a block yet. */
  | { state: 'unconfirmed'; lanoshis: bigint; nTime: number; inputs?: string[] }
  /** Every server said it does not know this transaction. */
  | { state: 'not_found' }
  /**
   * No server gave an answer that checks: try again. `notFoundByAllReachable`: at least one server said −5, every
   * other one was silent (no answer to transaction.get) — none answered its bytes or anything else.
   */
  | { state: 'unknown'; notFoundByAllReachable?: true };

export interface PaymentReader {
  /** What `txid` (64 hex) pays `wallet` (a LANA address that reads in full). Never rejects. */
  read(txid: string, wallet: string): Promise<PaymentRead>;
}

export interface PaymentReaderOptions {
  /** The servers, read at each question (the newest verified KIND 38888); none — nothing is asked, "unknown". */
  servers: () => ElectrumServer[];
  timeoutMs?: number;
  connect?: ElectrumConnect;
  /**
   * The machine a session reached, from the address its socket connected to (machineOfAddress). Default: that address
   * alone — never the server's name or port. Tests only, whose fake servers all listen on 127.0.0.1: one per port.
   */
  machineOf?: (remoteAddress: string, server: ElectrumServer) => string;
}

/** The address a socket connected to, as one machine: lower case, an IPv4-mapped IPv6 address as the IPv4 one. */
export const machineOfAddress = (remoteAddress: string): string => remoteAddress.trim().toLowerCase().replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/, '');

const plainConnect: ElectrumConnect = (server) => net.createConnection({ host: server.host, port: server.port });

/**
 * What a transaction pays one key hash, in lanoshis: its exact P2PKH outputs to it (lanaTx.ts lanoshisPaidTo) and its
 * pay-to-public-key outputs of a key — compressed or not — whose hash160 it is (a coinstake's or a staking reward's:
 * the servers list them under that address, and only that key spends them). Any other script never counts.
 */
export function lanoshisPaidToKey(tx: LanaTx, hash160Hex: string): bigint {
  const h160 = hash160Hex.toLowerCase();
  return lanoshisPaidTo(tx, h160) + tx.outputs.reduce((sum, out) => (p2pkHash160(out.script) === h160 ? sum + out.lanoshis : sum), 0n);
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
/** The −5 of these servers, in plain or Python-repr form: this server does not know the transaction. */
export const isTxUnknownError = (error: unknown): boolean => /No information available about transaction|'code': -5|"code":\s*-5/.test(errorText(error));
const hasError = (reply: ElectrumReply | undefined) => !reply || (reply.error !== undefined && reply.error !== null);
const safeInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

type ServerAnswer =
  | { kind: 'final'; read: PaymentRead }
  /**
   * In a block by this server's word — its branch reaches its header's root: confirmed only once another server holds
   * that block. `machines`: the machines its sessions reached (the bytes and history; the header and branch).
   */
  | { kind: 'proven'; lanoshis: bigint; height: number; tip: number; nTime: number; blockTime: number; root: string; inputs: string[]; machines: string[] }
  | { kind: 'not_found' }
  | { kind: 'unconfirmed'; lanoshis: bigint; nTime: number; inputs: string[] }
  /** `silent`: no answer to transaction.get at all — it said nothing of the transaction. */
  | { kind: 'unknown'; silent?: true };

/**
 * The address each input of a raw transaction spends from, read from its signature script: a P2PKH spend
 * (<signature> <public key>) names the key that signed it, and so its address — for a transaction in a block the very
 * address of the coin it spends (the chain checked the key against the coin's script). "" for any other input.
 */
export function inputAddressesOf(raw: string): string[] {
  try {
    return decodeTx(raw).inputs.map((input) => {
      const sig = parseP2pkhScriptSig(input.scriptSigHex);
      if (!sig) return '';
      try {
        return addressOfPublicKey(sig.publicKey);
      } catch {
        return '';
      }
    });
  } catch {
    return [];
  }
}

/**
 * Whether a signature script is a pay-to-public-key spend's: exactly one push of a signature (DER, starting 0x30, with
 * its hash type) and nothing else — no public key, so the address is only in the coin it spends.
 */
export function isSignatureOnlyScript(scriptSigHex: string): boolean {
  const m = /^([0-9a-f]{2})((?:[0-9a-f]{2})*)$/.exec(scriptSigHex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return n >= 9 && n <= 73 && m[2].length === n * 2 && m[2].startsWith('30');
}

/** At most this many previous transactions are read for one answer; an input beyond them stays "". */
export const MAX_SPENT_COINS_READ = 20;

export function createPaymentReader(options: PaymentReaderOptions): PaymentReader {
  const timeoutMs = options.timeoutMs ?? CHAIN_TIMEOUT_MS;
  const machineOf = options.machineOf ?? ((remoteAddress: string) => machineOfAddress(remoteAddress));

  /**
   * One session (electrumSession), and the machine it reached: the address its socket connected to, read the moment
   * it connected (before any answer can come) — undefined when it never connected. No lookup of our own: the very
   * connection that answered says where it went.
   */
  const session = async (server: ElectrumServer, requests: readonly ElectrumRequest[]): Promise<{ replies: Map<number, ElectrumReply>; machine: string | undefined }> => {
    let remote: string | undefined;
    const connect: ElectrumConnect = (s) => {
      const socket = (options.connect ?? plainConnect)(s);
      socket.once('connect', () => {
        remote = socket.remoteAddress;
      });
      return socket;
    };
    const replies = await electrumSession(server, requests, timeoutMs, connect);
    return { replies, machine: remote ? machineOf(remote, server) : undefined };
  };

  /**
   * `inputs` (inputAddressesOf) completed for the pay-to-public-key spends: a staking reward of the LANA desktop wallet
   * is an output paid to the wallet's PUBLIC KEY, and spending it puts only a signature in the input (review of
   * 7. 10. 2026: the seller's own wallet software may spend one in the sale's transaction, and it read as "not from
   * the seller"). The coin such an input spends is read from its own previous transaction, asked of the same server and
   * re-hashed to its id (never the server's word): a <public key> OP_CHECKSIG output gives the address of that key —
   * the address the servers list the coin under. In a block the chain has checked the signature against that very key.
   * Anything else, or a transaction that does not come, stays "".
   */
  const spentCoinAddresses = async (server: ElectrumServer, raw: string, inputs: string[]): Promise<string[]> => {
    let spends: ({ prevTxid: string; vout: number } | null)[];
    try {
      spends = decodeTx(raw).inputs.map((input, i) => (inputs[i] === '' && isSignatureOnlyScript(input.scriptSigHex) ? { prevTxid: input.prevTxid, vout: input.vout } : null));
    } catch {
      return inputs;
    }
    const parents = [...new Set(spends.flatMap((s) => (s ? [s.prevTxid] : [])))].slice(0, MAX_SPENT_COINS_READ);
    if (parents.length === 0) return inputs;
    let replies: Map<number, ElectrumReply>;
    try {
      replies = await electrumSession(
        server,
        parents.map((txid, i) => ({ id: i + 1, method: GET_TRANSACTION, params: [txid] })),
        timeoutMs,
        options.connect,
      );
    } catch {
      return inputs;
    }
    const rawOf = new Map<string, string>();
    parents.forEach((txid, i) => {
      const reply = replies.get(i + 1);
      if (!hasError(reply) && typeof reply!.result === 'string') rawOf.set(txid, reply!.result.toLowerCase());
    });
    return inputs.map((address, i) => {
      const spend = spends[i];
      if (!spend) return address;
      const parent = rawOf.get(spend.prevTxid);
      if (!parent) return '';
      try {
        // The bytes must hash to the coin's transaction id: a server cannot make up the script.
        const coin = prevoutFromRawTx(parent, spend.prevTxid, spend.vout);
        const key = p2pkHash160(coin.scriptPubKeyHex);
        return key ? hash160ToAddress(key) : '';
      } catch {
        return '';
      }
    });
  };

  const askServer = async (server: ElectrumServer, txid: string, wallet: string, hash160: string): Promise<ServerAnswer> => {
    const opened = await session(server, [
      { id: 1, method: GET_TIP, params: [] },
      { id: 2, method: GET_HISTORY, params: [wallet] },
      { id: 3, method: GET_TRANSACTION, params: [txid] },
    ]);
    const first = opened.replies;
    const txReply = first.get(3);
    if (!txReply) return { kind: 'unknown', silent: true };
    if (hasError(txReply)) return isTxUnknownError(txReply.error) ? { kind: 'not_found' } : { kind: 'unknown' };
    const raw = txReply.result;
    if (typeof raw !== 'string') return { kind: 'unknown' };
    let tx;
    try {
      tx = parseLanaTx(raw);
    } catch {
      return { kind: 'unknown' };
    }
    // The bytes must be the transaction asked for.
    if (txidOfRaw(raw) !== txid) return { kind: 'unknown' };
    const lanoshis = lanoshisPaidToKey(tx, hash160);
    if (lanoshis === 0n) return { kind: 'final', read: { state: 'pays_nothing', nTime: tx.nTime } };

    const tipReply = first.get(1);
    const tip = !hasError(tipReply) ? (tipReply?.result as { block_height?: unknown } | null)?.block_height : undefined;
    const historyReply = first.get(2);
    if (!safeInt(tip, 1) || hasError(historyReply) || !Array.isArray(historyReply!.result)) return { kind: 'unknown' };
    const entry = (historyReply!.result as unknown[]).find((h) => (h as { tx_hash?: unknown } | null)?.tx_hash === txid) as { height?: unknown } | undefined;
    const inputs = await spentCoinAddresses(server, raw, inputAddressesOf(raw));
    if (!entry || !safeInt(entry.height, 1)) return { kind: 'unconfirmed', lanoshis, nTime: tx.nTime, inputs };
    const height = entry.height;

    const proving = await session(server, [
      { id: 1, method: GET_HEADER, params: [height] },
      { id: 2, method: GET_MERKLE, params: [txid, height] },
    ]);
    const second = proving.replies;
    const headerReply = second.get(1);
    const merkleReply = second.get(2);
    if (hasError(headerReply) || hasError(merkleReply)) return { kind: 'unknown' };
    const header = headerReply!.result as { block_height?: unknown; merkle_root?: unknown; timestamp?: unknown } | null;
    const merkle = merkleReply!.result as { merkle?: unknown; pos?: unknown } | null;
    if (!header || header.block_height !== height || typeof header.merkle_root !== 'string' || !safeInt(header.timestamp)) return { kind: 'unknown' };
    if (!merkle || !Array.isArray(merkle.merkle) || !merkle.merkle.every((h) => typeof h === 'string' && TXID.test(h)) || !safeInt(merkle.pos)) return { kind: 'unknown' };
    const root = header.merkle_root.toLowerCase();
    if (!TXID.test(root) || merkleRootOf(txid, merkle.merkle as string[], merkle.pos) !== root) return { kind: 'unknown' };
    // Where it was proven must be known, or no other machine can be told apart from it.
    if (!opened.machine || !proving.machine) return { kind: 'unknown' };
    return { kind: 'proven', lanoshis, height, tip, nTime: tx.nTime, blockTime: header.timestamp, root, inputs, machines: [opened.machine, proving.machine] };
  };

  /**
   * Another server's word on the block at `height`: its merkle root, that server's tip, and the machine that answered —
   * null when it gives none that reads, or its connection's address is not known.
   */
  const askBlock = async (server: ElectrumServer, height: number): Promise<{ root: string; tip: number; machine: string } | null> => {
    const asked = await session(server, [
      { id: 1, method: GET_TIP, params: [] },
      { id: 2, method: GET_HEADER, params: [height] },
    ]);
    if (!asked.machine) return null;
    const answers = asked.replies;
    const tipReply = answers.get(1);
    const headerReply = answers.get(2);
    if (hasError(tipReply) || hasError(headerReply)) return null;
    const tip = (tipReply!.result as { block_height?: unknown } | null)?.block_height;
    const header = headerReply!.result as { block_height?: unknown; merkle_root?: unknown } | null;
    if (!safeInt(tip, 1) || !header || header.block_height !== height || typeof header.merkle_root !== 'string') return null;
    const root = header.merkle_root.toLowerCase();
    return TXID.test(root) ? { root, tip, machine: asked.machine } : null;
  };

  return {
    async read(txidIn, wallet) {
      const txid = typeof txidIn === 'string' ? txidIn.trim().toLowerCase() : '';
      const hash160 = lanaAddressHash160(wallet);
      if (!TXID.test(txid) || !hash160) return { state: 'unknown' };
      let servers: ElectrumServer[] = [];
      try {
        servers = options.servers();
      } catch {
        servers = [];
      }
      let notFound = 0;
      /** Servers that answered anything but −5: its bytes, an error, something that did not check. */
      let answered = 0;
      let unconfirmed: { lanoshis: bigint; nTime: number; inputs: string[] } | null = null;
      for (const server of servers) {
        let answer: ServerAnswer;
        try {
          answer = await askServer(server, txid, wallet, hash160);
        } catch {
          // Thrown midway: it may have answered the bytes — never counted as silent.
          answer = { kind: 'unknown' };
        }
        if (answer.kind === 'final') return answer.read;
        if (answer.kind === 'proven') {
          // It answered the transaction's bytes: whatever comes of the proof, this server is no silent one.
          answered++;
          // Never on one server's word: another server — another MACHINE — must hold the same block. One machine under
          // two names (electrum1 and electrum3, 8. 10. 2026) or on two ports is one: the address its connection
          // reached is one the proof's sessions reached.
          const proving = new Set(answer.machines);
          for (const other of servers) {
            if (other === server || (other.host.toLowerCase() === server.host.toLowerCase() && other.port === server.port)) continue;
            let block: { root: string; tip: number; machine: string } | null = null;
            try {
              block = await askBlock(other, answer.height);
            } catch {
              block = null;
            }
            if (block && !proving.has(block.machine) && block.root === answer.root) {
              const tip = Math.min(answer.tip, block.tip);
              return {
                state: 'confirmed',
                lanoshis: answer.lanoshis,
                height: answer.height,
                confirmations: Math.max(1, tip - answer.height + 1),
                nTime: answer.nTime,
                blockTime: answer.blockTime,
                inputs: answer.inputs,
              };
            }
          }
          // No other server holds that block: nothing is proven — this server counts as one that gave no answer.
          continue;
        }
        if (answer.kind === 'not_found') notFound++;
        else if (!(answer.kind === 'unknown' && answer.silent)) answered++;
        if (answer.kind === 'unconfirmed') unconfirmed = { lanoshis: answer.lanoshis, nTime: answer.nTime, inputs: answer.inputs };
      }
      if (unconfirmed) return { state: 'unconfirmed', ...unconfirmed };
      if (servers.length > 0 && notFound === servers.length) return { state: 'not_found' };
      // −5 from every server that answered, silence from the rest: no server holds it — said, never decided, here.
      return notFound > 0 && answered === 0 ? { state: 'unknown', notFoundByAllReachable: true } : { state: 'unknown' };
    },
  };
}
