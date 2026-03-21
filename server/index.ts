import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { fetchKind38888, Kind38888Data } from './lib/nostr.js';
import db, { closeDb } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1); // Behind nginx reverse proxy
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Security middleware ─────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://lana.discount',
  'https://www.lana.discount',
  'https://brain.lanapays.us',
  'https://direct.lana.fund',
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(null, false);
  },
}));
app.use(express.json({ limit: '50kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// API routes
app.use('/api', apiRouter);
app.use('/health', (_req, res) => res.redirect('/api/health'));

// Serve static frontend in production
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ---------------------------------------------------------------------------
// KIND 38888 sync — fetches from relays and stores in DB (DELETE + INSERT)
// ---------------------------------------------------------------------------

async function syncKind38888ToDb(): Promise<boolean> {
  try {
    const data: Kind38888Data | null = await fetchKind38888();
    if (!data) {
      console.warn('[lana-discount] KIND 38888 sync returned no data');
      return false;
    }

    // Replace old data with fresh
    db.prepare('DELETE FROM kind_38888').run();
    db.prepare(`
      INSERT INTO kind_38888 (
        id, event_id, pubkey, created_at, relays, electrum_servers,
        exchange_rates, split, version, valid_from, split_started_at,
        split_target_lana, trusted_signers, raw_event
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'live_' + data.event_id,
      data.event_id,
      data.pubkey,
      data.created_at,
      JSON.stringify(data.relays),
      JSON.stringify(data.electrum_servers),
      JSON.stringify(data.exchange_rates),
      data.split || null,
      data.version || null,
      data.valid_from || null,
      data.split_started_at || null,
      data.split_target_lana || null,
      JSON.stringify(data.trusted_signers),
      data.raw_event
    );

    console.log(`[lana-discount] KIND 38888 synced — ${data.relays.length} relays, version ${data.version}`);
    return true;
  } catch (error) {
    console.error('[lana-discount] KIND 38888 sync failed:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// withTimeout — prevents any single heartbeat task from blocking forever
// ---------------------------------------------------------------------------

function withTimeout<T>(fn: () => Promise<T>, label: string, ms: number): Promise<T | undefined> {
  return Promise.race([
    fn(),
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        console.warn(`[lana-discount] ${label} timed out after ${ms / 1000}s — skipping this cycle`);
        resolve(undefined);
      }, ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Heartbeat — modulo-based task dispatch (same pattern as MejmoseFajn)
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL = 60 * 1000; // 1 minute
let heartbeatCount = 0;

async function verifyUnconfirmedTransactions(): Promise<void> {
  try {
    const { verifyTransaction, checkRpcConnection } = await import('./lib/rpc.js');

    const rpcStatus = await checkRpcConnection();
    if (!rpcStatus.connected) {
      console.log(`[lana-discount] RPC not reachable: ${rpcStatus.error}`);
      return;
    }

    const unverified = db.prepare(`
      SELECT id, tx_hash, status FROM buyback_transactions
      WHERE tx_hash IS NOT NULL AND tx_hash != ''
        AND rpc_verified = 0
        AND status IN ('broadcast', 'completed', 'pending_verification')
    `).all() as any[];

    if (unverified.length === 0) return;

    console.log(`[lana-discount] Verifying ${unverified.length} transaction(s) via RPC (block ${rpcStatus.blockHeight})...`);

    let verified = 0;
    for (const tx of unverified) {
      try {
        const result = await verifyTransaction(tx.tx_hash);
        if (result.confirmed) {
          const txBlockHeight = rpcStatus.blockHeight ? rpcStatus.blockHeight - result.confirmations + 1 : null;
          // Update RPC fields + promote 'broadcast' → 'completed'
          const newStatus = tx.status === 'broadcast' ? 'completed' : tx.status;
          db.prepare(`
            UPDATE buyback_transactions
            SET rpc_verified = 1, rpc_confirmations = ?, rpc_verified_at = datetime('now'),
                rpc_block_hash = ?, rpc_block_height = ?,
                status = CASE WHEN status = 'broadcast' THEN 'completed' ELSE status END,
                completed_at = CASE WHEN status = 'broadcast' THEN datetime('now') ELSE completed_at END
            WHERE id = ?
          `).run(result.confirmations, result.blockHash || null, txBlockHeight, tx.id);
          console.log(`[lana-discount] TX#${tx.id} RPC verified: ${result.confirmations} conf, block #${txBlockHeight} — status → ${newStatus}`);
          verified++;
        }
      } catch (err: any) {
        console.warn(`[lana-discount] RPC verify failed for TX#${tx.id}: ${err.message}`);
      }
    }

    if (verified > 0) {
      console.log(`[lana-discount] RPC verified ${verified}/${unverified.length} transaction(s)`);
    }
  } catch (err: any) {
    console.error('[lana-discount] RPC verification error:', err.message);
  }
}

const heartbeatTimer = setInterval(async () => {
  heartbeatCount++;

  // KIND 38888 sync every 60 heartbeats (= every hour)
  if (heartbeatCount % 60 === 0) {
    await withTimeout(() => syncKind38888ToDb(), 'KIND 38888 sync', 45000);
  }

  // RPC transaction verification every 10 heartbeats (= every 10 minutes)
  if (heartbeatCount % 10 === 0) {
    await verifyUnconfirmedTransactions();
  }
}, HEARTBEAT_INTERVAL);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string) {
  console.log(`[lana-discount] ${signal} received — shutting down gracefully`);
  clearInterval(heartbeatTimer);
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[lana-discount] Server running on port ${PORT}`);

  // Initial KIND 38888 sync on startup
  const ok = await syncKind38888ToDb();
  if (!ok) {
    console.warn('[lana-discount] Initial sync failed — using seed data as fallback');
  }
});
