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
    split_approaching INTEGER DEFAULT 0,
    freeze_lana_retail_account_above INTEGER DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS sale_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES buyback_transactions(id),
    payout_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    paid_to_account TEXT,
    reference TEXT,
    note TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    app_name TEXT NOT NULL,
    label TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_buyback_user ON buyback_transactions(user_hex_id);
  CREATE INDEX IF NOT EXISTS idx_buyback_status ON buyback_transactions(status);
  CREATE INDEX IF NOT EXISTS idx_sale_payouts_tx ON sale_payouts(transaction_id);

  -- Incoming batch tracking (from Direct Fund investor payments)
  CREATE TABLE IF NOT EXISTS incoming_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_ref TEXT NOT NULL UNIQUE,
    investor_hex TEXT NOT NULL,
    total_amount REAL NOT NULL,
    currency TEXT NOT NULL,
    payment_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'incoming',
    received_at TEXT,
    lana_bought_at TEXT,
    lana_sent_at TEXT,
    lana_tx_hash TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Individual payments within incoming batches
  CREATE TABLE IF NOT EXISTS incoming_batch_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES incoming_batches(id),
    pp_id INTEGER NOT NULL,
    order_type TEXT,
    amount_fiat REAL NOT NULL,
    currency TEXT NOT NULL,
    recipient_wallet TEXT,
    shop_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- LanaCrowd donations (KIND 60200) — one row per donation receipt, read from
  -- relays by the heartbeat. Powers the crowd-funding payout-priority tier: a
  -- project OWNER who has raised donations is paid right after investors.
  CREATE TABLE IF NOT EXISTS crowdfund_donations (
    event_id TEXT PRIMARY KEY,
    project_id TEXT,
    owner_hex TEXT NOT NULL,
    supporter_hex TEXT,
    amount_lanoshis INTEGER NOT NULL DEFAULT 0,
    amount_fiat REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    tx TEXT,
    donation_type TEXT NOT NULL DEFAULT 'donation',
    timestamp_paid INTEGER,
    event_created_at INTEGER,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cf_donations_owner ON crowdfund_donations(owner_hex);
  CREATE INDEX IF NOT EXISTS idx_cf_donations_currency ON crowdfund_donations(currency);
  CREATE INDEX IF NOT EXISTS idx_cf_donations_paid ON crowdfund_donations(timestamp_paid);

  -- LanaCrowd projects (KIND 31234) — metadata for the monitoring tab + the
  -- blocked-project (KIND 31235) exclusion. Replaceable: keep newest by created_at.
  CREATE TABLE IF NOT EXISTS crowdfund_projects (
    project_id TEXT PRIMARY KEY,
    owner_hex TEXT,
    title TEXT,
    fiat_goal REAL,
    currency TEXT,
    wallet TEXT,
    status TEXT,
    visibility TEXT NOT NULL DEFAULT 'visible',
    project_type TEXT,
    event_created_at INTEGER,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cf_projects_owner ON crowdfund_projects(owner_hex);
`);

// --- Safe migrations: add columns to buyback_transactions ---
const migrationColumns = [
  "ALTER TABLE buyback_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'internal'",
  "ALTER TABLE buyback_transactions ADD COLUMN api_key_id INTEGER REFERENCES api_keys(id)",
  "ALTER TABLE buyback_transactions ADD COLUMN verified_at TEXT",
  "ALTER TABLE buyback_transactions ADD COLUMN verified_by TEXT",
  "ALTER TABLE buyback_transactions ADD COLUMN rpc_verified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE buyback_transactions ADD COLUMN rpc_confirmations INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE buyback_transactions ADD COLUMN rpc_verified_at TEXT",
  "ALTER TABLE buyback_transactions ADD COLUMN rpc_block_hash TEXT",
  "ALTER TABLE buyback_transactions ADD COLUMN rpc_block_height INTEGER",
];
for (const sql of migrationColumns) {
  try { db.exec(sql); } catch {}
}

// --- Safe migration: KIND 38888 v3 fields (split_approaching + retail wallet freeze threshold) ---
try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN split_approaching INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN freeze_lana_retail_account_above INTEGER DEFAULT 0`); } catch {}

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

  const defaultExchangeRates = { EUR: 0, USD: 0, GBP: 0 };
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
      split_target_lana, split_approaching, freeze_lana_retail_account_above, trusted_signers, raw_event
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'seed_kind_38888',
    'local_seed_event_' + Date.now(),
    '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3',
    Math.floor(Date.now() / 1000),
    JSON.stringify(defaultRelays),
    JSON.stringify(defaultElectrumServers),
    JSON.stringify(defaultExchangeRates),
    '',
    '1.0.0',
    Math.floor(Date.now() / 1000),
    0,
    0,
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

// --- Safe migration: add commission settings if missing ---
const ensureSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_by) VALUES (?, ?, ?)');
ensureSetting.run('commission_lanapays', '21', 'system');
ensureSetting.run('commission_other', '30', 'system');

// Fix: swap commission values if they were set backwards (lanapays=30, other=21)
const currentLp = (db.prepare("SELECT value FROM app_settings WHERE key = 'commission_lanapays'").get() as any)?.value;
const currentOt = (db.prepare("SELECT value FROM app_settings WHERE key = 'commission_other'").get() as any)?.value;
if (currentLp === '30' && currentOt === '21') {
  db.prepare("UPDATE app_settings SET value = '21' WHERE key = 'commission_lanapays'").run();
  db.prepare("UPDATE app_settings SET value = '30' WHERE key = 'commission_other'").run();
  console.log('[lana-discount] Fixed commission values: LanaPays=21%, Other=30%');
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
  return { EUR: 0 };
}

export function getSplitFromDb(): string | null {
  const row = db.prepare('SELECT split FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.split ?? null;
}

/** KIND 38888 v3 fields: a Split round is near + retail wallet freeze threshold. */
export function getSplitApproachingFromDb(): boolean {
  const row = db.prepare('SELECT split_approaching FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.split_approaching === 1;
}

export function getFreezeLanaRetailAccountAboveFromDb(): number {
  const row = db.prepare('SELECT freeze_lana_retail_account_above FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.freeze_lana_retail_account_above ?? 0;
}

/** Split start (Unix seconds) from KIND 38888, or 0 if not published. */
export function getSplitStartedAtFromDb(): number {
  const row = db.prepare('SELECT split_started_at FROM kind_38888 ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.split_started_at || 0;
}

/**
 * Sum of sale_payouts (fiat) per `hex|currency`, optionally only for payouts
 * made since the current split started (`sinceUnixSec` in Unix seconds; 0 =
 * lifetime). Shared by the Expecting Cash Out report + the crowd-funding
 * eligibility math so both net payouts identically.
 */
export function getPaidByHexCurrencySinceSplit(hexes: string[], sinceUnixSec = 0): Map<string, number> {
  const out = new Map<string, number>();
  if (hexes.length === 0) return out;
  const placeholders = hexes.map(() => '?').join(',');
  const sinceClause = sinceUnixSec > 0 ? "AND sp.paid_at >= datetime(?, 'unixepoch')" : '';
  const params: any[] = sinceUnixSec > 0 ? [...hexes, sinceUnixSec] : [...hexes];
  const rows = db.prepare(`
    SELECT bt.user_hex_id AS hex, bt.currency AS currency, COALESCE(SUM(sp.amount),0) AS paid
    FROM sale_payouts sp
    JOIN buyback_transactions bt ON sp.transaction_id = bt.id
    WHERE bt.user_hex_id IN (${placeholders}) ${sinceClause}
    GROUP BY bt.user_hex_id, bt.currency
  `).all(...params) as any[];
  for (const r of rows) out.set(`${r.hex}|${r.currency}`, r.paid || 0);
  return out;
}

// ── Crowd-funding (LanaCrowd KIND 60200) eligibility ──────────────────────────

export interface CrowdfundDonationData {
  event_id: string;
  project_id: string | null;
  owner_hex: string;
  supporter_hex: string | null;
  amount_lanoshis: number;
  amount_fiat: number;
  currency: string;
  tx: string | null;
  donation_type: string;
  timestamp_paid: number | null;
  event_created_at: number | null;
}
const insertCrowdfundDonationStmt = db.prepare(`
  INSERT OR IGNORE INTO crowdfund_donations
    (event_id, project_id, owner_hex, supporter_hex, amount_lanoshis, amount_fiat, currency, tx, donation_type, timestamp_paid, event_created_at)
  VALUES (@event_id, @project_id, @owner_hex, @supporter_hex, @amount_lanoshis, @amount_fiat, @currency, @tx, @donation_type, @timestamp_paid, @event_created_at)
`);
/** Insert a donation receipt (idempotent — dedupes on event_id). */
export function insertCrowdfundDonation(d: CrowdfundDonationData): void {
  insertCrowdfundDonationStmt.run(d);
}

export interface CrowdfundProjectData {
  project_id: string;
  owner_hex: string | null;
  title: string | null;
  fiat_goal: number | null;
  currency: string | null;
  wallet: string | null;
  status: string | null;
  project_type: string | null;
  event_created_at: number | null;
}
/** Upsert a project (KIND 31234 is replaceable — keep the newest event). Visibility
 *  is patched separately by KIND 31235 so re-indexing never clobbers a 'blocked' flag. */
export function upsertCrowdfundProject(p: CrowdfundProjectData): void {
  db.prepare(`
    INSERT INTO crowdfund_projects
      (project_id, owner_hex, title, fiat_goal, currency, wallet, status, project_type, event_created_at)
    VALUES (@project_id, @owner_hex, @title, @fiat_goal, @currency, @wallet, @status, @project_type, @event_created_at)
    ON CONFLICT(project_id) DO UPDATE SET
      owner_hex = excluded.owner_hex, title = excluded.title, fiat_goal = excluded.fiat_goal,
      currency = excluded.currency, wallet = excluded.wallet, status = excluded.status,
      project_type = excluded.project_type, event_created_at = excluded.event_created_at,
      fetched_at = datetime('now')
    WHERE excluded.event_created_at >= COALESCE(crowdfund_projects.event_created_at, 0)
  `).run(p);
}
export function setCrowdfundProjectVisibility(projectId: string, visibility: string): void {
  db.prepare(`UPDATE crowdfund_projects SET visibility = ? WHERE project_id = ?`).run(visibility, projectId);
}

export interface CrowdfundRaised { owner_hex: string; currency: string; raisedFiat: number; raisedLana: number; donationCount: number; }
/**
 * Raised per owner+currency for donations since `sinceUnixSec` (0 = all-time),
 * counting only donation_type='donation' and excluding donations whose project
 * KIND 31235 has marked blocked.
 */
export function getCrowdfundRaised(sinceUnixSec = 0): CrowdfundRaised[] {
  const sinceClause = sinceUnixSec > 0 ? 'AND d.timestamp_paid >= ?' : '';
  const params: any[] = sinceUnixSec > 0 ? [sinceUnixSec] : [];
  return (db.prepare(`
    SELECT d.owner_hex AS owner_hex, d.currency AS currency,
           COALESCE(SUM(d.amount_fiat),0) AS raisedFiat,
           COALESCE(SUM(d.amount_lanoshis),0) AS raisedLanoshis,
           COUNT(*) AS donationCount
    FROM crowdfund_donations d
    LEFT JOIN crowdfund_projects p ON p.project_id = d.project_id
    WHERE d.donation_type = 'donation'
      AND (p.visibility IS NULL OR p.visibility != 'blocked')
      ${sinceClause}
    GROUP BY d.owner_hex, d.currency
  `).all(...params) as any[]).map((r) => ({
    owner_hex: r.owner_hex, currency: r.currency,
    raisedFiat: Math.round((r.raisedFiat || 0) * 100) / 100,
    raisedLana: Math.round(((r.raisedLanoshis || 0) / 1e8) * 100) / 100,
    donationCount: r.donationCount || 0,
  }));
}

export interface CrowdfundEligibility { owner_hex: string; currency: string; raisedFiat: number; raisedLana: number; donationCount: number; paidFiat: number; remainingFiat: number; }
/** Per owner+currency crowd-funding eligibility for THIS split: raised(since split)
 *  − paid(since split). Both sides scoped to the same window. */
export function getCrowdfundEligibility(sinceUnixSec = 0): CrowdfundEligibility[] {
  const raised = getCrowdfundRaised(sinceUnixSec);
  const hexes = [...new Set(raised.map((r) => r.owner_hex))];
  const paid = getPaidByHexCurrencySinceSplit(hexes, sinceUnixSec);
  return raised.map((r) => {
    const paidFiat = Math.round((paid.get(`${r.owner_hex}|${r.currency}`) || 0) * 100) / 100;
    return { ...r, paidFiat, remainingFiat: Math.max(0, Math.round((r.raisedFiat - paidFiat) * 100) / 100) };
  });
}

/** Set of owner hexes with remaining crowd-funding eligibility > 0 in `currency`
 *  (this split). NEVER throws → an empty set means "no crowd-funding blocks", so
 *  payout ordering behaves exactly like today if the data is unavailable. */
export function getCrowdfundBandSet(currency: string): Set<string> {
  try {
    const since = getSplitStartedAtFromDb();
    const set = new Set<string>();
    for (const e of getCrowdfundEligibility(since)) {
      if (e.currency === currency && e.remainingFiat > 0) set.add(e.owner_hex);
    }
    return set;
  } catch (err: any) {
    console.warn('[lana-discount] getCrowdfundBandSet failed (fail-open):', err?.message);
    return new Set<string>();
  }
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
    WHERE status IN ('broadcast', 'completed')
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

export function getPaginatedBuybackTransactions(opts: {
  page: number; limit: number; status?: string; search?: string;
}): { data: any[]; total: number } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.status && opts.status !== 'all') {
    conditions.push('bt.status = ?');
    params.push(opts.status);
  }
  if (opts.search) {
    conditions.push('(u.display_name LIKE ? OR u.full_name LIKE ? OR bt.user_hex_id LIKE ? OR bt.tx_hash LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s, s);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (opts.page - 1) * opts.limit;

  const total = (db.prepare(`
    SELECT COUNT(*) as count FROM buyback_transactions bt
    LEFT JOIN users u ON bt.user_hex_id = u.nostr_hex_id
    ${where}
  `).get(...params) as any).count;

  const data = db.prepare(`
    SELECT bt.*, u.display_name, u.full_name
    FROM buyback_transactions bt
    LEFT JOIN users u ON bt.user_hex_id = u.nostr_hex_id
    ${where}
    ORDER BY bt.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, opts.limit, offset) as any[];

  return { data, total };
}

export function getUserSalesWithPayouts(hexId: string): any[] {
  // Get all completed/paid sales for this user (exclude failed)
  const sales = db.prepare(`
    SELECT * FROM buyback_transactions
    WHERE user_hex_id = ? AND status IN ('broadcast', 'pending_verification', 'completed', 'paid')
    ORDER BY created_at DESC
  `).all(hexId) as any[];

  // Get all payouts for each sale
  const getPayouts = db.prepare(`
    SELECT * FROM sale_payouts
    WHERE transaction_id = ?
    ORDER BY paid_at ASC
  `);

  return sales.map(sale => {
    const payouts = getPayouts.all(sale.id) as any[];
    const totalPaid = payouts.reduce((sum: number, p: any) => sum + p.amount, 0);
    const remaining = Math.round((sale.net_fiat - totalPaid) * 100) / 100;

    return {
      id: sale.id,
      lanaAmount: sale.lana_amount_display,
      lanaAmountLanoshis: sale.lana_amount_lanoshis,
      currency: sale.currency,
      exchangeRate: sale.exchange_rate,
      split: sale.split,
      grossFiat: sale.gross_fiat,
      commissionPercent: sale.commission_percent,
      commissionFiat: sale.commission_fiat,
      netFiat: sale.net_fiat,
      txHash: sale.tx_hash,
      txFeeLanoshis: sale.tx_fee_lanoshis,
      status: sale.status,
      createdAt: sale.created_at,
      completedAt: sale.completed_at,
      senderWallet: sale.sender_wallet_id,
      buybackWallet: sale.buyback_wallet_id,
      totalPaid: Math.round(totalPaid * 100) / 100,
      remaining: remaining <= 0 ? 0 : remaining,
      payouts: payouts.map(p => ({
        id: p.id,
        payoutId: p.payout_id,
        amount: p.amount,
        currency: p.currency,
        paidToAccount: p.paid_to_account,
        reference: p.reference,
        note: p.note,
        paidAt: p.paid_at,
      })),
    };
  });
}

// Mock sales data seeding removed — production uses real transactions only

// --- Admin Payout Helpers ---

/** Generate a unique payout ID in format PAY-YYYY-NNN */
export function generatePayoutId(): string {
  const year = new Date().getFullYear();
  const count = (db.prepare('SELECT COUNT(*) as count FROM sale_payouts').get() as any).count;
  const seq = (count + 1).toString().padStart(3, '0');
  return `PAY-${year}-${seq}`;
}

/** Insert a payout installment and auto-update transaction status if fully paid */
export function insertSalePayout(data: {
  transactionId: number;
  payoutId: string;
  amount: number;
  currency: string;
  paidToAccount: string | null;
  reference?: string;
  note?: string;
}): any {
  const result = db.prepare(`
    INSERT INTO sale_payouts (transaction_id, payout_id, amount, currency, paid_to_account, reference, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.transactionId, data.payoutId, data.amount, data.currency,
    data.paidToAccount || null, data.reference || null, data.note || null
  );

  // Check if fully paid — update buyback_transactions status
  const tx = db.prepare('SELECT net_fiat FROM buyback_transactions WHERE id = ?').get(data.transactionId) as any;
  const totalPaid = (db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM sale_payouts WHERE transaction_id = ?'
  ).get(data.transactionId) as any).total;

  if (tx && totalPaid >= tx.net_fiat) {
    db.prepare("UPDATE buyback_transactions SET status = 'paid' WHERE id = ?").run(data.transactionId);
  }

  return {
    id: Number(result.lastInsertRowid),
    payoutId: data.payoutId,
    amount: data.amount,
    currency: data.currency,
    paidToAccount: data.paidToAccount,
  };
}

/** Get admin payout stats — totalPaidOut and totalRemaining */
export function getAdminPayoutStats(): {
  totalLanaBoughtBack: number;
  totalOwed: number;
  totalPaidOut: number;
  totalRemaining: number;
  totalTransactions: number;
  usersServed: number;
} {
  const txStats = db.prepare(`
    SELECT
      COALESCE(SUM(lana_amount_display), 0) as totalLana,
      COALESCE(SUM(net_fiat), 0) as totalFiat,
      COUNT(*) as txCount,
      COUNT(DISTINCT user_hex_id) as userCount
    FROM buyback_transactions
    WHERE status IN ('broadcast', 'completed', 'paid')
  `).get() as any;

  const pendingVerificationCount = getPendingVerificationCount();

  const payoutTotal = (db.prepare(`
    SELECT COALESCE(SUM(sp.amount), 0) as total
    FROM sale_payouts sp
    JOIN buyback_transactions bt ON sp.transaction_id = bt.id
    WHERE bt.status IN ('broadcast', 'completed', 'paid')
  `).get() as any).total;

  const totalOwed = Math.round((txStats.totalFiat || 0) * 100) / 100;
  const totalPaidOut = Math.round((payoutTotal || 0) * 100) / 100;

  return {
    totalLanaBoughtBack: txStats.totalLana || 0,
    totalOwed,
    totalPaidOut,
    totalRemaining: Math.round((totalOwed - totalPaidOut) * 100) / 100,
    totalTransactions: txStats.txCount || 0,
    usersServed: txStats.userCount || 0,
    pendingVerificationCount,
  };
}

/** Get all sales with payouts for admin view — grouped by user */
export function getAllSalesWithPayouts(): any[] {
  // Get all users who have completed/paid/pending_verification transactions
  const users = db.prepare(`
    SELECT DISTINCT bt.user_hex_id, u.display_name, u.full_name
    FROM buyback_transactions bt
    LEFT JOIN users u ON bt.user_hex_id = u.nostr_hex_id
    WHERE bt.status IN ('broadcast', 'completed', 'paid', 'pending_verification')
    ORDER BY bt.user_hex_id
  `).all() as any[];

  const getSales = db.prepare(`
    SELECT * FROM buyback_transactions
    WHERE user_hex_id = ? AND status IN ('broadcast', 'completed', 'paid', 'pending_verification')
    ORDER BY created_at DESC
  `);

  const getPayouts = db.prepare(`
    SELECT * FROM sale_payouts WHERE transaction_id = ? ORDER BY paid_at ASC
  `);

  return users.map(user => {
    const sales = getSales.all(user.user_hex_id) as any[];

    return {
      hexId: user.user_hex_id,
      displayName: user.display_name || user.full_name || 'Anonymous',
      sales: sales.map(sale => {
        const payouts = getPayouts.all(sale.id) as any[];
        const totalPaid = payouts.reduce((sum: number, p: any) => sum + p.amount, 0);
        const remaining = Math.round((sale.net_fiat - totalPaid) * 100) / 100;

        return {
          id: sale.id,
          lanaAmount: sale.lana_amount_display,
          lanaAmountLanoshis: sale.lana_amount_lanoshis,
          currency: sale.currency,
          exchangeRate: sale.exchange_rate,
          grossFiat: sale.gross_fiat,
          commissionPercent: sale.commission_percent,
          commissionFiat: sale.commission_fiat,
          netFiat: sale.net_fiat,
          txHash: sale.tx_hash,
          senderWalletId: sale.sender_wallet_id,
          buybackWalletId: sale.buyback_wallet_id,
          status: sale.status,
          source: sale.source || 'internal',
          verifiedAt: sale.verified_at || null,
          rpcVerified: !!sale.rpc_verified,
          rpcConfirmations: sale.rpc_confirmations || 0,
          rpcBlockHeight: sale.rpc_block_height || null,
          rpcVerifiedAt: sale.rpc_verified_at || null,
          createdAt: sale.created_at,
          completedAt: sale.completed_at || null,
          totalPaid: Math.round(totalPaid * 100) / 100,
          remaining: remaining <= 0 ? 0 : remaining,
          payouts: payouts.map(p => ({
            id: p.id,
            payoutId: p.payout_id,
            amount: p.amount,
            currency: p.currency,
            paidToAccount: p.paid_to_account,
            reference: p.reference,
            note: p.note,
            paidAt: p.paid_at,
          })),
        };
      }),
    };
  });
}

// --- API Key Helpers ---

export function insertApiKey(keyHash: string, appName: string, label: string | null, createdBy: string): number {
  const result = db.prepare(
    'INSERT INTO api_keys (key_hash, app_name, label, created_by) VALUES (?, ?, ?, ?)'
  ).run(keyHash, appName, label, createdBy);
  return Number(result.lastInsertRowid);
}

export function getApiKeyByHash(keyHash: string): any | null {
  return db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash) || null;
}

export function getAllApiKeys(): any[] {
  return db.prepare(
    'SELECT id, app_name, label, created_by, created_at, last_used_at, is_active FROM api_keys ORDER BY created_at DESC'
  ).all() as any[];
}

export function updateApiKeyLastUsed(id: number): void {
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

export function toggleApiKeyActive(id: number, active: boolean): void {
  db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function deleteApiKey(id: number): void {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

// --- External Transaction Helpers ---

export interface ExternalBuybackData {
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
  tx_hash: string;
  tx_fee_lanoshis: number;
  api_key_id: number;
}

export function insertExternalTransaction(data: ExternalBuybackData): number {
  const result = db.prepare(`
    INSERT INTO buyback_transactions (
      user_hex_id, sender_wallet_id, buyback_wallet_id,
      lana_amount_lanoshis, lana_amount_display, currency, exchange_rate,
      split, gross_fiat, commission_percent, commission_fiat, net_fiat,
      tx_hash, tx_fee_lanoshis, status, source, api_key_id,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_verification', 'external', ?, datetime('now'))
  `).run(
    data.user_hex_id, data.sender_wallet_id, data.buyback_wallet_id,
    data.lana_amount_lanoshis, data.lana_amount_display, data.currency, data.exchange_rate,
    data.split, data.gross_fiat, data.commission_percent, data.commission_fiat, data.net_fiat,
    data.tx_hash, data.tx_fee_lanoshis || 0, data.api_key_id
  );
  return Number(result.lastInsertRowid);
}

export function verifyTransaction(txId: number, adminHex: string): boolean {
  const result = db.prepare(`
    UPDATE buyback_transactions
    SET status = 'completed', verified_at = datetime('now'), verified_by = ?
    WHERE id = ? AND status = 'pending_verification'
  `).run(adminHex, txId);
  return result.changes > 0;
}

export function rejectTransaction(txId: number, reason: string | null): boolean {
  const result = db.prepare(`
    UPDATE buyback_transactions
    SET status = 'failed', error_message = ?
    WHERE id = ? AND status = 'pending_verification'
  `).run(reason || 'Rejected by admin', txId);
  return result.changes > 0;
}

export function getPendingVerificationCount(): number {
  return (db.prepare("SELECT COUNT(*) as count FROM buyback_transactions WHERE status = 'pending_verification'").get() as any).count;
}

export function txHashExists(txHash: string): boolean {
  return !!(db.prepare('SELECT 1 FROM buyback_transactions WHERE tx_hash = ?').get(txHash));
}

export function closeDb(): void {
  try { db.close(); } catch {}
}

export default db;
