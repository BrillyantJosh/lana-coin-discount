/**
 * Bearer `ldk_…` gate for machine callers (the brain, direct.lana.fund).
 * Moved out of routes/api.ts unchanged so the treasury router can require
 * the same key the external API already requires. Also home to
 * isActiveMachineKey, the same question asked without answering, for the /api
 * rate limiter (lib/apiRateLimit.ts).
 */
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { getApiKeyByHash, updateApiKeyLastUsed } from '../db/index.js';

export interface ApiKeyIdentity {
  apiKeyId: number;
  appName: string;
}

/**
 * The api_keys row an `Authorization: Bearer ldk_…` header names, or null.
 * One function for both callers below, so the rate limiter and the gate can
 * never disagree about which key a header carries.
 */
function findApiKeyRow(authHeader: string): any | null {
  const apiKey = authHeader.replace('Bearer ', '');
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  return getApiKeyByHash(keyHash);
}

/** Reads Authorization: Bearer ldk_xxx; answers 401/403 itself. */
export function requireApiKey(req: Request, res: Response): ApiKeyIdentity | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ldk_')) {
    res.status(401).json({ error: 'Missing or invalid API key. Use: Authorization: Bearer ldk_...' });
    return null;
  }

  const row = findApiKeyRow(authHeader);

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
 * Would requireApiKey let this request in? The same test — the whole key
 * hashes to a row in api_keys and that row is active — asked without side
 * effects: it answers nothing, and it does not touch last_used_at (that is the
 * route's to record, once, when the request is actually served).
 *
 * It exists for the /api rate limiter (lib/apiRateLimit.ts), which lets an
 * authenticated machine caller past and keeps everyone else on the per-IP
 * budget. So it fails CLOSED: a header that is not ours, a key that is unknown
 * or disabled, or a lookup that throws (the database not open yet) all answer
 * false, and the request keeps the limit.
 */
export function isActiveMachineKey(req: Pick<Request, 'headers'>): boolean {
  try {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ldk_')) return false;
    const row = findApiKeyRow(authHeader);
    return !!row && !!row.is_active;
  } catch {
    return false;
  }
}
