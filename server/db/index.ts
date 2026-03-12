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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    pubkey TEXT,
    relays TEXT,
    raw_event TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_wallet_id ON users(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
`);

export default db;
