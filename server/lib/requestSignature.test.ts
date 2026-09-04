// @vitest-environment node
/**
 * A mandate is a financer's quota; the request that spends it must be signed
 * by that financer's key, recently, for this very endpoint, over THIS body,
 * and be honoured only once.
 *
 * The last two are what v2 of the scheme added. Under v1 (method+path+time)
 * a captured signature could be re-sent with another amount or wallet, and
 * re-sent again for five minutes. Both are refused here, so removing the
 * body hash from the payload or the replay cache must fail this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  verifyRequestSignature, canonicalBody, signaturePayload, signaturePayloadHash, createReplayCache,
  SIGNATURE_WINDOW_SECONDS, REPLAY_TTL_SECONDS,
} from './requestSignature';
import { makeKey, signedHeaders } from './roundMandateTestKit';

const PATH = '/api/acquisitions/offers';
const NOW = 1_757_000_000;
const BODY = { hexId: 'a'.repeat(64), senderAddress: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', lanaAmount: 600, currency: 'EUR' };

const verify = (
  headers: Record<string, string>,
  over: Partial<Parameters<typeof verifyRequestSignature>[0]> = {},
  expected?: string,
) =>
  verifyRequestSignature({
    expectedPubkey: expected ?? headers['x-auth-pubkey'],
    pubkeyHeader: headers['x-auth-pubkey'],
    timestampHeader: headers['x-auth-timestamp'],
    signatureHeader: headers['x-auth-signature'],
    method: 'POST', path: PATH, body: BODY, now: NOW,
    // A fresh memory per call unless the test is about replay.
    replayCache: createReplayCache(),
    ...over,
  });

describe('the canonical body', () => {
  it('sorts keys recursively, keeps array order, and is empty for no body', () => {
    expect(canonicalBody({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe('{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalBody(undefined)).toBe('');
    expect(canonicalBody(null)).toBe('');
  });

  it('the payload is METHOD:PATH:timestamp:sha256hex(canonicalBody)', () => {
    // sha256('') — the GET case; any client can check this constant.
    expect(signaturePayload('get', '/api/acquisitions/mandate', 5)).toBe(
      'GET:/api/acquisitions/mandate:5:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

/**
 * The worked example in the doc block at the top of requestSignature.ts. A
 * UI author reproduces these four strings on their side; if any of them
 * drifts, the contract text and the code have parted ways.
 */
describe('the worked example in the contract doc block', () => {
  const ts = 1_757_000_000;
  const example = { hexId: 'a'.repeat(64), senderAddress: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', lanaAmount: 600, currency: 'EUR' };

  it('reproduces canonical body, body hash, payload and the digest that is signed', () => {
    expect(canonicalBody(example)).toBe(
      '{"currency":"EUR","hexId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lanaAmount":600,"senderAddress":"LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB"}',
    );
    expect(signaturePayload('POST', PATH, ts, example)).toBe(
      'POST:/api/acquisitions/offers:1757000000:103b4ba1a0425ecf34fcd9528dd551e5b6eaa505392c2b482a08587aff293802',
    );
    expect(signaturePayloadHash('POST', PATH, ts, example).toString('hex')).toBe(
      'dec7a821a809846237d083f8375bbb1fe6843cfeb782da49dccbbcad52e5c353',
    );
  });

  it('the doc block itself carries the same figures, the error codes and every gated route', () => {
    const src = readFileSync(new URL('./requestSignature.ts', import.meta.url), 'utf8');
    const doc = src.slice(0, src.indexOf('*/'));
    for (const needle of [
      '103b4ba1a0425ecf34fcd9528dd551e5b6eaa505392c2b482a08587aff293802',
      'dec7a821a809846237d083f8375bbb1fe6843cfeb782da49dccbbcad52e5c353',
      '1757000000',
      'Errors', 'Where required',
      '401 SIGNATURE_REQUIRED', 'MISSING', 'PUBKEY_MISMATCH', 'STALE', 'INVALID',
      '401 SIGNATURE_REPLAYED', '403 WALLET_NOT_OWNED', '503 WALLET_OWNERSHIP_UNVERIFIABLE',
      'POST /api/acquisitions/offers', 'POST /api/acquisitions/:ref/accept',
      'POST /api/acquisitions/:ref/withdraw', 'GET /api/acquisitions/mandate',
    ]) {
      expect(doc, `doc block is missing "${needle}"`).toContain(needle);
    }
  });
});

describe('verifyRequestSignature', () => {
  const key = makeKey();

  it('accepts a fresh signature from the claimed hex over this body', () => {
    expect(verify(signedHeaders(key, 'POST', PATH, NOW, BODY))).toEqual({ ok: true });
  });

  it('accepts the same body sent with its keys in another order', () => {
    const reordered = { currency: 'EUR', lanaAmount: 600, senderAddress: BODY.senderAddress, hexId: BODY.hexId };
    expect(verify(signedHeaders(key, 'POST', PATH, NOW, BODY), { body: reordered })).toEqual({ ok: true });
  });

  it('accepts a GET with no body and refuses one where a body was smuggled in', () => {
    const h = signedHeaders(key, 'GET', '/api/acquisitions/mandate', NOW);
    expect(verify(h, { method: 'GET', path: '/api/acquisitions/mandate', body: undefined })).toEqual({ ok: true });
    expect(verify(h, { method: 'GET', path: '/api/acquisitions/mandate', body: {} }).code).toBe('INVALID');
  });

  it('REFUSES a signature made over a different body (amount, wallet)', () => {
    const h = signedHeaders(key, 'POST', PATH, NOW, BODY);
    expect(verify(h, { body: { ...BODY, lanaAmount: 6000 } }).code).toBe('INVALID');
    expect(verify(h, { body: { ...BODY, senderAddress: 'LdY5W1Qm6xXoTmr3hjCkGyeJ7YqTx6Zv4t' } }).code).toBe('INVALID');
    expect(verify(h, { body: undefined }).code).toBe('INVALID');
  });

  it('REFUSES a replay: the same signature is honoured once, then REPLAYED for ten minutes', () => {
    const cache = createReplayCache();
    const h = signedHeaders(key, 'POST', PATH, NOW, BODY);
    expect(verify(h, { replayCache: cache })).toEqual({ ok: true });
    expect(verify(h, { replayCache: cache })).toEqual({ ok: false, code: 'REPLAYED' });
    // Still refused right up to the TTL — which outlasts the ±300 s window,
    // so there is no moment when a replay is both fresh enough and forgotten.
    expect(verify(h, { replayCache: cache, now: NOW + SIGNATURE_WINDOW_SECONDS }).code).toBe('REPLAYED');
    expect(REPLAY_TTL_SECONDS).toBeGreaterThan(SIGNATURE_WINDOW_SECONDS);
    // Past the TTL the timestamp is stale anyway (refused before the cache is
    // consulted), and the next cache touch prunes the old entry.
    expect(verify(h, { replayCache: cache, now: NOW + REPLAY_TTL_SECONDS + 1 }).code).toBe('STALE');
    expect(cache.seenBefore('someone-else', NOW + REPLAY_TTL_SECONDS + 1)).toBe(false);
    expect(cache.size()).toBe(1);
  });

  it('a failed attempt does not burn the signature for the real client', () => {
    const cache = createReplayCache();
    const h = signedHeaders(key, 'POST', PATH, NOW, BODY);
    expect(verify(h, { replayCache: cache, body: { ...BODY, lanaAmount: 1 } }).code).toBe('INVALID');
    expect(verify(h, { replayCache: cache })).toEqual({ ok: true });
  });

  it('accepts a clock drift inside the window and refuses one outside it (STALE)', () => {
    expect(verify(signedHeaders(key, 'POST', PATH, NOW - SIGNATURE_WINDOW_SECONDS, BODY)).ok).toBe(true);
    expect(verify(signedHeaders(key, 'POST', PATH, NOW - SIGNATURE_WINDOW_SECONDS - 1, BODY)).code).toBe('STALE');
    expect(verify(signedHeaders(key, 'POST', PATH, NOW + SIGNATURE_WINDOW_SECONDS + 1, BODY)).code).toBe('STALE');
  });

  it('refuses when nothing is signed', () => {
    expect(verify({}).code).toBe('MISSING');
  });

  it('refuses a signature by a different key than the body claims', () => {
    const other = makeKey();
    expect(verify(signedHeaders(other, 'POST', PATH, NOW, BODY), {}, key.pub).code).toBe('PUBKEY_MISMATCH');
  });

  it('refuses a signature made for another path or method', () => {
    expect(verify(signedHeaders(key, 'POST', '/api/acquisitions/OFF-1/accept', NOW, BODY)).code).toBe('INVALID');
    expect(verify(signedHeaders(key, 'GET', PATH, NOW, BODY)).code).toBe('INVALID');
  });

  it('refuses a signature whose timestamp was edited after signing', () => {
    const h = signedHeaders(key, 'POST', PATH, NOW, BODY);
    h['x-auth-timestamp'] = String(NOW + 1);
    expect(verify(h).code).toBe('INVALID');
  });

  it('refuses garbage without throwing', () => {
    const h = signedHeaders(key, 'POST', PATH, NOW, BODY);
    h['x-auth-signature'] = 'zz'.repeat(64);
    expect(verify(h).ok).toBe(false);
  });
});
