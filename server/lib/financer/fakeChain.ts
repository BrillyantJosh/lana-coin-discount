/**
 * A LANA chain in memory, served by a fake Electrum server on 127.0.0.1 —
 * nothing leaves this machine. It answers exactly as electrum1/2.lanacoin.com
 * answered on 6. 10. 2026 (protocol "0.9", newline-delimited JSON-RPC):
 *   - blockchain.headers.subscribe → {block_height, merkle_root, timestamp, …}
 *     (block_height, not height);
 *   - blockchain.address.get_history → [{tx_hash, height}] NOT sorted, height 0
 *     while in the mempool;
 *   - blockchain.transaction.get → always the raw hex (verbose ignored);
 *   - blockchain.block.get_header, blockchain.transaction.get_merkle →
 *     {merkle, pos, block_height};
 *   - every error a STRING, often a Python repr: the −5 of an unknown
 *     transaction, "u'<txid>' is not in list", "unknown method:…".
 * Transactions are built here in the Peercoin layout (version, nTime, inputs,
 * outputs, locktime), paying throwaway wallets that belong to nobody.
 *
 * For the payout wallet (payouts.test.ts) it also answers as those servers do:
 *   - blockchain.address.listunspent → [{tx_hash, tx_pos, value, height}] —
 *     confirmed coins only, and a coin an unconfirmed transaction spends is
 *     still listed (the Lana8Wonder double cash-out);
 *   - blockchain.address.get_balance → {confirmed, unconfirmed}, unconfirmed
 *     below 0 while a payment out waits in the mempool;
 *   - get_history also lists every transaction that SPENDS the wallet's coins;
 *   - an output paid to a wallet's PUBLIC KEY (pay-to-public-key: a staking
 *     reward) is filed under that key's address, as electrum-server's
 *     get_address_from_output_script does;
 *   - blockchain.transaction.broadcast → the id (taken into the mempool), or,
 *     as `chain.broadcast` says: a refusal as a Python repr in `result`, another
 *     id, or silence. A transaction spending a coin already spent elsewhere is
 *     refused ("-22 TX rejected"), as the node does.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's server/tests/fakeChain.ts
 * (origin/main a46f618), a test kit like nip98TestKit.ts — imported only by
 * tests (the financer's chain modules, its sends and the treasury's), never by
 * the server. Only its import paths changed, and randomKey() is written here
 * instead of coming from Krog Menjave's tests/helpers.ts.
 */
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lanaAddressHash160, lanaAddressOf } from './lanaAddress.ts';
import { parseLanaTx, p2pkhScript, txidOfRaw } from './lanaTx.ts';
import { decodeTx, outpointKey } from '../../shared/lana-tx/codec.ts';
import { p2pkHash160 } from '../../shared/lana-tx/address.ts';
import type { ElectrumServer } from './electrumSession.ts';

/** A fresh secret key, drawn in this process and gone when it ends (Krog Menjave's tests/helpers.ts randomKey). */
const randomKey = (): Uint8Array => schnorr.utils.randomSecretKey();

const sha256d = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

/** A LANA address nobody holds: made from a throwaway key. */
export const throwawayWallet = (): string => lanaAddressOf(schnorr.getPublicKey(randomKey()));

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/**
 * A raw transaction in the Peercoin layout: one input (a made-up previous
 * output), the outputs given — each a P2PKH to a wallet, or a raw script —
 * and locktime 0.
 */
export function rawTx(nTime: number, outputs: { wallet?: string; script?: string; lanoshis: bigint }[]): string {
  const parts: Buffer[] = [u32(1), u32(nTime), Buffer.from([1]), randomBytes(32), u32(0), Buffer.from([2, 0x51, 0x51]), u32(0xffffffff), Buffer.from([outputs.length])];
  for (const out of outputs) {
    const script = Buffer.from(out.script ?? p2pkhScript(lanaAddressHash160(out.wallet) as string), 'hex');
    parts.push(u64(out.lanoshis), Buffer.from([script.length]), script);
  }
  parts.push(u32(0));
  return Buffer.concat(parts).toString('hex');
}

/** The merkle root of a block's transactions and one's branch (Bitcoin's rule: an odd level repeats its last hash). */
export function merkleOf(txids: string[], pos: number): { root: string; branch: string[] } {
  let level: Buffer[] = txids.map((t) => Buffer.from(t, 'hex').reverse());
  const branch: string[] = [];
  let at = pos;
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    branch.push(Buffer.from(level[at ^ 1]).reverse().toString('hex'));
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i], level[i + 1]])));
    level = next;
    at = Math.floor(at / 2);
  }
  return { root: Buffer.from(level[0]).reverse().toString('hex'), branch };
}

export interface FakeChain {
  tip: number;
  /** height → its transactions (ids, in order) and its time. */
  blocks: Map<number, { txids: string[]; timestamp: number }>;
  /** Every transaction known, in a block or not. */
  raws: Map<string, string>;
  /** How a broadcast is answered: taken (the default), refused in words, answered with another id, or not at all. */
  broadcast?: 'accept' | 'refuse' | 'other_id' | 'silent';
  /** Every raw transaction broadcast to this chain, in order. */
  broadcasts?: string[];
}

/** The outpoints each known transaction spends ("txid:vout"); a transaction that does not decode spends nothing here. */
function spendsOf(raw: string): string[] {
  try {
    return decodeTx(raw).inputs.map((i) => outpointKey(i.prevTxid, i.vout));
  } catch {
    return [];
  }
}

/** Put a broadcast into the chain as the node would: the id when taken (or already held), else the node's refusal. */
export function takeBroadcast(chain: FakeChain, raw: string): { result?: unknown; error?: string } | null {
  (chain.broadcasts ??= []).push(raw);
  const mode = chain.broadcast ?? 'accept';
  if (mode === 'silent') return null;
  if (mode === 'refuse') return { result: "{u'message': u'TX rejected', u'code': -22}" };
  if (mode === 'other_id') return { result: 'ab'.repeat(32) };
  let txid: string;
  try {
    decodeTx(raw);
    txid = txidOfRaw(raw);
  } catch {
    return { result: "{u'message': u'TX decode failed', u'code': -22}" };
  }
  if (chain.raws.has(txid)) return { result: txid };
  const spent = new Set([...chain.raws.entries()].flatMap(([id, r]) => (id === txid ? [] : spendsOf(r))));
  if (spendsOf(raw).some((key) => spent.has(key))) return { result: "{u'message': u'TX rejected', u'code': -22}" };
  chain.raws.set(txid, raw);
  return { result: txid };
}

export function newChain(tip = 1_067_542): FakeChain {
  return { tip, blocks: new Map(), raws: new Map(), broadcast: 'accept', broadcasts: [] };
}

/** Put a transaction on the chain: in a block at `height` (with `others` beside it, it at `pos`), or in the mempool (height 0). */
export function addTx(chain: FakeChain, raw: string, place: { height: number; timestamp?: number; others?: number; pos?: number } | 'mempool'): string {
  const txid = txidOfRaw(raw);
  chain.raws.set(txid, raw);
  if (place === 'mempool') return txid;
  const others = Array.from({ length: place.others ?? 0 }, () => {
    const filler = rawTx(1_791_000_000, [{ wallet: throwawayWallet(), lanoshis: 100_000_000n }]);
    chain.raws.set(txidOfRaw(filler), filler);
    return txidOfRaw(filler);
  });
  const txids = [...others];
  txids.splice(Math.min(place.pos ?? txids.length, txids.length), 0, txid);
  chain.blocks.set(place.height, { txids, timestamp: place.timestamp ?? 1_791_190_912 });
  return txid;
}

const TX_UNKNOWN = "{u'message': u'No information available about transaction', u'code': -5}";

/**
 * How the fake server answers. Besides the plain failures, two liars:
 * `forged` — every transaction of a wallet "in a block" a few below the tip,
 * that block's header with the transaction's own id as its merkle_root and an
 * empty branch (pos 0): a "proof" that holds for any transaction, made up by
 * one server alone; `other_root` — every block's header with another merkle
 * root (a server on another branch of the chain, or one that lies about it).
 * For sending: `broadcast_hangs` — a server whose node is down: every read is
 * answered from its own index, a broadcast never is (and nothing is taken);
 * `get_silent` — a busy server that never answers transaction.get.
 */
export type ChainMode = 'normal' | 'silent' | 'close' | 'not_found' | 'wrong_tx' | 'bad_merkle' | 'no_history' | 'forged' | 'other_root' | 'broadcast_hangs' | 'get_silent';

/** A fake Electrum server over the chain. `mode` can be changed while it runs. */
export async function fakeElectrumChain(chain: FakeChain, mode: { value: ChainMode } = { value: 'normal' }) {
  const seen: { method: string; params: unknown[] }[] = [];
  const stats = { connections: 0 };
  /** The transaction asked last: what a forging server puts in its made-up header. */
  let lastTx = '';
  const heightOf = (txid: string) => [...chain.blocks].find(([, b]) => b.txids.includes(txid))?.[0] ?? 0;
  /** The outputs paying `address`: "txid:vout" → value and the height of its transaction. */
  const outputsTo = (address: string) => {
    const h160 = lanaAddressHash160(address);
    const out = new Map<string, { txid: string; vout: number; value: bigint; height: number }>();
    if (!h160) return out;
    for (const [txid, raw] of chain.raws) {
      parseLanaTx(raw).outputs.forEach((o, vout) => {
        if (o.script === p2pkhScript(h160) || p2pkHash160(o.script) === h160) out.set(`${txid}:${vout}`, { txid, vout, value: o.lanoshis, height: heightOf(txid) });
      });
    }
    return out;
  };
  const historyOf = (address: string) => {
    const h160 = lanaAddressHash160(address);
    const mine = outputsTo(address);
    const out: { tx_hash: string; height: number }[] = [];
    for (const [txid, raw] of chain.raws) {
      const tx = parseLanaTx(raw);
      const pays = h160 && tx.outputs.some((o) => o.script === p2pkhScript(h160) || p2pkHash160(o.script) === h160);
      const spends = spendsOf(raw).some((key) => mine.has(key));
      if (pays || spends) out.push({ tx_hash: txid, height: heightOf(txid) });
    }
    return out.reverse(); // not sorted, as the real servers answer
  };
  /** Confirmed coins of `address` that no CONFIRMED transaction spends — one spent in the mempool is still listed. */
  const unspentOf = (address: string) => {
    const spentInBlocks = new Set([...chain.raws].filter(([txid]) => heightOf(txid) > 0).flatMap(([, raw]) => spendsOf(raw)));
    return [...outputsTo(address)].filter(([key, o]) => o.height > 0 && !spentInBlocks.has(key)).map(([, o]) => o);
  };
  const balanceOf = (address: string) => {
    const coins = unspentOf(address);
    const confirmed = coins.reduce((s, c) => s + c.value, 0n);
    const keys = new Set(coins.map((c) => `${c.txid}:${c.vout}`));
    let unconfirmed = 0n;
    for (const [txid, raw] of chain.raws) {
      if (heightOf(txid) > 0) continue;
      for (const key of spendsOf(raw)) {
        const coin = coins.find((c) => `${c.txid}:${c.vout}` === key);
        if (coin && keys.has(key)) unconfirmed -= coin.value;
      }
    }
    for (const o of outputsTo(address).values()) if (o.height === 0) unconfirmed += o.value;
    return { confirmed: Number(confirmed), unconfirmed: Number(unconfirmed) };
  };
  const answer = (method: string, params: unknown[]): { result?: unknown; error?: string } => {
    switch (method) {
      case 'blockchain.headers.subscribe':
        return { result: { nonce: 0, prev_block_hash: '0'.repeat(64), timestamp: 1_791_275_072, merkle_root: '0'.repeat(64), block_height: chain.tip, utxo_root: '0'.repeat(64), version: 1, bits: 419_695_289 } };
      case 'blockchain.address.listunspent':
        return { result: unspentOf(String(params[0])).map((c) => ({ tx_hash: c.txid, tx_pos: c.vout, value: Number(c.value), height: c.height })).reverse() };
      case 'blockchain.address.get_balance':
        return { result: balanceOf(String(params[0])) };
      case 'blockchain.address.get_history':
        if (mode.value === 'forged') return { result: historyOf(String(params[0])).map((h) => ({ ...h, height: chain.tip - 3 })) };
        return mode.value === 'no_history' ? { result: [] } : { result: historyOf(String(params[0])) };
      case 'blockchain.transaction.get': {
        const txid = String(params[0]).toLowerCase();
        lastTx = txid;
        if (mode.value === 'not_found' || !chain.raws.has(txid)) return { error: TX_UNKNOWN };
        if (mode.value === 'wrong_tx') return { result: [...chain.raws.values()].find((r) => txidOfRaw(r) !== txid) };
        return { result: chain.raws.get(txid) };
      }
      case 'blockchain.block.get_header': {
        const height = Number(params[0]);
        if (mode.value === 'forged') return { result: { nonce: 0, prev_block_hash: '0'.repeat(64), timestamp: 1_791_275_000, merkle_root: lastTx, block_height: height, version: 1, bits: 419_695_289 } };
        const block = chain.blocks.get(height);
        if (block && mode.value === 'other_root') return { result: { nonce: 0, prev_block_hash: '0'.repeat(64), timestamp: block.timestamp, merkle_root: 'cd'.repeat(32), block_height: height, version: 1, bits: 419_695_289 } };
        if (!block) return { error: "{u'message': u'Block number out of range.', u'code': -1}" };
        return { result: { nonce: 0, prev_block_hash: '0'.repeat(64), timestamp: block.timestamp, merkle_root: merkleOf(block.txids, 0).root, block_height: height, version: 1, bits: 419_695_289 } };
      }
      case 'blockchain.transaction.get_merkle': {
        const txid = String(params[0]);
        if (mode.value === 'forged') return { result: { merkle: [], pos: 0, block_height: Number(params[1]) } };
        const block = chain.blocks.get(Number(params[1]));
        const pos = block?.txids.indexOf(txid) ?? -1;
        if (!block || pos < 0) return { error: `u'${txid}' is not in list` };
        const { branch } = merkleOf(block.txids, pos);
        return { result: { merkle: mode.value === 'bad_merkle' ? branch.map(() => 'ab'.repeat(32)).concat(branch.length ? [] : ['ab'.repeat(32)]) : branch, pos, block_height: Number(params[1]) } };
      }
      default:
        return { error: `unknown method:${method}` };
    }
  };
  const server = net.createServer((socket) => {
    stats.connections++;
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end: number;
      const out: string[] = [];
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: number; method: string; params: unknown[] };
        seen.push({ method: request.method, params: request.params });
        if (mode.value === 'silent') continue;
        if (mode.value === 'close') return void socket.destroy();
        if (mode.value === 'get_silent' && request.method === 'blockchain.transaction.get') continue;
        if (request.method === 'blockchain.transaction.broadcast') {
          if (mode.value === 'broadcast_hangs') continue;
          const taken = takeBroadcast(chain, String(request.params[0]));
          if (taken) out.push(JSON.stringify({ id: request.id, ...taken }));
          continue;
        }
        out.push(JSON.stringify({ id: request.id, ...answer(request.method, request.params) }));
      }
      // Answered out of order, as the real servers do.
      if (out.length) socket.write(`${out.reverse().join('\n')}\n`);
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  return { server, seen, stats, mode, at: { host: '127.0.0.1', port } as ElectrumServer, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
