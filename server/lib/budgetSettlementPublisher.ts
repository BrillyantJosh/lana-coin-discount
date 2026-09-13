/**
 * Publishing KIND 30961 — reads the database, builds one event per budget
 * (budgetSettlement.ts), and sends only what changed.
 *
 * Two things this file has to get right that the builder cannot:
 *
 * 1. A BUDGET OUTLIVES ITS MANDATE ROW. The brain closes a mandate one split
 *    after its window (a tombstone with no wallets), but a sale made on the
 *    last day is still paid up to fifteen days later — and that payment must
 *    still reach the budget's event. So every budget a mandate has ever named
 *    is kept here, with its wallet history and the LANA it received, and the
 *    event goes on being rebuilt from that after the mandate is gone.
 *
 * 2. NOTHING IS SENT TWICE, NOTHING IS LOST. The tags are hashed without their
 *    timestamp; an unchanged hash that reached at least one relay is not sent
 *    again. A publish no relay accepted is tried again on the next run. A
 *    replacement always carries a created_at later than the one it replaces,
 *    or a relay would keep the old one.
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { schnorr } from '@noble/curves/secp256k1.js';
import { broadcastEvent, type NostrEvent } from './nostr.js';
import { minimumFiatFor, proposalTooSmall } from './acquisitionMinimum.js';
import {
  BUDGET_SETTLEMENT_KIND, buildBudgetSettlements,
  type BudgetDefinition, type BuildInput, type PayoutInput, type RoundTermsEcho, type SaleInput,
} from './budgetSettlement.js';

export { BUDGET_SETTLEMENT_SCHEMA_SQL } from '../db/roundMandateSchema.js';

/** SQLite's 'YYYY-MM-DD HH:MM:SS' is UTC; ISO strings pass through. */
export function sqliteTimeToUnix(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Bring the kept budget definitions up to date with the mandate mirror.
 * Returns the definitions to build from, the ones no longer named included.
 */
export function syncBudgetDefinitions(db: Database.Database): BudgetDefinition[] {
  const mandates = db.prepare('SELECT d_tag, split, round, financer_hex, pubkey, status, wallets_json, raw_event FROM acquisition_mandates').all() as any[];
  const stored = new Map<string, BudgetDefinition>(
    (db.prepare('SELECT d_tag, budget_json FROM budget_settlement_publications').all() as any[])
      .map(r => [r.d_tag, JSON.parse(r.budget_json) as BudgetDefinition]),
  );
  const named = new Set<string>();
  const upsert = db.prepare(`INSERT INTO budget_settlement_publications (d_tag, budget_json) VALUES (?, ?)
                             ON CONFLICT(d_tag) DO UPDATE SET budget_json = excluded.budget_json`);

  db.transaction(() => {
    for (const m of mandates) {
      if (m.status !== 'announced') continue;
      let wallets: any[] = [];
      try { wallets = JSON.parse(m.wallets_json || '[]'); } catch { wallets = []; }
      let eventTags: string[][] = [];
      try { eventTags = JSON.parse(m.raw_event || '{}').tags || []; } catch { eventTags = []; }

      for (const w of wallets) {
        const fundSettingId = String(w.fundSettingId ?? '').trim();
        if (!fundSettingId || !w.address) continue;
        const dTag = `${m.split}:${m.round}:${fundSettingId}`;
        named.add(dTag);
        const before = stored.get(dTag);
        const budgetAddress = eventTags.find(t => t[0] === 'a' && typeof t[1] === 'string'
          && t[1].startsWith('30938:') && t[1].endsWith(`:${fundSettingId}`))?.[1] ?? before?.budgetAddress ?? null;
        const history = [...(before?.walletHistory ?? [])];
        if (!history.includes(w.address)) history.push(w.address);
        const def: BudgetDefinition = {
          split: Number(m.split),
          round: Number(m.round),
          financerHex: String(m.financer_hex).toLowerCase(),
          fundSettingId,
          currency: String(w.currency || '').toUpperCase(),
          wallet: w.address,
          walletHistory: history,
          lanaReceivedLanoshis: Number(w.lanaLanoshis) || 0,
          mandateDTag: m.d_tag,
          mandateAddress: `30960:${m.pubkey}:${m.d_tag}`,
          budgetAddress,
          mandateStatus: 'announced',
        };
        if (JSON.stringify(def) !== JSON.stringify(before)) upsert.run(dTag, JSON.stringify(def));
        stored.set(dTag, def);
      }
    }

    // Budgets the mirror no longer names: closed with their mandate, or dropped from a live one.
    const statusByMandate = new Map<string, string>(mandates.map(m => [m.d_tag, m.status]));
    for (const [dTag, def] of stored) {
      if (named.has(dTag)) continue;
      const next: BudgetDefinition['mandateStatus'] = statusByMandate.get(def.mandateDTag) === 'announced' ? 'not_in_mandate' : 'closed';
      if (def.mandateStatus !== next) {
        const updated = { ...def, mandateStatus: next };
        upsert.run(dTag, JSON.stringify(updated));
        stored.set(dTag, updated);
      }
    }
  })();

  return [...stored.values()];
}

export function loadBuildInput(db: Database.Database, budgets: BudgetDefinition[], signerPubkey: string, now: number): BuildInput {
  const mandateRefs = [...new Set(budgets.map(b => b.mandateDTag))];
  const sales: SaleInput[] = [];
  const payouts: PayoutInput[] = [];

  if (mandateRefs.length > 0) {
    const rows = db.prepare(`
      SELECT t.*,
             -- Prefixed, and after t.*: the transaction shares several column
             -- names with the offer, and on a LEFT JOIN miss its NULLs would
             -- overwrite the offer's values in the row object.
             o.offer_ref AS o_offer_ref, o.mandate_ref AS o_mandate_ref, o.sender_wallet_id AS o_sender_wallet,
             o.currency AS o_currency, o.status AS o_status, o.lana_amount_lanoshis AS o_lanoshis,
             o.reference_rate AS o_reference_rate, o.discount_percent AS o_discount_percent,
             o.gross_fiat AS o_gross_fiat, o.purchase_price_fiat AS o_purchase_price,
             o.accepted_at AS o_accepted_at, o.transaction_id AS o_transaction_id
        FROM acquisition_offers o
        LEFT JOIN buyback_transactions t ON t.id = o.transaction_id
       WHERE o.mandate_ref IN (${mandateRefs.map(() => '?').join(',')})
         AND o.status IN ('accepted', 'settled')
    `).all(...mandateRefs) as any[];

    for (const r of rows) {
      const hasTx = r.id !== null && r.id !== undefined;
      sales.push({
        offerRef: r.o_offer_ref,
        mandateRef: r.o_mandate_ref,
        senderWallet: r.o_sender_wallet,
        currency: String(r.o_currency || '').toUpperCase(),
        offerStatus: r.o_status === 'settled' ? 'settled' : 'accepted',
        lanaLanoshis: Number(r.o_lanoshis) || 0,
        // The transaction is what the payments are measured against once it exists.
        referenceRate: (hasTx ? numOrNull(r.exchange_rate) : null) ?? numOrNull(r.o_reference_rate),
        discountPercent: (hasTx ? numOrNull(r.commission_percent) : null) ?? numOrNull(r.o_discount_percent),
        grossFiat: (hasTx ? numOrNull(r.gross_fiat) : null) ?? numOrNull(r.o_gross_fiat),
        netFiat: (hasTx ? numOrNull(r.net_fiat) : null) ?? numOrNull(r.o_purchase_price),
        acceptedAt: sqliteTimeToUnix(r.o_accepted_at),
        transactionId: hasTx ? Number(r.id) : null,
        txHash: hasTx ? (r.tx_hash || null) : null,
        txStatus: hasTx ? (r.status || null) : null,
        lanaMovedLanoshis: hasTx ? numOrNull(r.lana_received_lanoshis) : null,
        completedAt: hasTx ? sqliteTimeToUnix(r.completed_at) : null,
        blockHeight: hasTx ? numOrNull(r.rpc_block_height) : null,
      });
    }

    const txIds = [...new Set(sales.map(s => s.transactionId).filter((x): x is number => x !== null))];
    if (txIds.length > 0) {
      for (const p of db.prepare(`SELECT payout_id, transaction_id, amount, currency, paid_at FROM sale_payouts
                                   WHERE transaction_id IN (${txIds.map(() => '?').join(',')})`).all(...txIds) as any[]) {
        payouts.push({
          payoutId: p.payout_id,
          transactionId: Number(p.transaction_id),
          amount: Number(p.amount) || 0,
          currency: String(p.currency || '').toUpperCase(),
          recordedAt: sqliteTimeToUnix(p.paid_at),
        });
      }
    }
  }

  const terms = new Map<string, RoundTermsEcho>();
  for (const t of db.prepare('SELECT split, round, opens_at, discount_percent FROM acquisition_rounds').all() as any[]) {
    terms.set(`${t.split}:${t.round}`, {
      opensAt: t.opens_at ? sqliteTimeToUnix(t.opens_at) : null,
      sellFeePercent: numOrNull(t.discount_percent),
    });
  }

  let rates: Record<string, number> = {};
  try {
    rates = JSON.parse((db.prepare('SELECT exchange_rates FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any)?.exchange_rates || '{}');
  } catch { rates = {}; }
  const settings: Record<string, string> = {};
  for (const r of db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'min_sell_%'").all() as any[]) settings[r.key] = r.value;

  return {
    budgets,
    sales,
    payouts,
    terms,
    signerPubkey,
    // The same crumb rule as the admin worklist: a remainder under the smallest
    // purchase at the live rate is not something anybody can still sell.
    sellable: (lana, currency) => lana > 0 && !proposalTooSmall(lana, rates[currency] ?? null, minimumFiatFor(settings, currency)),
    now,
  };
}

export type Publish = (event: NostrEvent) => Promise<{ success: string[]; failed: string[] }>;

export interface PublishDeps {
  privateKeyHex: string;
  relays: string[];
  now?: number;
  /** How many events one run may send; the rest wait for the next run. */
  limit?: number;
  /** Injectable for tests; defaults to the real relay broadcast. */
  publish?: Publish;
}

export interface PublishRunResult {
  budgets: number;
  published: string[];
  failed: string[];
  unchanged: number;
  deferred: number;
  unattributed: string[];
}

export function pubkeyOf(privateKeyHex: string): string {
  return Buffer.from(schnorr.getPublicKey(Buffer.from(privateKeyHex, 'hex'))).toString('hex');
}

function signEvent(privateKeyHex: string, pubkey: string, kind: number, tags: string[][], content: string, createdAt: number): NostrEvent {
  const id = crypto.createHash('sha256').update(JSON.stringify([0, pubkey, createdAt, kind, tags, content])).digest('hex');
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), Buffer.from(privateKeyHex, 'hex'))).toString('hex');
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

export async function publishBudgetSettlements(db: Database.Database, deps: PublishDeps): Promise<PublishRunResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const limit = deps.limit ?? 25;
  const publish: Publish = deps.publish ?? ((event) => broadcastEvent(event, deps.relays));
  const pubkey = pubkeyOf(deps.privateKeyHex);

  const budgets = syncBudgetDefinitions(db);
  const { events, unattributed } = buildBudgetSettlements(loadBuildInput(db, budgets, pubkey, now));

  const result: PublishRunResult = { budgets: events.length, published: [], failed: [], unchanged: 0, deferred: 0, unattributed };
  const readRow = db.prepare('SELECT payload_hash, relays_ok, event_created_at FROM budget_settlement_publications WHERE d_tag = ?');
  const markOk = db.prepare(`UPDATE budget_settlement_publications
                                SET payload_hash = ?, event_id = ?, event_created_at = ?, relays_ok = ?, last_attempt_at = datetime('now'), last_error = NULL
                              WHERE d_tag = ?`);
  const markFailed = db.prepare(`UPDATE budget_settlement_publications
                                    SET last_attempt_at = datetime('now'), last_error = ?
                                  WHERE d_tag = ?`);

  for (const e of events) {
    const row = readRow.get(e.dTag) as any;
    if (row && row.payload_hash === e.hash && Number(row.relays_ok) > 0) { result.unchanged++; continue; }
    if (result.published.length + result.failed.length >= limit) { result.deferred++; continue; }

    const createdAt = Math.max(now, (Number(row?.event_created_at) || 0) + 1);
    const event = signEvent(deps.privateKeyHex, pubkey, BUDGET_SETTLEMENT_KIND, e.tags, e.content, createdAt);
    try {
      const sent = await publish(event);
      if (sent.success.length > 0) {
        markOk.run(e.hash, event.id, createdAt, sent.success.length, e.dTag);
        result.published.push(e.dTag);
      } else {
        markFailed.run(`no relay accepted (${sent.failed.length} tried)`, e.dTag);
        result.failed.push(e.dTag);
      }
    } catch (err: any) {
      markFailed.run(String(err?.message || err).slice(0, 300), e.dTag);
      result.failed.push(e.dTag);
    }
  }
  return result;
}
