import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import db, { getRelaysFromDb, getTrustedSignersFromDb, getElectrumServersFromDb, isAdminUser, getAllAdmins, getAllAppSettings, setAppSetting, getAppSetting, getExchangeRatesFromDb, getSplitFromDb, insertBuybackTransaction, getBuybackStats, getRecentBuybackTransactions, getUserSalesWithPayouts, getAdminPayoutStats, getAllSalesWithPayouts, generatePayoutId, insertSalePayout, insertApiKey, getApiKeyByHash, getAllApiKeys, updateApiKeyLastUsed, toggleApiKeyActive, deleteApiKey, insertExternalTransaction, verifyTransaction, rejectTransaction, txHashExists } from '../db/index.js';
import { sendLanaTransaction } from '../lib/transaction.js';
import { fetchKind38888, fetchKind0, fetchUserWallets, signAndPublishEvent } from '../lib/nostr.js';
import { fetchBatchBalances } from '../lib/electrum.js';

const router = Router();

const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY || '';

/**
 * Publish KIND 30936 — Buyback Transaction event to Nostr relays
 */
async function publishBuybackEvent(tx: {
  id: number | string; tx_hash: string; user_hex_id: string; sender_wallet_id: string;
  buyback_wallet_id: string; lana_amount_lanoshis: number; lana_amount_display: number;
  currency: string; exchange_rate: number; gross_fiat: number; commission_percent: number;
  commission_fiat: number; net_fiat: number; split: string; source?: string; status: string;
  paid_fiat?: number;
}) {
  if (!NOSTR_PRIVATE_KEY) return;
  const relays = getRelaysFromDb();
  const tags: string[][] = [
    ['d', String(tx.id)],
    ['tx_hash', tx.tx_hash || ''],
    ['user_hex', tx.user_hex_id],
    ['sender_wallet', tx.sender_wallet_id],
    ['buyback_wallet', tx.buyback_wallet_id],
    ['lana_amount', String(tx.lana_amount_lanoshis)],
    ['lana_display', String(tx.lana_amount_display)],
    ['currency', tx.currency],
    ['exchange_rate', String(tx.exchange_rate)],
    ['gross_fiat', String(tx.gross_fiat)],
    ['commission_percent', String(tx.commission_percent)],
    ['commission_fiat', String(tx.commission_fiat)],
    ['net_fiat', String(tx.net_fiat)],
    ['split', tx.split || ''],
    ['source', tx.source || 'internal'],
    ['status', tx.status],
    ['paid_fiat', String(tx.paid_fiat || 0)],
  ];
  await signAndPublishEvent(30936, tags, '', NOSTR_PRIVATE_KEY, relays);
}

/**
 * Publish KIND 30937 — FIAT Payout event to Nostr relays
 */
async function publishPayoutEvent(payout: {
  payout_id: string; transaction_id: number | string; user_hex_id: string;
  amount: number; currency: string; paid_to_account: string; reference: string;
  paid_at: string; remaining: number; status: string;
}) {
  if (!NOSTR_PRIVATE_KEY) return;
  const relays = getRelaysFromDb();

  // Derive pubkey for the a-tag reference
  const ellipticLib = await import('elliptic');
  const ecInstance = new ellipticLib.default.ec('secp256k1');
  const pubkey = ecInstance.keyFromPrivate(NOSTR_PRIVATE_KEY).getPublic().getX().toString(16).padStart(64, '0');

  const tags: string[][] = [
    ['d', payout.payout_id],
    ['a', `30936:${pubkey}:${payout.transaction_id}`],
    ['tx_ref', String(payout.transaction_id)],
    ['user_hex', payout.user_hex_id],
    ['amount', String(payout.amount)],
    ['currency', payout.currency],
    ['paid_to_account', payout.paid_to_account || ''],
    ['reference', payout.reference || ''],
    ['paid_at', payout.paid_at || ''],
    ['remaining', String(payout.remaining)],
    ['status', payout.status],
  ];
  await signAndPublishEvent(30937, tags, '', NOSTR_PRIVATE_KEY, relays);
}

/**
 * POST /api/login
 * Register or update user on login. Receives derived IDs from client + fetches KIND 0 server-side.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { nostrHexId, npub, walletId, walletIdCompressed, walletIdUncompressed } = req.body;

    if (!nostrHexId || !walletId) {
      return res.status(400).json({ error: 'Missing nostrHexId or walletId' });
    }

    // Get relays from kind_38888
    const relays = getRelaysFromDb();

    // Fetch KIND 0 profile from Nostr relays
    const kind0Event = await fetchKind0(nostrHexId, relays);

    let displayName: string | null = null;
    let fullName: string | null = null;
    let picture: string | null = null;
    let about: string | null = null;
    let lanaWalletID: string | null = null;
    let rawKind0: string | null = null;

    if (kind0Event) {
      try {
        const content = JSON.parse(kind0Event.content);
        displayName = content.display_name || null;
        fullName = content.name || null;
        picture = content.picture || null;
        about = content.about || null;
        lanaWalletID = content.lanaWalletID || null;
        rawKind0 = JSON.stringify(content);
      } catch {}
    }

    // Upsert user
    db.prepare(`
      INSERT INTO users (nostr_hex_id, npub, wallet_id, wallet_id_compressed, wallet_id_uncompressed,
                         display_name, full_name, picture, about, lana_wallet_id, raw_kind0, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(nostr_hex_id) DO UPDATE SET
        npub = excluded.npub,
        wallet_id = excluded.wallet_id,
        wallet_id_compressed = excluded.wallet_id_compressed,
        wallet_id_uncompressed = excluded.wallet_id_uncompressed,
        display_name = excluded.display_name,
        full_name = excluded.full_name,
        picture = excluded.picture,
        about = excluded.about,
        lana_wallet_id = excluded.lana_wallet_id,
        raw_kind0 = excluded.raw_kind0,
        last_login_at = datetime('now'),
        updated_at = datetime('now')
    `).run(
      nostrHexId, npub, walletId, walletIdCompressed || null, walletIdUncompressed || null,
      displayName, fullName, picture, about, lanaWalletID, rawKind0
    );

    return res.json({
      success: true,
      user: {
        nostrHexId,
        displayName: displayName || fullName || 'Anonymous',
        picture,
        lanaWalletID,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/user/:hexId
 */
router.get('/user/:hexId', (req: Request, res: Response) => {
  const user = db.prepare('SELECT * FROM users WHERE nostr_hex_id = ?').get(req.params.hexId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json(user);
});

/**
 * GET /api/relays
 * Returns relay list from KIND 38888
 */
router.get('/relays', (_req: Request, res: Response) => {
  const relays = getRelaysFromDb();
  return res.json({ relays });
});

/**
 * POST /api/sync-kind-38888
 * Fetch and store KIND 38888 from Nostr
 */
router.post('/sync-kind-38888', async (_req: Request, res: Response) => {
  try {
    const data = await fetchKind38888();

    if (data) {
      db.prepare('DELETE FROM kind_38888').run();
      db.prepare(`
        INSERT INTO kind_38888 (
          id, event_id, pubkey, created_at, relays, electrum_servers,
          exchange_rates, split, version, valid_from, split_started_at,
          split_target_lana, trusted_signers, raw_event
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'live_' + data.event_id, data.event_id, data.pubkey, data.created_at,
        JSON.stringify(data.relays), JSON.stringify(data.electrum_servers),
        JSON.stringify(data.exchange_rates), data.split || null,
        data.version || null, data.valid_from || null,
        data.split_started_at || null, data.split_target_lana || null,
        JSON.stringify(data.trusted_signers), data.raw_event
      );
    }

    const relays = getRelaysFromDb();
    return res.json({ relays });
  } catch (error) {
    console.error('Sync KIND 38888 error:', error);
    return res.status(500).json({ error: 'Failed to sync' });
  }
});

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/user/:hexId/wallets
 * Fetch user's registered wallets from KIND 30889, excluding Lana8Wonder and Knights.
 */
router.get('/user/:hexId/wallets', async (req: Request, res: Response) => {
  try {
    const { hexId } = req.params;
    const relays = getRelaysFromDb();
    const trustedSigners = getTrustedSignersFromDb();
    const lanaRegistrar = trustedSigners.LanaRegistrar || [];

    const allWallets = await fetchUserWallets(hexId, relays, lanaRegistrar);

    // Filter out Lana8Wonder and Knights wallet types
    const wallets = allWallets.filter(
      w => w.walletType !== 'Lana8Wonder' && w.walletType !== 'Knights'
    );

    return res.json({ wallets });
  } catch (error) {
    console.error('Fetch wallets error:', error);
    return res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

/**
 * POST /api/wallets/balances
 * Fetch balances for given wallet addresses via Electrum.
 */
router.post('/wallets/balances', async (req: Request, res: Response) => {
  try {
    const { addresses } = req.body;
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'Missing addresses array' });
    }

    const electrumServers = getElectrumServersFromDb();
    const balances = await fetchBatchBalances(electrumServers, addresses);

    return res.json({ balances });
  } catch (error) {
    console.error('Fetch balances error:', error);
    return res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

/**
 * GET /api/user/:hexId/watched-wallets
 * Get user's watched wallets from SQLite.
 */
router.get('/user/:hexId/watched-wallets', (req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM watched_wallets WHERE user_hex_id = ? ORDER BY created_at ASC')
    .all(req.params.hexId);
  return res.json({ watchedWallets: rows });
});

/**
 * POST /api/user/:hexId/watched-wallets
 * Save which wallets user wants monitored. Replaces all existing watched wallets.
 */
router.post('/user/:hexId/watched-wallets', (req: Request, res: Response) => {
  try {
    const { hexId } = req.params;
    const { wallets } = req.body;

    if (!wallets || !Array.isArray(wallets)) {
      return res.status(400).json({ error: 'Missing wallets array' });
    }

    const saveAll = db.transaction(() => {
      // Remove old selections
      db.prepare('DELETE FROM watched_wallets WHERE user_hex_id = ?').run(hexId);

      // Insert new selections
      const insert = db.prepare(`
        INSERT INTO watched_wallets (user_hex_id, wallet_id, wallet_type, note)
        VALUES (?, ?, ?, ?)
      `);

      for (const w of wallets) {
        insert.run(hexId, w.walletId, w.walletType || null, w.note || null);
      }
    });

    saveAll();

    const rows = db.prepare('SELECT * FROM watched_wallets WHERE user_hex_id = ? ORDER BY created_at ASC')
      .all(hexId);

    return res.json({ success: true, watchedWallets: rows });
  } catch (error) {
    console.error('Save watched wallets error:', error);
    return res.status(500).json({ error: 'Failed to save watched wallets' });
  }
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

/** Admin auth helper — reads x-admin-hex-id header and verifies against admin_users table */
function requireAdmin(req: Request, res: Response): string | null {
  const hexId = req.headers['x-admin-hex-id'] as string;
  if (!hexId || !isAdminUser(hexId)) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return hexId;
}

/**
 * GET /api/admin/check/:hexId
 * Public — check if a hex ID is an admin.
 */
router.get('/admin/check/:hexId', (req: Request, res: Response) => {
  return res.json({ isAdmin: isAdminUser(req.params.hexId) });
});

/**
 * GET /api/admin/stats
 * Returns buyback dashboard statistics with payout progress and live wallet balance.
 */
router.get('/admin/stats', async (_req: Request, res: Response) => {
  const adminHex = requireAdmin(_req, res);
  if (!adminHex) return;

  try {
    const stats = getAdminPayoutStats();
    const recentTxs = getRecentBuybackTransactions(10);

    const recentTransactions = recentTxs.map((tx: any) => ({
      id: tx.id,
      date: tx.created_at?.split('T')[0] || tx.created_at?.split(' ')[0] || '',
      user: tx.display_name || tx.full_name || 'Anonymous',
      hexId: tx.user_hex_id.slice(0, 8) + '...' + tx.user_hex_id.slice(-6),
      fullHexId: tx.user_hex_id,
      lanaAmount: tx.lana_amount_display,
      eurPayout: tx.net_fiat,
      currency: tx.currency,
      status: tx.status,
    }));

    // Fetch live buyback wallet LANA balance via Electrum
    let buybackWalletBalance: number | null = null;
    const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
    if (buybackWalletId) {
      try {
        const electrumServers = getElectrumServersFromDb();
        const balances = await fetchBatchBalances(electrumServers, [buybackWalletId]);
        // fetchBatchBalances returns WalletBalance[] — get the first (and only) entry
        const bal = balances[0];
        if (bal && !bal.error) {
          buybackWalletBalance = bal.balance; // already converted from lanoshis to LANA
        }
      } catch (err) {
        console.error('Failed to fetch buyback wallet balance:', err);
      }
    }

    return res.json({
      ...stats,
      buybackWalletBalance,
      buybackWalletId,
      recentTransactions,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
});

/**
 * GET /api/admin/users
 * List all admin users.
 */
router.get('/admin/users', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  return res.json({ admins: getAllAdmins() });
});

/**
 * POST /api/admin/users
 * Add a new admin user.
 */
router.post('/admin/users', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const { hexId, label } = req.body;

    if (!hexId || typeof hexId !== 'string' || !/^[0-9a-f]{64}$/.test(hexId)) {
      return res.status(400).json({ error: 'Invalid hex ID — must be 64 lowercase hex characters' });
    }

    // Check duplicate
    if (isAdminUser(hexId)) {
      return res.status(409).json({ error: 'This user is already an admin' });
    }

    db.prepare('INSERT INTO admin_users (hex_id, label, added_by) VALUES (?, ?, ?)')
      .run(hexId, label || null, adminHex);

    console.log(`[lana-discount] Admin added: ${hexId.slice(0, 12)}... by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true, admins: getAllAdmins() });
  } catch (error) {
    console.error('Add admin error:', error);
    return res.status(500).json({ error: 'Failed to add admin' });
  }
});

/**
 * DELETE /api/admin/users/:hexId
 * Remove an admin user. Cannot remove yourself or the last admin.
 */
router.delete('/admin/users/:hexId', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const { hexId } = req.params;

    if (hexId === adminHex) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    const allAdmins = getAllAdmins();
    if (allAdmins.length <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }

    if (!isAdminUser(hexId)) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    db.prepare('DELETE FROM admin_users WHERE hex_id = ?').run(hexId);

    console.log(`[lana-discount] Admin removed: ${hexId.slice(0, 12)}... by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true, admins: getAllAdmins() });
  } catch (error) {
    console.error('Remove admin error:', error);
    return res.status(500).json({ error: 'Failed to remove admin' });
  }
});

// ---------------------------------------------------------------------------
// Admin Payouts endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/next-payout-id
 * Preview the next auto-generated payout ID.
 */
router.get('/admin/next-payout-id', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;
  return res.json({ payoutId: generatePayoutId() });
});

/**
 * GET /api/admin/payouts
 * Returns all sales grouped by user with payouts and user profile info.
 */
router.get('/admin/payouts', async (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const users = getAllSalesWithPayouts();
    return res.json({ users });
  } catch (err) {
    console.error('Admin payouts fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

/**
 * POST /api/admin/payouts
 * Record a new payout installment for a transaction.
 */
router.post('/admin/payouts', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const { transactionId, amount, currency, paidToAccount, note } = req.body;

    if (!transactionId || typeof transactionId !== 'number') {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    if (!currency) {
      return res.status(400).json({ error: 'Currency is required' });
    }

    // Verify transaction exists and is completed/paid
    const tx = db.prepare(
      "SELECT * FROM buyback_transactions WHERE id = ? AND status IN ('completed', 'paid')"
    ).get(transactionId) as any;

    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found or not in completed state' });
    }

    // Check remaining amount
    const totalPaid = (db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM sale_payouts WHERE transaction_id = ?'
    ).get(transactionId) as any).total;

    const remaining = Math.round((tx.net_fiat - totalPaid) * 100) / 100;
    if (amount > remaining + 0.01) { // small tolerance for rounding
      return res.status(400).json({ error: `Amount exceeds remaining (${remaining.toFixed(2)} ${currency})` });
    }

    // Generate payout ID and insert
    const payoutId = generatePayoutId();
    const payout = insertSalePayout({
      transactionId,
      payoutId,
      amount,
      currency,
      paidToAccount: paidToAccount || null,
      note: note || null,
    });

    console.log(`[lana-discount] Payout recorded: ${payoutId} — ${amount} ${currency} for TX#${transactionId} by admin ${adminHex.slice(0, 12)}...`);

    // Publish KIND 30937 (payout) + update KIND 30936 (transaction)
    const newRemaining = Math.round((remaining - amount) * 100) / 100;
    const payoutStatus = newRemaining <= 0 ? 'full' : 'partial';

    publishPayoutEvent({
      payout_id: payoutId, transaction_id: transactionId, user_hex_id: tx.user_hex_id,
      amount, currency, paid_to_account: paidToAccount || '',
      reference: note || '', paid_at: new Date().toISOString(),
      remaining: Math.max(0, newRemaining), status: payoutStatus,
    }).catch(err => console.error('[lana-discount] Nostr payout publish failed:', err.message));

    // Re-publish KIND 30936 with updated paid_fiat and status
    const newTotalPaid = totalPaid + amount;
    const txStatus = newRemaining <= 0 ? 'paid' : 'completed';
    publishBuybackEvent({
      id: tx.id, tx_hash: tx.tx_hash, user_hex_id: tx.user_hex_id,
      sender_wallet_id: tx.sender_wallet_id, buyback_wallet_id: tx.buyback_wallet_id,
      lana_amount_lanoshis: tx.lana_amount_lanoshis, lana_amount_display: tx.lana_amount_display,
      currency: tx.currency, exchange_rate: tx.exchange_rate, gross_fiat: tx.gross_fiat,
      commission_percent: tx.commission_percent, commission_fiat: tx.commission_fiat,
      net_fiat: tx.net_fiat, split: tx.split, source: tx.source || 'internal',
      status: txStatus, paid_fiat: newTotalPaid,
    }).catch(err => console.error('[lana-discount] Nostr buyback update failed:', err.message));

    return res.json({
      success: true,
      payout,
    });
  } catch (err) {
    console.error('Admin payout create error:', err);
    return res.status(500).json({ error: 'Failed to record payout' });
  }
});

/**
 * GET /api/user/:hexId/payout-account
 * Fetch user's payout account from KIND 0 profile (payment_methods with scope payout/both).
 */
router.get('/user/:hexId/payout-account', async (req: Request, res: Response) => {
  try {
    const hexId = req.params.hexId;
    const relays = getRelaysFromDb();
    const kind0Event = await fetchKind0(hexId, relays);

    let payoutAccount: any = null;

    if (kind0Event) {
      const content = JSON.parse(kind0Event.content);
      const paymentMethods = content.payment_methods || [];
      // Find method with scope 'payout' or 'both'
      const payoutMethod = paymentMethods.find(
        (m: any) => m.scope === 'payout' || m.scope === 'both'
      );
      if (payoutMethod) {
        payoutAccount = payoutMethod;
      }
    }

    // Fallback to cached DB data
    if (!payoutAccount) {
      const user = db.prepare('SELECT raw_kind0 FROM users WHERE nostr_hex_id = ?').get(hexId) as any;
      if (user?.raw_kind0) {
        const profile = JSON.parse(user.raw_kind0);
        const paymentMethods = profile.payment_methods || [];
        const payoutMethod = paymentMethods.find(
          (m: any) => m.scope === 'payout' || m.scope === 'both'
        );
        if (payoutMethod) payoutAccount = payoutMethod;
      }
    }

    return res.json({ payoutAccount });
  } catch (err) {
    console.error('Payout account fetch error:', err);
    return res.json({ payoutAccount: null });
  }
});

// ---------------------------------------------------------------------------
// App Settings endpoints
// ---------------------------------------------------------------------------

const AVAILABLE_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CZK', 'PLN', 'HRK', 'RSD', 'HUF', 'BAM'];

/**
 * GET /api/admin/settings
 * Get all app settings.
 */
router.get('/admin/settings', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  const settings = getAllAppSettings();
  return res.json({
    settings,
    availableCurrencies: AVAILABLE_CURRENCIES,
  });
});

/**
 * PUT /api/admin/settings
 * Update one or more app settings.
 */
router.put('/admin/settings', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const { buyback_wallet_id, active_currencies } = req.body;

    if (buyback_wallet_id !== undefined) {
      if (typeof buyback_wallet_id !== 'string') {
        return res.status(400).json({ error: 'buyback_wallet_id must be a string' });
      }
      // Allow empty string (no wallet set) or valid LanaCoin address (starts with L, 26-35 chars)
      if (buyback_wallet_id !== '' && !/^L[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(buyback_wallet_id)) {
        return res.status(400).json({ error: 'Invalid wallet address — must start with L' });
      }
      setAppSetting('buyback_wallet_id', buyback_wallet_id, adminHex);
    }

    if (active_currencies !== undefined) {
      if (!Array.isArray(active_currencies) || active_currencies.length === 0) {
        return res.status(400).json({ error: 'At least one currency must be selected' });
      }
      // Validate all currencies
      const invalid = active_currencies.filter((c: string) => !AVAILABLE_CURRENCIES.includes(c));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Invalid currencies: ${invalid.join(', ')}` });
      }
      setAppSetting('active_currencies', JSON.stringify(active_currencies), adminHex);
    }

    const settings = getAllAppSettings();
    console.log(`[lana-discount] Settings updated by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true, settings });
  } catch (error) {
    console.error('Update settings error:', error);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ---------------------------------------------------------------------------
// System params & Sell endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/system-params
 * Public — exchange rates, active currencies, buyback wallet, commission.
 */
router.get('/system-params', (_req: Request, res: Response) => {
  const exchangeRates = getExchangeRatesFromDb();
  const split = getSplitFromDb();
  let activeCurrencies: string[] = ['EUR'];
  try {
    activeCurrencies = JSON.parse(getAppSetting('active_currencies') || '["EUR"]');
  } catch {}
  const buybackWalletId = getAppSetting('buyback_wallet_id') || '';

  return res.json({
    exchangeRates,
    split,
    activeCurrencies,
    buybackWalletId,
    commissionPercent: 30,
  });
});

/**
 * GET /api/user/:hexId/profile
 * Returns parsed KIND 0 profile including payment_methods.
 * Fetches LIVE from Nostr relays to ensure fresh data (payment methods may have been
 * added after the user logged in, so the cached raw_kind0 in DB can be stale).
 */
router.get('/user/:hexId/profile', async (req: Request, res: Response) => {
  const hexId = req.params.hexId;
  try {
    const relays = getRelaysFromDb();
    const kind0Event = await fetchKind0(hexId, relays);

    if (kind0Event) {
      const content = JSON.parse(kind0Event.content);

      // Also update the cached raw_kind0 in DB so it stays fresh
      db.prepare('UPDATE users SET raw_kind0 = ?, updated_at = datetime(\'now\') WHERE nostr_hex_id = ?')
        .run(JSON.stringify(content), hexId);

      return res.json({ profile: content });
    }

    // Fallback to cached DB data if relay fetch fails
    const user = db.prepare('SELECT raw_kind0 FROM users WHERE nostr_hex_id = ?').get(hexId) as any;
    if (user?.raw_kind0) {
      const profile = JSON.parse(user.raw_kind0);
      return res.json({ profile });
    }

    return res.json({ profile: null });
  } catch (err) {
    console.error('Profile fetch error:', err);
    // Fallback to cached DB data on error
    try {
      const user = db.prepare('SELECT raw_kind0 FROM users WHERE nostr_hex_id = ?').get(hexId) as any;
      if (user?.raw_kind0) {
        return res.json({ profile: JSON.parse(user.raw_kind0) });
      }
    } catch {}
    return res.json({ profile: null });
  }
});

/**
 * GET /api/user/:hexId/sales
 * Returns all completed sales for this user with their payout installments.
 */
router.get('/user/:hexId/sales', (req: Request, res: Response) => {
  try {
    const sales = getUserSalesWithPayouts(req.params.hexId);
    return res.json({ sales });
  } catch (err) {
    console.error('Sales fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

/**
 * POST /api/sell/preview
 * Calculate payout preview before execution.
 */
router.post('/sell/preview', (req: Request, res: Response) => {
  try {
    const { lanaAmount, currency } = req.body;

    if (!lanaAmount || lanaAmount <= 0) {
      return res.status(400).json({ error: 'Invalid LANA amount' });
    }
    if (!currency) {
      return res.status(400).json({ error: 'Currency is required' });
    }

    // Check currency is active
    let activeCurrencies: string[] = ['EUR'];
    try { activeCurrencies = JSON.parse(getAppSetting('active_currencies') || '["EUR"]'); } catch {}
    if (!activeCurrencies.includes(currency)) {
      return res.status(400).json({ error: `Currency ${currency} is not active` });
    }

    // Check buyback wallet configured
    const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
    if (!buybackWalletId) {
      return res.status(400).json({ error: 'Buyback wallet not configured. Contact admin.' });
    }

    // Get exchange rate
    const exchangeRates = getExchangeRatesFromDb();
    const exchangeRate = exchangeRates[currency];
    if (!exchangeRate) {
      return res.status(400).json({ error: `No exchange rate available for ${currency}` });
    }

    const split = getSplitFromDb();
    const lanaAmountLanoshis = Math.floor(lanaAmount * 100000000);
    const grossFiat = Math.round(lanaAmount * exchangeRate * 100) / 100;
    const commissionPercent = 30;
    const commissionFiat = Math.round(grossFiat * commissionPercent / 100 * 100) / 100;
    const netFiat = Math.round((grossFiat - commissionFiat) * 100) / 100;

    // Estimate fee (1 input, 2 outputs is typical)
    const estimatedFee = Math.floor((1 * 180 + 2 * 34 + 10) * 100 * 1.5);

    return res.json({
      lanaAmount,
      lanaAmountLanoshis,
      currency,
      exchangeRate,
      split,
      grossFiat,
      commissionPercent,
      commissionFiat,
      netFiat,
      buybackWalletId,
      estimatedFee,
    });
  } catch (error) {
    console.error('Sell preview error:', error);
    return res.status(500).json({ error: 'Failed to calculate preview' });
  }
});

/**
 * POST /api/sell/execute
 * Execute the buyback transaction.
 */
router.post('/sell/execute', async (req: Request, res: Response) => {
  try {
    const { hexId, senderAddress, lanaAmount, currency, privateKey } = req.body;

    if (!hexId || !senderAddress || !lanaAmount || !currency || !privateKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (lanaAmount <= 0) {
      return res.status(400).json({ error: 'Invalid LANA amount' });
    }

    // Validate currency
    let activeCurrencies: string[] = ['EUR'];
    try { activeCurrencies = JSON.parse(getAppSetting('active_currencies') || '["EUR"]'); } catch {}
    if (!activeCurrencies.includes(currency)) {
      return res.status(400).json({ error: `Currency ${currency} is not active` });
    }

    // Validate buyback wallet
    const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
    if (!buybackWalletId) {
      return res.status(400).json({ error: 'Buyback wallet not configured' });
    }

    // Get exchange rate
    const exchangeRates = getExchangeRatesFromDb();
    const exchangeRate = exchangeRates[currency];
    if (!exchangeRate) {
      return res.status(400).json({ error: `No exchange rate for ${currency}` });
    }

    const split = getSplitFromDb();
    const lanaAmountLanoshis = Math.floor(lanaAmount * 100000000);
    const grossFiat = Math.round(lanaAmount * exchangeRate * 100) / 100;
    const commissionPercent = 30;
    const commissionFiat = Math.round(grossFiat * commissionPercent / 100 * 100) / 100;
    const netFiat = Math.round((grossFiat - commissionFiat) * 100) / 100;

    // Get Electrum servers
    const electrumServers = getElectrumServersFromDb();

    console.log(`[lana-discount] Sell execute: ${lanaAmount} LANA from ${senderAddress} to ${buybackWalletId}`);

    // Execute transaction
    const txResult = await sendLanaTransaction({
      senderAddress,
      recipientAddress: buybackWalletId,
      amount: lanaAmount,
      privateKey,
      electrumServers,
    });

    if (txResult.success) {
      // Record successful transaction
      const txId = insertBuybackTransaction({
        user_hex_id: hexId,
        sender_wallet_id: senderAddress,
        buyback_wallet_id: buybackWalletId,
        lana_amount_lanoshis: lanaAmountLanoshis,
        lana_amount_display: lanaAmount,
        currency,
        exchange_rate: exchangeRate,
        split,
        gross_fiat: grossFiat,
        commission_percent: commissionPercent,
        commission_fiat: commissionFiat,
        net_fiat: netFiat,
        tx_hash: txResult.txHash,
        tx_fee_lanoshis: txResult.fee,
        status: 'completed',
      });

      console.log(`[lana-discount] Sell completed: TX ${txResult.txHash}, ID ${txId}`);

      // Publish KIND 30936 to Nostr
      publishBuybackEvent({
        id: txId, tx_hash: txResult.txHash, user_hex_id: hexId,
        sender_wallet_id: senderAddress, buyback_wallet_id: buybackWalletId,
        lana_amount_lanoshis: lanaAmountLanoshis, lana_amount_display: lanaAmount,
        currency, exchange_rate: exchangeRate, gross_fiat: grossFiat,
        commission_percent: commissionPercent, commission_fiat: commissionFiat,
        net_fiat: netFiat, split, source: 'internal', status: 'completed',
      }).catch(err => console.error('[lana-discount] Nostr publish failed:', err.message));

      return res.json({
        success: true,
        txHash: txResult.txHash,
        lanaAmount,
        currency,
        grossFiat,
        commissionFiat,
        netFiat,
        fee: txResult.fee,
        transactionId: txId,
      });
    } else {
      // Record failed transaction
      const txId = insertBuybackTransaction({
        user_hex_id: hexId,
        sender_wallet_id: senderAddress,
        buyback_wallet_id: buybackWalletId,
        lana_amount_lanoshis: lanaAmountLanoshis,
        lana_amount_display: lanaAmount,
        currency,
        exchange_rate: exchangeRate,
        split,
        gross_fiat: grossFiat,
        commission_percent: commissionPercent,
        commission_fiat: commissionFiat,
        net_fiat: netFiat,
        status: 'failed',
        error_message: txResult.error,
      });

      console.error(`[lana-discount] Sell failed: ${txResult.error}, ID ${txId}`);

      return res.status(400).json({
        success: false,
        error: txResult.error,
        transactionId: txId,
      });
    }
  } catch (error) {
    console.error('Sell execute error:', error);
    return res.status(500).json({ error: 'Failed to execute transaction' });
  }
});

// ---------------------------------------------------------------------------
// API Key Management + External API
// ---------------------------------------------------------------------------

/** API key auth helper — reads Authorization: Bearer ldk_xxx header */
function requireApiKey(req: Request, res: Response): { apiKeyId: number; appName: string } | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ldk_')) {
    res.status(401).json({ error: 'Missing or invalid API key. Use: Authorization: Bearer ldk_...' });
    return null;
  }

  const apiKey = authHeader.replace('Bearer ', '');
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const row = getApiKeyByHash(keyHash);

  if (!row) {
    res.status(401).json({ error: 'Invalid API key' });
    return null;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'API key is disabled' });
    return null;
  }

  updateApiKeyLastUsed(row.id);
  return { apiKeyId: row.id, appName: row.app_name };
}

/**
 * GET /api/admin/api-keys
 * List all API keys (without hashes).
 */
router.get('/admin/api-keys', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;
  return res.json({ apiKeys: getAllApiKeys() });
});

/**
 * POST /api/admin/api-keys
 * Create a new API key. Returns the plaintext key ONCE.
 */
router.post('/admin/api-keys', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const { appName, label } = req.body;

    if (!appName || typeof appName !== 'string' || appName.trim().length === 0) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // Generate key: ldk_ + 48 random hex chars
    const plaintextKey = 'ldk_' + randomBytes(24).toString('hex');
    const keyHash = createHash('sha256').update(plaintextKey).digest('hex');

    const id = insertApiKey(keyHash, appName.trim(), label?.trim() || null, adminHex);

    console.log(`[lana-discount] API key created for "${appName.trim()}" by ${adminHex.slice(0, 12)}...`);

    return res.json({
      success: true,
      apiKey: {
        id,
        appName: appName.trim(),
        label: label?.trim() || null,
        key: plaintextKey, // shown ONCE
      },
    });
  } catch (error) {
    console.error('Create API key error:', error);
    return res.status(500).json({ error: 'Failed to create API key' });
  }
});

/**
 * PUT /api/admin/api-keys/:id
 * Toggle API key active/inactive.
 */
router.put('/admin/api-keys/:id', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const id = parseInt(req.params.id);
    const { isActive } = req.body;

    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be a boolean' });

    toggleApiKeyActive(id, isActive);
    console.log(`[lana-discount] API key #${id} ${isActive ? 'activated' : 'deactivated'} by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true, apiKeys: getAllApiKeys() });
  } catch (error) {
    console.error('Toggle API key error:', error);
    return res.status(500).json({ error: 'Failed to update API key' });
  }
});

/**
 * DELETE /api/admin/api-keys/:id
 * Delete an API key.
 */
router.delete('/admin/api-keys/:id', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    deleteApiKey(id);
    console.log(`[lana-discount] API key #${id} deleted by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true, apiKeys: getAllApiKeys() });
  } catch (error) {
    console.error('Delete API key error:', error);
    return res.status(500).json({ error: 'Failed to delete API key' });
  }
});

/**
 * POST /api/admin/verify-transaction/:id
 * Verify an external transaction (pending_verification → completed).
 */
router.post('/admin/verify-transaction/:id', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const txId = parseInt(req.params.id);
    if (isNaN(txId)) return res.status(400).json({ error: 'Invalid transaction ID' });

    const success = verifyTransaction(txId, adminHex);
    if (!success) {
      return res.status(404).json({ error: 'Transaction not found or not in pending_verification status' });
    }

    console.log(`[lana-discount] Transaction #${txId} verified by ${adminHex.slice(0, 12)}...`);

    // Publish KIND 30936 for verified external transaction
    const verifiedTx = db.prepare('SELECT * FROM buyback_transactions WHERE id = ?').get(txId) as any;
    if (verifiedTx) {
      publishBuybackEvent({
        id: verifiedTx.id, tx_hash: verifiedTx.tx_hash, user_hex_id: verifiedTx.user_hex_id,
        sender_wallet_id: verifiedTx.sender_wallet_id, buyback_wallet_id: verifiedTx.buyback_wallet_id,
        lana_amount_lanoshis: verifiedTx.lana_amount_lanoshis, lana_amount_display: verifiedTx.lana_amount_display,
        currency: verifiedTx.currency, exchange_rate: verifiedTx.exchange_rate, gross_fiat: verifiedTx.gross_fiat,
        commission_percent: verifiedTx.commission_percent, commission_fiat: verifiedTx.commission_fiat,
        net_fiat: verifiedTx.net_fiat, split: verifiedTx.split, source: 'external', status: 'completed',
      }).catch(err => console.error('[lana-discount] Nostr publish failed:', err.message));
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Verify transaction error:', error);
    return res.status(500).json({ error: 'Failed to verify transaction' });
  }
});

/**
 * POST /api/admin/reject-transaction/:id
 * Reject an external transaction (pending_verification → failed).
 */
router.post('/admin/reject-transaction/:id', (req: Request, res: Response) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;

  try {
    const txId = parseInt(req.params.id);
    if (isNaN(txId)) return res.status(400).json({ error: 'Invalid transaction ID' });

    const { reason } = req.body || {};
    const success = rejectTransaction(txId, reason || null);
    if (!success) {
      return res.status(404).json({ error: 'Transaction not found or not in pending_verification status' });
    }

    console.log(`[lana-discount] Transaction #${txId} rejected by ${adminHex.slice(0, 12)}...`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Reject transaction error:', error);
    return res.status(500).json({ error: 'Failed to reject transaction' });
  }
});

// ---------------------------------------------------------------------------
// External API endpoints (authenticated by API key)
// ---------------------------------------------------------------------------

/**
 * POST /api/external/sale
 * Report a completed LANA sale from an external application.
 */
router.post('/external/sale', (req: Request, res: Response) => {
  const auth = requireApiKey(req, res);
  if (!auth) return;

  try {
    const {
      tx_hash, sender_wallet_id, buyback_wallet_id,
      lana_amount, currency, exchange_rate,
      commission_percent, user_hex_id, tx_fee_lanoshis, note,
    } = req.body;

    // Validate required fields
    if (!tx_hash || typeof tx_hash !== 'string') {
      return res.status(400).json({ error: 'tx_hash is required' });
    }
    if (!sender_wallet_id || typeof sender_wallet_id !== 'string') {
      return res.status(400).json({ error: 'sender_wallet_id is required' });
    }
    if (!buyback_wallet_id || typeof buyback_wallet_id !== 'string') {
      return res.status(400).json({ error: 'buyback_wallet_id is required' });
    }
    if (!lana_amount || typeof lana_amount !== 'number' || lana_amount <= 0) {
      return res.status(400).json({ error: 'lana_amount must be a positive number (in LANA)' });
    }
    if (!currency || typeof currency !== 'string') {
      return res.status(400).json({ error: 'currency is required' });
    }
    if (!exchange_rate || typeof exchange_rate !== 'number' || exchange_rate <= 0) {
      return res.status(400).json({ error: 'exchange_rate must be a positive number' });
    }

    // Check duplicate tx_hash
    if (txHashExists(tx_hash)) {
      return res.status(409).json({ error: 'Transaction with this tx_hash already exists' });
    }

    // Calculate financials
    const lanaAmountLanoshis = Math.floor(lana_amount * 100000000);
    const commissionPct = typeof commission_percent === 'number' ? commission_percent : 30;
    const grossFiat = Math.round(lana_amount * exchange_rate * 100) / 100;
    const commissionFiat = Math.round(grossFiat * commissionPct / 100 * 100) / 100;
    const netFiat = Math.round((grossFiat - commissionFiat) * 100) / 100;

    const split = getSplitFromDb();
    const hexId = user_hex_id || 'external_' + auth.appName.toLowerCase().replace(/\s+/g, '_');

    const txId = insertExternalTransaction({
      user_hex_id: hexId,
      sender_wallet_id,
      buyback_wallet_id,
      lana_amount_lanoshis: lanaAmountLanoshis,
      lana_amount_display: lana_amount,
      currency,
      exchange_rate,
      split,
      gross_fiat: grossFiat,
      commission_percent: commissionPct,
      commission_fiat: commissionFiat,
      net_fiat: netFiat,
      tx_hash,
      tx_fee_lanoshis: tx_fee_lanoshis || 0,
      api_key_id: auth.apiKeyId,
    });

    console.log(`[lana-discount] External sale received from "${auth.appName}": ${lana_amount} LANA, TX#${txId}, hash=${tx_hash.slice(0, 16)}...`);

    return res.status(201).json({
      success: true,
      transactionId: txId,
      status: 'pending_verification',
      grossFiat,
      commissionFiat,
      netFiat,
    });
  } catch (error) {
    console.error('External sale error:', error);
    return res.status(500).json({ error: 'Failed to record external sale' });
  }
});

/**
 * GET /api/external/sale/:id
 * Check the status of a previously submitted external sale.
 */
router.get('/external/sale/:id', (req: Request, res: Response) => {
  const auth = requireApiKey(req, res);
  if (!auth) return;

  try {
    const txId = parseInt(req.params.id);
    if (isNaN(txId)) return res.status(400).json({ error: 'Invalid transaction ID' });

    const tx = db.prepare(
      "SELECT id, status, lana_amount_display, currency, net_fiat, tx_hash, source, verified_at, created_at, completed_at FROM buyback_transactions WHERE id = ? AND source = 'external'"
    ).get(txId) as any;

    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.json({
      transactionId: tx.id,
      status: tx.status,
      lanaAmount: tx.lana_amount_display,
      currency: tx.currency,
      netFiat: tx.net_fiat,
      txHash: tx.tx_hash,
      verifiedAt: tx.verified_at,
      createdAt: tx.created_at,
    });
  } catch (error) {
    console.error('External sale status error:', error);
    return res.status(500).json({ error: 'Failed to fetch transaction status' });
  }
});

// ---------------------------------------------------------------------------

/**
 * GET /health
 */
router.get('/health', (_req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  return res.json({ status: 'ok', users: userCount, timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Brain Integration API endpoints
// ---------------------------------------------------------------------------

// Brain LANA orders table (auto-create)
db.exec(`
  CREATE TABLE IF NOT EXISTS brain_lana_orders (
    id TEXT PRIMARY KEY,
    transaction_ref TEXT,
    order_type TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    to_hex TEXT NOT NULL,
    lana_amount INTEGER NOT NULL,
    fiat_value REAL NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    tx_hash TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )
`);

/**
 * POST /api/brain/lana-order
 * Receive a LANA send order from Brain
 */
router.post('/brain/lana-order', async (req: Request, res: Response) => {
  const auth = requireApiKey(req, res);
  if (!auth) return;

  try {
    const { order_id, tx_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate } = req.body;

    if (!order_id || !order_type || !to_wallet || !to_hex || !lana_amount) {
      return res.status(400).json({ error: 'Missing required fields', required: ['order_id', 'order_type', 'to_wallet', 'to_hex', 'lana_amount'] });
    }

    // Store the order
    try {
      db.prepare(`
        INSERT INTO brain_lana_orders (id, transaction_ref, order_type, to_wallet, to_hex, lana_amount, fiat_value, currency, exchange_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(order_id, tx_ref || null, order_type, to_wallet, to_hex, lana_amount, fiat_value || 0, currency || 'EUR', exchange_rate || 0);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({ status: 'exists', error: 'Order already exists' });
      }
      throw err;
    }

    // Attempt to send LANA from buyback wallet
    const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
    if (!buybackWalletId) {
      db.prepare(`UPDATE brain_lana_orders SET status = 'failed', error_message = 'No buyback wallet configured' WHERE id = ?`).run(order_id);
      return res.json({ status: 'failed', error: 'No buyback wallet configured' });
    }

    // Queue the order — actual sending will be done by admin or automated process
    // For now, mark as pending and return
    console.log(`[lana-discount] Brain LANA order received: ${order_id} (${order_type}), ${lana_amount} lanoshis → ${to_wallet}`);

    return res.status(201).json({
      status: 'pending',
      order_id,
      buyback_wallet: buybackWalletId,
    });
  } catch (error: any) {
    console.error('Brain LANA order error:', error);
    return res.status(500).json({ status: 'failed', error: error.message });
  }
});

/**
 * GET /api/brain/lana-order/:id
 * Check LANA order status
 */
router.get('/brain/lana-order/:id', (req: Request, res: Response) => {
  const auth = requireApiKey(req, res);
  if (!auth) return;

  const order = db.prepare('SELECT * FROM brain_lana_orders WHERE id = ?').get(req.params.id) as any;
  if (!order) {
    return res.status(404).json({ status: 'not_found' });
  }

  return res.json({
    status: order.status,
    order_id: order.id,
    tx_hash: order.tx_hash,
    lana_amount: order.lana_amount,
    to_wallet: order.to_wallet,
    created_at: order.created_at,
    completed_at: order.completed_at,
  });
});

/**
 * GET /api/brain/buyback-balance
 * Return current buyback wallet LANA balance
 */
router.get('/brain/buyback-balance', async (req: Request, res: Response) => {
  const auth = requireApiKey(req, res);
  if (!auth) return;

  try {
    const buybackWalletId = getAppSetting('buyback_wallet_id') || '';
    if (!buybackWalletId) {
      return res.json({ balance: 0, error: 'No buyback wallet configured' });
    }

    const electrumServers = getElectrumServersFromDb();
    if (electrumServers.length === 0) {
      return res.json({ balance: 0, wallet: buybackWalletId, error: 'No electrum servers available' });
    }

    const balances = await fetchBatchBalances([buybackWalletId], electrumServers);
    const walletBalance = balances[buybackWalletId];

    return res.json({
      wallet: buybackWalletId,
      balance: walletBalance?.confirmed || 0,
      unconfirmed: walletBalance?.unconfirmed || 0,
    });
  } catch (error: any) {
    return res.json({ balance: 0, error: error.message });
  }
});

export default router;
