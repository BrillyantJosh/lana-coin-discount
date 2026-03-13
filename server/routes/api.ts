import { Router, Request, Response } from 'express';
import db, { getRelaysFromDb, getTrustedSignersFromDb, getElectrumServersFromDb, isAdminUser, getAllAdmins, getAllAppSettings, setAppSetting, getAppSetting, getExchangeRatesFromDb, getSplitFromDb, insertBuybackTransaction, getBuybackStats, getRecentBuybackTransactions, getUserSalesWithPayouts, getAdminPayoutStats, getAllSalesWithPayouts, generatePayoutId, insertSalePayout } from '../db/index.js';
import { sendLanaTransaction } from '../lib/transaction.js';
import { fetchKind38888, fetchKind0, fetchUserWallets } from '../lib/nostr.js';
import { fetchBatchBalances } from '../lib/electrum.js';

const router = Router();

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
        const bal = balances[buybackWalletId];
        if (bal) {
          buybackWalletBalance = (bal.confirmed + bal.unconfirmed) / 100000000; // lanoshis to LANA
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

/**
 * GET /health
 */
router.get('/health', (_req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  return res.json({ status: 'ok', users: userCount, timestamp: new Date().toISOString() });
});

export default router;
