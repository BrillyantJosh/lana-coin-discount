import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { fetchKind38888, Kind38888Data } from './lib/nostr.js';
import db, { closeDb, getElectrumServersFromDb, getAppSetting } from './db/index.js';

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

function withTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, label: string, ms: number): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    fn(controller.signal).then(result => { clearTimeout(timer); return result; }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        console.warn(`[lana-discount] ${label} timed out after ${ms / 1000}s — skipping this cycle`);
        resolve(undefined);
      }, ms);
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Heartbeat — modulo-based task dispatch (same pattern as MejmoseFajn)
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL = 60 * 1000; // 1 minute
const AUTO_SEND_CYCLE = 5; // every 5 heartbeats = 5 min
const AUTO_SEND_OFFSET = 3;
let heartbeatCount = 0;
let lastAutoSendAt: string | null = null;
let nextAutoSendIn = AUTO_SEND_CYCLE - AUTO_SEND_OFFSET; // initial countdown
let autoSendSkipUntil = 0; // timestamp — skip auto-send until this time (insufficient balance cooldown)
let autoSendRunning = false; // prevent concurrent auto-send runs
let lastKnownBalance = 0; // LANA balance from last Electrum fetch (for quick pre-check)

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

          // Re-publish KIND 30936 with RPC data
          try {
            const fullTx = db.prepare('SELECT * FROM buyback_transactions WHERE id = ?').get(tx.id) as any;
            if (fullTx) {
              const { publishBuybackEvent } = await import('./routes/api.js');
              await publishBuybackEvent(fullTx);
            }
          } catch { /* non-critical */ }

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

// ---------------------------------------------------------------------------
// Auto-send pending LANA orders (batch up to 30 recipients per TX)
// ---------------------------------------------------------------------------

async function autoSendPendingLana(): Promise<void> {
  // Prevent concurrent runs
  if (autoSendRunning) {
    console.log('[lana-discount] Auto-send already running — skipping');
    return;
  }

  // Skip if in cooldown (insufficient balance)
  if (Date.now() < autoSendSkipUntil) {
    const remainSec = Math.ceil((autoSendSkipUntil - Date.now()) / 1000);
    console.log(`[lana-discount] Auto-send: insufficient balance cooldown (${remainSec}s remaining) — skipping`);
    return;
  }

  autoSendRunning = true;
  try {
    const buybackWif = process.env.BUYBACK_WIF;
    if (!buybackWif) return;

    // Send LANA orders that are either:
    // 1. Explicitly authorized by Brain (brain_authorized=1), OR
    // 2. In a batch with incoming_batches.status = 'lana_bought' (admin confirmed receipt)
    let pendingOrders = db.prepare(`
      SELECT DISTINCT blo.* FROM brain_lana_orders blo
      LEFT JOIN incoming_batches ib ON blo.batch_ref = ib.batch_ref
      WHERE blo.status = 'pending'
        AND (blo.brain_authorized = 1 OR ib.status = 'lana_bought')
      ORDER BY blo.created_at ASC
      LIMIT 100
    `).all() as any[];

    if (pendingOrders.length === 0) return;

    // Group orders by transaction_ref — all orders in same tx_ref must be sent together (whole batch or nothing)
    const groupMap = new Map<string, any[]>();
    for (const o of pendingOrders) {
      const ref = o.transaction_ref || o.id; // fallback to id if no ref
      const group = groupMap.get(ref) || [];
      group.push(o);
      groupMap.set(ref, group);
    }
    const txGroups = Array.from(groupMap.values()).sort((a, b) => {
      const sumA = a.reduce((s: number, o: any) => s + o.lana_amount, 0);
      const sumB = b.reduce((s: number, o: any) => s + o.lana_amount, 0);
      return sumA - sumB; // smallest groups first
    });

    let totalLanoshis = pendingOrders.reduce((s: number, o: any) => s + o.lana_amount, 0);
    const totalLana = totalLanoshis / 100_000_000;

    console.log(`[lana-discount] Auto-send LANA: ${pendingOrders.length} orders in ${txGroups.length} groups, ${totalLana.toFixed(3)} LANA total`);

    // Quick balance check: use cached balance from last Electrum fetch to skip early
    const smallestGroupLanoshis = txGroups[0].reduce((s: number, o: any) => s + o.lana_amount, 0);
    const smallestGroupLana = smallestGroupLanoshis / 100_000_000;
    if (lastKnownBalance > 0 && lastKnownBalance < smallestGroupLana + 1) {
      autoSendSkipUntil = Date.now() + 15 * 60 * 1000;
      console.log(`[lana-discount] Auto-send: known balance (${lastKnownBalance.toFixed(3)} LANA) too low for smallest group (${smallestGroupLana.toFixed(3)} LANA) — cooldown 15min`);
      return;
    }

    const { normalizeWif, base58CheckDecode, privateKeyToUncompressedPublicKey, privateKeyToPublicKey, publicKeyToAddress, normalizeAddress, buildSignedTx } = await import('./lib/transaction.js');
    const { electrumCall } = await import('./lib/electrum.js');

    const electrumServers = getElectrumServersFromDb();
    if (electrumServers.length === 0) {
      console.warn('[lana-discount] Auto-send: no electrum servers');
      return;
    }

    // Derive addresses from WIF
    const normalizedKey = normalizeWif(buybackWif);
    const keyBytes = base58CheckDecode(normalizedKey);
    const privKeyHex = Array.from(keyBytes.slice(1, 33)).map(b => b.toString(16).padStart(2, '0')).join('');

    const uncompAddr = publicKeyToAddress(privateKeyToUncompressedPublicKey(privKeyHex));
    const compAddr = publicKeyToAddress(privateKeyToPublicKey(privKeyHex));

    let useAddress = uncompAddr;
    let useCompressed = false;

    let utxos = await electrumCall('blockchain.address.listunspent', [uncompAddr], electrumServers);
    if (!utxos || utxos.length === 0) {
      utxos = await electrumCall('blockchain.address.listunspent', [compAddr], electrumServers);
      if (utxos && utxos.length > 0) { useAddress = compAddr; useCompressed = true; }
    }

    if (!utxos || utxos.length === 0) {
      console.warn('[lana-discount] Auto-send: no UTXOs in buyback wallet');
      autoSendSkipUntil = Date.now() + 15 * 60 * 1000;
      return;
    }

    // Update known balance from UTXOs
    lastKnownBalance = utxos.reduce((s: number, u: any) => s + u.value, 0) / 100_000_000;

    // Build recipients
    const txRecipients = pendingOrders.map((o: any) => ({
      address: normalizeAddress(o.to_wallet),
      amount: o.lana_amount,
    }));

    // UTXO selection
    const outputCount = txRecipients.length + 1;
    const sorted = [...utxos].sort((a: any, b: any) => b.value - a.value);
    let selected: any[] = [];
    let total = 0;
    let fee = 0;

    for (const u of sorted) {
      if (selected.length >= 30) break;
      selected.push(u);
      total += u.value;
      fee = Math.floor((selected.length * 180 + outputCount * 34 + 10) * 150);
      if (total >= totalLanoshis + fee) break;
    }

    if (total < totalLanoshis + fee) {
      // Try to send whole groups (batches) that we can afford — never split a group
      console.warn(`[lana-discount] Auto-send: insufficient balance for all ${pendingOrders.length} orders (need ${totalLanoshis + fee}, have ${total}). Trying whole groups...`);

      const affordableGroups: any[][] = [];
      let runningTotal = 0;

      for (const group of txGroups) {
        const groupTotal = group.reduce((s: number, o: any) => s + o.lana_amount, 0);
        const newTotal = runningTotal + groupTotal;
        const estInputs = Math.min(5, sorted.length);
        const estOutputs = affordableGroups.reduce((s, g) => s + g.length, 0) + group.length + 1;
        const estFee = Math.floor((estInputs * 180 + estOutputs * 34 + 10) * 150);
        if (newTotal + estFee <= total) {
          affordableGroups.push(group);
          runningTotal = newTotal;
        }
      }

      if (affordableGroups.length === 0) {
        const smallestGroup = txGroups[0];
        const smallestTotal = smallestGroup?.reduce((s: number, o: any) => s + o.lana_amount, 0) || 0;
        // Cooldown for 15 minutes — don't keep retrying when balance is too low
        autoSendSkipUntil = Date.now() + 15 * 60 * 1000;
        console.warn(`[lana-discount] Auto-send: cannot afford even smallest group (${(smallestTotal / 100_000_000).toFixed(3)} LANA, ${smallestGroup?.length} orders, available: ${(total / 100_000_000).toFixed(3)} LANA) — cooldown 15min`);
        return;
      }

      const affordableOrders = affordableGroups.flat();
      console.log(`[lana-discount] Auto-send partial: sending ${affordableGroups.length}/${txGroups.length} groups (${affordableOrders.length} orders, ${(runningTotal / 100_000_000).toFixed(3)} LANA)`);

      // Re-select UTXOs for partial amount only
      selected = [];
      total = 0;
      const partialOutputCount = affordableOrders.length + 1;
      for (const u of sorted) {
        if (selected.length >= 30) break;
        selected.push(u);
        total += u.value;
        fee = Math.floor((selected.length * 180 + partialOutputCount * 34 + 10) * 150);
        if (total >= runningTotal + fee) break;
      }

      if (total < runningTotal + fee) {
        console.warn('[lana-discount] Auto-send partial: still insufficient after UTXO re-select — skipping');
        return;
      }

      // Replace with affordable subset
      pendingOrders = affordableOrders;
      totalLanoshis = runningTotal;

      // Rebuild recipients for partial set
      txRecipients.length = 0;
      txRecipients.push(...affordableOrders.map((o: any) => ({
        address: normalizeAddress(o.to_wallet),
        amount: o.lana_amount,
      })));
    }

    // Build, sign, broadcast
    const { txHex } = await buildSignedTx(selected, buybackWif, txRecipients, fee, useAddress, electrumServers, useCompressed);
    const txHash = await electrumCall('blockchain.transaction.broadcast', [txHex], electrumServers);

    if (!txHash || typeof txHash !== 'string' || txHash.length !== 64) {
      console.error('[lana-discount] Auto-send broadcast failed:', txHash);
      return;
    }

    const sentLana = totalLanoshis / 100_000_000;
    console.log(`[lana-discount] Auto-send LANA TX: ${txHash} (${pendingOrders.length} recipients, ${sentLana.toFixed(3)} LANA)`);

    // Update all orders to 'sent'
    const updateStmt = db.prepare("UPDATE brain_lana_orders SET status = 'sent', tx_hash = ?, completed_at = datetime('now') WHERE id = ?");
    for (const o of pendingOrders) {
      updateStmt.run(txHash, o.id);
    }

    // Notify Brain that LANA was sent (callback)
    const sentTxRefs = [...new Set(pendingOrders.map((o: any) => o.transaction_ref).filter(Boolean))];
    if (sentTxRefs.length > 0) {
      const brainUrl = process.env.BRAIN_CALLBACK_URL || process.env.BRAIN_API_URL;
      const brainKey = process.env.BRAIN_CALLBACK_KEY || process.env.LANA_DISCOUNT_API_KEY;
      if (brainUrl) {
        fetch(`${brainUrl}/api/callbacks/lana-sent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-key': brainKey || '' },
          body: JSON.stringify({ transaction_refs: sentTxRefs, tx_hash: txHash }),
        }).then(r => {
          if (r.ok) console.log(`[lana-discount] Brain callback lana-sent: ${sentTxRefs.length} txs`);
          else console.warn(`[lana-discount] Brain callback failed: HTTP ${r.status}`);
        }).catch(err => console.warn('[lana-discount] Brain callback error:', err.message));
      }
    }

    // Update incoming_batches per-batch: if all orders for a batch are sent, mark it lana_sent
    const boughtBatches = db.prepare("SELECT * FROM incoming_batches WHERE status = 'lana_bought'").all() as any[];
    for (const batch of boughtBatches) {
      // Check if this batch has any pending orders via batch_ref
      const pendingForBatch = (db.prepare(
        "SELECT COUNT(*) as c FROM brain_lana_orders WHERE batch_ref = ? AND status = 'pending'"
      ).get(batch.batch_ref) as any).c;
      const totalForBatch = (db.prepare(
        "SELECT COUNT(*) as c FROM brain_lana_orders WHERE batch_ref = ?"
      ).get(batch.batch_ref) as any).c;

      if (totalForBatch > 0 && pendingForBatch === 0) {
        // All orders for this batch are sent — get the tx_hash from one of the sent orders
        const sentOrder = db.prepare(
          "SELECT tx_hash FROM brain_lana_orders WHERE batch_ref = ? AND status = 'sent' AND tx_hash IS NOT NULL LIMIT 1"
        ).get(batch.batch_ref) as any;
        const batchTxHash = sentOrder?.tx_hash || txHash;

        db.prepare(`
          UPDATE incoming_batches SET status = 'lana_sent', lana_sent_at = datetime('now'), lana_tx_hash = ?
          WHERE id = ?
        `).run(batchTxHash, batch.id);
        console.log(`[lana-discount] Batch ${batch.batch_ref} → lana_sent (all ${totalForBatch} orders sent)`);
      }
    }

    // Fallback for batches without batch_ref linked orders: if no pending orders globally, move remaining
    const stillPendingGlobal = (db.prepare("SELECT COUNT(*) as c FROM brain_lana_orders WHERE status = 'pending'").get() as any).c;
    if (stillPendingGlobal === 0) {
      const updated = db.prepare(`
        UPDATE incoming_batches SET status = 'lana_sent', lana_sent_at = datetime('now'), lana_tx_hash = ?
        WHERE status = 'lana_bought'
      `).run(txHash);
      if (updated.changes > 0) {
        console.log(`[lana-discount] Fallback: moved ${updated.changes} remaining batches → lana_sent`);
      }
    }
  } catch (err: any) {
    console.error('[lana-discount] Auto-send LANA error:', err.message);
  } finally {
    autoSendRunning = false;
  }
}

// Heartbeat loop — waits for tasks to finish before sleeping (no overlap)
let heartbeatRunning = true;

async function heartbeatLoop() {
  console.log(`[lana-discount] Heartbeat loop started (interval: ${HEARTBEAT_INTERVAL / 1000}s)`);
  while (heartbeatRunning) {
    await sleep(HEARTBEAT_INTERVAL);
    if (!heartbeatRunning) break;
    heartbeatCount++;
    console.log(`[lana-discount] Heartbeat #${heartbeatCount}`);
    try {
      // KIND 38888 sync every 60 heartbeats (= every hour)
      if (heartbeatCount % 60 === 0) {
        await withTimeout(() => syncKind38888ToDb(), 'KIND 38888 sync', 30000);
      }

      // RPC transaction verification every 10 heartbeats (= every 10 minutes)
      if (heartbeatCount % 10 === 0) {
        await withTimeout(() => verifyUnconfirmedTransactions(), 'RPC verification', 30000);
      }

      // Auto-send pending LANA every 5 heartbeats (= every 5 minutes)
      nextAutoSendIn = AUTO_SEND_CYCLE - ((heartbeatCount % AUTO_SEND_CYCLE) - AUTO_SEND_OFFSET + AUTO_SEND_CYCLE) % AUTO_SEND_CYCLE;
      if (nextAutoSendIn === AUTO_SEND_CYCLE) nextAutoSendIn = 0;
      if (heartbeatCount % AUTO_SEND_CYCLE === AUTO_SEND_OFFSET) {
        await withTimeout(() => autoSendPendingLana(), 'Auto-send LANA', 45000);
        lastAutoSendAt = new Date().toISOString();
        nextAutoSendIn = AUTO_SEND_CYCLE;
      }
    } catch (err: any) {
      console.error(`[lana-discount] Heartbeat #${heartbeatCount} error:`, err.message);
    }
  }
}

heartbeatLoop().catch(err => console.error('[lana-discount] Heartbeat loop crashed:', err));

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string) {
  console.log(`[lana-discount] ${signal} received — shutting down gracefully`);
  heartbeatRunning = false;
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Heartbeat status endpoint for UI
app.get('/api/heartbeat-status', (req, res) => {
  const pendingCount = (db.prepare("SELECT COUNT(*) as c FROM brain_lana_orders WHERE status = 'pending'").get() as any).c;
  // Calculate seconds until next heartbeat (60s cycle)
  const now = Date.now();
  const elapsedSinceLastHb = now % HEARTBEAT_INTERVAL;
  const nextHbSec = Math.ceil((HEARTBEAT_INTERVAL - elapsedSinceLastHb) / 1000);

  res.json({
    heartbeatCount,
    heartbeatIntervalSec: HEARTBEAT_INTERVAL / 1000,
    autoSendCycleMin: AUTO_SEND_CYCLE,
    nextAutoSendMin: nextAutoSendIn,
    nextHeartbeatSec: nextHbSec,
    lastAutoSendAt,
    pendingLanaOrders: pendingCount,
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[lana-discount] Server running on port ${PORT}`);

  // Initial KIND 38888 sync on startup
  const ok = await syncKind38888ToDb();
  if (!ok) {
    console.warn('[lana-discount] Initial sync failed — using seed data as fallback');
  }
});
