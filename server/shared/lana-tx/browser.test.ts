// @vitest-environment node
/**
 * The payout is signed in the admin's browser, so the library must build for
 * the browser: Vite bundles it here exactly as it bundles the site (a client
 * build, the packages' "browser" fields honoured), and the bundle must need
 * nothing of Node. elliptic's helpers ask for Node's crypto and buffer inside a
 * try (brorand, bn.js); their "browser" fields map both to nothing, and the
 * bundle takes randomness from the page's own crypto. Any warning, any Node
 * module or require() left in the output, and this fails.
 *
 * Built on 6. 10. 2026 and also run once in a real Chromium: a throwaway payout
 * wallet planned, signed and verified two payouts of five outputs (both key
 * forms) in the page, with no errors.
 *
 * lana.discount (8. 10. 2026): the same build, with the page's own glue added —
 * src/lib/financer/payoutKey.ts (reads the financer's WIF, signs, wipes) and
 * payoutView.ts (the payout planned from the server's answer) — since that is
 * what the /financer page actually loads. Built without this repository's
 * vite.config.ts, as in Krog Menjave: that config adds only the React plugin,
 * the dev proxy and the "@" alias, none of which this path may need, and it has
 * no Node polyfills either, so what passes here is what the site bundles.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build, createLogger, type Rollup } from 'vite';

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

describe('shared/lana-tx builds for the browser', () => {
  it('Vite bundles the payout path without a warning, a Node module or a require()', async () => {
    const warnings: string[] = [];
    const logger = createLogger('silent');
    logger.warn = (msg) => void warnings.push(msg);
    logger.warnOnce = (msg) => void warnings.push(msg);
    logger.error = (msg) => void warnings.push(msg);
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      customLogger: logger,
      build: {
        write: false,
        minify: false,
        lib: {
          entry: {
            payout: here('./payout.ts'),
            verify: here('./verify.ts'),
            select: here('./select.ts'),
            payments: here('./payments.ts'),
            codec: here('./codec.ts'),
            payoutKey: here('../../../src/lib/financer/payoutKey.ts'),
            payoutView: here('../../../src/lib/financer/payoutView.ts'),
          },
          formats: ['es'],
        },
      },
    })) as Rollup.RollupOutput[] | Rollup.RollupOutput;
    assert.deepEqual(warnings, []);
    const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).filter((c): c is Rollup.OutputChunk => c.type === 'chunk');
    assert.ok(chunks.some((c) => c.name === 'payout'), 'the payout entry is built');
    assert.ok(chunks.some((c) => c.name === 'payoutKey') && chunks.some((c) => c.name === 'payoutView'), 'the /financer glue is built');
    const code = chunks.map((c) => c.code).join('\n');
    assert.ok(code.includes('signAsync'), 'the signer is in the bundle');
    const names = new Set(chunks.map((c) => c.fileName));
    for (const c of chunks) {
      const outside = [...c.imports, ...c.dynamicImports].filter((i) => !names.has(i));
      assert.deepEqual(outside, [], `${c.fileName} imports from outside the bundle`);
    }
    assert.ok(!/\brequire\s*\(/.test(code), 'no require() is left');
    assert.ok(!/from\s*["']node:|import\(\s*["']node:/.test(code), 'no node: module is imported');
  });
});
