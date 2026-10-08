// @vitest-environment node
/**
 * WHICH REQUESTS COUNT AS AN AUTHENTICATED MACHINE.
 *
 * isActiveMachineKey decides who the /api rate limiter lets past. Getting it
 * wrong one way is the outage of 7–8 Oct 2026 again (the brain held to the
 * per-IP budget and answered 429 for most of every window); getting it wrong
 * the other way lets anyone shed the limit by typing a header. So it must say
 * yes to exactly the requests requireApiKey would serve — and say it without
 * answering, without touching last_used_at, and with "no" whenever it cannot
 * be sure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';

const keys = vi.hoisted(() => ({
  rows: new Map<string, { id: number; app_name: string; is_active: number }>(),
  throwOnLookup: false,
  lookups: 0,
  lastUsed: [] as number[],
}));
vi.mock('../db/index.js', () => ({
  getApiKeyByHash: (hash: string) => {
    keys.lookups++;
    if (keys.throwOnLookup) throw new TypeError('The database connection is not open');
    return keys.rows.get(hash) ?? null;
  },
  updateApiKeyLastUsed: (id: number) => { keys.lastUsed.push(id); },
}));

import { isActiveMachineKey, requireApiKey } from './apiKeyAuth';

// Shaped like the keys routes/api.ts mints: ldk_ + 48 hex. Throwaway values.
const ACTIVE = 'ldk_' + '1a'.repeat(24);
const DISABLED = 'ldk_' + '2b'.repeat(24);
const UNKNOWN = 'ldk_' + '3c'.repeat(24);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as any;

/** Just enough of express's Response to see what requireApiKey answered. */
function fakeRes() {
  const res: any = { statusCode: 0, body: undefined as any };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

beforeEach(() => {
  keys.rows.clear();
  keys.rows.set(sha(ACTIVE), { id: 7, app_name: 'Brain', is_active: 1 });
  keys.rows.set(sha(DISABLED), { id: 8, app_name: 'Old brain', is_active: 0 });
  keys.throwOnLookup = false;
  keys.lookups = 0;
  keys.lastUsed = [];
});

describe('isActiveMachineKey', () => {
  it('is true for an active key', () => {
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE}`))).toBe(true);
  });

  it('is false for a key nobody issued', () => {
    expect(isActiveMachineKey(req(`Bearer ${UNKNOWN}`))).toBe(false);
  });

  it('is false for a key that exists but was disabled', () => {
    expect(isActiveMachineKey(req(`Bearer ${DISABLED}`))).toBe(false);
  });

  it('is false with no header, another scheme, or only the prefix', () => {
    for (const h of [
      undefined,
      '',
      `Basic ${ACTIVE}`,
      `bearer ${ACTIVE}`,
      ACTIVE,
      'Bearer ',
      'Bearer ldk_',
      'Bearer sk_' + '1a'.repeat(24),
    ]) {
      expect(isActiveMachineKey(req(h)), String(h)).toBe(false);
    }
  });

  it('wants the WHOLE key: a prefix of it, or the key with something added, is not it', () => {
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE.slice(0, -1)}`))).toBe(false);
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE.slice(0, 12)}`))).toBe(false);
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE}0`))).toBe(false);
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE} `))).toBe(false);
  });

  it('fails CLOSED: a lookup that throws answers false instead of throwing', () => {
    keys.throwOnLookup = true;
    expect(() => isActiveMachineKey(req(`Bearer ${ACTIVE}`))).not.toThrow();
    expect(isActiveMachineKey(req(`Bearer ${ACTIVE}`))).toBe(false);
  });

  it('does not look the key up at all unless the header is Bearer ldk_', () => {
    isActiveMachineKey(req());
    isActiveMachineKey(req(`Basic ${ACTIVE}`));
    expect(keys.lookups).toBe(0);
  });

  it('never records last_used_at — that is the route\'s to do, once, when it serves the request', () => {
    for (let i = 0; i < 5; i++) isActiveMachineKey(req(`Bearer ${ACTIVE}`));
    isActiveMachineKey(req(`Bearer ${DISABLED}`));
    isActiveMachineKey(req(`Bearer ${UNKNOWN}`));
    expect(keys.lastUsed).toEqual([]);
  });

  it('says yes to exactly the requests requireApiKey lets in', () => {
    const headers = [
      undefined, '', `Basic ${ACTIVE}`, 'Bearer ldk_',
      `Bearer ${ACTIVE}`, `Bearer ${DISABLED}`, `Bearer ${UNKNOWN}`, `Bearer ${ACTIVE}0`,
    ];
    for (const h of headers) {
      expect(isActiveMachineKey(req(h)), String(h)).toBe(requireApiKey(req(h), fakeRes()) !== null);
    }
  });
});

describe('requireApiKey (sharing the lookup did not change what it answers)', () => {
  it('401 with no header or another scheme, without a lookup', () => {
    for (const h of [undefined, `Basic ${ACTIVE}`]) {
      const res = fakeRes();
      expect(requireApiKey(req(h), res)).toBeNull();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Missing or invalid API key. Use: Authorization: Bearer ldk_...' });
    }
    expect(keys.lookups).toBe(0);
  });

  it('401 for an unknown key, 403 for a disabled one', () => {
    const unknown = fakeRes();
    expect(requireApiKey(req(`Bearer ${UNKNOWN}`), unknown)).toBeNull();
    expect([unknown.statusCode, unknown.body]).toEqual([401, { error: 'Invalid API key' }]);

    const disabled = fakeRes();
    expect(requireApiKey(req(`Bearer ${DISABLED}`), disabled)).toBeNull();
    expect([disabled.statusCode, disabled.body]).toEqual([403, { error: 'API key is disabled' }]);
    expect(keys.lastUsed).toEqual([]);
  });

  it('lets an active key in as its app, records last_used_at, and answers nothing itself', () => {
    const res = fakeRes();
    expect(requireApiKey(req(`Bearer ${ACTIVE}`), res)).toEqual({ apiKeyId: 7, appName: 'Brain' });
    expect(res.statusCode).toBe(0);
    expect(keys.lastUsed).toEqual([7]);
  });
});
