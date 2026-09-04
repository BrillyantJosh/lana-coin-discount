// @vitest-environment node
/**
 * The browser signer and the server verifier are two implementations of one
 * contract. This test holds them together: the same key, clock and body must
 * produce the same payload string on both sides, and what the browser signs
 * must be what the server accepts — once.
 */
import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  canonicalBody, signaturePayload, signRequestHeaders, pathnameOf,
} from './signedRequest';
import {
  verifyRequestSignature, createReplayCache,
  canonicalBody as serverCanonicalBody, signaturePayload as serverSignaturePayload,
} from '../../server/lib/requestSignature';

// A fixed key so the strings below are reproducible run after run.
const PRIV = '1f'.repeat(32);
const PUB = bytesToHex(schnorr.getPublicKey(hexToBytes(PRIV)));
const KEY = { privateKeyHex: PRIV, pubkeyHex: PUB };
const TS = 1_757_000_000;
const PATH = '/api/acquisitions/offers';
// Keys deliberately out of order on the wire.
const BODY = { senderAddress: 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB', hexId: PUB, currency: 'EUR', lanaAmount: 600 };

const verify = (headers: Record<string, string>, over: Partial<Parameters<typeof verifyRequestSignature>[0]> = {}) =>
  verifyRequestSignature({
    expectedPubkey: PUB,
    pubkeyHeader: headers['x-auth-pubkey'],
    timestampHeader: headers['x-auth-timestamp'],
    signatureHeader: headers['x-auth-signature'],
    method: 'POST', path: PATH, body: BODY, now: TS,
    replayCache: createReplayCache(),
    ...over,
  });

describe('the browser reproduces the server contract', () => {
  it('canonical body and payload string are identical on both sides', () => {
    expect(canonicalBody(BODY)).toBe(serverCanonicalBody(BODY));
    expect(canonicalBody(BODY)).toBe(
      '{"currency":"EUR","hexId":"' + PUB + '","lanaAmount":600,"senderAddress":"LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB"}',
    );
    expect(signaturePayload('post', PATH, TS, BODY)).toBe(serverSignaturePayload('post', PATH, TS, BODY));
    // GET: empty canonical body → sha256('') — the constant any client can check.
    expect(signaturePayload('GET', '/api/acquisitions/mandate', 5)).toBe(
      'GET:/api/acquisitions/mandate:5:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(canonicalBody(undefined)).toBe('');
  });

  it('emits the three headers exactly as named, and the server verifies them', () => {
    const headers = signRequestHeaders(KEY, 'POST', PATH, BODY, TS);
    expect(Object.keys(headers).sort()).toEqual(['x-auth-pubkey', 'x-auth-signature', 'x-auth-timestamp']);
    expect(headers['x-auth-pubkey']).toBe(PUB);
    expect(headers['x-auth-timestamp']).toBe(String(TS));
    expect(headers['x-auth-signature']).toMatch(/^[0-9a-f]{128}$/);
    expect(verify(headers)).toEqual({ ok: true });
  });

  it('a GET is signed over the pathname only, with an empty body', () => {
    const headers = signRequestHeaders(KEY, 'GET', pathnameOf(`/api/acquisitions/mandate?hexId=${PUB}&wallet=LKs7&currency=EUR`), undefined, TS);
    expect(verify(headers, { method: 'GET', path: '/api/acquisitions/mandate', body: undefined })).toEqual({ ok: true });
    expect(pathnameOf('https://lana.discount/api/acquisitions/mandate?x=1')).toBe('/api/acquisitions/mandate');
  });

  it('the signature binds the body: a changed amount is refused', () => {
    const headers = signRequestHeaders(KEY, 'POST', PATH, BODY, TS);
    expect(verify(headers, { body: { ...BODY, lanaAmount: 6000 } })).toEqual({ ok: false, code: 'INVALID' });
  });

  it('the same signature is honoured once', () => {
    const headers = signRequestHeaders(KEY, 'POST', PATH, BODY, TS);
    const cache = createReplayCache();
    expect(verify(headers, { replayCache: cache })).toEqual({ ok: true });
    expect(verify(headers, { replayCache: cache })).toEqual({ ok: false, code: 'REPLAYED' });
  });

  it('refuses to sign for a hex the key does not derive to', () => {
    expect(() => signRequestHeaders({ privateKeyHex: PRIV, pubkeyHex: 'ab'.repeat(32) }, 'POST', PATH, BODY, TS))
      .toThrow(/does not belong/);
  });
});
