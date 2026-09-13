// @vitest-environment node
/**
 * POST /api/wallets/consolidate, END TO END — everything but the chain.
 *
 * The router is real and so is the key check (a real WIF, a real address);
 * electrum, the signer and the freeze sources are stand-ins that record what
 * they were asked. What is pinned: nothing is signed for a key that is not the
 * wallet's, for a wallet the gate refuses, for pieces a merge in flight already
 * spent, or for a fee an open offer from the wallet cannot absorb; the
 * transaction is priced from the chain; a lost broadcast answer is never told
 * as "nothing moved"; the key is never echoed or logged; two presses at once
 * make one merge.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../db/index.js', () => ({
  getDbHandle: () => memDb,
  getElectrumServersFromDb: () => [{ host: 'electrum.test', port: 5097 }],
  getRelaysFromDb: () => ['wss://relay.test'],
  getTrustedSignersFromDb: () => ({ LanaRegistrar: [] }),
}));

import { createConsolidationRouter, keyMatchesAddress, txidOf, committedLanoshis } from './consolidation';
import { WALLET_CONSOLIDATION_SCHEMA_SQL } from '../lib/consolidation';
import { consolidationFee } from '../lib/consolidationPlan';
import {
  base58CheckEncode, hexToUint8Array, privateKeyToPublicKey, privateKeyToUncompressedPublicKey, publicKeyToAddress,
} from '../lib/transaction';

memDb.exec(WALLET_CONSOLIDATION_SCHEMA_SQL);
// The columns of acquisition_offers this route reads — which open offers a wallet backs.
memDb.exec(`CREATE TABLE acquisition_offers (
  offer_ref TEXT PRIMARY KEY, sender_wallet_id TEXT, status TEXT, lana_amount_lanoshis INTEGER, offer_expires_at TEXT
)`);

const wifOf = (privHex: string, compressed: boolean) =>
  base58CheckEncode(Uint8Array.from([0xb0, ...hexToUint8Array(privHex), ...(compressed ? [0x01] : [])]));
const PRIV = '1a'.repeat(32);
const WIF = wifOf(PRIV, true);
const ADDRESS = publicKeyToAddress(privateKeyToPublicKey(PRIV));
const OTHER_WIF = wifOf('2b'.repeat(32), true);
const HEX = 'a'.repeat(64);

const hash = (n: number) => n.toString(16).padStart(64, '0');
const txHexOf = (n: number) => '0100'.repeat(40) + n.toString(16).padStart(4, '0');
const pieces = (from: number, count: number, value = 1_000_000) =>
  Array.from({ length: count }, (_, i) => ({ tx_hash: hash(from + i), tx_pos: 0, value, height: 100 }));
const names = (list: Array<{ tx_hash: string; tx_pos: number }>) => list.map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos }));

const world = {
  chain: pieces(1, 45) as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>,
  unconfirmed: 0 as number | 'throw',
  gate: { blocked: false } as any,
  broadcast: 'f'.repeat(64) as unknown,
  broadcastThrows: false,
  /** How a thrown broadcast failed: a silence, no connection at all, or electrum's own error. */
  broadcastFailure: 'silence' as 'silence' | 'notSent' | 'refused',
  seenOnChain: false,
  outputs: 1,
  built: [] as any[],
  broadcasts: [] as string[],
  /** When set, the signer waits for it — to hold a merge open. */
  hold: null as Promise<void> | null,
};

const app = express();
app.use(express.json());
app.use('/api/wallets', createConsolidationRouter({
  walletCheckBaseUrl: 'http://check.test',
  electrumCall: async (method, params) => {
    if (method === 'blockchain.address.listunspent') return world.chain;
    if (method === 'blockchain.address.get_balance') {
      if (world.unconfirmed === 'throw') throw new Error('electrum down');
      return { confirmed: world.chain.reduce((s, u) => s + u.value, 0), unconfirmed: world.unconfirmed };
    }
    if (method === 'blockchain.transaction.broadcast') {
      world.broadcasts.push(params[0]);
      if (world.broadcastThrows) {
        if (world.broadcastFailure === 'notSent') throw Object.assign(new Error('Failed to connect to any Electrum server'), { notSent: true });
        if (world.broadcastFailure === 'refused') throw Object.assign(new Error('Electrum error: {"code":-26}'), { electrumRefused: true });
        throw new Error('Electrum call timeout after 45000ms');
      }
      return world.broadcast;
    }
    if (method === 'blockchain.transaction.get') { if (world.seenOnChain) return 'aa'; throw new Error('No such mempool or blockchain transaction'); }
    throw new Error(`unexpected ${method}`);
  },
  buildSignedTx: (async (utxos, wif, recipients, fee, change, _servers, compressed) => {
    world.built.push({ utxos, recipients, fee, change, compressed, wifMatches: wif === WIF });
    if (world.hold) await world.hold;
    return { txHex: txHexOf(world.built.length), inputCount: utxos.length, outputCount: world.outputs, selectedUTXOs: utxos };
  }) as any,
  walletGate: async () => world.gate,
}));

const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => { server.close(); memDb.close(); });

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}/api/wallets${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any, text: '' };
};
const consolidate = (inputs: unknown, extra: Record<string, unknown> = {}) =>
  post('/consolidate', { hexId: HEX, address: ADDRESS, privateKey: WIF, inputs, ...extra });

beforeEach(() => {
  memDb.exec('DELETE FROM wallet_consolidations');
  memDb.exec('DELETE FROM acquisition_offers');
  Object.assign(world, {
    chain: pieces(1, 45), unconfirmed: 0, gate: { blocked: false }, broadcast: 'f'.repeat(64), broadcastThrows: false, broadcastFailure: 'silence',
    seenOnChain: false, outputs: 1, built: [], broadcasts: [], hold: null,
  });
});

describe('the key', () => {
  it('derives this wallet — compressed or not — or nothing is signed', async () => {
    expect(keyMatchesAddress(WIF, ADDRESS)).toEqual({ compressed: true });
    const uncompressedAddress = publicKeyToAddress(privateKeyToUncompressedPublicKey(PRIV));
    expect(keyMatchesAddress(wifOf(PRIV, false), uncompressedAddress)).toEqual({ compressed: false });
    expect(keyMatchesAddress(OTHER_WIF, ADDRESS)).toBeNull();
    expect(keyMatchesAddress('not a key', ADDRESS)).toBeNull();

    const r = await consolidate(names(world.chain.slice(0, 20)), { privateKey: OTHER_WIF });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('KEY_MISMATCH');
    expect(world.built).toHaveLength(0);
    expect(world.broadcasts).toHaveLength(0);
  });
});

describe('a merge', () => {
  it('is priced from the chain, has one output back to the wallet, and is remembered', async () => {
    const lying = world.chain.slice(0, 20).map(u => ({ ...u, value: 9_999_999_999 }));
    const r = await consolidate(lying);
    expect(r.status).toBe(200);
    const fee = consolidationFee(20);
    expect(r.body).toMatchObject({ success: true, txid: 'f'.repeat(64), inputCount: 20, totalLanoshis: 20_000_000, feeLanoshis: fee, netLanoshis: 20_000_000 - fee });

    expect(world.built).toHaveLength(1);
    const b = world.built[0];
    expect(b.wifMatches).toBe(true);
    expect(b.compressed).toBe(true);
    expect(b.fee).toBe(fee);
    expect(b.change).toBe(ADDRESS);
    expect(b.recipients).toEqual([{ address: ADDRESS, amount: 20_000_000 - fee }]);
    expect(b.utxos.every((u: any) => u.value === 1_000_000)).toBe(true);
    expect(world.broadcasts).toEqual([txHexOf(1)]);

    const row = memDb.prepare('SELECT * FROM wallet_consolidations').get() as any;
    expect(row).toMatchObject({ wallet_id: ADDRESS, hex_id: HEX, txid: 'f'.repeat(64), input_count: 20, fee_lanoshis: fee });
    expect(JSON.parse(row.inputs_json)[0]).toEqual({ tx_hash: hash(1), tx_pos: 0, value: 1_000_000 });
    expect(row.inputs_json).not.toContain(WIF);
  });

  it('pressed again while it confirms: refused, though the chain still lists its pieces — and the next batch goes', async () => {
    const first = world.chain.slice(0, 20);
    expect((await consolidate(names(first))).status).toBe(200);
    world.unconfirmed = -consolidationFee(20);   // what electrum shows for a merge in flight
    world.broadcast = 'e'.repeat(64);

    const again = await consolidate(names(first));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PIECES_ALREADY_MERGING');

    const next = await consolidate(names(world.chain.slice(20, 40)));
    expect(next.status).toBe(200);
    expect(world.built).toHaveLength(2);
  });

  it('the read shows the wallet the same way: merged pieces held back, the merge pending, the count after it', async () => {
    await consolidate(names(world.chain.slice(0, 20)));
    world.unconfirmed = -consolidationFee(20);
    const r = await post('/consolidation', { address: ADDRESS });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, utxoCount: 45, piecesAfterPending: 26, inFlight: 'ours', maxInputs: 20 });
    expect(r.body.available).toHaveLength(25);
    expect(r.body.pending).toEqual([expect.objectContaining({ txid: 'f'.repeat(64), inputCount: 20, feeLanoshis: consolidationFee(20) })]);
  });

  it('something else unconfirmed in the wallet: nothing is signed', async () => {
    world.unconfirmed = -123_456_789;
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('WALLET_HAS_PENDING_TRANSACTION');
    expect(world.built).toHaveLength(0);
  });

  it('a balance that cannot be read: nothing is signed', async () => {
    world.unconfirmed = 'throw';
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('WALLET_UNREADABLE');
    expect(world.built).toHaveLength(0);
  });

  it('a wallet the gate refuses — frozen, or not on the account\'s list: nothing is signed', async () => {
    for (const gate of [
      { blocked: true, httpStatus: 403, code: 'WALLET_FROZEN', reason: 'This wallet is frozen.' },
      { blocked: true, httpStatus: 403, code: 'WALLET_NOT_OWNED', reason: 'not yours' },
      { blocked: true, httpStatus: 503, code: 'WALLET_OWNERSHIP_UNVERIFIABLE', reason: 'unreadable' },
    ]) {
      world.gate = gate;
      const r = await consolidate(names(world.chain.slice(0, 20)));
      expect(r.status).toBe(gate.httpStatus);
      expect(r.body.code).toBe(gate.code);
    }
    expect(world.built).toHaveLength(0);
  });

  it('an accepted offer covering the whole wallet: a 20-piece fee that would leave it short is refused, a small one goes', async () => {
    const balance = world.chain.reduce((s, u) => s + u.value, 0);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('OFF-1', ?, 'accepted', ?, NULL)`).run(ADDRESS, balance - 33_600);
    expect(committedLanoshis(memDb, ADDRESS)).toBe(balance - 33_600);

    const big = await consolidate(names(world.chain.slice(0, 20)));
    expect(big.status).toBe(409);
    expect(big.body.code).toBe('MERGE_WOULD_UNDERCUT_OFFER');
    expect(world.built).toHaveLength(0);

    const small = await consolidate(names(world.chain.slice(0, 19)));
    expect(small.status).toBe(200);
    expect(small.body.feeLanoshis).toBe(consolidationFee(19));
  });

  it('lapsed, declined and settled offers promise nothing', async () => {
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('A', ?, 'offered', 999999999999, datetime('now', '-1 hour'))`).run(ADDRESS);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('B', ?, 'declined', 999999999999, NULL)`).run(ADDRESS);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('C', ?, 'settled', 999999999999, NULL)`).run(ADDRESS);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('D', 'Lsomeoneelse', 'accepted', 999999999999, NULL)`).run();
    expect(committedLanoshis(memDb, ADDRESS)).toBe(0);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('E', ?, 'offered', 7, datetime('now', '+1 hour'))`).run(ADDRESS);
    expect(committedLanoshis(memDb, ADDRESS)).toBe(7);
  });

  it('the read reports the room an open offer leaves', async () => {
    const balance = world.chain.reduce((s, u) => s + u.value, 0);
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('OFF-1', ?, 'accepted', ?, NULL)`).run(ADDRESS, balance - 33_600);
    const r = await post('/consolidation', { address: ADDRESS });
    expect(r.body).toMatchObject({ balanceLanoshis: balance, committedLanoshis: balance - 33_600, feeRoomLanoshis: 533_600 });
    memDb.exec('DELETE FROM acquisition_offers');
    expect((await post('/consolidation', { address: ADDRESS })).body.feeRoomLanoshis).toBeNull();
  });

  it('a broadcast whose answer is lost is NOT reported as nothing moved: remembered, and its pieces held back', async () => {
    world.broadcastThrows = true;
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(202);
    expect(r.body.code).toBe('BROADCAST_UNCERTAIN');
    expect(r.body.txid).toBe(txidOf(txHexOf(1)));
    expect(r.body.error).not.toMatch(/nothing moved/i);
    const row = memDb.prepare('SELECT txid FROM wallet_consolidations').get() as any;
    expect(row.txid).toBe(txidOf(txHexOf(1)));

    // Pressed again straight away: those pieces are held back, though nothing shows unconfirmed yet.
    world.broadcastThrows = false;
    const again = await consolidate(names(world.chain.slice(0, 20)));
    expect(again.body.code).toBe('PIECES_ALREADY_MERGING');
  });

  it('no connection at all, or electrum\'s own error: nothing moved, and nothing is remembered', async () => {
    world.broadcastThrows = true;
    for (const failure of ['notSent', 'refused'] as const) {
      world.broadcastFailure = failure;
      const r = await consolidate(names(world.chain.slice(0, 20)));
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('BROADCAST_FAILED');
      expect(r.body.error).toMatch(/nothing moved/);
    }
    expect(memDb.prepare('SELECT COUNT(*) AS c FROM wallet_consolidations').get()).toEqual({ c: 0 });
  });

  it('a second merge minutes after the first is measured against the room the first already used — even before electrum shows it', async () => {
    // 21 pieces of 1.5 LANA backing an offer for all of them: the room is exactly the tolerance.
    world.chain = pieces(1, 21, 150_000_000);
    const balance = 21 * 150_000_000;
    memDb.prepare(`INSERT INTO acquisition_offers VALUES ('OFF-1', ?, 'accepted', ?, NULL)`).run(ADDRESS, balance);
    const first = await consolidate(names(world.chain.slice(0, 18)));          // fee 492,600
    expect(first.status).toBe(200);
    world.broadcast = 'e'.repeat(64);
    world.unconfirmed = 0;                                                     // electrum has not caught up
    const read = await post('/consolidation', { address: ADDRESS });
    expect(read.body.feeRoomLanoshis).toBe(500_000 - consolidationFee(18));
    const second = await consolidate(names(world.chain.slice(18, 20)));        // fee 60,600 > 7,400 left
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('MERGE_WOULD_UNDERCUT_OFFER');
    expect(world.built).toHaveLength(1);
  });

  it('a lost answer for a transaction electrum can already see is a success', async () => {
    world.broadcastThrows = true;
    world.seenOnChain = true;
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, txid: txidOf(txHexOf(1)) });
  });

  it('the txid is the byte-reversed double SHA-256 of the transaction', () => {
    // The genesis coinbase of Bitcoin, whose id everyone can check.
    const genesis = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
    expect(txidOf(genesis)).toBe('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
  });

  it('refused by the network: said plainly, and not remembered', async () => {
    world.broadcast = "{u'message': u'TX rejected', u'code': -22}";
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('NETWORK_REJECTED');
    expect(r.body.error).toContain('nothing moved');
    expect(r.body.error).not.toContain("u'");
    expect(memDb.prepare('SELECT COUNT(*) AS c FROM wallet_consolidations').get()).toEqual({ c: 0 });
  });

  it('a signed transaction with a second output is never broadcast', async () => {
    world.outputs = 2;
    const r = await consolidate(names(world.chain.slice(0, 20)));
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('UNEXPECTED_SHAPE');
    expect(world.broadcasts).toHaveLength(0);
  });

  it('two presses at once make ONE merge', async () => {
    let open!: () => void;
    world.hold = new Promise<void>(r => { open = r; });
    const a = consolidate(names(world.chain.slice(0, 20)));
    await vi.waitFor(() => expect(world.built).toHaveLength(1));
    const b = await consolidate(names(world.chain.slice(20, 40)));
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('MERGE_IN_PROGRESS');
    open();
    expect((await a).status).toBe(200);
    expect(world.broadcasts).toHaveLength(1);
  });

  it('the key is never in a response or a log line', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    try {
      const responses = [
        await consolidate(names(world.chain.slice(0, 20))),
        await consolidate(names(world.chain.slice(0, 20))),
        await consolidate(names(world.chain.slice(0, 1))),
        await consolidate('x'),
      ];
      world.broadcast = 'garbage';
      responses.push(await consolidate(names(world.chain.slice(20, 40))));
      for (const r of responses) expect(JSON.stringify(r.body)).not.toContain(WIF);
      for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(WIF);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
  });
});
