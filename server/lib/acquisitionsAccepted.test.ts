// @vitest-environment node
/**
 * GET /api/acquisitions/admin/accepted — THE TWO CLOCKS, KEPT APART.
 *
 * The screen this feeds exists because an accepted offer has two deadlines
 * that point at different people and mean opposite things:
 *
 *   the SELLER's window to transfer — miss it and the acquisition never
 *   happens, so nothing is owed;
 *   the TREASURY's own settlement date — miss it and we are late paying for
 *   LANA we already hold.
 *
 * A single field called "expires" would be read as whichever of those the
 * reader had in mind. So the properties pinned here are not about layout: the
 * two moments come back under two names, the endpoint says which is nearer,
 * the seller's horizon is the one `sellerActionDeadline` computes (24 h after
 * acceptance on a mandate-bound row, NOT the 8-day offer window it was
 * accepted inside), and the money that is not owed — a row whose transfer
 * window has already closed — is kept out of the total rather than swelling
 * it.
 *
 * Rows are written straight into the table rather than driven through
 * /offers → /accept: what is under test is a read, and a fixture that states
 * the row it means cannot be moved by a change to how offers are priced.
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
import { createAcquisitionsRouter } from '../routes/acquisitions';
import { ACCEPTED_TRANSFER_WINDOW_HOURS } from './acquisitionOffer';
import { createReplayCache } from './requestSignature';

const db: Database.Database = getDbHandle();
const ADMIN = 'c'.repeat(64);
const SELLER = 'a'.repeat(64);
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const LANOSHI = 100_000_000;

const app = express();
app.use(express.json());
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: 'http://check.test',
  publishBuybackEvent: async () => undefined,
  fetchBatchBalances: async (_s, addresses) => addresses.map(a => ({ wallet_id: a, balance: 1_000_000, status: 'active' })),
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
  db.prepare('DELETE FROM acquisition_offers').run();
  db.prepare('DELETE FROM admin_users').run();
  db.prepare("INSERT INTO admin_users (hex_id, label) VALUES (?, 'test')").run(ADMIN);
});
afterAll(() => new Promise<void>(r => server?.close(() => r())));

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers }).then(async r => ({ status: r.status, body: await r.json() as any }));

const list = () => get('/api/acquisitions/admin/accepted', { 'x-admin-hex-id': ADMIN });

/** `YYYY-MM-DD HH:MM:SS` UTC, the only shape this table holds. */
const at = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface OfferFixture {
  ref?: string;
  status?: string;
  currency?: string;
  lana?: number;
  price?: number | null;
  acceptedAt?: string | null;
  offerExpiresAt?: string | null;
  settlementDueAt?: string | null;
  mandateRef?: string | null;
  round?: number | null;
  transactionId?: number | null;
}

let seq = 0;
function insert(o: OfferFixture = {}): string {
  const ref = o.ref ?? `OFF-T-${++seq}`;
  const lana = o.lana ?? 1000;
  db.prepare(`
    INSERT INTO acquisition_offers (
      offer_ref, user_hex_id, sender_wallet_id, wallet_class,
      lana_amount_lanoshis, lana_amount_display, currency, status,
      purchase_price_fiat, settlement_due_at, offer_expires_at, accepted_at,
      mandate_ref, round, transaction_id
    ) VALUES (?, ?, ?, 'lanapays', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref, SELLER, WALLET,
    Math.round(lana * LANOSHI), lana, o.currency ?? 'EUR', o.status ?? 'accepted',
    o.price === undefined ? 100 : o.price,
    o.settlementDueAt === undefined ? at(15 * DAY) : o.settlementDueAt,
    o.offerExpiresAt === undefined ? at(7 * DAY) : o.offerExpiresAt,
    o.acceptedAt === undefined ? at(-1 * HOUR) : o.acceptedAt,
    o.mandateRef === undefined ? '9:1:' + SELLER : o.mandateRef,
    o.round === undefined ? 1 : o.round,
    o.transactionId ?? null,
  );
  return ref;
}

const only = (body: any) => body.offers[0];

describe('who may read it', () => {
  it('is admin-only', async () => {
    insert();
    expect((await get('/api/acquisitions/admin/accepted')).status).toBe(403);
    expect((await list()).status).toBe(200);
  });
});

describe('what belongs on the list', () => {
  it('lists accepted offers whose LANA has not arrived, and nothing else', async () => {
    insert({ ref: 'OFF-ACCEPTED' });
    insert({ ref: 'OFF-OFFERED', status: 'offered' });
    insert({ ref: 'OFF-SETTLED', status: 'settled' });
    insert({ ref: 'OFF-EXPIRED', status: 'expired' });
    insert({ ref: 'OFF-WITHDRAWN', status: 'withdrawn' });
    const { body } = await list();
    expect(body.offers.map((o: any) => o.offerRef)).toEqual(['OFF-ACCEPTED']);
  });

  it('drops an accepted row whose transfer already happened — it is a sale, not a wait', async () => {
    const txId = Number(db.prepare(`
      INSERT INTO buyback_transactions (user_hex_id, sender_wallet_id, buyback_wallet_id,
        lana_amount_lanoshis, lana_amount_display, currency, exchange_rate, gross_fiat,
        commission_percent, commission_fiat, net_fiat, status)
      VALUES (?, ?, 'LTreasury', 1, 1, 'EUR', 0.25, 1, 21, 1, 1, 'completed')
    `).run(SELLER, WALLET).lastInsertRowid);
    insert({ ref: 'OFF-TRANSFERRED', transactionId: txId });
    insert({ ref: 'OFF-WAITING' });
    const { body } = await list();
    expect(body.offers.map((o: any) => o.offerRef)).toEqual(['OFF-WAITING']);
  });
});

describe('the two clocks are two fields', () => {
  it('never collapses them into one, and never calls either of them "expires"', async () => {
    insert({ acceptedAt: at(-1 * HOUR), settlementDueAt: at(15 * DAY) });
    const row = only((await list()).body);
    expect(row.transferDueAt).toBeTruthy();
    expect(row.settlementDueAt).toBeTruthy();
    expect(row.transferDueAt).not.toBe(row.settlementDueAt);
    // The word that would have caused the confusion is not on the wire at all.
    expect(Object.keys(row).some(k => /expire/i.test(k))).toBe(false);
  });

  /**
   * THE TRAP. The offer stood 8 days and was accepted inside it; from the
   * moment of acceptance the sweep gives the seller 24 hours. A page that read
   * `offer_expires_at` would print a week left on a row this server voids
   * tomorrow.
   */
  it('the seller\'s window on a mandate row is 24 h from acceptance, not the 8-day offer window', async () => {
    const acceptedAt = at(-2 * HOUR);
    insert({ acceptedAt, offerExpiresAt: at(7 * DAY) });
    const row = only((await list()).body);
    const expected = new Date(new Date(`${acceptedAt.replace(' ', 'T')}Z`).getTime() + ACCEPTED_TRANSFER_WINDOW_HOURS * HOUR);
    expect(row.transferDueAt).toBe(expected.toISOString().slice(0, 19).replace('T', ' '));
    expect(row.sweepsItself).toBe(true);
  });

  it('a legacy row gets the same transfer window as any other — and the same sweep', async () => {
    // Until 11 Sept 2026 a legacy row's deadline was the OFFER's window and
    // nothing swept it. Both were wrong in the same way: the window belongs to
    // the seller's transfer, and it does not depend on a mandate.
    const acceptedAt = at(-2 * HOUR);
    insert({ mandateRef: null, round: null, acceptedAt, offerExpiresAt: at(3 * DAY) });
    const row = only((await list()).body);
    expect(row.transferDueAt).not.toBe(at(3 * DAY));
    expect(row.sweepsItself).toBe(true);
  });
});

describe('which clock runs out first', () => {
  it('says the transfer, when the transfer is nearer', async () => {
    insert({ acceptedAt: at(-1 * HOUR), settlementDueAt: at(15 * DAY) });
    const row = only((await list()).body);
    expect(row.nextDue).toBe('transfer');
    expect(row.nextDueAt).toBe(row.transferDueAt);
  });

  it('says the settlement, when the settlement is nearer', async () => {
    // Due tomorrow morning on a row accepted an hour ago: our own date lands
    // before the seller's 24 hours are up.
    insert({ acceptedAt: at(-1 * HOUR), settlementDueAt: at(2 * HOUR) });
    const row = only((await list()).body);
    expect(row.nextDue).toBe('settlement');
    expect(row.nextDueAt).toBe(row.settlementDueAt);
  });

  it('says nothing rather than guessing when a row carries no deadline at all', async () => {
    insert({ mandateRef: null, round: null, acceptedAt: null, offerExpiresAt: null, settlementDueAt: null });
    const row = only((await list()).body);
    expect(row.nextDue).toBeNull();
    expect(row.nextDueAt).toBeNull();
  });

  it('puts the soonest deadline first, whichever clock it belongs to', async () => {
    insert({ ref: 'OFF-LATE', acceptedAt: at(-1 * HOUR), settlementDueAt: at(20 * DAY) });
    insert({ ref: 'OFF-SOON', acceptedAt: at(-1 * HOUR), settlementDueAt: at(30 * 60_000) });
    insert({ ref: 'OFF-NEVER', mandateRef: null, round: null, acceptedAt: null, offerExpiresAt: null, settlementDueAt: null });
    const { body } = await list();
    expect(body.offers.map((o: any) => o.offerRef)).toEqual(['OFF-SOON', 'OFF-LATE', 'OFF-NEVER']);
  });
});

describe('the money owed', () => {
  it('totals the purchase prices per currency and never adds two currencies together', async () => {
    insert({ currency: 'EUR', price: 651.32, lana: 3261.797 });
    insert({ currency: 'EUR', price: 100.5, lana: 500 });
    insert({ currency: 'GBP', price: 40, lana: 200 });
    const { body } = await list();
    expect(body.totals.EUR.owed).toBe(751.82);
    expect(body.totals.EUR.count).toBe(2);
    expect(body.totals.EUR.lana).toBe(3761.797);
    expect(body.totals.GBP.owed).toBe(40);
  });

  it('counts a row with no purchase price instead of pretending it is zero', async () => {
    insert({ price: null });
    insert({ price: 25 });
    const { body } = await list();
    expect(body.totals.EUR.owed).toBe(25);
    expect(body.totals.EUR.unpriced).toBe(1);
    expect(body.totals.EUR.count).toBe(2);
  });

  /**
   * A closed transfer window is refused by assertTransferable, so the row can
   * never become a sale. Counting its price as owed would tell the treasury it
   * owes money that no one can claim.
   */
  it('leaves a row whose transfer window has closed OUT of the total, and still lists it', async () => {
    insert({ ref: 'OFF-DEAD', acceptedAt: at(-2 * DAY), price: 900 });
    insert({ ref: 'OFF-LIVE', acceptedAt: at(-1 * HOUR), price: 100 });
    const { body } = await list();
    expect(body.offers.map((o: any) => o.offerRef)).toContain('OFF-DEAD');
    expect(body.offers.find((o: any) => o.offerRef === 'OFF-DEAD').transferLapsed).toBe(true);
    expect(body.offers.find((o: any) => o.offerRef === 'OFF-LIVE').transferLapsed).toBe(false);
    expect(body.totals.EUR.owed).toBe(100);
    expect(body.totals.EUR.count).toBe(1);
    expect(body.lapsed).toEqual({ count: 1, byCurrency: { EUR: 900 } });
  });
});

describe('the money that is NOT on this list', () => {
  it('names what is still out with sellers separately, and counts only live offers', async () => {
    insert({ status: 'offered', price: 300, offerExpiresAt: at(20 * 60_000) });
    insert({ status: 'offered', price: 44, offerExpiresAt: at(-1 * HOUR) });
    insert({ status: 'offered', price: 10, currency: 'GBP', offerExpiresAt: at(2 * DAY) });
    insert({ price: 7 });
    const { body } = await list();
    expect(body.stillWithSellers.count).toBe(2);
    expect(body.stillWithSellers.byCurrency).toEqual({ EUR: 300, GBP: 10 });
    // And it is nowhere near the figure the screen leads with.
    expect(body.totals.EUR.owed).toBe(7);
  });

  /**
   * THE ROWS, NOT ONLY THE SUM — 11 Sept 2026.
   *
   * A count told the operator that two offers were out with sellers, and he
   * remembered one of them by name and could not find it on any screen: the
   * review page holds what waits on US, this page held what a seller had
   * already accepted, and the step between the two was a sentence. An offer
   * nobody can find is an offer nobody chases.
   */
  it('lists them, so the operator can see WHOSE they are', async () => {
    insert({ ref: 'OFF-WAIT', status: 'offered', price: 300, offerExpiresAt: at(20 * 60_000) });
    insert({ ref: 'OFF-GONE', status: 'offered', price: 44, offerExpiresAt: at(-1 * HOUR) });
    const { body } = await list();
    const refs = body.stillWithSellers.offers.map((o: any) => o.offerRef);
    expect(refs).toContain('OFF-WAIT');
    // A lapsed offer is not waiting on anybody, and must not be listed as if it were.
    expect(refs).not.toContain('OFF-GONE');
    const row = body.stillWithSellers.offers.find((o: any) => o.offerRef === 'OFF-WAIT');
    expect(row.purchasePrice).toBe(300);
    expect(row.userHexId).toBeTruthy();
    expect(row.standsUntil).toBeTruthy();
  });

  it('puts the offer closest to lapsing first — that is the one worth a nudge', async () => {
    insert({ ref: 'OFF-LATER', status: 'offered', price: 1, offerExpiresAt: at(3 * DAY) });
    insert({ ref: 'OFF-SOON', status: 'offered', price: 2, offerExpiresAt: at(1 * HOUR) });
    const { body } = await list();
    expect(body.stillWithSellers.offers.map((o: any) => o.offerRef)).toEqual(['OFF-SOON', 'OFF-LATER']);
  });

  it('reports an empty world as empty rather than as zero owed everywhere', async () => {
    const { body } = await list();
    expect(body.offers).toEqual([]);
    expect(body.totals).toEqual({});
    expect(body.lapsed).toEqual({ count: 0, byCurrency: {} });
    expect(body.stillWithSellers).toEqual({ count: 0, byCurrency: {}, offers: [] });
  });
});

describe('the window is the server\'s number', () => {
  it('ships the transfer window rather than leaving a browser to hardcode 24', async () => {
    const { body } = await list();
    expect(body.transferWindowHours).toBe(ACCEPTED_TRANSFER_WINDOW_HOURS);
  });
});
