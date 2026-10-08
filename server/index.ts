import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { installRequestLogging } from './shared/requestLogging.js';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { createAcquisitionsRouter } from './routes/acquisitions.js';
import { createTreasuryRouter } from './routes/treasury.js';
import { createConsolidationRouter } from './routes/consolidation.js';
import { pullRoundMandates } from './lib/roundMandateSync.js';
import { applyPublishedRoundTerms } from './lib/publishedRoundTerms.js';
import { publishBudgetSettlements } from './lib/budgetSettlementPublisher.js';
import { fetchKind38888, fetchKind0, Kind38888Data } from './lib/nostr.js';
import db, { closeDb, getElectrumServersFromDb, getAppSetting, getRelaysFromDb } from './db/index.js';
import { heartbeatLegCounts } from './lib/autoSendSelection.js';
import { runOutbox, outboxHealth, brainCallbackTarget } from './lib/financer/brainOutbox.js';
import { createFinancerRouter } from './routes/financer.js';
// The LANA send machine (8 Oct 2026): every send recorded before it is
// broadcast and finished from the chain — the financers' and the treasury's.
import { defaultSends, sendsHealth } from './lib/financer/sends.js';
import { financerHeartbeatFields } from './lib/financer/heartbeatStatus.js';
import { createTreasuryAutoSend } from './lib/treasuryAutoSend.js';
import { settleBatchesWithSentLana } from './lib/batchSettlement.js';
import { installJsonBodies } from './lib/jsonBodies.js';
import { apiRateLimit } from './lib/apiRateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Gzip every response. Measured 2026-08-05 on direct.lana.fund: a 5.1 MB
// admin JSON feed was going out UNCOMPRESSED — nothing in the chain (app or
// nginx-proxy) set Content-Encoding — and the page took ~10 s. The same
// payload gzips ~10x. Registered first so it wraps every route.
app.use(compression());
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
// ─── Request logging + 24h retention ──────────────────────
// Breadcrumb trail of every request path, to debug stuck flows. Stores
// method/path/status/duration/ip ONLY — never bodies (may hold WIF/secrets).
// Skips static assets; auto-purges rows older than 24h; viewable by root admin.
// Registered BEFORE the rate limiter so 429 (Too Many Requests) responses ARE logged,
// and BEFORE the body parsers so a refused body is logged too: on 2 Oct 2026 a
// batch too large to confirm left no trace here, because the parser threw first.
installRequestLogging(app, db);

// JSON bodies: 50 kb everywhere, more for the one route whose body is a whole
// batch of payments, and refusals answered in JSON. See lib/jsonBodies.ts.
installJsonBodies(app);

// Rate limit per IP, ON THE API ONLY. It used to sit in front of everything,
// so an operator who spent their budget on polls could not load the site at
// all: /login answered "Too many requests, please try again later." in plain
// text, with no page, no styling and no way back in (seen 9 Sept 2026, after
// the admin pages resolved ~70 names one request at a time). Serving HTML and
// assets costs nothing worth defending; the API is what abuse would target.
//
// 1500/15min (≈100/min) stays: the admin pages poll incoming-payments,
// heartbeat-status and profiles, and a tighter cap once blocked send-batch-lana
// in the middle of a payout run.
//
// Per IP is the right shape for browsers and the wrong one for lana-brain. The
// brain reaches us over the docker network, so ALL of it arrives from one
// container IP and shares one bucket. Its heartbeat asks GET
// /api/brain/lana-order/:id about every open order — with ~1,078 of them open
// in October that is ~1,000 requests every 10 minutes — on top of order
// ingest, mandate pushes and round-terms. From 7 Oct 2026 12:01 UTC that
// bucket ran dry early in every 15-minute window and the rest of the window
// was 429: 19,692 refusals in 24 hours, every one of them to the brain's IP
// and not one to anybody else. They did damage. A refused POST
// /api/brain/lana-order made the brain record the leg as failed, and 10 cash
// purchases were falsely settled on the strength of it; a refused
// send-customer-lana turned LANA purchases away at the till; refused
// round-terms kept KIND 30960 being republished over and over.
//
// So a machine caller that authenticates is let past, as Direct.Fund lets the
// brain past its limiter (isBrainRequest in its server/index.ts): an
// authenticated server-to-server caller is not the abuse this limit is for.
// Anonymous and browser traffic keeps 1500/15min, unchanged. The test is the
// one requireApiKey makes, not a look at the header — anybody can type
// "Bearer ldk_": the whole key must hash to a row in api_keys and that row must
// be active, and if the database cannot say, the request keeps the limit.
// See lib/apiRateLimit.ts and isActiveMachineKey in lib/apiKeyAuth.ts.
app.use('/api', apiRateLimit());

// API routes
app.use('/api', apiRouter);

// The acquisition workflow — a seller proposes, the treasury decides, and only
// then does LANA move. Mounted alongside the existing API rather than inside
// it: /api/sell/* stays exactly as it is until the client has moved over.
app.use('/api/acquisitions', createAcquisitionsRouter({
  walletCheckBaseUrl: process.env.WALLET_CHECK_BASE_URL || 'https://check.lanapays.us',
  publishBuybackEvent: async (tx) => {
    const { publishBuybackEvent } = await import('./routes/api.js');
    return publishBuybackEvent(tx as any);
  },
}));
// Financing-round mandates (KIND 30960): public round dates, the brain's
// push/terms endpoints, and the admin worklist. Reads the tables the
// acquisitions router's gate reads; writes nothing that moves money.
app.use('/api/treasury', createTreasuryRouter());
// Merging a wallet's pieces so a transfer can carry them — copied from
// MejmoSeFajn's Consolidate page (13 Sept 2026). Signs with the seller's key
// exactly as the transfer does; the only output is the seller's own wallet.
app.use('/api/wallets', createConsolidationRouter({
  walletCheckBaseUrl: process.env.WALLET_CHECK_BASE_URL || 'https://check.lanapays.us',
}));
app.use('/health', (_req, res) => res.redirect('/api/health'));
// A financer's own page: confirm their internal batches and send the LANA of
// their purchases from their own Lana.Discount wallet (8 Oct 2026). Signed by
// the financer's key (NIP-98), not an admin route. Before the SPA catch-all
// below, like every /api route — after it, express would answer index.html.
app.use('/api/financer', createFinancerRouter({
  walletCheckBaseUrl: process.env.WALLET_CHECK_BASE_URL || 'https://check.lanapays.us',
  sends: defaultSends(),
}));

// Heartbeat status for the admin page. It MUST be registered before the static
// files and the SPA catch-all below: an /api route declared after them never
// runs — express answers with index.html, the page's `res.json()` throws into an
// empty catch, and the badge silently keeps its initial "no pending orders".
// That is exactly what happened between 22 Mar and 9 Sep 2026: the endpoint was
// added after the catch-all and never once answered, so the dashboard reported
// "No pending LANA orders" while the auto-sender was failing every 3 minutes.
app.get('/api/heartbeat-status', (_req, res) => {
  // What the next send will actually attempt — the same gate autoSendPendingLana
  // uses. Not every pending order is one of them: three caretaker legs from June
  // and July were never authorised and no run has ever picked them up. Counting
  // them in the badge would light it amber for ever and teach the operator to
  // ignore it, which is how they stayed invisible in the first place. So they
  // are reported apart, as stranded.
  //
  // From 8 Oct 2026 the treasury sends only the purchases it settles, so two
  // more kinds of pending leg are counted apart too: a financer's (they send
  // those themselves) and those of purchases nobody has confirmed yet. Neither
  // is the treasury's work, and neither is "stranded" — see heartbeatLegCounts.
  const legs = heartbeatLegCounts(db);
  const callbacks = outboxHealth(db);
  const sends = sendsHealth(db);
  // Seconds until the next heartbeat (60s cycle)
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
    pendingLanaOrders: legs.pending.orders,
    pendingLanoshis: legs.pending.lanoshis,
    sendableLanaOrders: legs.sendable.orders,
    sendableLanoshis: legs.sendable.lanoshis,
    strandedLanaOrders: legs.stranded.orders,
    strandedLanoshis: legs.stranded.lanoshis,
    financerLanaOrders: legs.financer.orders,
    financerLanoshis: legs.financer.lanoshis,
    unownedLanaOrders: legs.unowned.orders,
    unownedLanoshis: legs.unowned.lanoshis,
    sendingLanaOrders: legs.sending.orders,
    sendingLanoshis: legs.sending.lanoshis,
    // Calls to the brain still owed, those given up after 7 days (a person has
    // to look: a lost fiat-received leaves a purchase unauthorised; the admin
    // page re-sends one by its key), and those the brain took but whose
    // purchases are still not approved after 7 days. Signed sends (financers'
    // and the treasury's) not confirmed yet, and those unconfirmed for a day
    // with their coins unspent — never released without proof. Financer
    // purchases whose investor leg now names another investor. All of it in
    // lib/financer/heartbeatStatus.ts.
    ...financerHeartbeatFields(callbacks, sends),
  });
});

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
        exchange_rates, split, version, valid_from, split_started_at, split_ends_at,
        split_target_lana, split_approaching, freeze_lana_retail_account_above, trusted_signers, raw_event
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.split_ends_at || null,
      data.split_target_lana || null,
      data.split_approaching ? 1 : 0,
      data.freeze_lana_retail_account_above || 0,
      JSON.stringify(data.trusted_signers),
      data.raw_event
    );

    console.log(`[lana-discount] KIND 38888 synced — ${data.relays.length} relays, version ${data.version}`);

    // Payout dates and sell fees per round now come from the same event. Its
    // own try: a refusal here must not report the parameters sync as failed.
    try {
      const terms = applyPublishedRoundTerms(db, JSON.parse(data.raw_event));
      if (terms.outcome === 'ignored' && terms.reason === 'unverified') {
        console.warn(`[lana-discount] Round terms NOT read from KIND 38888 ${data.event_id.slice(0, 12)}… — signature or author did not verify`);
      }
      for (const split of terms.changed) {
        const rows = (db.prepare('SELECT round, opens_at, discount_percent FROM acquisition_rounds WHERE split = ? ORDER BY round').all(split) as any[])
          .map(r => `R${r.round}:${r.opens_at ?? '-'}/${r.discount_percent ?? '-'}%`).join(' ');
        console.log(`[lana-discount] Round terms for Split ${split} taken from KIND 38888 ${data.event_id.slice(0, 12)}… (${rows})`);
      }
      if (terms.generalFee.changed) {
        console.log(`[lana-discount] General fee ${terms.generalFee.published}% taken from KIND 38888 ${data.event_id.slice(0, 12)}…`);
      }
      if (terms.generalFee.rejectedChanged && terms.generalFee.rejected) {
        console.warn(`[lana-discount] KIND 38888 general fee refused, last good fee kept: ${terms.generalFee.rejected}`);
      }
      if (terms.rejectedChanged) {
        for (const r of terms.rejected) {
          console.warn(`[lana-discount] KIND 38888 round terms for Split ${r.split} refused, last good terms kept: ${r.reason}`);
        }
      }
    } catch (err: any) {
      console.error('[lana-discount] Round terms from KIND 38888 not applied:', err?.message || err);
    }
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
// One broadcast carries at most this many recipient outputs. The window of
// pending rows we read is wider so that whole purchases can be chosen from it;
// see selectWholeGroups for why the cap is applied to purchases, not rows.
const AUTO_SEND_MAX_OUTPUTS = 100;
const AUTO_SEND_WINDOW_ROWS = 1000;
const AUTO_SEND_CYCLE = 5; // every 5 heartbeats = 5 min
const AUTO_SEND_OFFSET = 3;
let heartbeatCount = 0;
let lastAutoSendAt: string | null = null;
let nextAutoSendIn = AUTO_SEND_CYCLE - AUTO_SEND_OFFSET; // initial countdown
// Concurrency between the auto-sender, the admin's manual batch and the send
// round is a shared lock in ./lib/sendLock.ts — all three touch the treasury
// wallet's sends, so only one may be in flight. The auto-sender's own state
// (cooldown, -22 blacklist) lives with it in ./lib/treasuryAutoSend.ts.

async function verifyUnconfirmedTransactions(): Promise<void> {
  try {
    const { verifyTransaction, checkRpcConnection } = await import('./lib/rpc.js');

    const rpcStatus = await checkRpcConnection();
    if (!rpcStatus.connected) {
      console.log(`[lana-discount] RPC not reachable: ${rpcStatus.error}`);
      return;
    }

    // Verify any transaction with a tx_hash that isn't yet RPC-verified.
    // Include 'paid' — admin may approve a tx before RPC catches up; without 'paid' in the list
    // such transactions would stay rpc_verified=0 forever.
    // Exclude 'failed' and 'cancelled' (nothing to verify).
    const unverified = db.prepare(`
      SELECT id, tx_hash, status FROM buyback_transactions
      WHERE tx_hash IS NOT NULL AND tx_hash != ''
        AND rpc_verified = 0
        AND status IN ('broadcast', 'completed', 'pending_verification', 'paid')
    `).all() as any[];

    if (unverified.length === 0) return;

    console.log(`[lana-discount] Verifying ${unverified.length} transaction(s) via RPC (block ${rpcStatus.blockHeight})...`);

    let verified = 0;
    for (const tx of unverified) {
      try {
        const result = await verifyTransaction(tx.tx_hash);
        if (result.confirmed) {
          const txBlockHeight = rpcStatus.blockHeight ? rpcStatus.blockHeight - result.confirmations + 1 : null;
          // Update RPC fields + auto-promote broadcast/pending_verification → completed
          const shouldPromote = tx.status === 'broadcast' || tx.status === 'pending_verification';
          const newStatus = shouldPromote ? 'completed' : tx.status;
          db.prepare(`
            UPDATE buyback_transactions
            SET rpc_verified = 1, rpc_confirmations = ?, rpc_verified_at = datetime('now'),
                rpc_block_hash = ?, rpc_block_height = ?,
                status = CASE WHEN status IN ('broadcast', 'pending_verification') THEN 'completed' ELSE status END,
                verified_at = CASE WHEN status = 'pending_verification' THEN datetime('now') ELSE verified_at END,
                verified_by = CASE WHEN status = 'pending_verification' THEN 'rpc_auto' ELSE verified_by END,
                completed_at = CASE WHEN status IN ('broadcast', 'pending_verification') THEN datetime('now') ELSE completed_at END
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

/**
 * The one case settleBatchesWithSentLana() refuses to judge: a batch the
 * operator marked 'lana_bought' that has NO linked LANA orders at all, because
 * another batch claimed the legs of its purchases first (the backfill matches
 * on transaction_ref and only claims rows where batch_ref IS NULL). There is no
 * evidence here, only an assumption, so it stays behind a ten-minute wait.
 *
 * It no longer borrows a hash. It used to stamp the batch with the newest
 * tx_hash in the whole table — some unrelated purchase's broadcast — which is a
 * money row that reads as an audit trail and would be believed. An empty hash
 * says "we do not know", which is the truth.
 */
function settleOrphanBoughtBatches(): void {
  try {
    const orphans = db.prepare(`
      SELECT ib.* FROM incoming_batches ib
      WHERE ib.status = 'lana_bought'
        AND NOT EXISTS (SELECT 1 FROM brain_lana_orders blo WHERE blo.batch_ref = ib.batch_ref)
    `).all() as any[];
    for (const batch of orphans) {
      const boughtAge = batch.lana_bought_at
        ? (Date.now() - new Date(batch.lana_bought_at + 'Z').getTime()) / 60000
        : 0;
      if (boughtAge <= 10) continue;
      db.prepare(`
        UPDATE incoming_batches
           SET status = 'lana_sent', lana_sent_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'lana_bought'
      `).run(batch.id);
      console.log(`[lana-discount] Batch ${batch.batch_ref} → lana_sent (no linked orders after ${Math.round(boughtAge)}min, assumed sent under another batch — no tx hash recorded)`);
    }
  } catch (err: any) {
    console.error('[lana-discount] Orphan batch sweep error:', err.message);
  }
}

/**
 * Tick off the batches whose LANA has already gone out. The decision is
 * settleBatchesWithSentLana()'s; this only logs it and never lets a bookkeeping
 * error take the heartbeat down with it.
 */
function settleFinishedBatches(): void {
  try {
    for (const b of settleBatchesWithSentLana(db)) {
      console.log(`[lana-discount] Batch ${b.batchRef} → lana_sent (from '${b.from}', all ${b.orders} LANA orders sent, tx ${b.txHash || 'unknown'})`);
    }
  } catch (err: any) {
    console.error('[lana-discount] Batch settlement error:', err.message);
  }
}

// The treasury's auto-send (moved to lib/treasuryAutoSend.ts on 8 Oct 2026 so
// it runs in a test against a fake chain): the same selection and signing, but
// every transaction is RECORDED with its legs 'sending' before it is broadcast,
// and the send round below marks them 'sent' once the chain has it — a
// broadcast whose answer did not come can no longer be paid a second time.
const treasuryAutoSend = createTreasuryAutoSend({
  db,
  sends: defaultSends(),
  electrumServers: getElectrumServersFromDb,
  wif: () => process.env.BUYBACK_WIF,
  settleFinishedBatches,
  settleOrphanBoughtBatches,
  maxOutputs: AUTO_SEND_MAX_OUTPUTS,
  windowRows: AUTO_SEND_WINDOW_ROWS,
});

async function autoSendPendingLana(): Promise<void> {
  await treasuryAutoSend.run();
}

// ---------------------------------------------------------------------------
// Sync KIND 0 profiles for users without display names
// ---------------------------------------------------------------------------
async function syncUserProfiles(): Promise<void> {
  try {
    // Find users from buyback_transactions that have no display_name in users table
    const unknownUsers = db.prepare(`
      SELECT DISTINCT bt.user_hex_id
      FROM buyback_transactions bt
      LEFT JOIN users u ON bt.user_hex_id = u.nostr_hex_id
      WHERE u.display_name IS NULL OR u.display_name = '' OR u.nostr_hex_id IS NULL
      LIMIT 10
    `).all() as any[];

    if (unknownUsers.length === 0) return;

    const relays = getRelaysFromDb();
    if (relays.length === 0) return;

    let resolved = 0;
    for (const row of unknownUsers) {
      try {
        const kind0Event = await fetchKind0(row.user_hex_id, relays);
        if (kind0Event) {
          const content = JSON.parse(kind0Event.content);
          const displayName = content.display_name || content.displayName || null;
          const fullName = content.name || null;
          if (displayName || fullName) {
            db.prepare(`
              INSERT INTO users (nostr_hex_id, display_name, full_name, raw_kind0)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(nostr_hex_id) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, display_name),
                full_name = COALESCE(excluded.full_name, full_name),
                raw_kind0 = excluded.raw_kind0,
                updated_at = datetime('now')
            `).run(row.user_hex_id, displayName, fullName, JSON.stringify(content));
            resolved++;
          }
        }
      } catch {}
    }
    if (resolved > 0) {
      console.log(`[lana-discount] Profile sync: resolved ${resolved}/${unknownUsers.length} user names`);
    }
  } catch (err: any) {
    console.error('[lana-discount] Profile sync error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// KIND 30961 — where each financing budget stands: every sale under its
// mandate and every payment recorded for them. Runs beside the heartbeat, not
// inside it: the first run after a deploy sends every budget, and a slow relay
// must never hold up the auto-send. One run at a time.
// ---------------------------------------------------------------------------

let budgetSettlementRunning = false;
let lastUnattributed = '';

function runBudgetSettlementPublisher(): void {
  const key = process.env.NOSTR_PRIVATE_KEY || '';
  if (!key || budgetSettlementRunning) return;
  budgetSettlementRunning = true;
  publishBudgetSettlements(db, { privateKeyHex: key, relays: getRelaysFromDb() })
    .then(r => {
      if (r.published.length || r.failed.length) {
        console.log(`[lana-discount] KIND 30961 budgets: ${r.published.length} published, ${r.failed.length} failed, ${r.unchanged} unchanged, ${r.deferred} waiting (of ${r.budgets})`);
      }
      const unattributed = r.unattributed.join(',');
      if (unattributed !== lastUnattributed) {
        lastUnattributed = unattributed;
        if (unattributed) console.warn(`[lana-discount] KIND 30961: sales under a mandate that no budget claims: ${unattributed}`);
      }
    })
    .catch(err => console.error('[lana-discount] KIND 30961 publish failed:', err?.message || err))
    .finally(() => { budgetSettlementRunning = false; });
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
      // KIND 38888 sync every heartbeat (= every minute)
      await withTimeout(() => syncKind38888ToDb(), 'KIND 38888 sync', 30000);

      // RPC transaction verification every 10 heartbeats (= every 10 minutes)
      if (heartbeatCount % 10 === 0) {
        await withTimeout(() => verifyUnconfirmedTransactions(), 'RPC verification', 30000);
      }

      // Calls owed to the brain (fiat-received, lana-sent), every beat. Its
      // own timeout; a brain that does not answer stops the run, not the beat.
      await withTimeout(() => runOutbox(db, brainCallbackTarget()).then(r => {
        if (r.gaveUp > 0) console.error(`[lana-discount] ${r.gaveUp} brain callback(s) given up after 7 days — see /api/heartbeat-status`);
      }), 'Brain callbacks', 45000);

      // The LANA sends on their way (lib/financer/sends.ts), every beat: each
      // read on the chain with the two-server proof — confirmed, its legs are
      // 'sent' and lana-sent goes to the brain; not yet, the same bytes are sent
      // again; proven dead, its legs go back to pending. One round at a time
      // (its own lock); the treasury's sends only while no treasury send is
      // being built (the send lock the auto-sender and the button take).
      await withTimeout(() => defaultSends().round().then(r => {
        const done = r.confirmed.length + r.lateConfirmed.length;
        if (done || r.released.length || r.stuck.length) {
          console.log(`[lana-discount] Send round: ${done} confirmed, ${r.released.length} released, ${r.sent.length} sent again, ${r.held.length} held, ${r.stuck.length} stuck`);
        }
      }), 'LANA send round', 55000);

      // A purchase offer nobody accepted stops standing. Cheap, so every beat.
      try {
        const { expireStaleOffers } = await import('./lib/acquisitionOffer.js');
        const { getDbHandle } = await import('./db/index.js');
        const lapsed = expireStaleOffers(getDbHandle());
        if (lapsed > 0) console.log(`[lana-discount] ${lapsed} purchase offer(s) lapsed`);
      } catch (err: any) {
        console.warn('[lana-discount] Offer expiry sweep failed:', err.message);
      }

      // Sync KIND 0 profiles for users without names every 30 heartbeats (= every 30 min)
      if (heartbeatCount % 30 === 5) {
        await withTimeout(() => syncUserProfiles(), 'Profile sync', 30000);
      }

      // Freeze status for the people named on the public board, every 15 min.
      // Three batched relay queries for everyone (~1s), offset so it never
      // shares a tick with the profile sync above.
      if (heartbeatCount % 15 === 7) {
        await withTimeout(async () => {
          const { refreshBoardFreezeStatus } = await import('./routes/api.js');
          const r = await refreshBoardFreezeStatus();
          console.log(`[lana-discount] Freeze directory: ${r.resolved} resolved, ${r.frozen} frozen`);
        }, 'Freeze directory', 30000);
      }

      // Auto-send pending LANA every 5 heartbeats (= every 5 minutes)
      nextAutoSendIn = AUTO_SEND_CYCLE - ((heartbeatCount % AUTO_SEND_CYCLE) - AUTO_SEND_OFFSET + AUTO_SEND_CYCLE) % AUTO_SEND_CYCLE;
      if (nextAutoSendIn === AUTO_SEND_CYCLE) nextAutoSendIn = 0;
      if (heartbeatCount % AUTO_SEND_CYCLE === AUTO_SEND_OFFSET) {
        try {
          await withTimeout(() => autoSendPendingLana(), 'Auto-send LANA', 45000);
        } finally {
          // Runs even when the send failed, and even when orders are still
          // pending: a batch whose own LANA has all gone out should not wait on
          // an unrelated one that has not. Between 5 and 9 September 2026 it
          // did, because this only ever ran when nothing at all was pending.
          settleFinishedBatches();
        }
        lastAutoSendAt = new Date().toISOString();
        nextAutoSendIn = AUTO_SEND_CYCLE;
      }

      // Round mandates (KIND 30960) every 5 heartbeats, on a tick of their
      // own so a slow relay never delays the auto-send.
      if (heartbeatCount % 5 === 1) {
        await withTimeout(() => pullRoundMandates(db, getRelaysFromDb()), 'Round mandates sync', 30000);
      }

      runBudgetSettlementPublisher();
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

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[lana-discount] Server running on port ${PORT}`);

  // Initial KIND 38888 sync on startup
  const ok = await syncKind38888ToDb();
  if (!ok) {
    console.warn('[lana-discount] Initial sync failed — using seed data as fallback');
  }

  // Initial round-mandate pull on startup (KIND 38888 must be synced first so
  // getRelaysFromDb() is populated). A failure here is a warning, not a stop:
  // the brain's push and the next heartbeat both retry.
  try {
    await pullRoundMandates(db, getRelaysFromDb());
  } catch (err: any) {
    console.warn('[lana-discount] Initial round mandates sync failed:', err.message);
  }

  runBudgetSettlementPublisher();

  // Freeze status on startup, so the public board is not blank about it for the
  // first quarter hour after a deploy.
  try {
    const { refreshBoardFreezeStatus } = await import('./routes/api.js');
    const r = await refreshBoardFreezeStatus();
    console.log(`[lana-discount] Freeze directory: ${r.resolved} resolved, ${r.frozen} frozen`);
  } catch (err: any) {
    console.warn('[lana-discount] Initial freeze sync failed:', err.message);
  }
});
