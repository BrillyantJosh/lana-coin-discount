// @vitest-environment node
/**
 * sendLanaTransaction ON THE PRODUCTION NUMBERS, WITH A REAL KEY AND A REAL
 * SIGNATURE — only the chain is a stand-in.
 *
 * The route decides whether a wallet is being emptied (transferEmptying.test.ts
 * proves that part); this file proves the other half: that the decision, once
 * made, actually produces a transaction. A wallet holding 326,179,687,500
 * lanoshis in six pieces, asked for 3,261.796875 LANA — the whole of it —
 * builds and broadcasts when it is emptied, and is refused by exactly the
 * network fee when it is not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const chain = {
  utxos: [] as any[],
  broadcast: [] as string[],
  answer: 'cd'.repeat(32) as string,
};

vi.mock('./electrum.js', () => ({
  electrumCall: async (method: string, params: any[]) => {
    if (method === 'blockchain.address.listunspent') return chain.utxos;
    if (method === 'blockchain.transaction.get') return rawTxWithOneOutput();
    if (method === 'blockchain.transaction.broadcast') {
      chain.broadcast.push(params[0]);
      return chain.answer;
    }
    throw new Error(`unexpected electrum call: ${method}`);
  },
  fetchBatchBalances: async () => [],
}));

import {
  sendLanaTransaction, base58CheckEncode, hexToUint8Array, uint8ArrayToHex,
  privateKeyToUncompressedPublicKey, publicKeyToAddress, base58CheckDecode,
} from './transaction';

const AGREED_LANA = 3261.796875;
const AGREED_LANOSHIS = 326_179_687_500;
const FEE_WHEN_EMPTYING = 168_600;

// A real key, in the WIF form this chain uses (version byte 0xB0).
const PRIV_HEX = '1f'.repeat(32);
const WIF = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(PRIV_HEX)]));
const SENDER = publicKeyToAddress(privateKeyToUncompressedPublicKey(PRIV_HEX));
const RECIPIENT = publicKeyToAddress(privateKeyToUncompressedPublicKey('2e'.repeat(32)));

/** A previous transaction to spend from: no inputs, one P2PKH output. */
function rawTxWithOneOutput(): string {
  const pubKeyHash = base58CheckDecode(SENDER).slice(1);
  const script = new Uint8Array([0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac]);
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, BigInt(AGREED_LANOSHIS / 6), true);
  return uint8ArrayToHex(new Uint8Array([
    1, 0, 0, 0,        // version
    0, 0, 0, 0,        // nTime
    0x00,              // input count
    0x01,              // output count
    ...value,
    script.length,
    ...script,
  ]));
}

const sixPieces = () => Array.from({ length: 6 }, (_, i) => ({
  tx_hash: (i + 1).toString().repeat(64).slice(0, 64),
  tx_pos: 0,
  value: AGREED_LANOSHIS / 6,
  height: 900 + i,
}));

/** The outputs of a signed transaction, as value/script pairs. */
function outputsOf(txHex: string): Array<{ value: number; script: string }> {
  const tx = hexToUint8Array(txHex);
  let o = 4 + 4;                      // version + nTime
  const inputs = tx[o]; o += 1;
  for (let i = 0; i < inputs; i++) {
    o += 32 + 4;
    const len = tx[o]; o += 1 + len;
    o += 4;
  }
  const count = tx[o]; o += 1;
  const out: Array<{ value: number; script: string }> = [];
  for (let i = 0; i < count; i++) {
    const value = Number(new DataView(tx.buffer, tx.byteOffset + o, 8).getBigUint64(0, true));
    o += 8;
    const len = tx[o]; o += 1;
    out.push({ value, script: uint8ArrayToHex(tx.slice(o, o + len)) });
    o += len;
  }
  return out;
}

beforeEach(() => {
  chain.utxos = sixPieces();
  chain.broadcast = [];
  chain.answer = 'cd'.repeat(32);
});

describe('the transfer of 10 September 2026, run again', () => {
  it('as it was sent then — amount plus a fee out of a wallet holding only the amount — is refused, in LANA', async () => {
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT, amount: AGREED_LANA,
      privateKey: WIF, emptyWallet: false, electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('INSUFFICIENT_FUNDS');
    expect(r.retryable).toBe(false);
    expect(r.detail).toMatchObject({ shortfallLanoshis: 173_700, feeLanoshis: 173_700 });
    expect(r.error).toContain('0.001737 LANA');
    expect(r.error).not.toContain('lanoshis');
    expect(chain.broadcast).toHaveLength(0);
  });

  it('as the server sends it now — emptying — is signed and broadcast', async () => {
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT,
      privateKey: WIF, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 600_800,
      electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(true);
    expect(r.fee).toBe(FEE_WHEN_EMPTYING);
    expect(r.amount).toBe(AGREED_LANOSHIS - FEE_WHEN_EMPTYING);
    expect(chain.broadcast).toHaveLength(1);

    // One output, for the balance less the fee: no change is left behind and
    // the fee is paid out of the amount, which is the whole point.
    const outs = outputsOf(chain.broadcast[0]);
    expect(outs).toHaveLength(1);
    expect(outs[0].value).toBe(AGREED_LANOSHIS - FEE_WHEN_EMPTYING);
    const toRecipient = uint8ArrayToHex(base58CheckDecode(RECIPIENT).slice(1));
    expect(outs[0].script).toContain(toRecipient);
  });

  it('an ordinary transfer out of a wallet that CAN pay the fee keeps its change', async () => {
    chain.utxos = [...sixPieces(), { tx_hash: 'f'.repeat(64), tx_pos: 0, value: 100_000_000, height: 999 }];
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT, amount: AGREED_LANA,
      privateKey: WIF, emptyWallet: false, electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(true);
    const outs = outputsOf(chain.broadcast[0]);
    expect(outs).toHaveLength(2);
    expect(outs[0].value).toBe(AGREED_LANOSHIS);
    const toSender = uint8ArrayToHex(base58CheckDecode(SENDER).slice(1));
    expect(outs[1].script).toContain(toSender);
  });

  it('emptying a wallet that turns out to hold more than the mandate is never swept', async () => {
    chain.utxos = [...sixPieces(), { tx_hash: 'f'.repeat(64), tx_pos: 0, value: 500_000_000_000, height: 999 }];
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT,
      privateKey: WIF, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 600_800,
      electrumServers: [{ host: 'e', port: 5097 }],
    });
    // Asked ONLY to sweep, with nothing to fall back to: refused.
    expect(r.success).toBe(false);
    expect(r.code).toBe('EMPTY_WALLET_EXCEEDS_CEILING');
    expect(chain.broadcast).toHaveLength(0);
    // …and it is not a dead end. The ceiling came from a reading taken one
    // layer up, not from this wallet, so a caller must not remember it.
    expect(r.retryable).toBe(true);
  });

  /**
   * THE DEAD BAND, SIGNED AND BROADCAST.
   *
   * A payment of 0.007125 LANA lands after acceptance. It does not move the
   * two-decimal figure electrum prints, so the route still asks for a sweep —
   * and the exact total is now above the ceiling the route handed down.
   * Refusing there marked the offer permanently refused and cached it: a
   * transfer that would have gone through the ordinary way became a dead end
   * inside a 24-hour window. It now goes through the ordinary way.
   */
  it('a wallet a hair above the sweep ceiling is signed as an ordinary transfer', async () => {
    const SURPLUS = 712_500;
    chain.utxos = [...sixPieces(), { tx_hash: 'f'.repeat(64), tx_pos: 0, value: SURPLUS, height: 999 }];
    const exactBalance = AGREED_LANOSHIS + SURPLUS;
    const ceiling = AGREED_LANOSHIS + 600_800;
    expect(exactBalance).toBeGreaterThan(ceiling);
    // What electrum prints is identical either way, which is why the route
    // could not tell and asked for the sweep.
    expect(Math.round(exactBalance / 1e6) / 100).toBe(Math.round(AGREED_LANOSHIS / 1e6) / 100);

    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT,
      amount: AGREED_LANA,            // the fallback the route now hands down
      privateKey: WIF, emptyWallet: true,
      sweepCeilingLanoshis: ceiling,
      electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(true);
    expect(r.emptyWallet).toBe(false);          // sent, not swept — and it says so
    expect(r.amount).toBe(AGREED_LANOSHIS);     // the agreed amount, not a lanoshi more
    expect(chain.broadcast).toHaveLength(1);

    const outs = outputsOf(chain.broadcast[0]);
    expect(outs).toHaveLength(2);               // the change the fee came out of
    expect(outs[0].value).toBe(AGREED_LANOSHIS);
    const toSender = uint8ArrayToHex(base58CheckDecode(SENDER).slice(1));
    expect(outs[1].script).toContain(toSender);
    expect(outs[0].value + outs[1].value + r.fee!).toBe(exactBalance);
  });

  it('and the successful sweep says so too, so the caller reports what happened', async () => {
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT, amount: AGREED_LANA,
      privateKey: WIF, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 600_800,
      electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(true);
    expect(r.emptyWallet).toBe(true);
    expect(r.amount).toBe(AGREED_LANOSHIS - FEE_WHEN_EMPTYING);
  });

  /**
   * TOO_MANY_UTXOS TELLS THE SELLER HOW TO FIX IT, so it cannot be a permanent
   * refusal. A sweep must take EVERY input, so a whole-wallet seller meets the
   * 20-input limit far sooner than an ordinary one — and emptying is now the
   * default for whole-wallet sales.
   */
  it('too many pieces to sweep is a refusal the seller can act on, not a dead end', async () => {
    chain.utxos = Array.from({ length: 21 }, (_, i) => ({
      tx_hash: (i + 10).toString().repeat(64).slice(0, 64), tx_pos: 0,
      value: Math.floor(AGREED_LANOSHIS / 21), height: 900 + i,
    }));
    const r = await sendLanaTransaction({
      senderAddress: SENDER, recipientAddress: RECIPIENT, amount: AGREED_LANA,
      privateKey: WIF, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 600_800,
      electrumServers: [{ host: 'e', port: 5097 }],
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('TOO_MANY_UTXOS');
    expect(r.error).toContain('Consolidate them with Registrar');
    expect(r.error).not.toContain('UTXO'); // words the seller can act on, not a code
    expect(r.retryable).toBe(true);   // consolidating is the cure, and it works
    expect(chain.broadcast).toHaveLength(0);
  });
});
