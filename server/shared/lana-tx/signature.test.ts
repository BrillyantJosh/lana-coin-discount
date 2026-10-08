// @vitest-environment node
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import elliptic from 'elliptic';
import { signLanaSighash, encodeDER } from './signature.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ec = new elliptic.ec('secp256k1');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function mod(a: bigint, m: bigint) { return ((a % m) + m) % m; }
function inv(a: bigint, m: bigint) {
  let [lm, hm, lo, hi] = [1n, 0n, mod(a, m), m];
  while (lo > 1n) { const r = hi / lo; [lm, hm] = [hm - lm * r, lm]; [lo, hi] = [hi - lo * r, lo]; }
  return mod(lm, m);
}

/** Read r and s back out of a strict DER signature. */
function parseDER(der: Uint8Array): { r: bigint; s: bigint } {
  assert.equal(der[0], 0x30);
  assert.equal(der[1], der.length - 2);
  assert.equal(der[2], 0x02);
  const rLen = der[3];
  const r = BigInt('0x' + hex(der.slice(4, 4 + rLen)));
  assert.equal(der[4 + rLen], 0x02);
  const sLen = der[5 + rLen];
  const s = BigInt('0x' + hex(der.slice(6 + rLen, 6 + rLen + sLen)));
  return { r, s };
}

const keyPair = () => {
  const priv = crypto.randomBytes(32);
  const k = ec.keyFromPrivate(priv);
  return {
    privHex: hex(priv),
    d: BigInt('0x' + hex(priv)),
    compressed: Uint8Array.from(k.getPublic(true, 'array')),
    uncompressed: Uint8Array.from(k.getPublic(false, 'array')),
  };
};

describe('signLanaSighash', () => {
  it('produces a strict-DER, low-S signature that two independent libraries accept', async () => {
    for (let i = 0; i < 20; i++) {
      const kp = keyPair();
      const z = crypto.randomBytes(32);
      for (const pub of [kp.compressed, kp.uncompressed]) {
        const der = await signLanaSighash(kp.privHex, z, pub);
        const { r, s } = parseDER(der);
        assert.ok(s <= N / 2n, 'low-S');
        assert.ok(ec.keyFromPublic(hex(pub), 'hex').verify(hex(z), Array.from(der)), 'elliptic verifies');
        const compact = new Uint8Array(64);
        compact.set(Buffer.from(r.toString(16).padStart(64, '0'), 'hex'), 0);
        compact.set(Buffer.from(s.toString(16).padStart(64, '0'), 'hex'), 32);
        assert.ok(secp.verify(compact, z, pub, { prehash: false }), 'noble verifies');
      }
    }
  });

  it('THE HOLE: the private key can no longer be computed from a signature', async () => {
    // The old signer used k = (z + d) mod n, so d = z(1 − s)/(s − r) for s or n − s.
    for (let i = 0; i < 50; i++) {
      const kp = keyPair();
      const zb = crypto.randomBytes(32);
      const z = BigInt('0x' + hex(zb));
      const { r, s } = parseDER(await signLanaSighash(kp.privHex, zb, kp.compressed));
      for (const ss of [s, N - s]) {
        const guess = mod(z * (1n - ss) * inv(mod(ss - r, N), N), N);
        assert.notEqual(guess, kp.d, 'key recovered — the nonce is derivable again');
      }
    }
  });

  it('the recovery formula is real: it DOES find the key in a signature made the old way', () => {
    // Guards the test above: if the formula were wrong, "not recovered" would prove nothing.
    for (let i = 0; i < 10; i++) {
      const kp = keyPair();
      const z = BigInt('0x' + hex(crypto.randomBytes(32)));
      const k = mod(z + kp.d, N);
      const r = mod(secp.Point.BASE.multiply(k).toAffine().x, N);
      let s = mod(inv(k, N) * (z + r * kp.d), N);
      if (s > N / 2n) s = N - s;
      const found = [s, N - s].some((ss) => mod(z * (1n - ss) * inv(mod(ss - r, N), N), N) === kp.d);
      assert.ok(found, 'formula failed on the old signer');
    }
  });

  it('never reuses a nonce, even for the same key and the same sighash', async () => {
    const kp = keyPair();
    const z = crypto.randomBytes(32);
    const rs = new Set<string>();
    for (let i = 0; i < 10; i++) rs.add(parseDER(await signLanaSighash(kp.privHex, z, kp.compressed)).r.toString(16));
    assert.equal(rs.size, 10);
  });

  it('refuses to sign for a public key that is not the signer’s — nothing wrong is ever broadcast', async () => {
    const a = keyPair();
    const b = keyPair();
    await assert.rejects(signLanaSighash(a.privHex, crypto.randomBytes(32), b.compressed));
  });

  it('refuses malformed input', async () => {
    const kp = keyPair();
    await assert.rejects(signLanaSighash(kp.privHex, crypto.randomBytes(31), kp.compressed));
    await assert.rejects(signLanaSighash('abcd', crypto.randomBytes(32), kp.compressed));
  });
});

describe('encodeDER', () => {
  it('pads a high bit and strips leading zeros', () => {
    const der = encodeDER(0x80n, 0x01n);
    assert.deepEqual(Array.from(der), [0x30, 0x07, 0x02, 0x02, 0x00, 0x80, 0x02, 0x01, 0x01]);
  });
});

describe('no copy of the leaky signer is left in this repo', () => {
  it('no source file derives the nonce from the sighash plus the key', () => {
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (!fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
    const leaky = /mod\(\s*(?:z|zInt|zBig|sighash|msgHash|messageHash)\s*\+\s*(?:d|pk|priv|privKey|privateKey)\s*,/;
    const skip = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.test\./.test(e.name) && leaky.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
});
