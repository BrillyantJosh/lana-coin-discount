/**
 * Shared fixtures for the round-mandate tests. Not a test file itself.
 *
 * Three things every one of those tests needs and none should re-invent:
 *   - a key pair and a NIP-01 signer, so events and requests are REALLY
 *     signed (the verifier under test recomputes ids and checks Schnorr —
 *     a hand-typed `sig: 'x'` would prove nothing);
 *   - a KIND 30960 builder that emits the contract's tags byte-for-byte;
 *   - an in-memory SQLite carrying the production DDL for every table the
 *     routers touch, plus a stand-in for db/index.ts built on it.
 */
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NostrEvent } from './nostr.js';
import { ROUND_MANDATE_SCHEMA_SQL, ROUND_MANDATE_OFFER_COLUMNS } from '../db/roundMandateSchema.js';
import { signaturePayloadHash } from './requestSignature.js';

export interface TestKey { priv: Uint8Array; pub: string }

export function makeKey(): TestKey {
  const priv = schnorr.utils.randomSecretKey();
  const pub = Buffer.from(schnorr.getPublicKey(priv)).toString('hex');
  return { priv, pub };
}

export function signEvent(key: TestKey, e: { kind: number; tags: string[][]; content: string; created_at: number }): NostrEvent {
  const serialized = JSON.stringify([0, key.pub, e.created_at, e.kind, e.tags, e.content]);
  const id = crypto.createHash('sha256').update(serialized).digest('hex');
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), key.priv)).toString('hex');
  return { id, pubkey: key.pub, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig };
}

export interface MandateWalletSpec { address: string; currency: string; lana: string; fundSettingId: string }

/** "1000" → "1000.00000000" (the contract's 8dp). */
export const lana8 = (n: number | string): string => {
  const s = String(n);
  const [whole, frac = ''] = s.split('.');
  return `${whole}.${(frac + '00000000').slice(0, 8)}`;
};

export const lanoshisOf = (lana8dp: string): string => {
  const [whole, frac] = lana8dp.split('.');
  return String(BigInt(whole) * 100_000_000n + BigInt(frac));
};

/** A contract-shaped KIND 30960, announced unless told otherwise. */
export function mandateTags(spec: {
  split: number; round: number; hex: string; wallets: MandateWalletSpec[];
  status?: 'announced' | 'closed'; snapshotAt?: number; extra?: string[][];
  /** Tag names to leave out — for the tests that prove each required tag is required. */
  omit?: string[];
  /** Overrides closed_reason on a tombstone (default window_ended). */
  closedReason?: string;
}): string[][] {
  const status = spec.status || 'announced';
  const d = `${spec.split}:${spec.round}:${spec.hex}`;
  const head: string[][] = [
    ['d', d], ['p', spec.hex], ['split', String(spec.split)], ['round', String(spec.round)], ['status', status],
  ];
  const tail: string[][] = [
    ['snapshot_at', String(spec.snapshotAt ?? 1_757_000_000)],
    ['lanapays_pubkey', '79730aba75d71584e8a4f9d0cc1173085e75590ce489760078d2bf6f5210d692'],
    ['bef_version', 'P08-1.0'],
  ];
  // `omit` drops generated tags only; `extra` is appended afterwards, so a
  // test can replace a tag by omitting it and supplying its own.
  const omit = new Set(spec.omit || []);
  const keep = (tags: string[][]) => [...tags.filter(t => !omit.has(t[0])), ...(spec.extra || [])];
  if (status === 'closed') {
    return keep([...head, ['closed_reason', spec.closedReason ?? 'window_ended'], ...tail]);
  }
  const shares = spec.wallets.map(w => lana8(w.lana));
  const total = shares.reduce((s, x) => s + BigInt(lanoshisOf(x)), 0n);
  const totalStr = `${total / 100_000_000n}.${String(total % 100_000_000n).padStart(8, '0')}`;
  return keep([
    ...head,
    ['lana_received', totalStr],
    ['lana_received_lanoshis', String(total)],
    ...spec.wallets.map((w, i) => ['wallet', w.address, w.currency, shares[i], w.fundSettingId]),
    ...spec.wallets.map(w => ['a', `30938:${'d'.repeat(64)}:${w.fundSettingId}`]),
    ['e', 'e'.repeat(64)],
    ...tail,
  ]);
}

export const MANDATE_NOTE = 'Indicative figures are projections, not a price, rate or guarantee. Only a Purchase Price accepted on lana.discount binds (BEF P08 §4).';

export function mandateEvent(
  key: TestKey,
  spec: Parameters<typeof mandateTags>[0] & { createdAt?: number; content?: string },
): NostrEvent {
  const tags = mandateTags(spec);
  return signEvent(key, {
    kind: 30960, tags, created_at: spec.createdAt ?? 1_757_000_000,
    content: spec.content ?? JSON.stringify({ non_binding: true, note: MANDATE_NOTE }),
  });
}

/**
 * The x-auth-* headers the mandate path requires, signed with `key` under the
 * v2 scheme (requestSignature.ts): the BODY is part of what is signed, so a
 * caller must pass the same object it is about to send. GET → no body.
 */
export function signedHeaders(
  key: TestKey, method: string, path: string, ts = Math.floor(Date.now() / 1000), body?: unknown,
): Record<string, string> {
  const sig = Buffer.from(schnorr.sign(signaturePayloadHash(method, path, ts, body), key.priv)).toString('hex');
  return { 'x-auth-pubkey': key.pub, 'x-auth-timestamp': String(ts), 'x-auth-signature': sig };
}

// ─── database ─────────────────────────────────────────────────────────────

/** Production DDL for the tables the routers read and write, in memory. */
export function createMandateTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE buyback_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hex_id TEXT NOT NULL, sender_wallet_id TEXT NOT NULL, buyback_wallet_id TEXT NOT NULL,
      lana_amount_lanoshis INTEGER NOT NULL, lana_amount_display REAL NOT NULL, currency TEXT NOT NULL,
      exchange_rate REAL NOT NULL, split TEXT, gross_fiat REAL NOT NULL,
      commission_percent REAL NOT NULL DEFAULT 30, commission_fiat REAL NOT NULL, net_fiat REAL NOT NULL,
      tx_hash TEXT, tx_fee_lanoshis INTEGER, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')), completed_at TEXT,
      offer_ref TEXT, settlement_due_at TEXT
    );
    CREATE TABLE acquisition_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_ref TEXT NOT NULL UNIQUE,
      user_hex_id TEXT NOT NULL,
      sender_wallet_id TEXT NOT NULL,
      wallet_class TEXT NOT NULL,
      lana_amount_lanoshis INTEGER NOT NULL,
      lana_amount_display REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      reference_rate REAL, discount_percent REAL, purchase_price_fiat REAL, gross_fiat REAL,
      mandate_code TEXT, eligibility_json TEXT,
      settlement_due_at TEXT, offer_expires_at TEXT,
      decided_by TEXT, decided_at TEXT, decision_reason TEXT,
      accepted_at TEXT, terms_version TEXT,
      transaction_id INTEGER REFERENCES buyback_transactions(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT
    );
    CREATE TABLE admin_users (hex_id TEXT PRIMARY KEY, label TEXT, added_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key_hash TEXT NOT NULL UNIQUE, app_name TEXT NOT NULL, label TEXT,
      created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT, is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE kind_38888 (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, relays TEXT NOT NULL, electrum_servers TEXT NOT NULL DEFAULT '[]',
      exchange_rates TEXT NOT NULL DEFAULT '{}', split TEXT, split_started_at INTEGER, split_ends_at INTEGER, trusted_signers TEXT
    );
  `);
  db.exec(ROUND_MANDATE_SCHEMA_SQL);
  for (const sql of ROUND_MANDATE_OFFER_COLUMNS) db.exec(sql);
  return db;
}

export function setSplit(db: Database.Database, split: number | null, rates: Record<string, number> = { EUR: 0.128 }, splitEndsAt = 0): void {
  db.prepare('DELETE FROM kind_38888').run();
  db.prepare(`INSERT INTO kind_38888 (id, created_at, relays, electrum_servers, exchange_rates, split, split_ends_at, trusted_signers)
              VALUES ('t', ?, '["wss://relay.test"]', '[{"host":"e","port":"5097"}]', ?, ?, ?, '{"LanaRegistrar":[]}')`)
    .run(Math.floor(Date.now() / 1000), JSON.stringify(rates), split === null ? null : String(split), splitEndsAt || null);
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, 'test')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** Round terms: opensAt as Unix seconds (null = no date). */
export function setRoundTerms(db: Database.Database, split: number, round: number, opensAt: number | null, discountPercent: number | null): void {
  db.prepare(`INSERT INTO acquisition_rounds (split, round, opens_at, discount_percent, updated_by)
              VALUES (?, ?, ?, ?, 'test')
              ON CONFLICT(split, round) DO UPDATE SET opens_at = excluded.opens_at, discount_percent = excluded.discount_percent`)
    .run(split, round, opensAt === null ? null : new Date(opensAt * 1000).toISOString(), discountPercent);
}

/**
 * Everything the acquisitions and treasury routers import from db/index.ts,
 * answered from the in-memory database. Passed to vi.mock's factory.
 */
export function dbModuleStub(db: Database.Database) {
  const latest38888 = () => db.prepare('SELECT * FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return {
    default: db,
    getDbHandle: () => db,
    closeDb: () => db.close(),
    getAppSetting: (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any)?.value ?? null,
    getAllAppSettings: () => {
      const out: Record<string, string> = {};
      for (const r of db.prepare('SELECT key, value FROM app_settings').all() as any[]) out[r.key] = r.value;
      return out;
    },
    setAppSetting: (key: string, value: string) => setSetting(db, key, value),
    getRelaysFromDb: () => ['wss://relay.test'],
    getTrustedSignersFromDb: () => ({ LanaRegistrar: [] as string[] }),
    getElectrumServersFromDb: () => [{ host: 'e', port: 5097 }],
    getExchangeRatesFromDb: () => { try { return JSON.parse(latest38888()?.exchange_rates || '{}'); } catch { return {}; } },
    getSplitFromDb: () => latest38888()?.split ?? null,
    getSplitEndsAtFromDb: () => latest38888()?.split_ends_at || 0,
    getSplitStartedAtFromDb: () => latest38888()?.split_started_at || 0,
    isAdminUser: (hex: string) => !!db.prepare('SELECT 1 FROM admin_users WHERE hex_id = ?').get(hex),
    getApiKeyByHash: (hash: string) => db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) ?? null,
    updateApiKeyLastUsed: (id: number) => db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id),
    insertBuybackTransaction: (d: any) => Number(db.prepare(`
      INSERT INTO buyback_transactions (user_hex_id, sender_wallet_id, buyback_wallet_id, lana_amount_lanoshis, lana_amount_display,
        currency, exchange_rate, split, gross_fiat, commission_percent, commission_fiat, net_fiat, tx_hash, tx_fee_lanoshis, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.user_hex_id, d.sender_wallet_id, d.buyback_wallet_id, d.lana_amount_lanoshis, d.lana_amount_display, d.currency,
      d.exchange_rate, d.split, d.gross_fiat, d.commission_percent, d.commission_fiat, d.net_fiat,
      d.tx_hash ?? null, d.tx_fee_lanoshis ?? null, d.status, d.error_message ?? null).lastInsertRowid),
  };
}
