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
`);

// --- Safe migrations: add columns to buyback_transactions ---
const migrationColumns = [
  "ALTER TABLE buyback_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'internal'",
  "ALTER TABLE buyback_transactions ADD COLUMN api_key_id INTEGER REFERENCES api_keys(id)",
  "ALTER TABLE buyback_transactions ADD COLUMN verified_at TEXT",
  "ALTER TABLE buyback_transactions ADD COLUMN verified_by TEXT",
];
for (const sql of migrationColumns) {
  try { db.exec(sql); } catch {}
}

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

export function getUserSalesWithPayouts(hexId: string): any[] {
  // Get all completed/paid sales for this user (exclude failed)
  const sales = db.prepare(`
    SELECT * FROM buyback_transactions
    WHERE user_hex_id = ? AND status IN ('completed', 'paid')
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

// --- Seed mock sales data for testing ---
const MOCK_USER_HEX = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
const mockSalesCount = (db.prepare(
  'SELECT COUNT(*) as count FROM buyback_transactions WHERE user_hex_id = ?'
).get(MOCK_USER_HEX) as any).count;

if (mockSalesCount === 0) {
  const insertTx = db.prepare(`
    INSERT INTO buyback_transactions (
      user_hex_id, sender_wallet_id, buyback_wallet_id,
      lana_amount_lanoshis, lana_amount_display, currency, exchange_rate,
      split, gross_fiat, commission_percent, commission_fiat, net_fiat,
      tx_hash, tx_fee_lanoshis, status, error_message,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPayout = db.prepare(`
    INSERT INTO sale_payouts (transaction_id, payout_id, amount, currency, paid_to_account, reference, note, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Sale 1: 500,000 LANA → 4.00 EUR gross → 1.20 commission → 2.80 net → FULLY PAID
  const sale1Id = Number(insertTx.run(
    MOCK_USER_HEX,
    'LWmockSender1xxxxxxxxxxxxxxxxxxxxxx',
    'LBuybackWalletxxxxxxxxxxxxxxxxxxxxxxxxx',
    50000000000000, // 500,000 LANA in lanoshis
    500000,
    'EUR', 0.000008,
    '4',
    4.00, 30, 1.20, 2.80,
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    1500000,
    'paid', null,
    '2026-01-15 10:30:00', '2026-01-15 10:30:45'
  ).lastInsertRowid);

  insertPayout.run(sale1Id, 'PAY-2026-001', 1.00, 'EUR', 'DE89370400440532013000', 'SEPA-2026-001', 'First installment', '2026-01-20 14:00:00');
  insertPayout.run(sale1Id, 'PAY-2026-002', 1.00, 'EUR', 'DE89370400440532013000', 'SEPA-2026-002', 'Second installment', '2026-02-10 11:30:00');
  insertPayout.run(sale1Id, 'PAY-2026-003', 0.80, 'EUR', 'DE89370400440532013000', 'SEPA-2026-003', 'Final installment', '2026-02-28 09:15:00');

  // Sale 2: 1,000,000 LANA → 8.00 EUR gross → 2.40 commission → 5.60 net → PARTIALLY PAID
  const sale2Id = Number(insertTx.run(
    MOCK_USER_HEX,
    'LWmockSender2xxxxxxxxxxxxxxxxxxxxxx',
    'LBuybackWalletxxxxxxxxxxxxxxxxxxxxxxxxx',
    100000000000000, // 1,000,000 LANA in lanoshis
    1000000,
    'EUR', 0.000008,
    '4',
    8.00, 30, 2.40, 5.60,
    'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
    2800000,
    'completed', null,
    '2026-02-20 16:45:00', '2026-02-20 16:45:30'
  ).lastInsertRowid);

  insertPayout.run(sale2Id, 'PAY-2026-004', 2.00, 'EUR', 'DE89370400440532013000', 'SEPA-2026-004', 'First installment', '2026-03-05 10:00:00');
  insertPayout.run(sale2Id, 'PAY-2026-005', 1.50, 'EUR', 'DE89370400440532013000', 'SEPA-2026-005', 'Second installment', '2026-03-12 14:30:00');

  // Sale 3: 250,000 LANA → 2.00 EUR gross → 0.60 commission → 1.40 net → PENDING PAYOUT
  insertTx.run(
    MOCK_USER_HEX,
    'LWmockSender3xxxxxxxxxxxxxxxxxxxxxx',
    'LBuybackWalletxxxxxxxxxxxxxxxxxxxxxxxxx',
    25000000000000, // 250,000 LANA in lanoshis
    250000,
    'EUR', 0.000008,
    '4',
    2.00, 30, 0.60, 1.40,
    'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    750000,
    'completed', null,
    '2026-03-13 08:20:00', '2026-03-13 08:20:25'
  );

  console.log('[lana-discount] Seeded mock sales data for user', MOCK_USER_HEX.slice(0, 8) + '...');
}

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
    WHERE status IN ('completed', 'paid')
  `).get() as any;

  const pendingVerificationCount = getPendingVerificationCount();

  const payoutTotal = (db.prepare(`
    SELECT COALESCE(SUM(sp.amount), 0) as total
    FROM sale_payouts sp
    JOIN buyback_transactions bt ON sp.transaction_id = bt.id
    WHERE bt.status IN ('completed', 'paid')
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
    WHERE bt.status IN ('completed', 'paid', 'pending_verification')
    ORDER BY bt.user_hex_id
  `).all() as any[];

  const getSales = db.prepare(`
    SELECT * FROM buyback_transactions
    WHERE user_hex_id = ? AND status IN ('completed', 'paid', 'pending_verification')
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
          createdAt: sale.created_at,
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
