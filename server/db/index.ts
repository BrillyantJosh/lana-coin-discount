import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'lana-discount.db');
const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    nostr_hex_id TEXT PRIMARY KEY,
    npub TEXT,
    wallet_id TEXT,
    wallet_id_compressed TEXT,
    wallet_id_uncompressed TEXT,
    display_name TEXT,
    full_name TEXT,
    picture TEXT,
    about TEXT,
    lana_wallet_id TEXT,
    raw_kind0 TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kind_38888 (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    fetched_at TEXT DEFAULT (datetime('now')),
    relays TEXT NOT NULL,
    electrum_servers TEXT NOT NULL DEFAULT '[]',
    exchange_rates TEXT NOT NULL DEFAULT '{}',
    split TEXT,
    version TEXT,
    valid_from INTEGER,
    split_started_at INTEGER,
    split_target_lana INTEGER,
    trusted_signers TEXT,
    raw_event TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watched_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_hex_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    wallet_type TEXT,
    note TEXT,
    last_balance REAL,
    last_balance_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_hex_id, wallet_id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    hex_id TEXT PRIMARY KEY,
    label TEXT,
    added_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS buyback_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_hex_id TEXT NOT NULL,
    sender_wallet_id TEXT NOT NULL,
    buyback_wallet_id TEXT NOT NULL,
    lana_amount_lanoshis INTEGER NOT NULL,
    lana_amount_display REAL NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    split TEXT,
    gross_fiat REAL NOT NULL,
    commission_percent REAL NOT NULL DEFAULT 30,
    commission_fiat REAL NOT NULL,
    net_fiat REAL NOT NULL,
    tx_hash TEXT,
    tx_fee_lanoshis INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_users_wallet_id ON users(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
  CREATE INDEX IF NOT EXISTS idx_watched_wallets_user ON watched_wallets(user_hex_id);
  CREATE INDEX IF NOT EXISTS idx_buyback_user ON buyback_transactions(user_hex_id);
  CREATE INDEX IF NOT EXISTS idx_buyback_status ON buyback_transactions(status);
`);

// --- Seed kind_38888 with bootstrap fallback data ---
const kind38888Count = (db.prepare('SELECT COUNT(*) as count FROM kind_38888').get() as any).count;
if (kind38888Count === 0) {
  const defaultRelays = [
    'wss://relay.lanavault.space',
    'wss://relay.lanacoin-eternity.com',
  ];

  const defaultElectrumServers = [
    { host: 'electrum1.lanacoin.com', port: '5097' },
    { host: 'electrum2.lanacoin.com', port: '5097' },
    { host: 'electrum3.lanacoin.com', port: '5097' },
  ];

  const defaultExchangeRates = { EUR: 0.00001, USD: 0.000011, GBP: 0.0000085 };
  const defaultTrustedSigners = {
    '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3': ['system'],
  };

  const rawEvent = JSON.stringify({
    id: 'local_seed_event',
    kind: 38888,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3',
    content: '',
    tags: [],
    sig: 'local_seed',
  });

  db.prepare(`
    INSERT INTO kind_38888 (
      id, event_id, pubkey, created_at, relays, electrum_servers,
      exchange_rates, split, version, valid_from, split_started_at,
      split_target_lana, trusted_signers, raw_event
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'seed_kind_38888',
    'local_seed_event_' + Date.now(),
    '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3',
    Math.floor(Date.now() / 1000),
    JSON.stringify(defaultRelays),
    JSON.stringify(defaultElectrumServers),
    JSON.stringify(defaultExchangeRates),
    '0.001',
    '1.0.0',
    Math.floor(Date.now() / 1000),
    0,
    0,
    JSON.stringify(defaultTrustedSigners),
    rawEvent
  );

  console.log('[lana-discount] Seeded kind_38888 with bootstrap fallback data');
}

// --- Seed admin_users with first administrator ---
const adminCount = (db.prepare('SELECT COUNT(*) as count FROM admin_users').get() as any).count;
if (adminCount === 0) {
  db.prepare('INSERT INTO admin_users (hex_id, label, added_by) VALUES (?, ?, ?)')
    .run('56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061', 'Brilly(ant) Josh', 'system');
  console.log('[lana-discount] Seeded first admin user');
}

// --- Seed app_settings with defaults ---
const settingsCount = (db.prepare('SELECT COUNT(*) as count FROM app_settings').get() as any).count;
if (settingsCount === 0) {
  const defaults: Array<[string, string]> = [
    ['buyback_wallet_id', ''],
    ['active_currencies', JSON.stringify(['EUR'])],
  ];

  const insertSetting = db.prepare('INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, ?)');
  for (const [key, value] of defaults) {
    insertSetting.run(key, value, 'system');
  }
  console.log('[lana-discount] Seeded app_settings with defaults');
}

// --- Helpers ---

export function getRelaysFromDb(): string[] {
  const row = db.prepare('SELECT relays FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  if (row?.relays) {
    try { return JSON.parse(row.relays); } catch {}
  }
  return ['wss://relay.lanavault.space', 'wss://relay.lanacoin-eternity.com'];
}

export function getElectrumServersFromDb(): Array<{ host: string; port: number }> {
  const row = db.prepare('SELECT electrum_servers FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  if (row?.electrum_servers) {
    try {
      const servers = JSON.parse(row.electrum_servers);
      return servers.map((s: any) => ({ host: s.host, port: parseInt(s.port) || 5097 }));
    } catch {}
  }
  return [
    { host: 'electrum1.lanacoin.com', port: 5097 },
    { host: 'electrum2.lanacoin.com', port: 5097 },
    { host: 'electrum3.lanacoin.com', port: 5097 },
  ];
}

export function getTrustedSignersFromDb(): Record<string, string[]> {
  const row = db.prepare('SELECT trusted_signers FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  if (row?.trusted_signers) {
    try { return JSON.parse(row.trusted_signers); } catch {}
  }
  return {};
}

export function isAdminUser(hexId: string): boolean {
  const row = db.prepare('SELECT 1 FROM admin_users WHERE hex_id = ?').get(hexId);
  return !!row;
}

export function getAllAdmins(): Array<{ hex_id: string; label: string | null; added_by: string | null; created_at: string }> {
  return db.prepare('SELECT * FROM admin_users ORDER BY created_at ASC').all() as any[];
}

export function getAppSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
  return row?.value ?? null;
}

export function getAllAppSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key ASC').all() as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function setAppSetting(key: string, value: string, updatedBy: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now'),
      updated_by = excluded.updated_by
  `).run(key, value, updatedBy);
}

export function getExchangeRatesFromDb(): Record<string, number> {
  const row = db.prepare('SELECT exchange_rates FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  if (row?.exchange_rates) {
    try { return JSON.parse(row.exchange_rates); } catch {}
  }
  return { EUR: 0.00001 };
}

export function getSplitFromDb(): string | null {
  const row = db.prepare('SELECT split FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.split ?? null;
}

export interface BuybackTransactionData {
  user_hex_id: string;
  sender_wallet_id: string;
  buyback_wallet_id: string;
  lana_amount_lanoshis: number;
  lana_amount_display: number;
  currency: string;
  exchange_rate: number;
  split: string | null;
  gross_fiat: number;
  commission_percent: number;
  commission_fiat: number;
  net_fiat: number;
  tx_hash?: string;
  tx_fee_lanoshis?: number;
  status: string;
  error_message?: string;
}

export function insertBuybackTransaction(data: BuybackTransactionData): number {
  const result = db.prepare(`
    INSERT INTO buyback_transactions (
      user_hex_id, sender_wallet_id, buyback_wallet_id,
      lana_amount_lanoshis, lana_amount_display, currency, exchange_rate,
      split, gross_fiat, commission_percent, commission_fiat, net_fiat,
      tx_hash, tx_fee_lanoshis, status, error_message,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${data.status === 'completed' ? "datetime('now')" : 'NULL'})
  `).run(
    data.user_hex_id, data.sender_wallet_id, data.buyback_wallet_id,
    data.lana_amount_lanoshis, data.lana_amount_display, data.currency, data.exchange_rate,
    data.split, data.gross_fiat, data.commission_percent, data.commission_fiat, data.net_fiat,
    data.tx_hash || null, data.tx_fee_lanoshis || null, data.status, data.error_message || null
  );
  return Number(result.lastInsertRowid);
}

export function getUserBuybackTransactions(hexId: string): any[] {
  return db.prepare('SELECT * FROM buyback_transactions WHERE user_hex_id = ? ORDER BY created_at DESC').all(hexId) as any[];
}

export function getBuybackStats(): {
  totalLanaBoughtBack: number;
  totalEurOwed: number;
  totalTransactions: number;
  usersServed: number;
} {
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(lana_amount_display), 0) as totalLana,
      COALESCE(SUM(net_fiat), 0) as totalFiat,
      COUNT(*) as txCount,
      COUNT(DISTINCT user_hex_id) as userCount
    FROM buyback_transactions
    WHERE status = 'completed'
  `).get() as any;

  return {
    totalLanaBoughtBack: stats.totalLana || 0,
    totalEurOwed: Math.round((stats.totalFiat || 0) * 100) / 100,
    totalTransactions: stats.txCount || 0,
    usersServed: stats.userCount || 0,
  };
}

export function getRecentBuybackTransactions(limit = 20): any[] {
  return db.prepare(`
    SELECT bt.*, u.display_name, u.full_name
    FROM buyback_transactions bt
    LEFT JOIN users u ON bt.user_hex_id = u.nostr_hex_id
    ORDER BY bt.created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}

export function closeDb(): void {
  try { db.close(); } catch {}
}

export default db;
