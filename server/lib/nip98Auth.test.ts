// @vitest-environment node
import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { verifyNip98, forgetSpentTokens, MAX_SKEW_SEC, type Nip98Request } from './nip98Auth.js';
import { newSigner, nip98Header } from './nip98TestKit.js';

const NOW = 1_800_000_000;
const HOST = 'service.example';
const alice = newSigner();
const mallory = newSigner();

function req(over: Partial<Nip98Request> & { authorization: string | undefined }): Nip98Request {
  return { method: 'POST', target: '/api/admin/thing/7?x=1', host: HOST, ...over };
}

function decode(header: string): any {
  return JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'));
}

function encode(ev: any): string {
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

describe('verifyNip98', () => {
  beforeEach(() => forgetSpentTokens());

  it('accepts a fresh token for this method, absolute URL and body, and returns the signer', () => {
    const body = JSON.stringify({ amount: 5 });
    const h = nip98Header(alice, { method: 'POST', url: `https://${HOST}/api/admin/thing/7?x=1`, body, nowSec: NOW });
    const r = verifyNip98(req({ authorization: h, rawBody: Buffer.from(body) }), { nowSec: NOW });
    assert.deepEqual(r.ok && r.hex, alice.hex);
  });

  it('accepts a bare path + query as the u tag', () => {
    const h = nip98Header(alice, { method: 'GET', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    const r = verifyNip98(req({ method: 'GET', authorization: h }), { nowSec: NOW });
    assert.equal(r.ok, true);
  });

  it('refuses no header, a bare hex, and a Bearer key', () => {
    assert.deepEqual(verifyNip98(req({ authorization: undefined }), { nowSec: NOW }), { ok: false, reason: 'MISSING' });
    assert.deepEqual(verifyNip98(req({ authorization: alice.hex }), { nowSec: NOW }), { ok: false, reason: 'MALFORMED' });
    assert.deepEqual(verifyNip98(req({ authorization: 'Bearer abc' }), { nowSec: NOW }), { ok: false, reason: 'MALFORMED' });
    assert.deepEqual(verifyNip98(req({ authorization: 'Nostr !!!' }), { nowSec: NOW }), { ok: false, reason: 'MALFORMED' });
  });

  it('refuses another kind', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW, kind: 1 });
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'BAD_KIND' });
  });

  it('refuses a token older or newer than the window', () => {
    for (const skew of [MAX_SKEW_SEC + 1, -(MAX_SKEW_SEC + 1)]) {
      const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW - skew });
      assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'STALE' });
    }
  });

  it('is bound to the method', () => {
    const h = nip98Header(alice, { method: 'GET', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'METHOD_MISMATCH' });
  });

  it('is bound to the path AND the query string', () => {
    for (const url of ['/api/admin/thing/8?x=1', '/api/admin/thing/7?x=2', '/api/admin/thing/7', `https://${HOST}/api/admin/other`]) {
      const h = nip98Header(alice, { method: 'POST', url, nowSec: NOW });
      assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'PATH_MISMATCH' }, url);
    }
  });

  it('is bound to the host when the u tag is absolute', () => {
    const h = nip98Header(alice, { method: 'POST', url: 'https://other.example/api/admin/thing/7?x=1', nowSec: NOW });
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'HOST_MISMATCH' });
  });

  it('is bound to the exact body bytes', () => {
    const signed = JSON.stringify({ new_investor_hex: 'a'.repeat(64) });
    const sent = JSON.stringify({ new_investor_hex: 'b'.repeat(64) });
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', body: signed, nowSec: NOW });
    assert.deepEqual(verifyNip98(req({ authorization: h, rawBody: Buffer.from(sent) }), { nowSec: NOW }), { ok: false, reason: 'PAYLOAD_MISMATCH' });
  });

  it('refuses a body that the token does not cover at all', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    assert.deepEqual(
      verifyNip98(req({ authorization: h, rawBody: Buffer.from('{"a":1}') }), { nowSec: NOW }),
      { ok: false, reason: 'PAYLOAD_MISSING' },
    );
  });

  it('refuses a payload tag when no body arrived (body stripped in flight)', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', body: '{"a":1}', nowSec: NOW });
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'PAYLOAD_MISMATCH' });
  });

  it('refuses an edited tag (id no longer matches) and a signature by another key', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    const ev = decode(h);
    const edited = { ...ev, tags: ev.tags.map((t: string[]) => (t[0] === 'u' ? ['u', '/api/admin/thing/7?x=1&y=2'] : t)) };
    assert.deepEqual(
      verifyNip98(req({ authorization: encode(edited), target: '/api/admin/thing/7?x=1&y=2' }), { nowSec: NOW }),
      { ok: false, reason: 'BAD_ID' },
    );

    // Mallory signs the request herself but claims Alice's pubkey.
    const own = decode(nip98Header(mallory, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW }));
    const forged = { ...own, pubkey: alice.hex };
    forged.id = eventId(forged);
    assert.deepEqual(verifyNip98(req({ authorization: encode(forged) }), { nowSec: NOW }), { ok: false, reason: 'BAD_SIG' });
  });

  it('refuses non-string tags', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW, extraTags: [['x', 1 as any]] });
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW }), { ok: false, reason: 'BAD_TAGS' });
  });

  it('is single use: the same header twice is a replay', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    assert.equal(verifyNip98(req({ authorization: h }), { nowSec: NOW }).ok, true);
    assert.deepEqual(verifyNip98(req({ authorization: h }), { nowSec: NOW + 1 }), { ok: false, reason: 'REPLAYED' });
  });

  it('two identical requests in the same second are two tokens (the nonce)', () => {
    const a = nip98Header(alice, { method: 'GET', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    const b = nip98Header(alice, { method: 'GET', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    assert.notEqual(decode(a).id, decode(b).id);
    assert.equal(verifyNip98(req({ method: 'GET', authorization: a }), { nowSec: NOW }).ok, true);
    assert.equal(verifyNip98(req({ method: 'GET', authorization: b }), { nowSec: NOW }).ok, true);
  });

  it('a refused token does not spend its id', () => {
    const h = nip98Header(alice, { method: 'POST', url: '/api/admin/thing/7?x=1', nowSec: NOW });
    assert.equal(verifyNip98(req({ authorization: h, target: '/elsewhere' }), { nowSec: NOW }).ok, false);
    assert.equal(verifyNip98(req({ authorization: h }), { nowSec: NOW }).ok, true);
  });
});

function eventId(e: any): string {
  return createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
}
