/**
 * Bearer `ldk_…` gate for machine callers (the brain, direct.lana.fund).
 * Moved out of routes/api.ts unchanged so the treasury router can require
 * the same key the external API already requires.
 */
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { getApiKeyByHash, updateApiKeyLastUsed } from '../db/index.js';

export interface ApiKeyIdentity {
  apiKeyId: number;
  appName: string;
}

/** Reads Authorization: Bearer ldk_xxx; answers 401/403 itself. */
export function requireApiKey(req: Request, res: Response): ApiKeyIdentity | null {
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
