/**
 * One admin gate for every router. It used to be defined twice — once in
 * routes/api.ts and once in routes/acquisitions.ts — with the same body, and
 * the treasury router would have made a third. Three copies of "who is an
 * admin" is three places for them to drift apart.
 */
import type { Request, Response } from 'express';
import { isAdminUser } from '../db/index.js';

/** Reads x-admin-hex-id and verifies it against admin_users; answers 403 itself. */
export function requireAdmin(req: Request, res: Response): string | null {
  const hexId = String(req.headers['x-admin-hex-id'] || '');
  if (!hexId || !isAdminUser(hexId)) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return hexId;
}
