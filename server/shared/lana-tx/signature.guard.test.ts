// @vitest-environment node
/**
 * Repo guard: the leaking nonce is never written again, anywhere in this repository.
 *
 * WHY. The fleet's old signer chose its nonce as mod(z + d, n): the sighash plus
 * the key. The sighash is public, so one signature on the chain gives anyone the
 * key, d = z(1 − s)/(s − r) (MEM:ops_fleet_ecdsa_nonce_leaks_keys.md). The copied
 * fleet test (signature.test.ts, last block) already walks the repository for that
 * line, but it skips every *.test.* file and knows only the bare names (z + d,
 * z + pk …). For the repository that will hold Krog Menjave's keys this guard is
 * stricter:
 *
 *   - it reads test files too: a test helper that signs the old way is one
 *     copy-paste away from the signer;
 *   - it also knows the key reached through an object (kp.d, this.privKey), the
 *     two terms in either order, and the nonce written with % instead of mod();
 *   - the only files allowed to contain the pattern are the tests that NAME it on
 *     purpose (NAMED below): this file, for its fixtures, and signature.test.ts,
 *     which signs the old way with a throwaway key to prove the recovery formula
 *     is real. Each of them must actually be found, so the walk is proven to read
 *     test files, and an allowance can never quietly outlive its reason.
 *
 * It reads the repository around it (up to the nearest package.json), so it holds
 * unchanged when lana-tx/ is copied into krog-menjave/shared/lana-tx.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);

/**
 * The tests that name the pattern on purpose, each with its reason. A new entry is
 * a deliberate act: a test that must build an old-style signature says so here.
 */
const NAMED: Record<string, string> = {
  [path.basename(SELF)]: 'the fixtures that prove the patterns below catch the leak',
  'signature.test.ts': 'signs the old way with a throwaway key, to prove the recovery formula is real',
};

/** The fleet guard's own pattern, verbatim from signature.test.ts, so this guard is never narrower. */
const FLEET = /mod\(\s*(?:z|zInt|zBig|sighash|msgHash|messageHash)\s*\+\s*(?:d|pk|priv|privKey|privateKey)\s*,/;

/** The sighash and the key by the names the fleet's copies used, bare or reached through an object. */
const Z = String.raw`(?:[A-Za-z_$][\w$]*\.)*(?:z|zInt|zBig|zNum|sighash|sigHash|msgHash|messageHash)`;
const D = String.raw`(?:[A-Za-z_$][\w$]*\.)*(?:d|pk|priv|privKey|privateKey|secret|secretKey)`;

const LEAKY: RegExp[] = [
  FLEET,
  new RegExp(String.raw`mod\(\s*${Z}\s*\+\s*${D}\s*,`), // mod(z + kp.d, N)
  new RegExp(String.raw`mod\(\s*${D}\s*\+\s*${Z}\s*,`), // mod(d + z, N)
  new RegExp(String.raw`\(\s*${Z}\s*\+\s*${D}\s*\)\s*%`), // (z + d) % N
  new RegExp(String.raw`\(\s*${D}\s*\+\s*${Z}\s*\)\s*%`), // (d + z) % N
];

const leaks = (text: string) => LEAKY.some((re) => re.test(text));

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', 'coverage']);
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|html)$/;

function repoRoot(): string {
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`no package.json above ${HERE}`);
  }
}

/** Every code file under `dir` (symlinks are not followed), with the first leaking line, if any. */
function scan(dir: string, out: { file: string; line: number; text: string }[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, out);
    } else if (entry.isFile() && CODE.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const re of LEAKY) {
        const m = re.exec(text);
        if (!m) continue;
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ file: full, line, text: text.split('\n')[line - 1].trim() });
        break;
      }
    }
  }
  return out;
}

describe('no file builds the nonce from the sighash plus the key', () => {
  it('the patterns catch every form the fleet’s leaking signers used', () => {
    const leaking = [
      // lana-pays-us server/routes/functions.ts, the live /send-lana signer until ef07a04.
      'const k = Point.mod(z + pk, Point.N);',
      'const k = mod(z + d, N);',
      'const k = mod(zInt + privateKey, CURVE.n);',
      // The way signature.test.ts builds its old-style signature.
      'const k = mod(z + kp.d, N);',
      'const k = mod(this.sighash + this.privKey, n);',
      'const k = mod(d + z, N);',
      'const k = (sighash + privKey) % N;',
      'const k = (secret + messageHash) % n;',
      // Spread over lines, as a formatter would leave it.
      'const k = mod(\n  z +\n    d,\n  N,\n);',
    ];
    for (const line of leaking) assert.ok(leaks(line), `not caught: ${line}`);
    assert.ok(FLEET.test(leaking[0]), 'the fleet pattern itself still catches the live line it was written for');
  });

  it('the patterns leave honest ECDSA arithmetic alone', () => {
    const honest = [
      // s = k⁻¹(z + r·d), the signing equation itself.
      'let s = mod(inv(k, N) * (z + r * kp.d), N);',
      'const s = mod(kInv * (z + r * d), N);',
      // The recovery formula the tests use to look for a leak.
      'const guess = mod(z * (1n - ss) * inv(mod(ss - r, N), N), N);',
      // The prose in signature.ts that describes the old nonce.
      ' * k = (sighash + privateKey) mod n. The sighash is public — anyone can rebuild',
      // Not a nonce at all: the fee formula, and an ordinary sum.
      'const fee = (180n * BigInt(inputs) + 34n * BigInt(outputs) + 10n) * 150n;',
      'const total = mod(data + delta, n);',
    ];
    for (const line of honest) assert.ok(!leaks(line), `false alarm: ${line}`);
  });

  it('only the tests that name it contain it, in the whole repository, test files included', () => {
    const root = repoRoot();
    const hits = scan(root);
    const allowed = new Set(Object.keys(NAMED).map((name) => path.join(HERE, name)));
    const outside = hits.filter((h) => !allowed.has(h.file));
    assert.deepEqual(
      outside.map((h) => `${path.relative(root, h.file)}:${h.line}: ${h.text}`),
      [],
      'the nonce must never come from the sighash and the key. Sign only through lana-tx/signature.ts. ' +
        'A test that has to build an old-style signature on purpose is added to NAMED in ' +
        `${path.relative(root, SELF)}, with its reason.`,
    );
    // The walk really reads test files: each named test is found holding what it names.
    const found = new Set(hits.map((h) => h.file));
    for (const file of allowed) assert.ok(found.has(file), `${path.relative(root, file)} is named but holds no such line`);
  });
});
