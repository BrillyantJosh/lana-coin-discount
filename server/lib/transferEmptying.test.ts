// @vitest-environment node
/**
 * THE TRANSFER THAT FAILED BY EXACTLY ONE NETWORK FEE, EIGHT TIMES.
 *
 * 10 September 2026, from `buyback_transactions.error_message`, identical on
 * all eight rows of one seller's acquisition:
 *
 *     Insufficient funds: need 326179861200 lanoshis, have 326179687500
 *
 * He had offered his WHOLE wallet — 3,261.796875 LANA — so the transfer wanted
 * the amount AND the fee out of a wallet holding exactly the amount. 173,700
 * lanoshis short: the fee, with nowhere to come from.
 *
 * The machinery to send a balance less the fee already existed. What decided
 * to use it was `req.body.emptyWallet`, a flag SubmitOffer keeps in the page
 * and loses with the tab, and it was gone. So this file holds the numbers of
 * that day and asks two things of them:
 *
 *   1. the arithmetic (planTransfer) — that the ordinary plan really is short
 *      by 173,700 lanoshis, and that the emptying plan is not short at all;
 *   2. the route — that the SERVER now recognises the emptying case from the
 *      balance, with the browser saying nothing at all, and that a refusal
 *      which cannot come out differently is issued once, not eight times.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

vi.mock('../db/index.js', async () => {
  const { createMandateTestDb, dbModuleStub } = await import('./roundMandateTestKit');
  return dbModuleStub(createMandateTestDb());
});

import { getDbHandle } from '../db/index.js';
import { createAcquisitionsRouter, OFFERS_SIGNED_PATH } from '../routes/acquisitions';
import { ingestMandateEvent } from './roundMandateSync';
import { createReplayCache } from './requestSignature';
import {
  planTransfer, describePlanFailure, estimateFeeLanoshis, planFailed, planFailurePermanent,
  MAX_TRANSACTION_INPUTS, type UTXO,
} from './transaction';
import { makeKey, mandateEvent, signedHeaders, setSplit, setSetting, setRoundTerms, type TestKey } from './roundMandateTestKit';

// ── the day's numbers ───────────────────────────────────────────────────
/** What Mitja Opalk offered: his whole wallet. */
const AGREED_LANA = 3261.796875;
const AGREED_LANOSHIS = 326_179_687_500;
/** What electrum PRINTS for that wallet: 2dp, i.e. 0.003125 LANA adrift. */
const REPORTED_BALANCE_LANA = 3261.8;
/** Two decimals, the way electrum rounds — for asserting what a figure HIDES. */
const asPrinted = (lana: number) => Math.round(lana * 100) / 100;
/** The six pieces the wallet was in — inputs are what set the fee. */
const PROD_UTXOS: UTXO[] = Array.from({ length: 6 }, (_, i) => ({
  tx_hash: String(i).repeat(64).slice(0, 64),
  tx_pos: 0,
  value: AGREED_LANOSHIS / 6,
  height: 100 + i,
}));
/** From the production message: 326179861200 − 326179687500. */
const FEE_WITH_CHANGE = 173_700;
/** One output instead of two: 34 bytes less, at 100 lanoshis a byte and half again. */
const FEE_WHEN_EMPTYING = 168_600;

describe('planTransfer, on the exact figures of 10 September 2026', () => {
  it('the ordinary plan is short by the fee — the production failure, reproduced', () => {
    const plan = planTransfer({ utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: false });
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan) || plan.code !== 'INSUFFICIENT_FUNDS') throw new Error('expected an insufficient-funds refusal');
    expect(plan).toMatchObject({
      requiredLanoshis: 326_179_861_200,   // the "need" in the error message
      availableLanoshis: 326_179_687_500,  // the "have"
      shortfallLanoshis: FEE_WITH_CHANGE,
      feeLanoshis: FEE_WITH_CHANGE,
    });
    expect(plan.shortfallLanoshis / 100_000_000).toBe(0.001737);
  });

  it('the emptying plan sends the balance less the fee, and is short of nothing', () => {
    const plan = planTransfer({ utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true });
    expect(planFailed(plan)).toBe(false);
    if (planFailed(plan)) return;
    expect(plan.emptyWallet).toBe(true);
    expect(plan.feeLanoshis).toBe(FEE_WHEN_EMPTYING);
    expect(plan.amountLanoshis).toBe(AGREED_LANOSHIS - FEE_WHEN_EMPTYING);
    // Every input, no change: amount + fee is the balance to the lanoshi, so
    // buildSignedTx adds no change output and nothing is left behind.
    expect(plan.selected).toHaveLength(6);
    expect(plan.amountLanoshis + plan.feeLanoshis).toBe(plan.totalBalance);
  });

  it('the fee is one estimate now, not two that can disagree', () => {
    expect(estimateFeeLanoshis(6, 2)).toBe(FEE_WITH_CHANGE);
    expect(estimateFeeLanoshis(6, 1)).toBe(FEE_WHEN_EMPTYING);
  });

  it('emptying never overshoots the mandate it was given, whatever the balance turns out to be', () => {
    // Nothing above the ceiling is swept: told to empty a wallet holding more
    // than the mandate and given nothing to fall back to, the plan refuses.
    const plan = planTransfer({
      utxos: PROD_UTXOS, emptyWallet: true, sweepCeilingLanoshis: AGREED_LANOSHIS - 1,
    });
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan)) return;
    expect(plan.code).toBe('EMPTY_WALLET_EXCEEDS_CEILING');
  });

  /**
   * THE DEAD BAND — the regression the fee fix introduced, on his own numbers.
   *
   * The route decides to empty from electrum's balance, which is rounded to
   * 0.01 LANA, and hands down a ceiling that is exact. A wallet holding
   * 3,261.804 LANA prints as 3,261.80, so the route reads a surplus of
   * 0.003125 LANA — inside the dust it tolerates — and asks for a sweep. The
   * exact total is 0.001117 LANA ABOVE the ceiling, and refusing there marked
   * the offer retryable:false and remembered it: a transfer that would have
   * gone through the ordinary way became a permanent refusal inside a 24-hour
   * window. One small payment arriving after acceptance was enough.
   */
  /**
   * THE OTHER END OF THE SAME RULE — A SWEEP HAD A CEILING AND NO FLOOR.
   *
   * Emptying sent whatever was in the wallet, less the fee, and said ok. It
   * never asked whether "whatever was in the wallet" was anywhere near the
   * amount the treasury had agreed to buy, because the layer above had checked
   * a balance. But the two layers read two different numbers: the route asks
   * electrum for a BALANCE, which is confirmed + unconfirmed, and this layer
   * spends `listunspent`, which is CONFIRMED ONLY.
   *
   * So: a payment into the wallet that never confirms. The route sees it, the
   * proposal is backed, the sweep is authorised — and the chain layer can spend
   * none of it. Before 11 Sept 2026 that swept the one confirmed LANA, returned
   * success, and left the row and the published event both saying 3,261.796875
   * LANA had been acquired at the full purchase price.
   */
  it('a sweep of a wallet that cannot pay what was agreed is refused, not delivered short', () => {
    // One confirmed LANA. The other 3,260 are an incoming payment that never
    // landed — visible to get_balance, unspendable here.
    const utxos: UTXO[] = [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 100_000_000, height: 1 }];
    const plan = planTransfer({
      utxos, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 100_800,
    });
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan)) return;
    expect(plan.code).toBe('INSUFFICIENT_FUNDS');
    // The sentence is about the wallet, in LANA, and names the real gap.
    expect(describePlanFailure(plan).error).toContain('LANA');
    expect((plan as any).shortfallLanoshis).toBe(AGREED_LANOSHIS - 100_000_000);
  });

  it('…but the fee a seller spent getting there is not "short"', () => {
    // He did what an earlier refusal told him to do and consolidated his
    // pieces; the merge cost him a fee, so the wallet is now a hair under the
    // agreed amount. BACKING_TOLERANCE_LANOSHIS is what the route forgives at
    // every step that commits something, so this layer forgives exactly it —
    // one definition, two places, and no wallet the route called backed is
    // refused here as short.
    const short = AGREED_LANOSHIS - 400_000; // 0.004 LANA, inside the tolerance
    const utxos: UTXO[] = [{ tx_hash: 'c'.repeat(64), tx_pos: 0, value: short, height: 1 }];
    const plan = planTransfer({
      utxos, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 100_800,
    });
    expect(planFailed(plan)).toBe(false);
    if (planFailed(plan)) return;
    expect(plan.emptyWallet).toBe(true);
    expect(plan.amountLanoshis).toBe(short - estimateFeeLanoshis(1, 1));
  });

  /**
   * THE PRODUCTION CASE OF 11 SEPTEMBER 2026, AT THIS LAYER.
   *
   * OFF-2026-056: the mandate trimmed the ask to 3,261.796875 LANA and the
   * wallet held 3,261.796875 LANA, in the six pieces below. Asked the ordinary
   * way it is short by the fee for ever; asked as what it is, it goes.
   */
  it('a wallet holding EXACTLY the agreed amount is short the ordinary way and fine swept', () => {
    const ordinary = planTransfer({ utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: false });
    expect(planFailed(ordinary)).toBe(true);
    if (!planFailed(ordinary)) return;
    expect(ordinary.code).toBe('INSUFFICIENT_FUNDS');
    if (ordinary.code === 'INSUFFICIENT_FUNDS') {
      // 0.001737 LANA — the fee, with nowhere to come from. The sentence the
      // seller read on 11 September, to the lanoshi.
      expect(ordinary.shortfallLanoshis).toBe(estimateFeeLanoshis(6, 2));
    }

    const swept = planTransfer({
      utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true,
      sweepCeilingLanoshis: AGREED_LANOSHIS + 100_800,
    });
    expect(planFailed(swept)).toBe(false);
    if (planFailed(swept)) return;
    expect(swept.amountLanoshis).toBe(AGREED_LANOSHIS - estimateFeeLanoshis(6, 1));
  });

  it('a wallet a hair above the sweep ceiling is SENT the ordinary way, not refused', () => {
    const SURPLUS = 712_500; // 0.007125 LANA — invisible at two decimals
    const utxos: UTXO[] = [...PROD_UTXOS, { tx_hash: 'e'.repeat(64), tx_pos: 0, value: SURPLUS, height: 200 }];
    const exactBalance = AGREED_LANOSHIS + SURPLUS;
    const ceiling = AGREED_LANOSHIS + 100_800 + 500_000; // agreed + dust + rounding
    expect(exactBalance).toBeGreaterThan(ceiling);         // the sweep cannot happen
    expect(asPrinted(exactBalance / 100_000_000)).toBe(REPORTED_BALANCE_LANA); // and electrum cannot see why

    const plan = planTransfer({
      utxos, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true, sweepCeilingLanoshis: ceiling,
    });
    expect(planFailed(plan)).toBe(false);
    if (planFailed(plan)) return;
    // Not swept — sent. The agreed amount and not one lanoshi more; the fee
    // comes out of the change, which is what the wallet has to spare.
    expect(plan.emptyWallet).toBe(false);
    expect(plan.amountLanoshis).toBe(AGREED_LANOSHIS);
    expect(plan.totalSelected).toBeGreaterThanOrEqual(AGREED_LANOSHIS + plan.feeLanoshis);
  });

  it('TOO_MANY_UTXOS is not a permanent refusal — its own sentence asks for a consolidation', () => {
    const many: UTXO[] = Array.from({ length: 21 }, (_, i) => ({
      tx_hash: String(i + 10).repeat(64).slice(0, 64), tx_pos: 0, value: 100_000_000_000, height: i,
    }));
    const plan = planTransfer({ utxos: many, amountLanoshis: AGREED_LANOSHIS, emptyWallet: true });
    if (!planFailed(plan)) throw new Error('expected a refusal');
    expect(plan.code).toBe('TOO_MANY_UTXOS');
    expect(describePlanFailure(plan).error).toContain('Consolidate them with Registrar');
    expect(describePlanFailure(plan).error).not.toContain('TOO_MANY_UTXOS');
    expect(planFailurePermanent(plan)).toBe(false);
    // The one refusal above that IS about the balance stays permanent.
    const short = planTransfer({ utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: false });
    if (!planFailed(short)) throw new Error('expected a refusal');
    expect(planFailurePermanent(short)).toBe(true);
  });

  it('a wallet that is genuinely short says so, and says it in LANA', () => {
    const utxos: UTXO[] = [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 100_000_000, height: 1 }];
    const plan = planTransfer({ utxos, amountLanoshis: AGREED_LANOSHIS, emptyWallet: false });
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan)) return;
    expect(plan.code).toBe('INSUFFICIENT_FUNDS');
    const said = describePlanFailure(plan).error;
    expect(said).not.toContain('lanoshis');
    expect(said).toContain('LANA');
  });

  it('the sentence a person is shown carries no lanoshi arithmetic', () => {
    const plan = planTransfer({ utxos: PROD_UTXOS, amountLanoshis: AGREED_LANOSHIS, emptyWallet: false });
    if (!planFailed(plan)) throw new Error('expected a refusal');
    const said = describePlanFailure(plan).error;
    expect(said).not.toContain('326179861200');
    expect(said).toContain('0.001737 LANA');
    expect(said).toContain('network fee');
  });
});

// ── the route ───────────────────────────────────────────────────────────

const db: Database.Database = getDbHandle();
const lanapays = makeKey();
const seller = makeKey();
const W1 = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const TREASURY = 'LTreasuryWalletXXXXXXXXXXXXXXXXXXX';

/** Time, so the ten-minute life of a remembered refusal can be walked past. */
const clock = { skewSeconds: 0 };

const world = {
  /** What the wallet EXACTLY holds, in LANA. */
  balance: AGREED_LANA as number | null,
  /**
   * Whether electrum carries the exact integer through beside the printed
   * figure. True is what the servers answer since 10 Sept 2026; false is the
   * old shape, where the only number available was rounded to 0.01 LANA.
   */
  exactBalance: true,
  sent: [] as any[],
  /** What the injected chain answers; success unless a test says otherwise. */
  result: { success: true, txHash: 'ab'.repeat(32), fee: FEE_WHEN_EMPTYING } as any,
};

const app = express();
app.use(express.json());
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: 'http://check.test',
  publishBuybackEvent: async () => undefined,
  checkSellerEligibility: async () => ({
    ok: true, walletType: 'LanaPays.Us', walletClass: 'lanapays', evidence: { splitCode: 'OK' },
  }) as any,
  fetchUserWallets: async () => [{ walletId: W1, walletType: 'LanaPays.Us' }] as any,
  fetchBatchBalances: async (_s, addresses) => {
    if (world.balance === null) throw new Error('electrum down');
    const exact = Math.round((world.balance as number) * 100_000_000);
    return addresses.map(a => ({
      wallet_id: a,
      // The figure electrum has always printed: LANA, two decimals.
      balance: asPrinted(exact / 100_000_000),
      // And the one it now carries beside it: the chain's own integer.
      ...(world.exactBalance ? { balanceLanoshis: exact } : {}),
      status: 'active',
    }));
  },
  sendLanaTransaction: async (args) => { world.sent.push(args); return world.result; },
  now: () => Math.floor(Date.now() / 1000) + clock.skewSeconds,
  replayCache: createReplayCache(),
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
  world.balance = AGREED_LANA;
  world.exactBalance = true;
  clock.skewSeconds = 0;
  world.sent = [];
  world.result = { success: true, txHash: 'ab'.repeat(32), fee: FEE_WHEN_EMPTYING };
  setSplit(db, 9, { EUR: 0.256 });
  setSetting(db, 'active_currencies', '["EUR"]');
  setSetting(db, 'acq_EUR_enabled', 'true');
  setSetting(db, 'acq_EUR_lanapays_enabled', 'true');
  setSetting(db, 'acq_EUR_lanapays_auto_cap', '');
  setSetting(db, 'acq_EUR_lanapays_due_days', '15');
  setSetting(db, 'buyback_wallet_id', TREASURY);
  // The mandate is exactly what he offered: the whole wallet.
  const e = mandateEvent(lanapays, {
    split: 8, round: 1, hex: seller.pub,
    wallets: [{ address: W1, currency: 'EUR', lana: String(AGREED_LANA), fundSettingId: '52' }],
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
const signedPost = (path: string, body: any, key: TestKey = seller) =>
  post(path, body, signedHeaders(key, 'POST', path, nowSec(), body));

/** A proposal for the whole wallet, accepted — the state the transfer starts from. */
const acceptedWholeWallet = async (lana = AGREED_LANA) => {
  const body = { hexId: seller.pub, senderAddress: W1, lanaAmount: lana, currency: 'EUR' };
  const made = await post('/api/acquisitions/offers', body, signedHeaders(seller, 'POST', OFFERS_SIGNED_PATH, nowSec(), body));
  expect(made.status).toBe(200);
  expect(made.body.offer.status).toBe('offered');
  const ref = made.body.offer.offerRef as string;
  expect((await signedPost(`/api/acquisitions/${ref}/accept`, { hexId: seller.pub })).status).toBe(200);
  return ref;
};

/** The transfer as a browser that has forgotten everything sends it. */
const transfer = (ref: string, over: Record<string, unknown> = {}) =>
  post(`/api/acquisitions/${ref}/transfer`, { hexId: seller.pub, privateKey: 'k', ...over });

const failedRows = () =>
  db.prepare("SELECT * FROM buyback_transactions WHERE status = 'failed'").all() as any[];

describe('POST /:ref/transfer — the server decides the emptying', () => {
  it('a whole-wallet offer empties the wallet even though the browser said nothing', async () => {
    const ref = await acceptedWholeWallet();
    const r = await transfer(ref); // no emptyWallet: the tab was closed and reopened
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(true);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0].emptyWallet).toBe(true);
    // The agreed amount goes down WITH the sweep instruction: it is what the
    // chain layer falls back to if the exact wallet sits above the ceiling.
    expect(world.sent[0].amount).toBe(AGREED_LANA);
  });

  it('…and hands the chain the mandate as a ceiling, in exact lanoshis', async () => {
    const ref = await acceptedWholeWallet();
    await transfer(ref);
    // agreed + three network fees. NO rounding slack: electrum carried the
    // exact integer through, so there is nothing to be uncertain about.
    expect(world.sent[0].sweepCeilingLanoshis).toBe(AGREED_LANOSHIS + 100_800);
    expect(world.sent[0].sweepCeilingLanoshis).toBeGreaterThan(AGREED_LANOSHIS);
  });

  it('…and widens that ceiling by the rounding, and only then, if the exact figure is missing', async () => {
    world.exactBalance = false; // an electrum that answers only in 2dp LANA
    const ref = await acceptedWholeWallet();
    await transfer(ref);
    expect(world.sent[0].sweepCeilingLanoshis).toBe(AGREED_LANOSHIS + 100_800 + 500_000);
  });

  /**
   * THE DEAD BAND, THROUGH THE ROUTE. A payment of 0.007125 LANA lands after
   * acceptance. Electrum prints 3,261.80 either way, so the rounded reading
   * says "close enough, sweep it" — and the sweep is then impossible. The
   * exact reading sees the surplus and never asks for a sweep at all.
   */
  it('a wallet a hair above the agreed amount is sent the ordinary way, not swept', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = AGREED_LANA + 0.007125;
    expect(asPrinted(world.balance)).toBe(REPORTED_BALANCE_LANA); // the printed figure did not move
    const r = await transfer(ref);
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(false);
    expect(world.sent[0].emptyWallet).toBe(false);
    expect(world.sent[0].amount).toBe(AGREED_LANA);
  });

  it('a sweep the chain turned into an ordinary transfer is REPORTED as one', async () => {
    const ref = await acceptedWholeWallet();
    // The chain layer fell back: it was asked to empty and sent instead.
    world.result = { success: true, txHash: 'ab'.repeat(32), fee: FEE_WITH_CHANGE, emptyWallet: false };
    const r = await transfer(ref);
    expect(r.status).toBe(200);
    expect(world.sent[0].emptyWallet).toBe(true);  // what we asked for
    expect(r.body.emptyWallet).toBe(false);        // what actually happened
  });

  it('the browser asking to empty a wallet that holds more is still refused', async () => {
    const ref = await acceptedWholeWallet(1000);
    world.balance = 3261.8; // far more than the 1000 agreed
    const r = await transfer(ref, { emptyWallet: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMPTY_WALLET_EXCEEDS_MANDATE');
    expect(world.sent).toHaveLength(0);
  });

  it('a wallet that holds more is not emptied by the server either — the agreed amount moves', async () => {
    const ref = await acceptedWholeWallet(1000);
    world.balance = 3261.8;
    const r = await transfer(ref); // browser silent
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(false);
    expect(world.sent[0].emptyWallet).toBe(false);
    expect(world.sent[0].amount).toBe(1000);
    expect(world.sent[0].sweepCeilingLanoshis).toBeUndefined();
  });

  it('an unreadable balance is still not permission to empty when the browser ASKS for it', async () => {
    const ref = await acceptedWholeWallet(1000);
    world.balance = null;
    const r = await transfer(ref, { emptyWallet: true });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('BALANCE_UNVERIFIABLE');
    expect(world.sent).toHaveLength(0);
  });

  /**
   * AN ELECTRUM OUTAGE USED TO RESTORE THE 10 SEPT BUG IN FULL.
   *
   * With no balance and no browser flag, a whole-wallet offer fell through to
   * an ordinary transfer and failed by the fee — the original eight rows, all
   * over again, every time electrum blinked. But "is this wallet being
   * emptied?" never needed electrum's balance call: it needs the UTXOs, and
   * the layer below is about to read them anyway. So the question goes down
   * with the ceiling instead of being guessed here.
   */
  it('an unreadable balance hands the emptying to the layer that reads the exact UTXOs', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = null;
    const r = await transfer(ref); // the browser has forgotten everything
    expect(r.status).toBe(200);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0].emptyWallet).toBe(true);
    expect(world.sent[0].sweepCeilingLanoshis).toBe(AGREED_LANOSHIS + 100_800 + 500_000);
    // …and the agreed amount travels with it, so a wallet found to hold more
    // is SENT rather than refused, without a balance ever being read.
    expect(world.sent[0].amount).toBe(AGREED_LANA);
  });

  it('…and the mandate is still the ceiling on what may be swept during an outage', async () => {
    const ref = await acceptedWholeWallet(1000);
    world.balance = null;
    const r = await transfer(ref);
    expect(r.status).toBe(200);
    // The wallet is unreadable, so the sweep is proposed — but bounded by the
    // 1,000 LANA agreed, never by the wallet. A wallet holding 3,261 is above
    // that ceiling and the chain layer sends the 1,000 instead.
    expect(world.sent[0].sweepCeilingLanoshis).toBe(100_000_000_000 + 100_800 + 500_000);
    expect(world.sent[0].amount).toBe(1000);
  });
});

describe('a refusal that cannot come out differently is issued once', () => {
  it('a wallet drained after acceptance is refused in words, before the chain, and only once', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = 12.5; // the coins went somewhere else in the meantime

    const first = await transfer(ref);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(first.body.retryable).toBe(false);
    expect(first.body.error).toContain('3,261.796875 LANA');
    expect(first.body.error).not.toContain('lanoshis');
    expect(world.sent).toHaveLength(0);
    expect(failedRows()).toHaveLength(0);

    // Seven more presses of the same button — the eight rows of 10 September.
    for (let i = 0; i < 7; i++) {
      const again = await transfer(ref);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(again.body.repeated).toBe(true);
    }
    expect(world.sent).toHaveLength(0);
    expect(failedRows()).toHaveLength(0);
  });

  it('a deterministic refusal from the chain is written down once, against its offer', async () => {
    const ref = await acceptedWholeWallet();
    world.result = {
      success: false,
      error: 'There is not enough LANA in this wallet: … Nothing has moved.',
      code: 'INSUFFICIENT_FUNDS',
      retryable: false,
    };

    const first = await transfer(ref);
    expect(first.status).toBe(400);
    expect(first.body.retryable).toBe(false);
    expect(world.sent).toHaveLength(1);
    const rows = failedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].offer_ref).toBe(ref); // attributable, which the eight rows were not

    const second = await transfer(ref);
    expect(second.status).toBe(400);
    expect(second.body.repeated).toBe(true);
    expect(second.body.error).toBe(first.body.error);
    expect(world.sent).toHaveLength(1); // the chain was not asked again
    expect(failedRows()).toHaveLength(1); // and no second row was written
  });

  it('a wallet that moves earns a fresh attempt', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = 12.5;
    expect((await transfer(ref)).status).toBe(409);
    expect((await transfer(ref)).body.repeated).toBe(true);

    world.balance = AGREED_LANA; // topped back up
    const r = await transfer(ref);
    expect(r.status).toBe(200);
    expect(r.body.emptyWallet).toBe(true);
    expect(world.sent).toHaveLength(1);
  });

  /**
   * THE GUARD MUST SEE THE REMEDY IT ASKS FOR.
   *
   * The fingerprint was electrum's 2dp balance, so any wallet change under
   * 0.01 LANA left it identical — including the 0.001737 LANA top-up the fee
   * message itself tells the seller to make. He did exactly what he was told
   * and was answered from memory with the same sentence, no chain call, no way
   * through, inside a 24-hour window. The print is the exact integer now.
   */
  it('a top-up smaller than electrum PRINTS still earns a fresh attempt', async () => {
    const ref = await acceptedWholeWallet();
    world.result = {
      success: false,
      error: 'There is not enough LANA in this wallet: … 0.001737 LANA short. Nothing has moved.',
      code: 'INSUFFICIENT_FUNDS', retryable: false,
      detail: { code: 'INSUFFICIENT_FUNDS', totalBalance: AGREED_LANOSHIS },
    };

    expect((await transfer(ref)).status).toBe(400);
    expect((await transfer(ref)).body.repeated).toBe(true);
    expect(world.sent).toHaveLength(1);

    // He tops up by the fee the message named — 0.001737 LANA.
    const before = world.balance as number;
    world.balance = before + 0.002;
    // The figure electrum PRINTS has not moved: the old fingerprint was blind.
    expect(asPrinted(world.balance)).toBe(asPrinted(before));

    world.result = { success: true, txHash: 'ab'.repeat(32), fee: FEE_WHEN_EMPTYING };
    const r = await transfer(ref);
    expect(r.body.repeated).toBeUndefined();
    expect(r.status).toBe(200);
    expect(world.sent).toHaveLength(2); // the chain WAS asked again
  });

  it('a rounded-only balance is not written down at all — too coarse to see a cure', async () => {
    world.exactBalance = false;
    const ref = await acceptedWholeWallet();
    world.balance = 12.5;
    expect((await transfer(ref)).status).toBe(409);
    // Refused again, in words — but freshly each time, never from a memory
    // that could not notice him fixing it.
    const again = await transfer(ref);
    expect(again.status).toBe(409);
    expect(again.body.repeated).toBeUndefined();
  });

  /**
   * TOO_MANY_UTXOS IS NOT A BALANCE PROBLEM, so no balance-keyed memory may
   * hold it. Its own sentence tells the seller to consolidate; consolidating
   * costs a single fee, moves the UTXO count and barely moves the balance.
   * Remembering it locked him out of the very fix we asked him for — and the
   * emptying path, which is now the default for whole-wallet sales, is exactly
   * where a >20-UTXO wallet meets it.
   */
  it('TOO_MANY_UTXOS is never remembered, however the chain labels it', async () => {
    const ref = await acceptedWholeWallet();
    world.result = {
      success: false,
      error: 'TOO_MANY_UTXOS: Your wallet has 42 UTXOs but the maximum per transaction is 20. Please consolidate your wallet using Registrar before sending.',
      code: 'TOO_MANY_UTXOS',
      retryable: false, // even mislabelled as permanent, it must not stick
      detail: { code: 'TOO_MANY_UTXOS', totalBalance: AGREED_LANOSHIS },
    };
    expect((await transfer(ref)).status).toBe(400);

    // He consolidates 42 pieces into one. The balance drops by a single fee —
    // far under the 0.01 LANA electrum prints — and the transfer now works.
    world.balance = (world.balance as number) - 0.000336;
    world.result = { success: true, txHash: 'ab'.repeat(32), fee: FEE_WHEN_EMPTYING };
    const r = await transfer(ref);
    expect(r.body.repeated).toBeUndefined();
    expect(r.status).toBe(200);
    expect(world.sent).toHaveLength(2);
  });

  it('…and not even on an unchanged wallet, where nothing could have moved', async () => {
    const ref = await acceptedWholeWallet();
    world.result = {
      success: false, error: 'TOO_MANY_UTXOS: …consolidate…', code: 'TOO_MANY_UTXOS',
      retryable: false, detail: { code: 'TOO_MANY_UTXOS', totalBalance: AGREED_LANOSHIS },
    };
    await transfer(ref);
    const second = await transfer(ref);
    expect(second.body.repeated).toBeUndefined();
    expect(world.sent).toHaveLength(2); // the consolidation is always allowed to prove itself
  });

  /**
   * EIGHT PRESSES DURING AN ELECTRUM OUTAGE. There is no balance to fingerprint
   * with, but the refused plan carries the chain's own UTXO total, which is
   * exact — so the storm still collapses to one row.
   */
  it('a hopeless transfer during an outage is still only attempted once', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = null;
    world.result = {
      success: false, error: 'There is not enough LANA in this wallet: … Nothing has moved.',
      code: 'INSUFFICIENT_FUNDS', retryable: false,
      detail: { code: 'INSUFFICIENT_FUNDS', totalBalance: 1_250_000_000 },
    };

    expect((await transfer(ref)).status).toBe(400);
    for (let i = 0; i < 7; i++) {
      const again = await transfer(ref);
      expect(again.status).toBe(400);
      expect(again.body.repeated).toBe(true);
    }
    expect(world.sent).toHaveLength(1);
    expect(failedRows()).toHaveLength(1);
  });

  it('a memory does not outlive its ten minutes', async () => {
    const ref = await acceptedWholeWallet();
    world.balance = 12.5;
    expect((await transfer(ref)).status).toBe(409);
    expect((await transfer(ref)).body.repeated).toBe(true);

    clock.skewSeconds = 601; // ten minutes and one second later
    const after = await transfer(ref);
    expect(after.status).toBe(409);
    expect(after.body.repeated).toBeUndefined(); // asked afresh, not from memory
  });

  it('a refusal that MIGHT come out differently is not remembered', async () => {
    const ref = await acceptedWholeWallet();
    world.result = { success: false, error: 'Transaction broadcast failed - no result' };

    expect((await transfer(ref)).status).toBe(400);
    const second = await transfer(ref);
    expect(second.status).toBe(400);
    expect(second.body.repeated).toBeUndefined();
    expect(world.sent).toHaveLength(2); // a broadcast is allowed a second try
  });
});

/**
 * The order of two refusals, which is not a detail.
 *
 * When the balance cannot be read the route assumes a sweep, because a sweep is
 * the case that fails by a fee. But `planTransfer` refused on the UTXO count
 * BEFORE asking whether this was a sweep at all — so during an electrum outage a
 * seller moving 100 LANA out of a 5,000 LANA wallet was told to consolidate all
 * 5,000, for a transfer that needed one input. Each press wrote another failed
 * row: the original eight-rows complaint, reopened by a different door.
 */
describe('a wallet in many pieces, when only part of it is being sold', () => {
  const pieces = (count: number, each: number): UTXO[] =>
    Array.from({ length: count }, (_, i) => ({
      tx_hash: String(i + 40).repeat(64).slice(0, 64), tx_pos: 0, value: each, height: 100 + i,
    }));

  it('does not demand consolidation for an amount one input could carry', () => {
    // 25 pieces of 200 LANA = 5,000. Selling 100, ceiling says it is no sweep.
    const plan = planTransfer({
      utxos: pieces(25, 200 * 100_000_000),
      amountLanoshis: 100 * 100_000_000,
      emptyWallet: true,
      sweepCeilingLanoshis: 101 * 100_000_000,
    });
    expect(plan.ok, planFailed(plan) ? `refused with ${plan.code}` : '').toBe(true);
    if (!planFailed(plan)) {
      expect(plan.selected.length).toBeLessThanOrEqual(MAX_TRANSACTION_INPUTS);
      // An ordinary transfer, not a sweep: it moves the agreed amount and no more.
      expect(plan.emptyWallet).toBe(false);
      expect(plan.amountLanoshis).toBe(100 * 100_000_000);
    }
  });

  it('still refuses when the sweep is genuine and really cannot fit', () => {
    // No ceiling to fall back on: this IS a sweep, and 25 pieces will not fit.
    const plan = planTransfer({ utxos: pieces(25, 200 * 100_000_000), emptyWallet: true });
    expect(planFailed(plan)).toBe(true);
    if (planFailed(plan)) expect(plan.code).toBe('TOO_MANY_UTXOS');
  });

  it('refuses a genuine sweep on the count even when a ceiling is given and not exceeded', () => {
    const plan = planTransfer({
      utxos: pieces(25, 200 * 100_000_000),
      emptyWallet: true,
      sweepCeilingLanoshis: 6000 * 100_000_000,
    });
    expect(planFailed(plan)).toBe(true);
    if (planFailed(plan)) expect(plan.code).toBe('TOO_MANY_UTXOS');
  });
});
