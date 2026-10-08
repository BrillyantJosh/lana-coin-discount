// @vitest-environment node
/**
 * The WIF rules, checked against an implementation that shares nothing with the
 * shipped one: Node's own OpenSSL for the curve (ECDH secp256k1), SHA-256 and
 * RIPEMD-160, and a base58 written here. If the two ever disagree, one of them
 * would show a person the wrong address or sign in the wrong identity.
 *
 * Cases follow lana-paper-wallet/tools/verify-wif.mjs: all four envelopes, the
 * flag byte, the key range, the leading zero byte, and what a paste drags along.
 *
 * lana.discount (8. 10. 2026): Krog Menjave's server/tests/wif.test.ts
 * (origin/main a46f618) under vitest — runner import and paths changed. Its last
 * test (a sign-in event verified by Krog Menjave's server, walletAuth.ts) is not
 * here: this site signs in otherwise (src/lib/crypto.ts) and reads a WIF only to
 * sign the financer's send (payoutKey.ts).
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { classifyKeyInput, decodeWif, normalizeKeyInput } from './wif.ts';
import { decodedCopies, wiped } from '../../test/decodedCopies.ts';

// node:test, which these tests were written for, sets no time limit; 42 keys in four envelopes each, checked against
// OpenSSL, can pass vitest's 5 s while the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 });

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest();
const b58 = (buf: Buffer): string => {
  let num = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
};
const check58 = (payload: Buffer) => b58(Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]));

function encodeWif(privHex: string, compressed: boolean, version = 0xb0, flag = 0x01): string {
  const parts = [Buffer.from([version]), Buffer.from(privHex.padStart(64, '0'), 'hex')];
  if (compressed) parts.push(Buffer.from([flag]));
  return check58(Buffer.concat(parts));
}

function independent(privHex: string) {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privHex, 'hex'));
  const compressedPub = ecdh.getPublicKey(null, 'compressed');
  const uncompressedPub = ecdh.getPublicKey(null, 'uncompressed');
  const address = (pub: Buffer) =>
    check58(Buffer.concat([Buffer.from([0x30]), createHash('ripemd160').update(sha(pub)).digest()]));
  return {
    hex: compressedPub.subarray(1).toString('hex'),
    compressedPub: compressedPub.toString('hex'),
    compressedAddress: address(compressedPub),
    uncompressedAddress: address(uncompressedPub),
  };
}

const keys = Array.from({ length: 40 }, () => {
  for (;;) {
    const k = randomBytes(32);
    const v = BigInt('0x' + k.toString('hex'));
    if (v > 0n && v < N) return k.toString('hex');
  }
});
// Edges of the range, too: 1 and n-1.
keys.push('0'.repeat(63) + '1', (N - 1n).toString(16));

test('all four envelopes of one key give one identity; the flag decides the address', () => {
  for (const priv of keys) {
    const ref = independent(priv);
    const shapes = [
      { wif: encodeWif(priv, true, 0xb0), start: 'T', compressed: true },
      { wif: encodeWif(priv, false, 0xb0), start: '6', compressed: false },
      { wif: encodeWif(priv, true, 0x41), start: 'A', compressed: true },
      { wif: encodeWif(priv, false, 0x41), start: '3', compressed: false },
    ];
    for (const shape of shapes) {
      assert.equal(shape.wif[0], shape.start, `envelope starts with ${shape.start}`);
      const decoded = decodeWif(shape.wif);
      assert.ok(decoded.ok, `${shape.start}… must decode`);
      assert.equal(decoded.hex, ref.hex, 'identity matches OpenSSL');
      assert.equal(decoded.publicKey, ref.compressedPub, 'public key matches OpenSSL, always in compressed form');
      assert.equal(decoded.compressed, shape.compressed);
      assert.equal(decoded.address, shape.compressed ? ref.compressedAddress : ref.uncompressedAddress, 'address matches OpenSSL');
      assert.equal(Buffer.from(decoded.privateKey).toString('hex'), priv.padStart(64, '0'));
    }
  }
});

test('another chain, a typo, a wrong flag or length is named for what it is', () => {
  const priv = keys[0];
  assert.deepEqual(decodeWif(encodeWif(priv, true, 0x80)), { ok: false, reason: 'wrongNetwork' });
  assert.deepEqual(decodeWif(encodeWif(priv, false, 0x80)), { ok: false, reason: 'wrongNetwork' });

  const good = encodeWif(priv, true);
  // One key byte changed, the old checksum kept: exactly what a typo leaves.
  const body = Buffer.from('b0' + priv + '01', 'hex');
  const checksum = sha(sha(body)).subarray(0, 4);
  body[10] ^= 0x01;
  assert.deepEqual(decodeWif(b58(Buffer.concat([body, checksum]))), { ok: false, reason: 'checksum' });
  // A changed character is always refused — as a typo, or as no key at all when
  // it moved the length or the flag byte.
  for (let i = 1; i < good.length; i++) {
    const swapped = good.slice(0, i) + (good[i] === 'z' ? 'y' : 'z') + good.slice(i + 1);
    const result = decodeWif(swapped);
    assert.equal(result.ok, false, `character ${i}`);
    assert.ok(!result.ok && (result.reason === 'checksum' || result.reason === 'notAKey'), `character ${i}: ${!result.ok && result.reason}`);
  }

  assert.deepEqual(decodeWif(encodeWif(priv, true, 0xb0, 0x02)), { ok: false, reason: 'notAKey' });
  assert.deepEqual(decodeWif(check58(Buffer.from('b0' + priv.slice(0, 60), 'hex'))), { ok: false, reason: 'notAKey' });
  assert.deepEqual(decodeWif(good.slice(0, -1)).ok, false);
  assert.deepEqual(decodeWif(''), { ok: false, reason: 'notAKey' });
  assert.deepEqual(decodeWif('T0OIl'), { ok: false, reason: 'notAKey' });
});

test('keys outside [1, n-1] are refused', () => {
  for (const priv of ['0'.repeat(64), N.toString(16), (N + 1n).toString(16)]) {
    for (const compressed of [true, false]) {
      assert.deepEqual(decodeWif(encodeWif(priv, compressed)), { ok: false, reason: 'notAKey' }, priv.slice(0, 8));
    }
  }
});

test('a leading zero version byte survives base58 and is another network, not a typo', () => {
  const wif = encodeWif(keys[1], true, 0x00);
  assert.ok(wif.startsWith('1'));
  assert.deepEqual(decodeWif(wif), { ok: false, reason: 'wrongNetwork' });
});

test('what a scan or a PDF paste drags along is stripped; case is not touched', () => {
  const wif = encodeWif(keys[2], true);
  const zwsp = String.fromCharCode(0x200b);
  const bom = String.fromCharCode(0xfeff);
  const nbsp = String.fromCharCode(0xa0);
  const messy = [
    ` ${wif} `,
    `${wif.slice(0, 10)}\n${wif.slice(10)}`,
    `${wif.slice(0, 8)}${zwsp}${wif.slice(8)}`,
    `${bom}${wif}\r\n`,
    `${nbsp}${wif}`,
    `lanacoin:${wif}`,
    `lanacoin://${wif}`,
  ];
  for (const raw of messy) {
    const decoded = decodeWif(raw);
    assert.ok(decoded.ok, JSON.stringify(raw));
    assert.equal(normalizeKeyInput(raw), wif);
  }
  assert.equal(normalizeKeyInput('TaBc'), 'TaBc');
});

test('an address, a Nostr key or a raw hex key is recognised before decoding', () => {
  const ref = independent(keys[3]);
  assert.equal(classifyKeyInput(ref.compressedAddress), 'address');
  assert.equal(classifyKeyInput(` ${ref.uncompressedAddress}\n`), 'address');
  assert.equal(classifyKeyInput('npub1' + 'q'.repeat(58)), 'npub');
  assert.equal(classifyKeyInput('NSEC1' + 'q'.repeat(58)), 'nsec');
  assert.equal(classifyKeyInput(keys[3]), 'hex');
  assert.equal(classifyKeyInput('   '), 'empty');
  assert.equal(classifyKeyInput(encodeWif(keys[3], true)), 'candidate');
  assert.equal(classifyKeyInput(encodeWif(keys[3], false, 0x41)), 'candidate');
});

/**
 * A finding of 8. 10. 2026: the sign-in fields now read what is typed on every change (src/lib/keyUsername.ts), and a
 * reading that was refused — one typo, a real key of another network, a wrong flag — left the decoded buffer, private
 * bytes and all, unwiped; so did the look classifyKeyInput takes. Every copy a reading makes is wiped before it answers;
 * only the private key handed over on success is left, for the caller to wipe once it has signed.
 */
test('reading a key leaves no decoded copy of it behind: refused for any reason, or only looked at', () => {
  const priv = keys[5];
  const good = encodeWif(priv, true);
  const body = Buffer.from('b0' + priv + '01', 'hex');
  const checksum = sha(sha(body)).subarray(0, 4);
  body[10] ^= 0x01;
  const refusals = [
    ['another network, compressed', encodeWif(priv, true, 0x80), 'wrongNetwork'],
    ['another network, uncompressed', encodeWif(priv, false, 0x80), 'wrongNetwork'],
    ['a typo the checksum catches', b58(Buffer.concat([body, checksum])), 'checksum'],
    ['a wrong flag byte', encodeWif(priv, true, 0xb0, 0x02), 'notAKey'],
    ['the key out of range', encodeWif(N.toString(16), true), 'notAKey'],
  ] as const;
  for (const [what, input, reason] of refusals) {
    const { result, copies } = decodedCopies(() => decodeWif(input));
    assert.deepEqual(result, { ok: false, reason }, what);
    assert.ok(copies.length > 0, `${what}: the reading is seen`);
    assert.ok(copies.every(wiped), `${what}: every copy wiped`);
  }
  // Every one-character change of a good key, whatever it is refused for.
  for (let i = 1; i < good.length; i++) {
    const swapped = good.slice(0, i) + (good[i] === 'z' ? 'y' : 'z') + good.slice(i + 1);
    const { result, copies } = decodedCopies(() => decodeWif(swapped));
    assert.equal(result.ok, false, `character ${i}`);
    assert.ok(copies.every(wiped), `character ${i}: every copy wiped`);
  }
  // A good key: the decoded buffer is wiped; the private key handed over is the caller's to wipe (wipe(), after signing).
  const { result: decoded, copies } = decodedCopies(() => decodeWif(good));
  assert.ok(decoded.ok);
  const handedOver = decoded.privateKey;
  assert.ok(copies.includes(handedOver), 'the private key is a slice of the decoded buffer');
  assert.ok(copies.filter((c) => c !== handedOver).every(wiped), 'everything else wiped');
  assert.ok(!wiped(handedOver), 'the private key itself is the caller’s');
  handedOver.fill(0);
  // classifyKeyInput only looks: a key, an address, anything it decodes is wiped before it answers.
  const ref = independent(priv);
  for (const [input, kind] of [
    [good, 'candidate'],
    [encodeWif(priv, false, 0x41), 'candidate'],
    [encodeWif(priv, true, 0x80), 'candidate'],
    [ref.compressedAddress, 'address'],
  ] as const) {
    const looked = decodedCopies(
      () => classifyKeyInput(input),
      (length) => length === 25 || length === 37 || length === 38,
    );
    assert.equal(looked.result, kind);
    assert.ok(looked.copies.length > 0, `${kind}: the reading is seen`);
    assert.ok(looked.copies.every(wiped), `${kind}: wiped before the answer`);
  }
});
