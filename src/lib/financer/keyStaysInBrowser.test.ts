// @vitest-environment node
/**
 * The financer's wallet key stays in the browser.
 *
 * Brilly's decision of 8. 10. 2026: the financer signs the LANA of their
 * purchases in the browser, with the WIF of their own Lana.Discount wallet, and
 * the key never reaches lana.discount — the server receives a signed
 * transaction, public the moment it is sent, and checks it on the chain.
 *
 * Krog Menjave holds the same rule for its payout wallet in
 * server/tests/keyStaysInBrowser.test.ts (origin/main a46f618); its checks of
 * the module that reads and signs (src/lib/payoutKey.ts) come here unchanged,
 * and its page-wide rules are applied to this site's page code:
 *   - one module reads a LANA wallet key for the financer: payoutKey.ts. The
 *     page imports payoutKey, never the key reader (wif.ts) itself;
 *   - that module talks to nothing, stores nothing, logs nothing; every key it
 *     reads is wiped — the check at once, the signature in a `finally`;
 *   - no line of the page code that sends, stores or logs names key material;
 *   - run: the key signs a send the server's own check accepts at the brain's
 *     exact amounts, only what is public comes back, and every copy of the key
 *     that reading it made is zeros once signing is over.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Encode } from './wif.ts';
import { checkPayoutKey, signPayoutWithKey } from './payoutKey.ts';
import { checkOwnSend, coinsOf, planOfPrepared, type PreparedSend } from './payoutView.ts';
import { decodedCopies, wiped } from '../../test/decodedCopies.ts';
import { bytesToHex } from '../../../server/shared/lana-tx/bytes.ts';
import { LANA, listedCoins, NOW_SEC, throwawayAddress, throwawayWallet } from '../../../server/shared/lana-tx/fixtures/wallets.ts';
import { verifyTxSignedBy } from '../../../server/shared/lana-tx/verify.ts';

// Signing with two libraries' checks, in both key forms, while the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 });

const src = fileURLToPath(new URL('../../', import.meta.url));
const rel = (file: string) => relative(join(src, '..'), file);

/** Every page source file under `dir`: code that ships, not the tests and their helpers. */
function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (full !== join(src, 'test')) files(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name) && !/ 2\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** An import of the financer's key reader, however it is spelled: './wif.ts', '@/lib/financer/wif', a dynamic import. */
const IMPORTS_KEY_READER = /(?:from\s+|import\(\s*)['"][^'"]*\/wif(?:\.(?:ts|js))?['"]/;
const SECRET = /wif|privateKey|private_key|nsec|secret|decoded\b/i;
const TALKS = /fetch\(|localStorage|sessionStorage|indexedDB|document\.cookie|console\.|sendBeacon|XMLHttpRequest|WebSocket/;

describe('the financer’s key: read, used and wiped in one module', () => {
  it('only src/lib/financer/payoutKey.ts imports the key reader; the page signs through it', () => {
    const users = files(src).filter((file) => IMPORTS_KEY_READER.test(readFileSync(file, 'utf8'))).map(rel).sort();
    expect(users).toEqual(['src/lib/financer/payoutKey.ts']);
  });

  it('payoutKey.ts talks to nothing, stores and logs nothing; both reads of a key are wiped; it returns nothing of the key', () => {
    const signer = readFileSync(join(src, 'lib', 'financer', 'payoutKey.ts'), 'utf8');
    expect(signer).not.toMatch(TALKS);
    // Two reads of a key, each wiped: the check at once, the signature in a finally — signed, refused or failed.
    expect([...signer.matchAll(/decodeWif\(/g)]).toHaveLength(2);
    expect(signer).toMatch(/const decoded = decodeWif\(input\);\s*if \(decoded\.ok === false\) return \{ state: decoded\.reason \};\s*wipe\(decoded\.privateKey\);/);
    expect(signer).toMatch(/\} finally \{\s*wipe\(decoded\.privateKey\);\s*\}/);
    // Only a key that opens exactly the financer's wallet signs; what comes back is public.
    expect(signer).toMatch(/if \(decoded\.address !== payout\.from\) return \{ ok: false, check: \{ state: 'other', opens: decoded\.address \} \};/);
    expect(signer).not.toMatch(/return \{[^}]*privateKey/);
  });

  it('payoutView.ts (the plan the page shows) holds no key and asks nothing', () => {
    const view = readFileSync(join(src, 'lib', 'financer', 'payoutView.ts'), 'utf8');
    expect(view).not.toMatch(TALKS);
    expect(view).not.toMatch(/decodeWif|privateKey|schnorr/);
    expect(view).not.toMatch(IMPORTS_KEY_READER);
  });

  it('no line of the page code that sends, stores or logs names key material', () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          const sends = /fetch\(|body:|JSON\.stringify\(|setItem\(|console\.|sendBeacon|XMLHttpRequest|WebSocket/.test(code);
          if (sends && SECRET.test(code)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

/* ── run ──────────────────────────────────────────────────────────────────── */

const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
/** A LanaCoin WIF (version 0xB0), compressed (T…) or not (6…), as a wallet prints it. */
function wifOf(privateKey: Uint8Array, compressed: boolean): string {
  const body = Buffer.concat([Buffer.from([0xb0]), Buffer.from(privateKey), compressed ? Buffer.from([0x01]) : Buffer.alloc(0)]);
  return base58Encode(Buffer.concat([body, sha(sha(body)).subarray(0, 4)]));
}

describe('the key module, run', () => {
  it('the key signs a send the server’s check accepts at the brain’s exact amounts; the other form, an address, a Nostr key, a typo — named, nothing signed; every copy of the key is zeros after', async () => {
    for (const compressed of [true, false]) {
      const wallet = throwawayWallet(compressed);
      const other = throwawayWallet(!compressed, wallet.privateKey);
      const wif = wifOf(wallet.privateKey, compressed);
      const otherWif = wifOf(wallet.privateKey, !compressed);
      const [buyer, caretaker] = [throwawayAddress(), throwawayAddress()];
      // As the server's prepare answers it (JSON: lanoshis as strings), real legs of 8. 10. 2026.
      const prepared: PreparedSend = {
        wallet: wallet.address,
        coins: listedCoins(wallet.address, [100n * LANA, 3n * LANA], NOW_SEC - 3600).map((c) => ({ ...c, value: c.value.toString() })),
        allocations: [
          { wallet: buyer, lanoshis: '1004492188', orderIds: ['leg-1', 'leg-3'] },
          { wallet: caretaker, lanoshis: '3446289063', orderIds: ['leg-2'] },
        ],
        nowSec: NOW_SEC,
      };
      const coins = coinsOf(prepared);
      if (!coins.ok) throw new Error('coins');
      const planned = planOfPrepared(prepared, coins.coins, NOW_SEC);
      if (planned.ok === false) throw new Error(json(planned.problem));
      const payout = { from: wallet.address, pay: planned.plan.pay, coins: planned.plan.coins, nowSec: NOW_SEC };

      // Checked as typed: its own form opens the wallet; the other form of the same secret opens another, named.
      expect(checkPayoutKey(wif, wallet.address)).toEqual({ state: 'opens' });
      expect(checkPayoutKey(otherWif, wallet.address)).toEqual({ state: 'other', opens: other.address });
      expect(checkPayoutKey('', wallet.address)).toEqual({ state: 'empty' });
      expect(checkPayoutKey(wallet.address, wallet.address)).toEqual({ state: 'address' });
      expect(checkPayoutKey('ab'.repeat(32), wallet.address)).toEqual({ state: 'hex' });
      const typo = wif.slice(0, 10) + (wif[10] === 'z' ? 'y' : 'z') + wif.slice(11);
      expect(['checksum', 'notAKey']).toContain(checkPayoutKey(typo, wallet.address).state);

      // Signed: every copy reading the key made is zeros once signing is over (the finally), and only what is public comes back.
      const { result, copies } = decodedCopies(() => signPayoutWithKey(` ${wif}\n`, payout));
      const signed = await result;
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.every(wiped)).toBe(true);
      expect(Object.keys(signed).sort()).toEqual(['change', 'fee', 'nTime', 'ok', 'rawTx', 'txid']);
      const text = json(signed);
      expect(text).not.toContain(bytesToHex(wallet.privateKey));
      expect(text).not.toContain(wif);
      expect(signed.nTime).toBe(NOW_SEC);

      // The bytes verify by the wallet's key, and the server's own rule (step 1, the legs as allocated) takes them.
      expect(verifyTxSignedBy(signed.rawTx, planned.plan.coins, wallet.address)).toEqual([]);
      const checked = checkOwnSend(signed.rawTx, prepared, planned.plan.coins, NOW_SEC);
      expect(checked.ok && checked.txid).toBe(signed.txid);

      // Refused, nothing signed: the other form, an address, a Nostr key.
      expect(await signPayoutWithKey(otherWif, payout)).toEqual({ ok: false, check: { state: 'other', opens: other.address } });
      expect(await signPayoutWithKey(wallet.address, payout)).toEqual({ ok: false, check: { state: 'address' } });
      expect(await signPayoutWithKey(`npub1${'q'.repeat(58)}`, payout)).toEqual({ ok: false, check: { state: 'npub' } });
    }
  });

  it('a refused key is wiped too: the key of another wallet leaves no copy behind', async () => {
    const wallet = throwawayWallet(true);
    const stranger = throwawayWallet(true);
    const prepared: PreparedSend = {
      wallet: wallet.address,
      coins: listedCoins(wallet.address, [20n * LANA], NOW_SEC - 3600).map((c) => ({ ...c, value: c.value.toString() })),
      allocations: [{ wallet: throwawayAddress(), lanoshis: '1004492188', orderIds: ['leg-1'] }],
      nowSec: NOW_SEC,
    };
    const coins = coinsOf(prepared);
    if (!coins.ok) throw new Error('coins');
    const planned = planOfPrepared(prepared, coins.coins, NOW_SEC);
    if (planned.ok === false) throw new Error(json(planned.problem));
    const { result, copies } = decodedCopies(() =>
      signPayoutWithKey(wifOf(stranger.privateKey, true), { from: wallet.address, pay: planned.plan.pay, coins: planned.plan.coins, nowSec: NOW_SEC }),
    );
    expect(await result).toEqual({ ok: false, check: { state: 'other', opens: stranger.address } });
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every(wiped)).toBe(true);
  });
});
