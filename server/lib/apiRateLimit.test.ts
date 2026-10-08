// @vitest-environment node
/**
 * THE BRAIN IS NOT LIMITED; EVERYBODY ELSE STILL IS.
 *
 * 7–8 Oct 2026: lana-brain reaches Discount from one docker IP, and with
 * ~1,000 open orders its heartbeat alone spent the 1500-per-15-minutes budget
 * early in every window. The rest of each window was 429 — 19,692 refusals in
 * a day, all to the brain. Refused lana-order posts left legs marked failed,
 * refused send-customer-lana turned LANA purchases away at the till, refused
 * round-terms churned KIND 30960.
 *
 * These tests run the limiter production mounts (lib/apiRateLimit.ts), with
 * the limit lowered to 3 so it can be reached, in front of a route gated by
 * the real requireApiKey: a caller with an active key is never refused and
 * spends none of the IP's budget, while an anonymous caller from the SAME IP
 * — and anyone with a key that is unknown, disabled or uncheckable — is
 * refused exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import { createHash } from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const keys = vi.hoisted(() => ({
  rows: new Map<string, { id: number; app_name: string; is_active: number }>(),
  throwOnLookup: false,
  lastUsed: [] as number[],
}));
vi.mock('../db/index.js', () => ({
  getApiKeyByHash: (hash: string) => {
    if (keys.throwOnLookup) throw new TypeError('The database connection is not open');
    return keys.rows.get(hash) ?? null;
  },
  updateApiKeyLastUsed: (id: number) => { keys.lastUsed.push(id); },
}));

import { apiRateLimit, API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS } from './apiRateLimit';
import { requireApiKey } from './apiKeyAuth';

// Throwaway keys shaped like the ones routes/api.ts mints.
const ACTIVE = 'ldk_' + '4d'.repeat(24);
const DISABLED = 'ldk_' + '5e'.repeat(24);
const UNKNOWN = 'ldk_' + '6f'.repeat(24);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let server: http.Server | undefined;
let base = '';

/** A fresh app (and so a fresh, empty bucket) mounted the way server/index.ts mounts it. */
async function serve(limiter: express.RequestHandler) {
  const app = express();
  app.use('/api', limiter);
  // A brain route: gated by the key, as every /api/brain/* route is.
  app.get('/api/brain/lana-order/:id', (req, res) => {
    const auth = requireApiKey(req, res);
    if (!auth) return;
    res.json({ id: req.params.id, app: auth.appName });
  });
  // An open route, as a browser would call.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  server = http.createServer(app);
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const get = (path: string, key?: string) =>
  fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {} })
    .then(r => ({ status: r.status, headers: r.headers }));

async function statuses(n: number, path: string, key?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await get(path, key)).status);
  return out;
}

beforeEach(() => {
  keys.rows.clear();
  keys.rows.set(sha(ACTIVE), { id: 1, app_name: 'Brain', is_active: 1 });
  keys.rows.set(sha(DISABLED), { id: 2, app_name: 'Brain (old key)', is_active: 0 });
  keys.throwOnLookup = false;
  keys.lastUsed = [];
});
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

describe('the /api rate limit', () => {
  it('still refuses an anonymous caller once the IP has spent its budget', async () => {
    await serve(apiRateLimit(3));
    expect(await statuses(4, '/api/health')).toEqual([200, 200, 200, 429]);
  });

  it('never refuses the brain with its active key — and the brain spends none of the IP\'s budget', async () => {
    await serve(apiRateLimit(3));
    // Far past the limit, from the same IP as everyone below.
    expect(await statuses(12, '/api/brain/lana-order/42', ACTIVE)).toEqual(Array(12).fill(200));
    // The anonymous caller on that IP still has all 3 of its requests, then is refused.
    expect(await statuses(4, '/api/health')).toEqual([200, 200, 200, 429]);
    // And with the IP's bucket empty, the brain is still served.
    expect(await statuses(3, '/api/brain/lana-order/42', ACTIVE)).toEqual([200, 200, 200]);
    // last_used_at is written by the route, once per served request — the limiter adds nothing.
    expect(keys.lastUsed).toEqual(Array(15).fill(1));
  });

  it('limits a request that only LOOKS like the brain: an unknown key, a disabled key, the bare prefix', async () => {
    for (const key of [UNKNOWN, DISABLED, 'ldk_']) {
      await serve(apiRateLimit(3));
      const got = await statuses(4, '/api/health', key);
      expect(got, key).toEqual([200, 200, 200, 429]);
      await new Promise<void>(r => server!.close(() => r()));
      server = undefined;
    }
  });

  it('fails closed: if the key cannot be checked, the brain is limited like anyone', async () => {
    keys.throwOnLookup = true;
    await serve(apiRateLimit(3));
    expect(await statuses(4, '/api/health', ACTIVE)).toEqual([200, 200, 200, 429]);
  });

  it('keeps the production numbers: 1500 per 15 minutes', async () => {
    expect(API_RATE_LIMIT_MAX).toBe(1500);
    expect(API_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
    await serve(apiRateLimit());
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('ratelimit-limit')).toBe('1500');
    expect(r.headers.get('ratelimit-policy')).toBe('1500;w=900');
    expect(r.headers.get('x-ratelimit-limit')).toBeNull(); // legacyHeaders: false
  });

  it('is the limiter server/index.ts mounts on /api, ahead of the API routes', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const mount = src.indexOf("app.use('/api', apiRateLimit());");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(src.indexOf("app.use('/api', apiRouter);"));
    // No second, unexempted limiter built by hand next to it.
    expect(src).not.toMatch(/from 'express-rate-limit'/);
  });
});
