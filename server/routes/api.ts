import { Router, Request, Response } from 'express';
import db, { getRelaysFromDb, getTrustedSignersFromDb, getElectrumServersFromDb, isAdminUser, getAllAdmins } from '../db/index.js';
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
 * Returns buyback dashboard statistics (mock data for now).
 */
router.get('/admin/stats', (_req: Request, res: Response) => {
  const adminHex = requireAdmin(_req, res);
  if (!adminHex) return;

  // Mock buyback data
  const stats = {
    totalLanaBoughtBack: 2_450_000,
    totalEurOwed: 19.60,
    totalTransactions: 12,
    usersServed: 5,
    recentTransactions: [
      { id: 1, date: '2026-03-10', user: 'Brilly(ant) Josh', hexId: '56e8670a...a362061', lanaAmount: 500_000, eurPayout: 4.00, status: 'paid' },
      { id: 2, date: '2026-03-09', user: 'LanaFan42', hexId: 'a1b2c3d4...e5f6a7b8', lanaAmount: 350_000, eurPayout: 2.80, status: 'paid' },
      { id: 3, date: '2026-03-08', user: 'CryptoMax', hexId: 'f9e8d7c6...b5a49382', lanaAmount: 600_000, eurPayout: 4.80, status: 'pending' },
      { id: 4, date: '2026-03-07', user: 'SatoshiSi', hexId: '11223344...55667788', lanaAmount: 200_000, eurPayout: 1.60, status: 'paid' },
      { id: 5, date: '2026-03-05', user: 'NodeRunner', hexId: 'aabbccdd...eeff0011', lanaAmount: 800_000, eurPayout: 6.40, status: 'pending' },
    ],
  };

  return res.json(stats);
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

/**
 * GET /health
 */
router.get('/health', (_req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  return res.json({ status: 'ok', users: userCount, timestamp: new Date().toISOString() });
});

export default router;
