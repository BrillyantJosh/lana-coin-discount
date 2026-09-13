// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createMandateTestDb, makeKey, mandateEvent, setRoundTerms, setSetting, setSplit } from './roundMandateTestKit';
import { ingestMandateEvent } from './roundMandateSync';
import { BUDGET_SETTLEMENT_SCHEMA_SQL } from '../db/roundMandateSchema';
import { publishBudgetSettlements, sqliteTimeToUnix, pubkeyOf, type Publish } from './budgetSettlementPublisher';
import { verifyEventSignature, type NostrEvent } from './nostr';

const LANA = 100_000_000;
const W1 = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const W2 = 'LdY5W1Qm6xXoTmr3hjCkGyeJ7YqTx6Zv4t';
const processor = makeKey();
const financer = makeKey();
const discountKey = Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

let db: Database.Database;
let sent: NostrEvent[];
let relayAnswer: 'ok' | 'none';
const publish: Publish = async (event) => {
  sent.push(event);
  return relayAnswer === 'ok' ? { success: ['wss://relay.test'], failed: [] } : { success: [], failed: ['wss://relay.test'] };
};
const run = (now = 1_789_300_000, limit?: number) =>
  publishBudgetSettlements(db, { privateKeyHex: discountKey, relays: [], now, limit, publish });
const tag = (e: NostrEvent, name: string) => e.tags.find(t => t[0] === name)?.[1];

function announce(split: number, round: number, wallets: Array<{ address: string; lana: string; fundSettingId: string; currency?: string }>, createdAt = 1_757_000_000) {
  const e = mandateEvent(processor, {
    split, round, hex: financer.pub, createdAt,
    wallets: wallets.map(w => ({ address: w.address, currency: w.currency || 'EUR', lana: w.lana, fundSettingId: w.fundSettingId })),
  });
  const r = ingestMandateEvent(db, e, { authorizedPubkey: processor.pub });
  if (!r.stored) throw new Error(r.reason);
}

function closeMandate(split: number, round: number, createdAt: number) {
  const e = mandateEvent(processor, { split, round, hex: financer.pub, wallets: [], status: 'closed', createdAt });
  const r = ingestMandateEvent(db, e, { authorizedPubkey: processor.pub });
  if (!r.stored) throw new Error(r.reason);
}

let offerSeq = 0;
function sell(opts: { wallet?: string; lana: number; net: number; status?: 'accepted' | 'settled'; txStatus?: string; round?: number }) {
  const ref = `OFF-2026-${String(++offerSeq).padStart(3, '0')}`;
  const round = opts.round ?? 1;
  let txId: number | null = null;
  if ((opts.status ?? 'settled') === 'settled') {
    txId = Number(db.prepare(`INSERT INTO buyback_transactions (user_hex_id, sender_wallet_id, buyback_wallet_id, lana_amount_lanoshis, lana_amount_display,
        currency, exchange_rate, split, gross_fiat, commission_percent, commission_fiat, net_fiat, tx_hash, status, completed_at, offer_ref, lana_received_lanoshis)
        VALUES (?, ?, 'LTreasury', ?, ?, 'EUR', 0.256, '9', ?, 22, ?, ?, ?, ?, '2026-09-12 17:59:10', ?, ?)`)
      .run(financer.pub, opts.wallet ?? W1, opts.lana * LANA, opts.lana, opts.net / 0.78, opts.net / 0.78 - opts.net, opts.net,
        'f'.repeat(64), opts.txStatus ?? 'completed', ref, opts.lana * LANA - 20000).lastInsertRowid);
  }
  db.prepare(`INSERT INTO acquisition_offers (offer_ref, user_hex_id, sender_wallet_id, wallet_class, lana_amount_lanoshis, lana_amount_display,
      currency, status, reference_rate, discount_percent, purchase_price_fiat, gross_fiat, accepted_at, transaction_id, mandate_ref, round)
      VALUES (?, ?, ?, 'lanapays', ?, ?, 'EUR', ?, 0.256, 22, ?, ?, '2026-09-12 17:49:58', ?, ?, ?)`)
    .run(ref, financer.pub, opts.wallet ?? W1, opts.lana * LANA, opts.lana, opts.status ?? 'settled', opts.net, opts.net / 0.78, txId, `8:${round}:${financer.pub}`, round);
  return { ref, txId };
}

let payoutSeq = 300;
function pay(txId: number, amount: number, when = '2026-09-13 10:35:03') {
  const id = `PAY-2026-${++payoutSeq}`;
  db.prepare(`INSERT INTO sale_payouts (transaction_id, payout_id, amount, currency, paid_to_account, note, paid_at)
              VALUES (?, ?, ?, 'EUR', 'SI56 0204 5106 2428 193', 'internal remark', ?)`).run(txId, id, amount, when);
  return id;
}

beforeEach(() => {
  db = createMandateTestDb();
  db.exec(BUDGET_SETTLEMENT_SCHEMA_SQL);
  db.exec(`CREATE TABLE sale_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL, payout_id TEXT NOT NULL,
           amount REAL NOT NULL, currency TEXT NOT NULL, paid_to_account TEXT, reference TEXT, note TEXT,
           paid_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')))`);
  setSplit(db, 9, { EUR: 0.256 });
  setSetting(db, 'min_sell_eur', '5');
  setRoundTerms(db, 8, 1, 1_788_969_420, 22);
  sent = [];
  relayAnswer = 'ok';
  offerSeq = 0;
});

describe('reading the database', () => {
  it("reads SQLite's UTC timestamps as UTC", () => {
    expect(sqliteTimeToUnix('2026-09-13 10:35:03')).toBe(Date.UTC(2026, 8, 13, 10, 35, 3) / 1000);
    expect(sqliteTimeToUnix('2026-09-09T15:57:00.000Z')).toBe(1_788_969_420);
    expect(sqliteTimeToUnix(null)).toBeNull();
  });
});

describe('publishing every budget', () => {
  it('publishes one signed KIND 30961 per budget, even one nobody has sold from', async () => {
    announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }, { address: W2, lana: '500', fundSettingId: '53', currency: 'GBP' }]);
    const r = await run();
    expect(r.published.sort()).toEqual(['8:1:52', '8:1:53']);
    expect(sent).toHaveLength(2);
    for (const e of sent) {
      expect(e.kind).toBe(30961);
      expect(e.pubkey).toBe(pubkeyOf(discountKey));
      expect(verifyEventSignature(e)).toBe(true);
    }
    const e52 = sent.find(e => tag(e, 'd') === '8:1:52')!;
    expect(e52.tags).toContainEqual(['a', `30938:${'d'.repeat(64)}:52`]);
    expect(e52.tags).toContainEqual(['a', `30960:${processor.pub}:8:1:${financer.pub}`]);
    expect(tag(e52, 'opens_at')).toBe('1788969420');
    expect(tag(e52, 'acquisition')).toBe('none');
  });

  it('links each sale and each payment, and leaves the bank account and the note out', async () => {
    announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }]);
    const s = sell({ lana: 1000, net: 199.68, txStatus: 'paid' });
    const payoutId = pay(s.txId!, 199.68);
    await run();
    const e = sent[0];
    const signer = pubkeyOf(discountKey);
    expect(e.tags).toContainEqual(['a', `30936:${signer}:${s.txId}`]);
    expect(e.tags).toContainEqual(['a', `30937:${signer}:${payoutId}`]);
    expect(e.tags.find(t => t[0] === 'sale')?.slice(1, 3)).toEqual([s.ref, 'confirmed']);
    expect(tag(e, 'paid_percent')).toBe('100.00');
    expect(tag(e, 'payment')).toBe('full');
    expect(JSON.stringify(e)).not.toContain('SI56');
    expect(JSON.stringify(e)).not.toContain('internal remark');
  });

  it('a sale that is only agreed is in progress, with no transaction to link', async () => {
    announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }]);
    sell({ lana: 400, net: 79.87, status: 'accepted' });
    await run();
    expect(tag(sent[0], 'lana_in_progress_lanoshis')).toBe(String(400 * LANA));
    expect(sent[0].tags.find(t => t[0] === 'sale')?.[2]).toBe('accepted');
  });
});

describe('sending only what changed', () => {
  beforeEach(() => announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }]));

  it('a second run with nothing new sends nothing', async () => {
    await run(1_789_300_000);
    const again = await run(1_789_300_060);
    expect(again).toMatchObject({ published: [], unchanged: 1 });
    expect(sent).toHaveLength(1);
  });

  it('a recorded payment republishes that budget, later than before', async () => {
    const s = sell({ lana: 1000, net: 199.68 });
    await run(1_789_300_000);
    pay(s.txId!, 100);
    const r = await run(1_789_300_000);
    expect(r.published).toEqual(['8:1:52']);
    expect(sent[1].created_at).toBe(1_789_300_001);
    expect(sent[1].tags.find(x => x[0] === 'fiat_paid')).toEqual(['fiat_paid', 'EUR', '100.00']);
    expect(tag(sent[1], 'payment')).toBe('partly');
  });

  it('a publish no relay accepted is tried again next time', async () => {
    relayAnswer = 'none';
    expect((await run()).failed).toEqual(['8:1:52']);
    relayAnswer = 'ok';
    expect((await run()).published).toEqual(['8:1:52']);
    expect((await run()).published).toEqual([]);
  });

  it('never sends more than the limit in one run; the rest wait', async () => {
    announce(8, 2, [{ address: W2, lana: '10', fundSettingId: '60' }]);
    const first = await run(1_789_300_000, 1);
    expect(first).toMatchObject({ deferred: 1 });
    expect(first.published).toHaveLength(1);
    expect((await run(1_789_300_060, 1)).published).toHaveLength(1);
  });
});

describe('a budget outlives its mandate row', () => {
  /**
   * The brain closes a mandate one split after its window; the payment for a
   * sale made on the last day can still arrive fifteen days later.
   */
  it('a payment after the mandate closed still reaches the budget, marked closed', async () => {
    announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }]);
    const s = sell({ lana: 1000, net: 199.68 });
    await run(1_789_300_000);
    closeMandate(8, 1, 1_757_000_100);
    pay(s.txId!, 199.68);
    const r = await run(1_789_400_000);
    expect(r.published).toEqual(['8:1:52']);
    const last = sent[sent.length - 1];
    expect(tag(last, 'mandate_status')).toBe('closed');
    expect(tag(last, 'lana_received')).toBe('1000.00000000');
    expect(tag(last, 'paid_percent')).toBe('100.00');
  });

  /** Rok Bele: a lost key, the budget moved to a new wallet mid-split. */
  it('a budget moved to a new wallet keeps the sales from the old one', async () => {
    announce(8, 1, [{ address: W1, lana: '1000', fundSettingId: '52' }], 1_757_000_000);
    sell({ lana: 300, net: 59.9 });
    await run(1_789_300_000);
    announce(8, 1, [{ address: W2, lana: '1000', fundSettingId: '52' }], 1_757_000_200);
    await run(1_789_300_100);
    const last = sent[sent.length - 1];
    expect(tag(last, 'wallet')).toBe(W2);
    expect(last.tags.filter(t => t[0] === 'sale')).toHaveLength(1);
    expect(tag(last, 'acquired_percent')).toBe('30.00');
  });
});
