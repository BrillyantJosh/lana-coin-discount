// @vitest-environment node
/**
 * THE WHOLE PATH, ON THE NUMBERS OF 10 SEPTEMBER 2026.
 *
 *     Insufficient funds: need 326179861200 lanoshis, have 326179687500
 *
 * Every other file here proves one layer with the next one standing in. This
 * one stands nothing in but the chain itself: the real router, the real
 * balance reading, the real plan, a real key and a real signature — a fake
 * electrum socket and nothing else. It exists because the fix for that failure
 * introduced two more that only appear where the layers meet:
 *
 *   1. the route decided to empty from a balance rounded to 0.01 LANA, and
 *      handed the plan an EXACT ceiling. When they disagreed the transfer was
 *      refused — and remembered, so every later press was refused from memory.
 *   2. the memory was fingerprinted with that same rounded balance, so no
 *      wallet change under 0.01 LANA could clear it, including the exact
 *      top-up and the exact consolidation the refusals asked for.
 *
 * Four presses of one button, end to end. Balance 326,179,687,500 lanoshis,
 * agreed 3,261.796875 LANA, each time.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

// ── the chain, and only the chain ──────────────────────────────────────
const chain = {
  utxos: [] as any[],
  broadcast: [] as string[],
  /** True when the balance CALL is down while the node itself answers. */
  balanceDown: false,
};

vi.mock('./electrum.js', () => ({
  electrumCall: async (method: string, params: any[]) => {
    if (method === 'blockchain.address.listunspent') return chain.utxos;
    if (method === 'blockchain.transaction.get') return rawTxWithOneOutput();
    if (method === 'blockchain.transaction.broadcast') {
      chain.broadcast.push(params[0]);
      return 'cd'.repeat(32);
    }
    throw new Error(`unexpected electrum call: ${method}`);
  },
  fetchBatchBalances: async (_s: unknown, addresses: string[]) => {
    if (chain.balanceDown) throw new Error('All Electrum servers failed');
    const exact = chain.utxos.reduce((t, u) => t + u.value, 0);
    // Exactly what server/lib/electrum.ts now returns: the printed figure and
    // the chain's own integer beside it.
    return addresses.map(a => ({
      wallet_id: a,
      balance: Math.round((exact / 100_000_000) * 100) / 100,
      balanceLanoshis: exact,
      status: 'active',
    }));
  },
}));

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('./roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { getDbHandle } from '../db/index.js';
import { createAcquisitionsRouter, OFFERS_SIGNED_PATH } from '../routes/acquisitions';
import { ingestMandateEvent } from './roundMandateSync';
import { createReplayCache } from './requestSignature';
import {
  base58CheckEncode, base58CheckDecode, hexToUint8Array, uint8ArrayToHex,
  privateKeyToUncompressedPublicKey, publicKeyToAddress,
} from './transaction';
import { makeKey, mandateEvent, signedHeaders, setSplit, setSetting, setRoundTerms } from './roundMandateTestKit';

// ── the day's numbers ───────────────────────────────────────────────────
const AGREED_LANA = 3261.796875;
const AGREED_LANOSHIS = 326_179_687_500;
const FEE_WHEN_EMPTYING = 168_600;    // 6 inputs, 1 output
const FEE_WHEN_ORDINARY = 173_700;    // 6 inputs, 2 outputs — the change costs 5,100
const PRINTED_LANA = 3261.8;

/** A real key in this chain's WIF form (version byte 0xB0), and its address. */
const PRIV_HEX = '1f'.repeat(32);
const WIF = base58CheckEncode(new Uint8Array([0xb0, ...hexToUint8Array(PRIV_HEX)]));
const SENDER = publicKeyToAddress(privateKeyToUncompressedPublicKey(PRIV_HEX));
const TREASURY = publicKeyToAddress(privateKeyToUncompressedPublicKey('2e'.repeat(32)));

/** A previous transaction to spend from: no inputs, one P2PKH output. */
function rawTxWithOneOutput(): string {
  const pubKeyHash = base58CheckDecode(SENDER).slice(1);
  const script = new Uint8Array([0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac]);
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, BigInt(AGREED_LANOSHIS / 6), true);
  return uint8ArrayToHex(new Uint8Array([
    1, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, ...value, script.length, ...script,
  ]));
}

/** The six pieces his wallet was in. */
const sixPieces = () => Array.from({ length: 6 }, (_, i) => ({
  tx_hash: (i + 1).toString().repeat(64).slice(0, 64),
  tx_pos: 0,
  value: AGREED_LANOSHIS / 6,
  height: 900 + i,
}));

function outputsOf(txHex: string): Array<{ value: number; script: string }> {
  const tx = hexToUint8Array(txHex);
  let o = 8;
  const inputs = tx[o]; o += 1;
  for (let i = 0; i < inputs; i++) {
    o += 36;
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

// ── the app ─────────────────────────────────────────────────────────────
const db: Database.Database = getDbHandle();
const lanapays = makeKey();
const seller = makeKey();

const app = express();
app.use(express.json());
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: 'http://check.test',
  publishBuybackEvent: async () => undefined,
  checkSellerEligibility: async () => ({
    ok: true, walletType: 'LanaPays.Us', walletClass: 'lanapays', evidence: { splitCode: 'OK' },
  }) as any,
  fetchUserWallets: async () => [{ walletId: SENDER, walletType: 'LanaPays.Us' }] as any,
  replayCache: createReplayCache(),
  // NOTHING else is injected: the balance, the plan, the signature and the
  // broadcast are the real ones.
}));

let server: http.Server;
let base = '';
beforeEach(async () => {
  if (!server) {
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  for (const t of ['acquisition_offers', 'acquisition_mandates', 'acquisition_mandate_releases', 'acquisition_rounds', 'app_settings', 'buyback_transactions']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  chain.utxos = sixPieces();
  chain.broadcast = [];
  chain.balanceDown = false;
  setSplit(db, 9, { EUR: 0.256 });
  setSetting(db, 'active_currencies', '["EUR"]');
  setSetting(db, 'acq_EUR_enabled', 'true');
  setSetting(db, 'acq_EUR_lanapays_enabled', 'true');
  setSetting(db, 'acq_EUR_lanapays_auto_cap', '');
  setSetting(db, 'acq_EUR_lanapays_due_days', '15');
  setSetting(db, 'buyback_wallet_id', TREASURY);
  setSetting(db, 'electrum_servers', JSON.stringify([{ host: 'e', port: 5097 }]));
  const e = mandateEvent(lanapays, {
    split: 8, round: 1, hex: seller.pub,
    wallets: [{ address: SENDER, currency: 'EUR', lana: String(AGREED_LANA), fundSettingId: '52' }],
  });
  const stored = ingestMandateEvent(db, e, { authorizedPubkey: lanapays.pub });
  if (!stored.stored) throw new Error(`fixture not stored: ${stored.reason}`);
  setRoundTerms(db, 8, 1, Math.floor(Date.now() / 1000) - 3600, 22);
});
afterAll(() => new Promise<void>(r => server?.close(() => r())));

const nowSec = () => Math.floor(Date.now() / 1000);
const post = (path: string, body: any, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }));

/** His whole wallet, offered and accepted — the state the transfer starts from. */
const acceptedWholeWallet = async () => {
  const body = { hexId: seller.pub, senderAddress: SENDER, lanaAmount: AGREED_LANA, currency: 'EUR' };
  const made = await post('/api/acquisitions/offers', body, signedHeaders(seller, 'POST', OFFERS_SIGNED_PATH, nowSec(), body));
  expect(made.status).toBe(200);
  const ref = made.body.offer.offerRef as string;
  const acc = await post(`/api/acquisitions/${ref}/accept`, { hexId: seller.pub },
    signedHeaders(seller, 'POST', `/api/acquisitions/${ref}/accept`, nowSec(), { hexId: seller.pub }));
  expect(acc.status).toBe(200);
  return ref;
};

/** The transfer as a browser that has forgotten everything sends it. */
const press = (ref: string, over: Record<string, unknown> = {}) =>
  post(`/api/acquisitions/${ref}/transfer`, { hexId: seller.pub, privateKey: WIF, ...over });

const failedRows = () => db.prepare("SELECT * FROM buyback_transactions WHERE status = 'failed'").all() as any[];

describe('the eight failures of 10 September 2026, end to end', () => {
  it('press one now signs and broadcasts — the balance less the fee, no change left behind', async () => {
    const ref = await acceptedWholeWallet();
    const r = await press(ref);

    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(true);
    expect(r.body.fee).toBe(FEE_WHEN_EMPTYING);
    expect(chain.broadcast).toHaveLength(1);
    expect(failedRows()).toHaveLength(0);

    const outs = outputsOf(chain.broadcast[0]);
    expect(outs).toHaveLength(1);
    expect(outs[0].value).toBe(AGREED_LANOSHIS - FEE_WHEN_EMPTYING);
    expect(outs[0].value + FEE_WHEN_EMPTYING).toBe(AGREED_LANOSHIS); // to the lanoshi
    expect(outs[0].script).toContain(uint8ArrayToHex(base58CheckDecode(TREASURY).slice(1)));
  });

  /**
   * THE DEAD BAND. A payment of 0.007125 LANA arrives between acceptance and
   * the transfer. Electrum prints 3,261.80 either way, so a rounded reading
   * still calls this the emptying case — and the exact ceiling then refuses it,
   * permanently and from memory. It is now sent the ordinary way instead.
   */
  it('a payment arriving after acceptance no longer turns the transfer into a dead end', async () => {
    const SURPLUS = 712_500;
    chain.utxos = [...sixPieces(), { tx_hash: 'f'.repeat(64), tx_pos: 0, value: SURPLUS, height: 999 }];
    const exact = AGREED_LANOSHIS + SURPLUS;
    // What electrum PRINTS is unchanged; only the exact integer knows.
    expect(Math.round((exact / 100_000_000) * 100) / 100).toBe(PRINTED_LANA);

    const ref = await acceptedWholeWallet();
    const r = await press(ref);

    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(false);
    expect(chain.broadcast).toHaveLength(1);
    const outs = outputsOf(chain.broadcast[0]);
    expect(outs).toHaveLength(2);
    expect(outs[0].value).toBe(AGREED_LANOSHIS);       // the agreed amount, exactly
    expect(outs[0].value + outs[1].value + r.body.fee).toBe(exact);
  });

  /**
   * THE DEAD BAND — OFF-2026-062, 11 September 2026.
   *
   * "This wallet holds more than the amount the treasury agreed to acquire, so
   * it cannot be emptied into this acquisition. Transfer the agreed amount
   * only." He could not: the agreed amount was exactly what he could not send.
   *
   * Two numbers that had to agree and never could. "Is this a sweep?" was
   * asked one layer up against a CONSTANT dust allowance priced on a ONE-input
   * transaction — 100,800 lanoshis. The fee a wallet actually pays is priced
   * on its real pieces: 173,700 for six. A surplus between the two is too much
   * to sweep and too little to pay for a change output, and there is nothing
   * the seller can do to either figure.
   *
   * 125,000 over, 48,700 short. On his own numbers, scaled to this file's.
   */
  it('a surplus too big to sweep and too small to pay its own change still completes', async () => {
    const SURPLUS = 125_000;
    chain.utxos = sixPieces().map((u, i) => ({ ...u, value: u.value + (i === 5 ? SURPLUS : 0) }));
    const exact = AGREED_LANOSHIS + SURPLUS;
    // Neither shape works on the old rules, and that was the whole trap.
    expect(SURPLUS).toBeGreaterThan(100_800);            // too much to sweep
    expect(SURPLUS).toBeLessThan(FEE_WHEN_ORDINARY);     // too little for change

    const ref = await acceptedWholeWallet();
    const r = await press(ref);

    expect(r.status).toBe(200);
    expect(chain.broadcast).toHaveLength(1);
    const outs = outputsOf(chain.broadcast[0]);
    // Swept: one output, no change, the fee out of the amount.
    expect(outs).toHaveLength(1);
    expect(outs[0].value).toBe(exact - FEE_WHEN_EMPTYING);
    // AND NEVER MORE THAN WAS AGREED. This is the bound the band is stated on.
    expect(outs[0].value).toBeLessThanOrEqual(AGREED_LANOSHIS);
    expect(failedRows()).toHaveLength(0);
  });

  /**
   * AN ELECTRUM OUTAGE USED TO RESTORE THE BUG IN FULL: no balance and no
   * browser flag meant an ordinary transfer for a whole wallet, short by the
   * fee, eight presses running. The question never needed the balance call.
   */
  it('an electrum balance outage no longer costs the seller eight presses', async () => {
    const ref = await acceptedWholeWallet();
    chain.balanceDown = true;

    const r = await press(ref);
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(true);
    expect(r.body.fee).toBe(FEE_WHEN_EMPTYING);
    expect(failedRows()).toHaveLength(0);
    expect(chain.broadcast).toHaveLength(1);
  });

  /**
   * THE CONSOLIDATION IT ASKED FOR. A sweep must take EVERY input, so the
   * 20-input limit is met far sooner than on an ordinary transfer — and
   * emptying is now the default for whole-wallet sales. The refusal names the
   * cure; caching it made the cure useless.
   */
  it('a wallet in too many pieces is refused, and the consolidation then works', async () => {
    chain.utxos = Array.from({ length: 21 }, (_, i) => ({
      tx_hash: (i + 10).toString().repeat(64).slice(0, 64), tx_pos: 0,
      value: Math.floor(AGREED_LANOSHIS / 21), height: 900 + i,
    }));
    const ref = await acceptedWholeWallet();

    const first = await press(ref);
    expect(first.status).toBe(400);
    expect(first.body.code).toBe('TOO_MANY_UTXOS');
    expect(first.body.error).toContain('Consolidate them with Registrar');
    expect(first.body.error).not.toContain('UTXO');
    expect(first.body.retryable).toBe(true); // not a dead end, and it says so
    expect(chain.broadcast).toHaveLength(0);

    // He does exactly what he was told. Twenty-one pieces become one, and the
    // balance drops only by the fee that cost — far under the 0.01 LANA
    // electrum prints, which is why the old memory could never see it.
    const consolidated = AGREED_LANOSHIS - 4_000; // one consolidation fee lighter
    chain.utxos = [{ tx_hash: 'c'.repeat(64), tx_pos: 0, value: consolidated, height: 1000 }];
    expect(Math.round((consolidated / 100_000_000) * 100) / 100).toBe(PRINTED_LANA);

    const second = await press(ref);
    expect(second.body.repeated).toBeUndefined(); // it reached the chain
    expect(second.status).toBe(200);
    expect(second.body.emptyWallet).toBe(true);
    expect(chain.broadcast).toHaveLength(1);
  });

  it('and a wallet that really is short is still refused once, in LANA, with a row against its offer', async () => {
    const ref = await acceptedWholeWallet();
    // Drained to a quarter after acceptance: less than the mandate, and the
    // route says so before anything is signed.
    chain.utxos = [{ tx_hash: 'd'.repeat(64), tx_pos: 0, value: 80_000_000_000, height: 1000 }];

    const first = await press(ref);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(first.body.error).toContain('3,261.796875 LANA');
    expect(first.body.error).not.toContain('lanoshis');

    for (let i = 0; i < 7; i++) {
      const again = await press(ref);
      expect(again.status).toBe(409);
      expect(again.body.repeated).toBe(true);
    }
    expect(chain.broadcast).toHaveLength(0);
    expect(failedRows()).toHaveLength(0);
  });
});
