// @vitest-environment node
/**
 * lana-tx/signature.ts is the fleet's nonce-safe signer, copied byte for byte.
 *
 * WHY A PIN. Until 24 Sep 2026 the fleet's hand-written ECDSA chose its nonce as
 * k = (sighash + key) mod n, so every signature it put on the chain gave the
 * signer's private key away to anyone who cared to do one line of algebra
 * (MEM:ops_fleet_ecdsa_nonce_leaks_keys.md). The repair is one small module,
 * written once and checked in ten repositories. km-signer signs with exactly that
 * module and with nothing it wrote itself. A copy that drifts is a new signer
 * nobody reviewed, so the bytes are pinned: any change to signature.ts, however
 * small, fails here, and whoever changes it has to come here and say why.
 *
 * Origin: lana-pays-us server/services/lanaSignature.ts at ef07a04 ("Stop leaking
 * the payer's private key in every /send-lana signature"), the commit that fixed
 * the live /send-lana signer. Its tests came along as signature.test.ts with one
 * change only, the import path. That is pinned too: undo that one change and the
 * bytes must be the origin's, so no copied test can be quietly loosened.
 *
 * This directory is later copied byte for byte into krog-menjave/shared/lana-tx
 * (spec §5.10). These tests read only the files next to them, the nearest
 * package.json and the installed libraries, so they hold unchanged there.
 *
 * lana.discount (8. 10. 2026) copied it again, from krog-menjave origin/main
 * a46f618, into server/shared/lana-tx: the financer signs the LANA of a purchase
 * in the browser with these very bytes (Brilly's decision of 8. 10. 2026: signed
 * in the browser, the key never reaches lana.discount). This repository runs its
 * tests with vitest, not node:test, so every copied test changed its runner
 * import, and took vitest's node environment and a long time limit on top
 * (node:test has none). Those lines are undone here before
 * the hash, like the import path: the origin's assertions stay pinned, byte for
 * byte. Two checks are this repository's own (at the bottom): package.json names
 * the two libraries EXACTLY, and package-lock.json agrees — the Docker image is
 * built with `npm ci`, and a "^3.0.0" there is one `npm install` away from another
 * signer.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data: Uint8Array | string) => crypto.createHash('sha256').update(data).digest('hex');

/** Where the module and its tests come from (git blobs 5477ead7… and fec54ffc…). */
const ORIGIN = {
  repo: 'lana-pays-us',
  commit: 'ef07a04346547f8db61efb2f62a82a2e6c6a58ce',
  module: 'server/services/lanaSignature.ts',
  tests: 'server/services/lanaSignature.test.ts',
};

/** sha256 of signature.ts, the raw bytes, exactly as `git show <commit>:<module>` prints them. */
const SIGNATURE_TS_SHA256 = '254a03f1bef7f12051bdc1d34ee84160ec6b1c7ea0720508adab6fb2eb24f71d';

/** sha256 of the origin's test file, which signature.test.ts must turn back into. */
const ORIGIN_TESTS_SHA256 = 'defc86812ca3dfa37c6ed82a2f088cb8b21ae90c317a66c3703ed194d46b417f';
const ORIGIN_IMPORT = "from './lanaSignature.js';";
const COPY_IMPORT = "from './signature.js';";
/**
 * The origin's first line, and what it is in this repository: vitest's node environment, vitest's describe/it, and
 * node:test's absent time limit as a long one (the same five lines head every test copied into this directory).
 */
const ORIGIN_RUNNER = "import { describe, it } from 'node:test';\n";
const COPY_RUNNER = [
  '// @vitest-environment node',
  "import { describe, it, vi } from 'vitest';",
  "// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over",
  '// thousands of cases while the whole suite runs at once.',
  'vi.setConfig({ testTimeout: 120_000 });',
  '',
].join('\n');

/**
 * The library versions the origin's lockfile resolved at ef07a04, the ones its
 * tests ran against when the fix went live. Another version is another signer as
 * far as this pin is concerned: change it here, on purpose, and run every test.
 */
const LIBRARIES: Record<string, string> = { '@noble/secp256k1': '3.0.0', elliptic: '6.6.1' };

function read(name: string): string {
  return fs.readFileSync(path.join(HERE, name), 'utf8');
}

function nearestPackageJson(): string {
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`no package.json above ${HERE}`);
  }
}

describe(`signature.ts is ${ORIGIN.repo} ${ORIGIN.module} @${ORIGIN.commit.slice(0, 7)}, byte for byte`, () => {
  it('the bytes of signature.ts hash to the pinned sha256', () => {
    // Raw bytes, no newline or encoding normalisation: a changed line ending is a change.
    const bytes = fs.readFileSync(path.join(HERE, 'signature.ts'));
    assert.equal(
      sha256(bytes),
      SIGNATURE_TS_SHA256,
      `lana-tx/signature.ts is no longer the fleet's signer from ${ORIGIN.repo}@${ORIGIN.commit}. ` +
        'Restore it with `git show ' + `${ORIGIN.commit}:${ORIGIN.module}` + '` instead of editing it.',
    );
  });

  it('signature.test.ts is the origin tests with only the import path and the test runner changed', () => {
    const copy = read('signature.test.ts');
    assert.equal(copy.split(COPY_IMPORT).length - 1, 1, `exactly one import ${COPY_IMPORT}`);
    assert.ok(copy.startsWith(COPY_RUNNER), 'the runner lines, at the very top and nowhere else');
    assert.equal(copy.split(COPY_RUNNER).length - 1, 1);
    assert.ok(!copy.includes('lanaSignature'), 'no leftover reference to the origin file name');
    assert.equal(
      sha256(copy.replace(COPY_RUNNER, ORIGIN_RUNNER).replace(COPY_IMPORT, ORIGIN_IMPORT)),
      ORIGIN_TESTS_SHA256,
      `signature.test.ts differs from ${ORIGIN.repo}@${ORIGIN.commit.slice(0, 7)}:${ORIGIN.tests} by more than its import path and its runner`,
    );
  });

  it('what the pinned bytes say is the fleet pattern, so a new pin cannot quietly weaken it', () => {
    // Redundant while the hash holds. It is here for the day someone updates the
    // hash: these are the lines that must survive any update.
    const src = read('signature.ts');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['@noble/secp256k1', 'elliptic'], 'it imports the two libraries and nothing else');
    assert.equal([...src.matchAll(/\bsign(?:Async)?\(/g)].length, 1, 'one signing call, no other');
    assert.match(src, /await secp\.signAsync\(sighash, secret, \{ prehash: false, lowS: true, extraEntropy: true \}\);/);
    assert.match(src, /secp\.verify\(compact, sighash, publicKey, \{ prehash: false, lowS: true \}\)/);
    assert.match(src, /ec\.keyFromPublic\(toHex\(publicKey\), 'hex'\)\.verify\(toHex\(sighash\), Array\.from\(der\)\)/);
    assert.match(src, /s > N \/ 2n\) throw/, 'a high-S signature is refused, never emitted');
  });

  it(`the installed libraries are the ones it was verified with: ${Object.entries(LIBRARIES).map(([n, v]) => `${n} ${v}`).join(', ')}`, () => {
    const requireHere = createRequire(import.meta.url);
    for (const [name, version] of Object.entries(LIBRARIES)) {
      const pkg = JSON.parse(fs.readFileSync(requireHere.resolve(`${name}/package.json`), 'utf8')) as { version: string };
      assert.equal(pkg.version, version, `${name} resolves to ${pkg.version}, the pin is ${version}`);
    }
  });

  it('both libraries are runtime dependencies of the package these files live in', () => {
    // A devDependency would be missing from a production install, and the signer
    // would then fail at the first signature instead of at boot.
    const own = JSON.parse(fs.readFileSync(nearestPackageJson(), 'utf8')) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(LIBRARIES)) {
      assert.ok(own.dependencies?.[name], `${name} must be in "dependencies" of ${nearestPackageJson()}`);
    }
  });

  it('lana.discount: package.json names both libraries exactly, and package-lock.json resolves them so for `npm ci`', () => {
    // The two above read what is installed HERE. The image is built elsewhere, by `npm ci` from the lockfile, which
    // refuses a lockfile that disagrees with package.json: so both must say the pinned version, not a range.
    const pkgPath = nearestPackageJson();
    const own = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgPath), 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    for (const [name, version] of Object.entries(LIBRARIES)) {
      assert.equal(own.dependencies?.[name], version, `package.json: "${name}": "${version}", exactly — no ^ or ~`);
      assert.equal(lock.packages['']?.dependencies?.[name], version, `package-lock.json: the root names ${name} ${version}`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `package-lock.json: node_modules/${name} is ${version}`);
    }
  });
});
