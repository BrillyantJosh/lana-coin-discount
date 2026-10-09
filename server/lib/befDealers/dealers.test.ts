// @vitest-environment node
/**
 * THE DEALER RULE, AS BEF EXPLORER READS IT — ported from
 * bef-explorer/server/tests/dealers.test.ts (a7d3702), case for case, onto the
 * database-free readDealers. Nothing here reaches a relay or a website.
 *
 *   shape      of the kind's own rules, only those of KIND 30972 v1.6.0 and
 *              v1.7.0 (BEF's shape tests of 9 Oct 2026, onto checkDealerShape):
 *              content "1.4.0" names a receive wallet per currency — 1 to 20
 *              ISO 4217 codes, each once, in alphabetical order, each to
 *              exactly a LANA address, receive_wallet the default — and
 *              "1.5.0" names a LanaPays.Us payout wallet per currency under
 *              the same shape (payout_wallets required, receive_wallets
 *              optional, payout_wallets[C] or none — never payout_wallet);
 *              both are read, and anything else makes the event invalid, with
 *              a sentence. Without them a firm that names one would drop off
 *              the buying firms;
 *   admission  a key the profile's own website lists for the slug, at least one
 *              of the site's admins a reliable person in KIND 38888 who has
 *              signed a profile of it naming that site (naming a reliable key
 *              is not enough), active, roles stated — and a site that
 *              redirects elsewhere vouches for nothing;
 *   strangers  what anyone can publish decides nothing: no stranger chooses
 *              the sites asked, fills the sites one read may ask, or hides a
 *              dealer's profile under a flood of events;
 *   silence    every read decides anew: a site that does not answer, or a
 *              profile no relay returned, lists nothing that time; only a read
 *              no relay answered decides nothing.
 *
 * What the port changed is pinned too: what a listed dealer carries is its
 * public facts, never a bank account, an owner or a wallet.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { fetchDealerEvents, readDealers, type DealerRead } from './dealers.ts';
import { fetchWellKnown, httpsGet, isPublicAddress, publicLookup, websiteHost, type HttpReply } from './wellKnown.ts';
import {
  checkDealerShape, DEALER_KIND, PAYOUT_WALLET_KEY_REFUSAL, payoutWalletFor, payoutWalletsProblems, READ_CONTENT_VERSIONS,
  RECEIVE_WALLET_KEY_REFUSAL, receiveWalletFor, receiveWalletsProblems, writtenKeysOf,
} from './dealerShape.ts';
import { isLanaAddress } from './lanaAddress.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { signEvent } from '../roundMandateTestKit.js';
import {
  dealerContent, dealerEvent, dealerTags, directory, newIdentity, NOW_MS, NOW_S, systemParams,
  TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_IBAN, TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET, TEST_PAYOUT_WALLET, TEST_RECEIVE_WALLET,
} from './dealerTestKit.ts';

const cleanups: (() => void)[] = [];
afterAll(() => { for (const c of cleanups) c(); });

/** The answer of a read that decided — the tests that expect one fail loudly otherwise. */
function decided(r: DealerRead) {
  if (r.read !== true) throw new Error(`expected a read, got: ${(r as any).skipped}`);
  return r as Extract<DealerRead, { read: true }>;
}

const site = (host: string, slug: string, admins: string[]) => ({ [host]: { dealers: { [slug]: { admins } } } });

/* ── shape: a receive wallet per currency ─────────────────────────────────── */

/** Twenty ISO 4217 codes in alphabetical order — the most receive_wallets may name — and a 21st after them. */
const CODES_20 = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'INR', 'JPY', 'NOK', 'NZD', 'PLN', 'RON', 'SEK', 'USD'];

/** Base58Check of a payload whose first byte is the version byte — to write an address with another version byte. */
function base58Check(payload: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const full = Uint8Array.from([...payload, ...sha256(sha256(payload)).subarray(0, 4)]);
  let n = BigInt('0x' + Buffer.from(full).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

describe('shape: a receive wallet per currency (KIND 30972 content "1.4.0", spec v1.6.0)', () => {
  const key = newIdentity();
  /** The profile a KIND 30972 with this content reads to — refused, the test fails with the reader's sentences. */
  const read = (content: Record<string, unknown>) => {
    const shape = checkDealerShape(dealerEvent(key, 'krog-menjave', content));
    if ('profile' in shape) return shape.profile;
    throw new Error(`refused: ${shape.errors.join(' | ')}`);
  };
  /** The sentences a KIND 30972 whose content is exactly this text (or this object, written as JSON) is refused with. */
  const errorsOf = (content: Record<string, unknown> | string): string[] => {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    const shape = checkDealerShape(signEvent(key, { kind: DEALER_KIND, created_at: NOW_S - 60, tags: dealerTags('krog-menjave', JSON.parse(raw)), content: raw }));
    expect(shape.ok, raw.slice(-300)).toBe(false);
    return 'errors' in shape ? shape.errors : [];
  };
  /** The sentences a "1.4.0" profile (with a default receive wallet) is refused with when its receive_wallets is `value`. */
  const wallets = (value: unknown) => errorsOf(dealerContent({ receiveWallet: TEST_RECEIVE_WALLET, receiveWallets: value }));
  const notCode = /receive_wallets has a key( "[^"]*")? that is not a currency code: each key is an ISO 4217 code, three capital letters \(e\.g\. EUR\)/;

  it('is read — the wallets, the default and the roles — and the one rule picks the wallet of the sale’s currency', () => {
    expect(READ_CONTENT_VERSIONS).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']);
    for (const w of [TEST_EUR_WALLET, TEST_GBP_WALLET]) expect(isLanaAddress(w), w).toBe(true);
    expect(new Set([TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET, TEST_PAYOUT_WALLET]).size).toBe(4);

    // As a writer writes it: "1.4.0" — payout_wallet, receive_wallet (the default), then receive_wallets as the last key.
    const all = dealerContent({ payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET, receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET } });
    expect(all.version).toBe('1.4.0');
    expect(Object.keys(all).slice(-3)).toEqual(['payout_wallet', 'receive_wallet', 'receive_wallets']);
    const p = read(all);
    expect([p.version, p.payoutWallet, p.receiveWallet, p.receiveWallets, p.roles, p.currencies]).toEqual(
      ['1.4.0', TEST_PAYOUT_WALLET, TEST_RECEIVE_WALLET, { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET }, ['sells', 'buys'], ['EUR', 'GBP']],
    );
    // receive_wallets[C], else receive_wallet, else none — and only an exact code finds an entry.
    expect(['EUR', 'GBP', 'USD'].map((c) => receiveWalletFor(p, c))).toEqual([TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET]);
    for (const other of ['eur', 'EUR ', 'constructor', '__proto__', '']) expect(receiveWalletFor(p, other), JSON.stringify(other)).toBe(TEST_RECEIVE_WALLET);

    // Without a default, a currency with no entry has no wallet; the same address may serve several currencies.
    const own = read(dealerContent({ roles: ['buys'], receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_EUR_WALLET } }));
    expect([own.version, own.payoutWallet, own.receiveWallet, own.roles]).toEqual(['1.4.0', null, null, ['buys']]);
    expect(['EUR', 'GBP', 'USD'].map((c) => receiveWalletFor(own, c))).toEqual([TEST_EUR_WALLET, TEST_EUR_WALLET, null]);

    // Twenty currencies is the most, and reads; written with spaces and new lines, it reads the same.
    const twenty = read(dealerContent({ receiveWallets: Object.fromEntries(CODES_20.map((c, i) => [c, i % 2 ? TEST_GBP_WALLET : TEST_EUR_WALLET])) }));
    expect(Object.keys(twenty.receiveWallets)).toEqual(CODES_20);
    const pretty = checkDealerShape(signEvent(key, { kind: DEALER_KIND, created_at: NOW_S - 60, tags: dealerTags('krog-menjave', all), content: JSON.stringify(all, null, 2) }));
    expect('profile' in pretty && pretty.profile.receiveWallets).toEqual({ EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET });

    // Lower versions name no wallet per currency: the one rule gives their receive_wallet, or none.
    const v130 = read(dealerContent({ receiveWallet: TEST_RECEIVE_WALLET }));
    expect([v130.version, v130.receiveWallets, receiveWalletFor(v130, 'GBP')]).toEqual(['1.3.0', null, TEST_RECEIVE_WALLET]);
    const v110 = read(dealerContent());
    expect([v110.version, v110.receiveWallets, receiveWalletFor(v110, 'EUR')]).toEqual(['1.1.0', null, null]);
    // Roles are required in "1.4.0" as in "1.1.0".
    expect(errorsOf(dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET }, roles: null })).join()).toMatch(
      /roles is required in content.version "1\.1\.0", "1\.2\.0", "1\.3\.0", "1\.4\.0" and "1\.5\.0"/,
    );
  });

  it('a code that is not three capital letters makes the event invalid, with a sentence — a long one is never repeated', () => {
    for (const code of ['eur', 'Eur', 'eUR', 'EU', 'EURO', 'E1R', '978', '', ' EUR', 'EUR ']) {
      const errors = wallets({ [code]: TEST_EUR_WALLET });
      expect(errors.some((e) => notCode.test(e)), `${JSON.stringify(code)}: ${JSON.stringify(errors)}`).toBe(true);
    }
    expect(wallets({ eur: TEST_EUR_WALLET })).toContain('receive_wallets has a key "eur" that is not a currency code: each key is an ISO 4217 code, three capital letters (e.g. EUR)');
    // One bad code beside good ones makes the whole event invalid.
    expect(wallets({ EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET, usd: TEST_EUR_WALLET }).join()).toMatch(notCode);
    const hexKey = 'ab'.repeat(32);
    const longKey = wallets({ [hexKey]: TEST_EUR_WALLET });
    expect(longKey.some((e) => notCode.test(e)), JSON.stringify(longKey)).toBe(true);
    expect(JSON.stringify(longKey)).not.toContain(hexKey);
  });

  it('a private key where the address belongs is refused with receive_wallet’s own sentence, once, never repeated', () => {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const shaped of [`T${b58.slice(0, 50)}`, `6${b58.slice(1, 52)}`, 'ab'.repeat(32), `0x${'cd'.repeat(32)}`]) {
      const errors = wallets({ EUR: TEST_EUR_WALLET, GBP: shaped });
      expect(errors).toContain(RECEIVE_WALLET_KEY_REFUSAL);
      expect(JSON.stringify(errors)).not.toContain(shaped);
    }
    expect(wallets({ EUR: 'ab'.repeat(32), GBP: 'cd'.repeat(32) }).filter((e) => e === RECEIVE_WALLET_KEY_REFUSAL)).toHaveLength(1);
  });

  it('a value that is not exactly a LANA address — a checksum that does not hold, another version byte, spaces, another case, not text — is refused, named by its currency', () => {
    const notAddress = /receive_wallets\.GBP must be the address of a LANA wallet: Base58Check with the version byte 0x30/;
    const typo = TEST_GBP_WALLET.slice(0, -1) + (TEST_GBP_WALLET.endsWith('2') ? '3' : '2');
    expect(isLanaAddress(typo)).toBe(false);
    expect(wallets({ EUR: TEST_EUR_WALLET, GBP: typo }).join()).toMatch(notAddress);
    const v31 = base58Check(Uint8Array.from({ length: 21 }, (_, i) => (i === 0 ? 0x31 : i)));
    expect(v31).toHaveLength(34);
    expect(wallets({ GBP: v31 }).join()).toMatch(notAddress);
    for (const value of [` ${TEST_GBP_WALLET}`, `${TEST_GBP_WALLET}\n`, TEST_GBP_WALLET.toLowerCase(), '']) {
      expect(wallets({ GBP: value }).join(), JSON.stringify(value)).toMatch(notAddress);
    }
    for (const value of [12345, null, [TEST_GBP_WALLET], { address: TEST_GBP_WALLET }, true]) {
      expect(wallets({ GBP: value }).join(), JSON.stringify(value)).toMatch(/receive_wallets\.GBP must be text: the address of a LANA wallet/);
    }
  });

  it('not an object, empty, more than 20 currencies, out of order, or a code written twice is refused, with a sentence', () => {
    for (const value of [[TEST_EUR_WALLET], TEST_EUR_WALLET, null, 1]) {
      expect(wallets(value), JSON.stringify(value)).toContain('receive_wallets must be an object: a currency code (ISO 4217, e.g. EUR) to the address of a LANA wallet');
    }
    expect(wallets({})).toContain('receive_wallets is empty: it names at least one currency and its wallet (a profile that names none is not content.version "1.4.0")');
    expect(wallets(Object.fromEntries([...CODES_20, 'ZAR'].map((c) => [c, TEST_EUR_WALLET])))).toContain('receive_wallets names more than 20 currencies: at most 20');

    const order = 'receive_wallets must be written in alphabetical order of the currency codes (e.g. EUR, GBP, USD)';
    expect(wallets({ GBP: TEST_GBP_WALLET, EUR: TEST_EUR_WALLET })).toContain(order);
    expect(wallets({ EUR: TEST_EUR_WALLET, USD: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET })).toContain(order);

    // A code written twice: JSON.parse keeps only the last, so the text itself is read — an escaped one too.
    const sorted = JSON.stringify(dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET } }));
    const twice = sorted.replace(`"EUR":"${TEST_EUR_WALLET}"`, `"EUR":"${TEST_EUR_WALLET}","EUR":"${TEST_GBP_WALLET}"`);
    expect(twice).not.toBe(sorted);
    expect(JSON.parse(twice).receive_wallets).toEqual({ EUR: TEST_GBP_WALLET, GBP: TEST_GBP_WALLET });
    expect(errorsOf(twice)).toContain('receive_wallets names "EUR" twice: each currency at most once');
    const escaped = sorted.replace(`"GBP":"${TEST_GBP_WALLET}"`, `"GBP":"${TEST_GBP_WALLET}","GB\\u0050":"${TEST_GBP_WALLET}"`);
    expect(errorsOf(escaped)).toContain('receive_wallets names "GBP" twice: each currency at most once');
    // receive_wallets itself written twice at the top.
    const twoObjects = sorted.replace('"receive_wallets":', `"receive_wallets":{"USD":"${TEST_EUR_WALLET}"},"receive_wallets":`);
    expect(errorsOf(twoObjects)).toContain('content names receive_wallets twice: it is written once');
    // What the rule reads from the text, alone.
    expect(writtenKeysOf(twice, 'receive_wallets')).toEqual([['EUR', 'EUR', 'GBP']]);
    expect(receiveWalletsProblems({ EUR: TEST_EUR_WALLET }, ['EUR', 'EUR'])).toEqual(['receive_wallets names "EUR" twice: each currency at most once']);
    expect(receiveWalletsProblems({ EUR: TEST_EUR_WALLET, GBP: TEST_EUR_WALLET })).toEqual([]);
  });

  it('missing in "1.4.0", or written in "1.3.0" and lower, makes the event invalid, with a sentence', () => {
    expect(errorsOf(dealerContent({ version: '1.4.0', receiveWallet: TEST_RECEIVE_WALLET })).join()).toMatch(
      /receive_wallets is required in content.version "1\.4\.0": at least one currency and its wallet \(a profile that names none is "1\.3\.0" or lower\)/,
    );
    for (const version of ['1.3.0', '1.2.0', '1.1.0', '1.0.0']) {
      expect(errorsOf(dealerContent({ version, receiveWallets: { EUR: TEST_EUR_WALLET } }))).toContain(
        `content.version "${version}" has no receive_wallets: a profile that names a receive wallet per currency is content.version "1.4.0" (or "1.5.0")`,
      );
    }
    // A version nobody wrote is refused, wallets or not; the default and the payout wallet are still checked in "1.4.0".
    errorsOf(dealerContent({ version: '1.6.0', receiveWallets: { EUR: TEST_EUR_WALLET } }));
    expect(errorsOf(dealerContent({ receiveWallet: TEST_RECEIVE_WALLET.toLowerCase(), receiveWallets: { EUR: TEST_EUR_WALLET } })).join()).toMatch(/receive_wallet must be the address of a LANA wallet/);
    expect(errorsOf(dealerContent({ payoutWallet: TEST_PAYOUT_WALLET.toLowerCase(), receiveWallets: { EUR: TEST_EUR_WALLET } })).join()).toMatch(/payout_wallet must be the address of a LANA wallet/);
    // payout_wallets is a key only "1.5.0" has (spec v1.7.0): in "1.4.0" it gets its own sentence, not "unknown key".
    expect(errorsOf({ ...dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET } }), payout_wallets: { EUR: TEST_PAYOUT_EUR_WALLET } })).toContain(
      'content.version "1.4.0" has no payout_wallets: a profile that names a LanaPays.Us payout wallet per currency is content.version "1.5.0"',
    );
    expect(errorsOf({ ...dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET } }), receive_wallets_gbp: TEST_GBP_WALLET }).join()).toMatch(/unknown key "receive_wallets_gbp"/);
  });
});

/* ── shape: a LanaPays.Us payout wallet per currency ──────────────────────── */

describe('shape: a LanaPays.Us payout wallet per currency (KIND 30972 content "1.5.0", spec v1.7.0)', () => {
  const key = newIdentity();
  /** The profile a KIND 30972 with this content reads to — refused, the test fails with the reader's sentences. */
  const read = (content: Record<string, unknown>) => {
    const shape = checkDealerShape(dealerEvent(key, 'krog-menjave', content));
    if ('profile' in shape) return shape.profile;
    throw new Error(`refused: ${shape.errors.join(' | ')}`);
  };
  /** The sentences a KIND 30972 whose content is exactly this text (or this object, written as JSON) is refused with. */
  const errorsOf = (content: Record<string, unknown> | string): string[] => {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    const shape = checkDealerShape(signEvent(key, { kind: DEALER_KIND, created_at: NOW_S - 60, tags: dealerTags('krog-menjave', JSON.parse(raw)), content: raw }));
    expect(shape.ok, raw.slice(-300)).toBe(false);
    return 'errors' in shape ? shape.errors : [];
  };
  /** The sentences a "1.5.0" profile (with a receive wallet per currency) is refused with when its payout_wallets is `value`. */
  const wallets = (value: unknown) => errorsOf(dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET }, payoutWallets: value }));
  const notCode = /payout_wallets has a key( "[^"]*")? that is not a currency code: each key is an ISO 4217 code, three capital letters \(e\.g\. EUR\)/;

  it('is read — payout_wallets[C] or none, never the old payout_wallet; receive_wallets optional beside it', () => {
    expect(READ_CONTENT_VERSIONS).toContain('1.5.0');
    for (const w of [TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET]) expect(isLanaAddress(w), w).toBe(true);
    expect(new Set([TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET, TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET, TEST_PAYOUT_WALLET]).size).toBe(6);

    // Everything named, as a writer writes it: "1.5.0" — payout_wallet, receive_wallet, receive_wallets, then payout_wallets as the last key.
    const all = dealerContent({
      payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET,
      receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET }, payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET },
    });
    expect(all.version).toBe('1.5.0');
    expect(Object.keys(all).slice(-4)).toEqual(['payout_wallet', 'receive_wallet', 'receive_wallets', 'payout_wallets']);
    const p = read(all);
    expect([p.version, p.payoutWallet, p.receiveWallet, p.receiveWallets, p.payoutWallets, p.roles, p.currencies]).toEqual([
      '1.5.0', TEST_PAYOUT_WALLET, TEST_RECEIVE_WALLET, { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET },
      { EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET }, ['sells', 'buys'], ['EUR', 'GBP'],
    ]);
    // The rule: payout_wallets[C], else none — the old single payout_wallet is read, but is never the wallet for a currency.
    expect(['EUR', 'GBP', 'USD'].map((c) => payoutWalletFor(p, c))).toEqual([TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET, null]);
    for (const other of ['eur', 'EUR ', ' GBP', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) expect(payoutWalletFor(p, other), JSON.stringify(other)).toBe(null);
    // The receive side is untouched by it: receive_wallets[C], else receive_wallet, else none.
    expect(['EUR', 'GBP', 'USD'].map((c) => receiveWalletFor(p, c))).toEqual([TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET]);

    // receive_wallets is optional in "1.5.0": a firm that only sells LANA names payout wallets alone.
    const onlyPayout = dealerContent({ roles: ['sells'], payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET } });
    expect([onlyPayout.version, Object.keys(onlyPayout).at(-1)]).toEqual(['1.5.0', 'payout_wallets']);
    for (const absent of ['payout_wallet', 'receive_wallet', 'receive_wallets']) expect(onlyPayout, absent).not.toHaveProperty(absent);
    const o = read(onlyPayout);
    expect([o.version, o.payoutWallet, o.receiveWallet, o.receiveWallets, o.payoutWallets, o.roles]).toEqual(['1.5.0', null, null, null, { EUR: TEST_PAYOUT_EUR_WALLET }, ['sells']]);
    expect([payoutWalletFor(o, 'EUR'), payoutWalletFor(o, 'GBP'), receiveWalletFor(o, 'EUR')]).toEqual([TEST_PAYOUT_EUR_WALLET, null, null]);
    // …or with only the default receive wallet beside them.
    const withDefault = read(dealerContent({ receiveWallet: TEST_RECEIVE_WALLET, payoutWallets: { GBP: TEST_PAYOUT_GBP_WALLET } }));
    expect([withDefault.version, withDefault.receiveWallet, withDefault.receiveWallets, withDefault.payoutWallets]).toEqual(['1.5.0', TEST_RECEIVE_WALLET, null, { GBP: TEST_PAYOUT_GBP_WALLET }]);
    expect([receiveWalletFor(withDefault, 'GBP'), payoutWalletFor(withDefault, 'GBP'), payoutWalletFor(withDefault, 'EUR')]).toEqual([TEST_RECEIVE_WALLET, TEST_PAYOUT_GBP_WALLET, null]);

    // The shape allows the same address for several currencies (that the Registrar holds it as LanaPays.Us of this Split is the firm's site's to check).
    const shared = read(dealerContent({ payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_EUR_WALLET, USD: TEST_PAYOUT_GBP_WALLET } }));
    expect(['EUR', 'GBP', 'USD', 'CHF'].map((c) => payoutWalletFor(shared, c))).toEqual([TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET, null]);
    // Twenty currencies is the most, and reads; written with spaces and new lines, or with the keys in another order, it reads the same.
    const twenty = read(dealerContent({ payoutWallets: Object.fromEntries(CODES_20.map((c, i) => [c, i % 2 ? TEST_PAYOUT_GBP_WALLET : TEST_PAYOUT_EUR_WALLET])) }));
    expect([Object.keys(twenty.payoutWallets ?? {}), payoutWalletFor(twenty, 'JPY')]).toEqual([CODES_20, TEST_PAYOUT_GBP_WALLET]);
    const { payout_wallets, ...rest } = all;
    expect(read({ payout_wallets, ...rest }).payoutWallets).toEqual({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET });
    const pretty = checkDealerShape(signEvent(key, { kind: DEALER_KIND, created_at: NOW_S - 60, tags: dealerTags('krog-menjave', all), content: JSON.stringify(all, null, 2) }));
    expect('profile' in pretty && pretty.profile.payoutWallets).toEqual({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET });

    // Every lower version reads as before and names no payout wallet per currency: none in every currency, even where payout_wallet is named.
    for (const content of [
      dealerContent({ payoutWallet: TEST_PAYOUT_WALLET, receiveWallets: { EUR: TEST_EUR_WALLET } }),
      dealerContent({ payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET }),
      dealerContent({ payoutWallet: TEST_PAYOUT_WALLET }),
      dealerContent(),
      dealerContent({ version: '1.0.0' }),
    ]) {
      const lower = read(content);
      expect([lower.payoutWallets, ...['EUR', 'GBP', 'USD'].map((c) => payoutWalletFor(lower, c))], lower.version).toEqual([null, null, null, null]);
    }
    // Roles are required in "1.5.0" as in "1.1.0".
    expect(errorsOf(dealerContent({ payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET }, roles: null })).join()).toMatch(
      /roles is required in content.version "1\.1\.0", "1\.2\.0", "1\.3\.0", "1\.4\.0" and "1\.5\.0"/,
    );
  });

  it('missing in "1.5.0" makes the event invalid — the old payout_wallet does not stand in for them', () => {
    const missing = 'payout_wallets is required in content.version "1.5.0": at least one currency and its wallet (a profile that names none is "1.4.0" or lower)';
    expect(errorsOf(dealerContent({ version: '1.5.0', receiveWallets: { EUR: TEST_EUR_WALLET } }))).toContain(missing);
    expect(errorsOf(dealerContent({ version: '1.5.0', payoutWallet: TEST_PAYOUT_WALLET }))).toContain(missing);
    expect(errorsOf(dealerContent({ version: '1.5.0' }))).toContain(missing);
  });

  it('a code that is not three capital letters makes the event invalid, with a sentence — a long one is never repeated', () => {
    for (const code of ['eur', 'Eur', 'EU', 'EURO', 'E1R', '978', '', ' EUR', 'EUR ']) {
      const errors = wallets({ [code]: TEST_PAYOUT_EUR_WALLET });
      expect(errors.some((e) => notCode.test(e)), `${JSON.stringify(code)}: ${JSON.stringify(errors)}`).toBe(true);
    }
    expect(wallets({ eur: TEST_PAYOUT_EUR_WALLET })).toContain('payout_wallets has a key "eur" that is not a currency code: each key is an ISO 4217 code, three capital letters (e.g. EUR)');
    const hexKey = 'ab'.repeat(32);
    const longKey = wallets({ [hexKey]: TEST_PAYOUT_EUR_WALLET });
    expect(longKey.some((e) => notCode.test(e)), JSON.stringify(longKey)).toBe(true);
    expect(JSON.stringify(longKey)).not.toContain(hexKey);
  });

  it('a private key where the address belongs is refused with payout_wallet’s own sentence, once, never repeated', () => {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const shaped of [`T${b58.slice(0, 50)}`, `6${b58.slice(1, 52)}`, 'ab'.repeat(32), `0x${'cd'.repeat(32)}`]) {
      const errors = wallets({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: shaped });
      expect(errors).toContain(PAYOUT_WALLET_KEY_REFUSAL);
      expect(errors, 'the payout side, not the receive side').not.toContain(RECEIVE_WALLET_KEY_REFUSAL);
      expect(JSON.stringify(errors)).not.toContain(shaped);
    }
    expect(wallets({ EUR: 'ab'.repeat(32), GBP: 'cd'.repeat(32) }).filter((e) => e === PAYOUT_WALLET_KEY_REFUSAL)).toHaveLength(1);
  });

  it('a value that is not exactly a LANA address — a checksum that does not hold, another version byte, spaces, another case, not text — is refused, named by its currency', () => {
    const notAddress = /payout_wallets\.GBP must be the address of a LANA wallet: Base58Check with the version byte 0x30/;
    const typo = TEST_PAYOUT_GBP_WALLET.slice(0, -1) + (TEST_PAYOUT_GBP_WALLET.endsWith('2') ? '3' : '2');
    expect(isLanaAddress(typo)).toBe(false);
    expect(wallets({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: typo }).join()).toMatch(notAddress);
    expect(wallets({ GBP: typo }).join(), 'the error names payout_wallets (the receive wallets here are fine)').not.toContain('receive_wallets');
    const v31 = base58Check(Uint8Array.from({ length: 21 }, (_, i) => (i === 0 ? 0x31 : i)));
    expect(wallets({ GBP: v31 }).join()).toMatch(notAddress);
    for (const value of [` ${TEST_PAYOUT_GBP_WALLET}`, `${TEST_PAYOUT_GBP_WALLET}\n`, TEST_PAYOUT_GBP_WALLET.toLowerCase(), '']) {
      expect(wallets({ GBP: value }).join(), JSON.stringify(value)).toMatch(notAddress);
    }
    for (const value of [12345, null, [TEST_PAYOUT_GBP_WALLET], { address: TEST_PAYOUT_GBP_WALLET }, true]) {
      expect(wallets({ GBP: value }).join(), JSON.stringify(value)).toMatch(/payout_wallets\.GBP must be text: the address of a LANA wallet/);
    }
  });

  it('not an object, empty, more than 20 currencies, out of order, or a code written twice is refused, with a sentence', () => {
    for (const value of [[TEST_PAYOUT_EUR_WALLET], TEST_PAYOUT_EUR_WALLET, null, 1]) {
      expect(wallets(value), JSON.stringify(value)).toContain('payout_wallets must be an object: a currency code (ISO 4217, e.g. EUR) to the address of a LANA wallet');
    }
    expect(wallets({})).toContain('payout_wallets is empty: it names at least one currency and its wallet (a profile that names none is not content.version "1.5.0")');
    expect(wallets(Object.fromEntries([...CODES_20, 'ZAR'].map((c) => [c, TEST_PAYOUT_EUR_WALLET])))).toContain('payout_wallets names more than 20 currencies: at most 20');

    const order = 'payout_wallets must be written in alphabetical order of the currency codes (e.g. EUR, GBP, USD)';
    expect(wallets({ GBP: TEST_PAYOUT_GBP_WALLET, EUR: TEST_PAYOUT_EUR_WALLET })).toContain(order);
    expect(wallets({ EUR: TEST_PAYOUT_EUR_WALLET, USD: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET })).toContain(order);

    // A code written twice: JSON.parse keeps only the last, so the text itself is read — an escaped one too.
    const sorted = JSON.stringify(dealerContent({ payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET } }));
    const twice = sorted.replace(`"EUR":"${TEST_PAYOUT_EUR_WALLET}"`, `"EUR":"${TEST_PAYOUT_EUR_WALLET}","EUR":"${TEST_PAYOUT_GBP_WALLET}"`);
    expect(twice).not.toBe(sorted);
    expect(JSON.parse(twice).payout_wallets).toEqual({ EUR: TEST_PAYOUT_GBP_WALLET, GBP: TEST_PAYOUT_GBP_WALLET });
    expect(errorsOf(twice)).toContain('payout_wallets names "EUR" twice: each currency at most once');
    const escaped = sorted.replace(`"GBP":"${TEST_PAYOUT_GBP_WALLET}"`, `"GBP":"${TEST_PAYOUT_GBP_WALLET}","GB\\u0050":"${TEST_PAYOUT_GBP_WALLET}"`);
    expect(errorsOf(escaped)).toContain('payout_wallets names "GBP" twice: each currency at most once');
    // payout_wallets itself written twice at the top.
    const twoObjects = sorted.replace('"payout_wallets":', `"payout_wallets":{"USD":"${TEST_PAYOUT_EUR_WALLET}"},"payout_wallets":`);
    expect(JSON.parse(twoObjects).payout_wallets).toEqual({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET });
    expect(errorsOf(twoObjects)).toContain('content names payout_wallets twice: it is written once');
    // What the rule reads from the text, alone — by the same reader as receive_wallets.
    const raw = `{"receive_wallets":{"EUR":"a"},"payout_wallets":{"EUR":"x","GBP":"y","E\\u0055R":"z"}}`;
    expect([writtenKeysOf(raw, 'payout_wallets'), writtenKeysOf(raw, 'receive_wallets')]).toEqual([[['EUR', 'GBP', 'EUR']], [['EUR']]]);
    expect(writtenKeysOf('{"payout_wallet":"a","version":"1.5.0"}', 'payout_wallets')).toEqual([]);
    expect(payoutWalletsProblems({ EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_EUR_WALLET })).toEqual([]);
    expect(payoutWalletsProblems({ EUR: TEST_PAYOUT_EUR_WALLET }, ['EUR', 'EUR'])).toEqual(['payout_wallets names "EUR" twice: each currency at most once']);
    expect(payoutWalletsProblems({ EUR: 'ab'.repeat(32) })).toEqual([PAYOUT_WALLET_KEY_REFUSAL]);
    // The receive side's sentences stay its own.
    expect(receiveWalletsProblems({ EUR: 'ab'.repeat(32) })).toEqual([RECEIVE_WALLET_KEY_REFUSAL]);
    expect(receiveWalletsProblems({})).toEqual(['receive_wallets is empty: it names at least one currency and its wallet (a profile that names none is not content.version "1.4.0")']);
  });

  it('written in "1.4.0" and lower, or under a version nobody wrote, makes the event invalid — and every other wallet is still checked in "1.5.0"', () => {
    for (const version of ['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']) {
      const errors = errorsOf(dealerContent({ version, receiveWallets: version === '1.4.0' ? { EUR: TEST_EUR_WALLET } : undefined, payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET } }));
      expect(errors).toContain(`content.version "${version}" has no payout_wallets: a profile that names a LanaPays.Us payout wallet per currency is content.version "1.5.0"`);
    }
    errorsOf(dealerContent({ version: '1.6.0', payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET } }));
    // The "(or …)" sentences of the older wallets name "1.5.0" too.
    expect(errorsOf({ ...dealerContent(), payout_wallet: TEST_PAYOUT_WALLET }).join()).toMatch(
      /has no payout_wallet: a profile that names a payout wallet is content.version "1\.2\.0" \(or "1\.3\.0", "1\.4\.0" or "1\.5\.0"\)/,
    );
    expect(errorsOf({ ...dealerContent({ payoutWallet: TEST_PAYOUT_WALLET }), receive_wallet: TEST_RECEIVE_WALLET }).join()).toMatch(
      /content.version "1\.2\.0" has no receive_wallet: a profile that names a receive wallet is content.version "1\.3\.0" \(or "1\.4\.0" or "1\.5\.0"\)/,
    );

    const good = { EUR: TEST_PAYOUT_EUR_WALLET };
    expect(errorsOf(dealerContent({ receiveWallets: {}, payoutWallets: good }))).toContain(
      'receive_wallets is empty: it names at least one currency and its wallet (a profile that names none is not content.version "1.4.0")',
    );
    expect(errorsOf(dealerContent({ receiveWallets: { GBP: TEST_GBP_WALLET, EUR: TEST_EUR_WALLET }, payoutWallets: good }))).toContain(
      'receive_wallets must be written in alphabetical order of the currency codes (e.g. EUR, GBP, USD)',
    );
    expect(errorsOf(dealerContent({ receiveWallets: { EUR: 'ab'.repeat(32) }, payoutWallets: good }))).toContain(RECEIVE_WALLET_KEY_REFUSAL);
    const receiveTwice = JSON.stringify(dealerContent({ receiveWallets: { EUR: TEST_EUR_WALLET }, payoutWallets: good }))
      .replace('"receive_wallets":', `"receive_wallets":{"USD":"${TEST_EUR_WALLET}"},"receive_wallets":`);
    expect(errorsOf(receiveTwice)).toContain('content names receive_wallets twice: it is written once');
    expect(errorsOf(dealerContent({ receiveWallet: TEST_RECEIVE_WALLET.toLowerCase(), payoutWallets: good })).join()).toMatch(/receive_wallet must be the address of a LANA wallet/);
    expect(errorsOf(dealerContent({ payoutWallet: TEST_PAYOUT_WALLET.toLowerCase(), payoutWallets: good })).join()).toMatch(/payout_wallet must be the address of a LANA wallet/);
    expect(errorsOf({ ...dealerContent({ payoutWallets: good }), payout_wallets_gbp: TEST_PAYOUT_GBP_WALLET }).join()).toMatch(/unknown key "payout_wallets_gbp"/);
  });
});

/* ── admission ────────────────────────────────────────────────────────────── */

describe('admission', () => {
  it('listed when the site lists the author for the slug and one of its admins is reliable — public facts only', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const event = dealerEvent(owner, 'krog-menjave', dealerContent());
    decided(await dir.read([event], site('krogmenjave.test', 'krog-menjave', [owner.hex])));
    const [dealer] = dir.listed();
    expect(dealer).toMatchObject({
      host: 'krogmenjave.test', slug: 'krog-menjave', name: 'Krog menjave d.o.o.', website: 'https://krogmenjave.test/',
      roles: ['sells', 'buys'], admins: [owner.hex], eventId: event.id, pubkey: owner.hex, signedAt: NOW_S - 3600, contentVersion: '1.1.0',
    });
    const text = JSON.stringify(dir.listed());
    for (const secret of [TEST_IBAN.EUR, TEST_IBAN.GBP, 'e'.repeat(64), 'd'.repeat(64), 'Ana Novak', '+386', 'SI12345678', '1234567000', 'Dunajska']) {
      expect(text, `${secret} is not a public fact a dealer is listed by`).not.toContain(secret);
    }
  });

  it('the newest edit may be any admin’s, once the reliable admin has signed a version naming the site', async () => {
    const brilly = newIdentity();
    const reliable = newIdentity();
    const dir = directory([reliable.hex]);
    const files = site('krogmenjave.test', 'krog-menjave', [brilly.hex, reliable.hex]);
    const signedOnce = dealerEvent(reliable, 'krog-menjave', dealerContent({ name: 'Krog menjave (first version)' }), { at: NOW_S - 7200 });
    const brillysEdit = dealerEvent(brilly, 'krog-menjave', dealerContent({ roles: ['sells'] }), { at: NOW_S - 3600 });
    const filters: any[] = [];
    await dir.read([signedOnce, brillysEdit], files, { filters });
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect([dir.listed()[0].name, dir.listed()[0].roles]).toEqual(['Krog menjave d.o.o.', ['sells']]);
    // Asked by key: first the reliable people, then the admins the site lists, for its slug.
    expect(filters).toEqual([{ authors: [reliable.hex] }, { authors: [brilly.hex, reliable.hex], d: ['krog-menjave'] }]);
    // A newer edit that retires the firm is read too, and takes it off the list.
    const r = decided(await dir.read([signedOnce, dealerEvent(brilly, 'krog-menjave', dealerContent({ status: 'retired' }), { at: NOW_S - 60 })], files));
    expect(dir.listedKeys()).toEqual([]);
    expect(r.removed[0].reason).toMatch(/retired/);
  });

  it('a site that only NAMES a reliable person is not listed — a stranger who copies a reliable key into his own dealer file gets nothing', async () => {
    const reliable = newIdentity();
    const stranger = newIdentity();
    const dir = directory([reliable.hex]);
    const forged = dealerEvent(stranger, 'krog-menjave', dealerContent({ host: 'evil.test' }), { at: NOW_S - 10 });
    const evil = site('evil.test', 'krog-menjave', [stranger.hex, reliable.hex]);
    let asked: string[] = [];
    await dir.read([forged], evil, { asked });
    expect(dir.listedKeys()).toEqual([]);
    expect(asked, 'no reliable person signed a profile naming evil.test, so it is not even asked').toEqual([]);
    // Even when the relays hand over everything, evil.test vouches for nothing.
    const real = dealerEvent(reliable, 'krog-menjave', dealerContent(), { at: NOW_S - 3600 });
    const both = { ...evil, ...site('krogmenjave.test', 'krog-menjave', [reliable.hex]) };
    asked = [];
    await dir.read([forged, real], both, { asked, liar: true });
    expect(asked).toEqual(['krogmenjave.test']);
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect(dir.listed()[0].eventId).toBe(real.id);
    // A forged copy that claims the reliable key but does not verify names no site either.
    const claimed = { ...dealerEvent(stranger, 'krog-menjave', dealerContent({ host: 'evil.test' }), { at: NOW_S - 5 }), pubkey: reliable.hex };
    asked = [];
    await dir.read([claimed, real], both, { asked, liar: true });
    expect(asked).toEqual(['krogmenjave.test']);
    // And when evil.test IS asked (a reliable person's profile once named it), naming the key still lists nothing.
    const once = dealerEvent(reliable, 'other-firm', dealerContent({ host: 'evil.test', name: 'Other firm' }), { at: NOW_S - 100 });
    const r = decided(await dir.read([forged, once, real], both, { liar: true }));
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect(r.notListed.find((n) => n.dealer === 'evil.test/other-firm')!.reason).toMatch(/does not list "other-firm"/);
  });

  it('not listed when no admin of the site is a reliable person', async () => {
    const owner = newIdentity();
    const reliable = newIdentity();
    const dir = directory([reliable.hex]);
    const asked: string[] = [];
    await dir.read([dealerEvent(owner, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'krog-menjave', [owner.hex]), { asked });
    expect([dir.listedKeys(), asked]).toEqual([[], []]);
    // A reliable person signed for it, but the site does not list that person.
    const r = decided(await dir.read([dealerEvent(reliable, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'krog-menjave', [owner.hex])));
    expect(dir.listedKeys()).toEqual([]);
    expect(r.notListed.find((n) => n.dealer === 'krogmenjave.test/krog-menjave')!.reason).toMatch(/reliable person/);
  });

  it('not listed when the site does not list the author — a forger cannot vouch for himself', async () => {
    const owner = newIdentity();
    const forger = newIdentity();
    const dir = directory([owner.hex, forger.hex]);
    const forged = dealerEvent(forger, 'krog-menjave', dealerContent({ name: 'Krog menjave (forged)' }), { at: NOW_S - 10 });
    const r = decided(await dir.read([forged], site('krogmenjave.test', 'krog-menjave', [owner.hex])));
    expect(dir.listedKeys()).toEqual([]);
    expect(r.notListed[0].reason).toMatch(/no valid profile signed by a key krogmenjave\.test lists/);
    await dir.read([forged, dealerEvent(owner, 'krog-menjave', dealerContent(), { at: NOW_S - 7200 })], site('krogmenjave.test', 'krog-menjave', [owner.hex]));
    expect(dir.listed().map((d) => d.name)).toEqual(['Krog menjave d.o.o.']);
    // A site that does not list the slug at all.
    const other = directory([owner.hex]);
    const r2 = decided(await other.read([dealerEvent(owner, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'ravena-plus', [owner.hex])));
    expect(other.listedKeys()).toEqual([]);
    expect(r2.notListed[0].reason).toMatch(/does not list "krog-menjave"/);
  });

  it('a site that redirects to another host vouches for nothing', async () => {
    const owner = newIdentity();
    const file = Buffer.from(JSON.stringify({ dealers: { 'krog-menjave': { admins: [owner.hex] } } }));
    const asked: string[] = [];
    const get = async (url: string): Promise<HttpReply> => {
      asked.push(url);
      if (url.startsWith('https://krogmenjave.test/')) return { status: 302, location: 'https://evil.test/.well-known/bef-dealer.json', body: null, tooLarge: false };
      return { status: 200, location: null, body: file, tooLarge: false };
    };
    const r = decided(await readDealers(systemParams([owner.hex]), [], {
      fetchEvents: async (_relays, filter) => ({
        events: [dealerEvent(owner, 'krog-menjave', dealerContent())].filter((e) => filter.authors.includes(e.pubkey)),
        relaysAsked: 2,
        relaysAnswered: 2,
      }),
      fetchWellKnown: (host) => fetchWellKnown(host, get),
      now: () => NOW_MS,
    }));
    expect(r.listed).toEqual([]);
    expect(asked, 'the other host is never asked').toEqual(['https://krogmenjave.test/.well-known/bef-dealer.json']);
    expect(r.notListed[0].reason).toMatch(/redirects to another host/);
  });

  it('a retired firm, and one whose profile does not state its roles, are not listed', async () => {
    const owner = newIdentity();
    const files = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    const retired = directory([owner.hex]);
    const r1 = decided(await retired.read([dealerEvent(owner, 'krog-menjave', dealerContent({ status: 'retired' }))], files));
    expect(retired.listedKeys()).toEqual([]);
    expect(r1.notListed[0].reason).toMatch(/retired/);

    const unstated = directory([owner.hex]);
    const r2 = decided(await unstated.read([dealerEvent(owner, 'krog-menjave', dealerContent({ version: '1.0.0' }))], files));
    expect(unstated.listedKeys()).toEqual([]);
    expect(r2.notListed[0].reason).toMatch(/does not say whether it buys or sells/);

    // Listed first; a newer profile that retires the firm removes it — an answer, not a silence.
    const dir = directory([owner.hex]);
    const first = dealerEvent(owner, 'krog-menjave', dealerContent(), { at: NOW_S - 7200 });
    await dir.read([first], files);
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    const r3 = decided(await dir.read([first, dealerEvent(owner, 'krog-menjave', dealerContent({ status: 'retired' }), { at: NOW_S - 60 })], files));
    expect(dir.listedKeys()).toEqual([]);
    expect(r3.removed[0].reason).toMatch(/retired/);
    // And a newer active one brings it back.
    await dir.read([dealerEvent(owner, 'krog-menjave', dealerContent(), { at: NOW_S - 30 })], files);
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
  });

  it('the newest valid profile wins; one dated over 15 minutes ahead, an invalid one and a bad signature are ignored', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const files = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    const older = dealerEvent(owner, 'krog-menjave', dealerContent({ name: 'Older name', roles: ['sells'] }), { at: NOW_S - 7200 });
    const newer = dealerEvent(owner, 'krog-menjave', dealerContent({ name: 'Newer name', roles: ['buys'] }), { at: NOW_S - 3600 });
    const future = dealerEvent(owner, 'krog-menjave', dealerContent({ name: 'From the future' }), { at: NOW_S + 16 * 60 });
    const broken = dealerEvent(owner, 'krog-menjave', { ...dealerContent({ name: 'Broken' }), version: '9.9.9' }, { at: NOW_S - 10 });
    const forgedSig = { ...dealerEvent(owner, 'krog-menjave', dealerContent({ name: 'Bad signature' }), { at: NOW_S - 5 }), sig: '0'.repeat(128) };
    await dir.read([older, future, broken, forgedSig, newer], files);
    const [dealer] = dir.listed();
    expect(dealer.name).toBe('Newer name');
    expect(dealer.roles).toEqual(['buys']);
    expect(dealer.eventId).toBe(newer.id);
  });

  it('a newest profile of 1.2.0 or 1.3.0 (payout / receive wallet named) stays listed — the wallets are read, not kept', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const files = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    const v120 = dealerEvent(owner, 'krog-menjave', dealerContent({ name: 'Krog menjave (1.2.0)', payoutWallet: TEST_PAYOUT_WALLET }), { at: NOW_S - 7200 });
    await dir.read([v120], files);
    expect(dir.listed().map((d) => d.contentVersion)).toEqual(['1.2.0']);
    const v130 = dealerEvent(owner, 'krog-menjave', dealerContent({ payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET }), { at: NOW_S - 60 });
    const r = decided(await dir.read([v120, v130], files));
    expect(r.removed).toEqual([]);
    expect(dir.listed().map((d) => [d.eventId, d.contentVersion, d.name])).toEqual([[v130.id, '1.3.0', 'Krog menjave d.o.o.']]);
    const text = JSON.stringify(dir.listed());
    expect(text).not.toContain(TEST_PAYOUT_WALLET);
    expect(text).not.toContain(TEST_RECEIVE_WALLET);
  });

  it('a newest profile of 1.4.0 (a receive wallet per currency, spec v1.6.0) stays listed — the wallets are read, not kept', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const files = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    const v130 = dealerEvent(
      owner, 'krog-menjave',
      dealerContent({ name: 'Krog menjave (1.3.0)', payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET }),
      { at: NOW_S - 7200 },
    );
    await dir.read([v130], files);
    expect(dir.listed().map((d) => d.contentVersion)).toEqual(['1.3.0']);
    // The admin names a wallet per currency at the firm's own /admin: the next version is "1.4.0".
    const v140 = dealerEvent(
      owner, 'krog-menjave',
      dealerContent({ payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET, receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET } }),
      { at: NOW_S - 60 },
    );
    const r = decided(await dir.read([v130, v140], files));
    expect(r.removed).toEqual([]);
    expect(dir.listed().map((d) => [d.eventId, d.contentVersion, d.name, d.roles])).toEqual([[v140.id, '1.4.0', 'Krog menjave d.o.o.', ['sells', 'buys']]]);
    const wallets = [TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET, TEST_PAYOUT_WALLET];
    const text = JSON.stringify(dir.listed());
    for (const w of wallets) expect(text, 'a listed dealer carries no wallet').not.toContain(w);

    // A firm whose only profile is "1.4.0" — wallets per currency only, no default, no payout wallet — is listed from the start.
    const fresh = directory([owner.hex]);
    await fresh.read([dealerEvent(owner, 'krog-menjave', dealerContent({ roles: ['buys'], receiveWallets: { EUR: TEST_EUR_WALLET } }))], files);
    expect(fresh.listed().map((d) => `${d.host}/${d.slug}:${d.contentVersion}:${d.roles}`)).toEqual(['krogmenjave.test/krog-menjave:1.4.0:buys']);

    // A newer profile whose receive_wallets breaks a rule — out of order, empty, a lower-case code, or the key in
    // "1.3.0" — is invalid: it is dropped as if never sent, and the 1.4.0 profile stands.
    const broken = [
      dealerContent({ name: 'Broken', receiveWallets: { GBP: TEST_GBP_WALLET, EUR: TEST_EUR_WALLET } }),
      dealerContent({ name: 'Broken', receiveWallets: {} }),
      dealerContent({ name: 'Broken', receiveWallets: { eur: TEST_EUR_WALLET } }),
      dealerContent({ name: 'Broken', version: '1.3.0', receiveWallet: TEST_RECEIVE_WALLET, receiveWallets: { EUR: TEST_EUR_WALLET } }),
    ].map((content, i) => dealerEvent(owner, 'krog-menjave', content, { at: NOW_S - 30 + i }));
    for (const event of broken) expect(checkDealerShape(event).ok).toBe(false);
    const again = decided(await dir.read([v130, v140, ...broken], files));
    expect(again.removed).toEqual([]);
    expect(dir.listed().map((d) => [d.eventId, d.contentVersion, d.name])).toEqual([[v140.id, '1.4.0', 'Krog menjave d.o.o.']]);
  });

  it('a newest profile of 1.5.0 (a LanaPays.Us payout wallet per currency, spec v1.7.0) stays listed — the wallets are read, not kept', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const files = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    const v140 = dealerEvent(
      owner, 'krog-menjave',
      dealerContent({ name: 'Krog menjave (1.4.0)', payoutWallet: TEST_PAYOUT_WALLET, receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET } }),
      { at: NOW_S - 7200 },
    );
    await dir.read([v140], files);
    expect(dir.listed().map((d) => d.contentVersion)).toEqual(['1.4.0']);
    // The admin names a LanaPays.Us payout wallet per currency at the firm's own /admin: the next version is "1.5.0".
    const v150 = dealerEvent(
      owner, 'krog-menjave',
      dealerContent({
        payoutWallet: TEST_PAYOUT_WALLET, receiveWallet: TEST_RECEIVE_WALLET,
        receiveWallets: { EUR: TEST_EUR_WALLET, GBP: TEST_GBP_WALLET }, payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET, GBP: TEST_PAYOUT_GBP_WALLET },
      }),
      { at: NOW_S - 60 },
    );
    expect(JSON.parse(v150.content).version).toBe('1.5.0');
    const r = decided(await dir.read([v140, v150], files));
    expect(r.removed).toEqual([]);
    expect(dir.listed().map((d) => [d.eventId, d.contentVersion, d.name, d.roles])).toEqual([[v150.id, '1.5.0', 'Krog menjave d.o.o.', ['sells', 'buys']]]);
    const wallets = [TEST_PAYOUT_EUR_WALLET, TEST_PAYOUT_GBP_WALLET, TEST_EUR_WALLET, TEST_GBP_WALLET, TEST_RECEIVE_WALLET, TEST_PAYOUT_WALLET];
    const text = JSON.stringify(dir.listed());
    for (const w of wallets) expect(text, 'a listed dealer carries no wallet').not.toContain(w);
    expect(text).not.toContain('payoutWallets');

    // A firm whose only profile is "1.5.0" — payout wallets per currency only, no receive wallet — is listed from the start.
    const fresh = directory([owner.hex]);
    await fresh.read([dealerEvent(owner, 'krog-menjave', dealerContent({ roles: ['sells'], payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET } }))], files);
    expect(fresh.listed().map((d) => `${d.host}/${d.slug}:${d.contentVersion}:${d.roles}`)).toEqual(['krogmenjave.test/krog-menjave:1.5.0:sells']);

    // A newer profile whose payout_wallets breaks a rule — missing in "1.5.0", out of order, empty, a key where an
    // address belongs, or the key in "1.4.0" — is invalid: it is dropped as if never sent, and the 1.5.0 profile stands.
    const broken = [
      dealerContent({ name: 'Broken', version: '1.5.0', receiveWallets: { EUR: TEST_EUR_WALLET } }),
      dealerContent({ name: 'Broken', payoutWallets: { GBP: TEST_PAYOUT_GBP_WALLET, EUR: TEST_PAYOUT_EUR_WALLET } }),
      dealerContent({ name: 'Broken', payoutWallets: {} }),
      dealerContent({ name: 'Broken', payoutWallets: { EUR: 'ab'.repeat(32) } }),
      dealerContent({ name: 'Broken', version: '1.4.0', receiveWallets: { EUR: TEST_EUR_WALLET }, payoutWallets: { EUR: TEST_PAYOUT_EUR_WALLET } }),
    ].map((content, i) => dealerEvent(owner, 'krog-menjave', content, { at: NOW_S - 30 + i }));
    for (const event of broken) expect(checkDealerShape(event).ok).toBe(false);
    const again = decided(await dir.read([v140, v150, ...broken], files));
    expect(again.removed).toEqual([]);
    expect(dir.listed().map((d) => [d.eventId, d.contentVersion, d.name])).toEqual([[v150.id, '1.5.0', 'Krog menjave d.o.o.']]);
  });

  it('a profile names no website, or one the reader may not ask — nothing to admit it', async () => {
    expect(websiteHost('https://krogmenjave.com/o-nas')).toBe('krogmenjave.com');
    expect(websiteHost('https://WWW.Krogmenjave.com')).toBe('www.krogmenjave.com');
    expect(websiteHost('https://krogmenjave.com:443/')).toBe('krogmenjave.com');
    for (const bad of [null, '', 'http://krogmenjave.com', 'https://krogmenjave.com:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'not a url']) {
      expect(websiteHost(bad), String(bad)).toBeNull();
    }
    // A website on another port is not listed, even when port 443 of that host vouches for it.
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const asked: string[] = [];
    const r = decided(await dir.read(
      [dealerEvent(owner, 'krog-menjave', dealerContent({ website: 'https://krogmenjave.test:8443/' }))],
      site('krogmenjave.test', 'krog-menjave', [owner.hex]),
      { asked },
    ));
    expect([dir.listedKeys(), asked]).toEqual([[], []]);
    expect(r.notListed[0].reason).toMatch(/no https website on the default port/);
  });
});

/* ── strangers ────────────────────────────────────────────────────────────── */

describe('strangers', () => {
  it('profiles anyone publishes cannot fill the sites one read asks — the real dealer is still asked and listed', async () => {
    const reliable = newIdentity();
    const stranger = newIdentity();
    const dir = directory([reliable.hex]);
    const junk = Array.from({ length: 60 }, (_, i) => dealerEvent(stranger, `junk-${i}`, dealerContent({ host: `h${i}.junk.test` }), { at: NOW_S - 10 + (i % 5) }));
    const real = dealerEvent(reliable, 'krog-menjave', dealerContent(), { at: NOW_S - 3600 });
    for (const liar of [false, true]) {
      const asked: string[] = [];
      await dir.read([...junk, real], site('krogmenjave.test', 'krog-menjave', [reliable.hex]), { asked, liar });
      expect(asked, `liar relays: ${liar}`).toEqual(['krogmenjave.test']);
      expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    }
  });

  it('a stranger’s own profile, on his own site that lists him, is never listed', async () => {
    const reliable = newIdentity();
    const stranger = newIdentity();
    const dir = directory([reliable.hex]);
    const asked: string[] = [];
    const r = decided(await dir.read(
      [dealerEvent(stranger, 'buyer-of-lana', dealerContent({ host: 'stranger.test', name: 'Buyer of LANA d.o.o.', roles: ['buys'] }))],
      site('stranger.test', 'buyer-of-lana', [stranger.hex]),
      { asked, liar: true },
    ));
    expect(r.listed).toEqual([]);
    expect(asked).toEqual([]);
  });
});

/* ── silence ──────────────────────────────────────────────────────────────── */

describe('silence', () => {
  it('a read no relay answered decides nothing; a site that does not answer, or a profile no relay returned, lists nothing that time', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    const event = dealerEvent(owner, 'krog-menjave', dealerContent());
    const listsOwner = site('krogmenjave.test', 'krog-menjave', [owner.hex]);
    await dir.read([event], listsOwner);
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);

    // 1. No relay answers: no read — the last list is kept, marked stale.
    const later = NOW_MS + 10 * 60 * 1000;
    const r1 = await dir.read([], listsOwner, { relaysAnswered: 0, nowMs: later });
    expect(r1.read).toBe(false);
    expect((r1 as any).skipped).toBe('the relays did not answer');
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect(dir.isStale()).toBe(true);

    // 2. The relays answer without the event: not listed this time.
    const r2 = decided(await dir.read([], listsOwner, { nowMs: later + 1000 }));
    expect(dir.listedKeys()).toEqual([]);
    expect(r2.removed[0].reason).toMatch(/came back from the relays/);
    // Back on the relays: listed again.
    await dir.read([event], listsOwner, { nowMs: later + 2000 });
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect(dir.isStale()).toBe(false);

    // 3. The site is down, or answers with an error page: not listed this time (fail-closed).
    const r4 = decided(await dir.read([event], {}, { nowMs: later + 3000 }));
    expect(dir.listedKeys()).toEqual([]);
    expect(r4.removed[0].reason).toMatch(/krogmenjave\.test did not answer/);
    const r5 = decided(await dir.read([event], { 'krogmenjave.test': { down: 'HTTP 503' } }, { nowMs: later + 4000 }));
    expect(r5.notListed[0].reason).toMatch(/HTTP 503/);
    await dir.read([event], listsOwner, { nowMs: later + 5000 });
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);

    // 4. The site answers and no longer lists the key (it lists another reliable person now): removed.
    const other = newIdentity();
    dir.setReliable([owner.hex, other.hex]);
    const r6 = decided(await dir.read([event], site('krogmenjave.test', 'krog-menjave', [other.hex])));
    expect(dir.listedKeys()).toEqual([]);
    expect(r6.removed[0].reason).toMatch(/no longer lists the key/);
  });

  it('a silence does not shield a dealer from the reliable list — a KIND 38888 without its admins removes it', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    await dir.read([dealerEvent(owner, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'krog-menjave', [owner.hex]));
    dir.setReliable([newIdentity().hex]);
    const r = await dir.read([], {}, { relaysAnswered: 0 });
    expect(r.read).toBe(false);
    expect(dir.listedKeys()).toEqual([]);
    expect(r.removed[0].reason).toMatch(/reliable person/);
  });

  it('with no verified KIND 38888 nothing is decided and nothing is removed — and no relay is asked', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    await dir.read([dealerEvent(owner, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'krog-menjave', [owner.hex]));
    dir.forgetParams();
    const filters: any[] = [];
    const r = await dir.read([], {}, { filters });
    expect(r.read).toBe(false);
    expect((r as any).skipped).toBe('no KIND 38888 is stored yet');
    expect(filters).toEqual([]);
    expect(dir.listedKeys()).toEqual(['krogmenjave.test/krog-menjave']);
    expect(dir.isStale()).toBe(true);
  });

  it('a signed KIND 38888 that names no reliable person is an answer: nobody is listed', async () => {
    const owner = newIdentity();
    const dir = directory([owner.hex]);
    await dir.read([dealerEvent(owner, 'krog-menjave', dealerContent())], site('krogmenjave.test', 'krog-menjave', [owner.hex]));
    dir.setReliable([]);
    const r = decided(await dir.read([], {}));
    expect(r.listed).toEqual([]);
    expect(r.removed[0].reason).toMatch(/names no reliable person/);
  });
});

/* ── the well-known file over HTTP ───────────────────────────────────────── */

describe('the dealer file', () => {
  it('only a well-formed file is an answer; a redirect is followed only on the same host over https', async () => {
    const hex = 'a'.repeat(64);
    const file = Buffer.from(JSON.stringify({ dealers: { 'krog-menjave': { admins: [hex, 'NOT-HEX'], name: 'Krog' }, 'Bad Slug': { admins: [hex] } } }));
    const reply = (status: number, extra: Partial<HttpReply> = {}): HttpReply => ({ status, location: null, body: null, tooLarge: false, ...extra });
    const ok = await fetchWellKnown('krogmenjave.test', async () => reply(200, { body: file }));
    expect(ok.answered).toBe(true);
    expect((ok as any).read.dealers).toEqual([{ d: 'krog-menjave', admins: [hex] }]);

    const hops: string[] = [];
    const sameHost = await fetchWellKnown('krogmenjave.test', async (url) => {
      hops.push(url);
      return hops.length === 1 ? reply(301, { location: '/.well-known/bef-dealer.json?v=2' }) : reply(200, { body: file });
    });
    expect(sameHost.answered).toBe(true);
    expect(hops).toEqual(['https://krogmenjave.test/.well-known/bef-dealer.json', 'https://krogmenjave.test/.well-known/bef-dealer.json?v=2']);

    const refused = async (get: (url: string) => Promise<HttpReply>, pattern: RegExp) => {
      const answer = await fetchWellKnown('krogmenjave.test', get);
      expect(answer.answered).toBe(false);
      expect((answer as any).reason).toMatch(pattern);
    };
    await refused(async () => reply(302, { location: 'https://www.krogmenjave.test/.well-known/bef-dealer.json' }), /another host/);
    await refused(async () => reply(302, { location: 'http://krogmenjave.test/.well-known/bef-dealer.json' }), /another host/);
    await refused(async () => reply(302, { location: 'https://krogmenjave.test:8443/.well-known/bef-dealer.json' }), /another host/);
    await refused(async () => reply(302, { location: '/again' }), /too many redirects/);
    await refused(async () => reply(404), /HTTP 404/);
    await refused(async () => reply(200, { body: Buffer.from('<!doctype html><title>Home</title>') }), /not JSON/);
    await refused(async () => reply(200, { body: Buffer.from('{"name":"not a dealer file"}') }), /not a dealer file/);
    await refused(async () => reply(200, { tooLarge: true }), /larger than/);
    await refused(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, /unreachable \(ECONNREFUSED\)/);
    expect(await fetchWellKnown('127.0.0.1', async () => reply(200, { body: file }))).toEqual({ answered: false, reason: 'not a host name' });
  });

  it('only public addresses are asked — a name that resolves into a private network is refused before connecting', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['204.168.131.108', '46.225.70.103', '1.1.1.1', '2a01:4f8::1', '::ffff:1.1.1.1']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    const refused = await new Promise<NodeJS.ErrnoException | null>((resolve) => publicLookup('localhost', {}, (err) => resolve(err)));
    expect(refused?.code).toBe('ENOTPUBLIC');
  });

  it('the HTTP client never follows a redirect itself and stops at the size limit', async () => {
    let hits = 0;
    const server: Server = createServer((req, res) => {
      hits++;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(200_000));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"dealers":{}}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const { request } = await import('node:http');
    const plainLookup = (_host: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, '127.0.0.1', 4);
    const local = { protocol: 'http:' as const, port, request, lookup: plainLookup as any };
    const redirect = await httpsGet('https://127.0.0.1/redirect', local);
    expect([redirect.status, redirect.location, redirect.body]).toEqual([302, 'http://127.0.0.1:1/elsewhere', null]);
    expect(hits, 'the redirect was not followed').toBe(1);
    const big = await httpsGet('https://127.0.0.1/big', { ...local, maxBytes: 64 * 1024 });
    expect(big.tooLarge).toBe(true);
    const small = await httpsGet('https://127.0.0.1/ok', local);
    expect(small.body?.toString()).toBe('{"dealers":{}}');
  });
});

/* ── the relays ───────────────────────────────────────────────────────────── */

describe('the relays', () => {
  it('KIND 30972 of the keys asked is read page by page from each relay; a relay that never finishes is not an answer', async () => {
    const owner = newIdentity();
    const events = Array.from({ length: 5 }, (_, i) => dealerEvent(owner, `firm-${i}`, dealerContent({ name: `Firm ${i}` }), { at: NOW_S - 1000 + i }));
    const filters: any[] = [];
    const answering = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => {
      for (const s of [answering, silent]) {
        for (const c of s.clients) c.terminate();
        s.close();
      }
    });
    await Promise.all([answering, silent].map((s) => new Promise<void>((resolve) => s.on('listening', () => resolve()))));
    answering.on('connection', (socket: WebSocket) => {
      socket.on('message', (data) => {
        const [type, sub, filter] = JSON.parse(String(data));
        if (type !== 'REQ') return;
        filters.push(filter);
        // A relay that caps every page at 2 events, newest first, `until` inclusive.
        const page = events
          .filter((e) => filter.until === undefined || e.created_at <= filter.until)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 2);
        for (const e of page) socket.send(JSON.stringify(['EVENT', sub, e]));
        socket.send(JSON.stringify(['EOSE', sub]));
      });
    });
    const url = (s: WebSocketServer) => `ws://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const answer = await fetchDealerEvents([url(answering), url(silent)], { authors: [owner.hex] }, 1500);
    expect(answer.relaysAsked).toBe(2);
    expect(answer.relaysAnswered).toBe(1);
    expect(answer.events.map((e) => e.tags[0][1]).sort()).toEqual(['firm-0', 'firm-1', 'firm-2', 'firm-3', 'firm-4']);
    expect(filters[0]).toEqual({ kinds: [30972], authors: [owner.hex], limit: 500 });
    expect(filters.length >= 3 && filters.slice(1).every((f) => typeof f.until === 'number')).toBe(true);
    filters.length = 0;
    await fetchDealerEvents([url(answering)], { authors: [owner.hex], d: ['firm-1'] }, 1500);
    expect(filters[0]).toEqual({ kinds: [30972], authors: [owner.hex], limit: 500, '#d': ['firm-1'] });
  });

  it('a flood of events in one second does not hide an older profile, even from a relay that ignores the keys asked', async () => {
    const owner = newIdentity();
    const stranger = newIdentity();
    const real = dealerEvent(owner, 'krog-menjave', dealerContent(), { at: NOW_S - 60 });
    const junk = Array.from({ length: 600 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'), pubkey: stranger.hex, created_at: NOW_S, kind: 30972, tags: [['d', `junk-${i}`]], content: '{}', sig: '0'.repeat(128),
    }));
    const hugeJunk = junk.map((e, i) => ({ ...e, id: (i + 1000).toString(16).padStart(64, 'f'), created_at: NOW_S - 1, content: 'x'.repeat(17 * 1024) }));
    const huge = hugeJunk[0];
    const all = [...junk, ...hugeJunk, real];
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => {
      for (const c of relay.clients) c.terminate();
      relay.close();
    });
    await new Promise<void>((resolve) => relay.on('listening', () => resolve()));
    let reqs = 0;
    relay.on('connection', (socket: WebSocket) => {
      socket.on('message', (data) => {
        const [type, sub, filter] = JSON.parse(String(data));
        if (type !== 'REQ') return;
        reqs++;
        const page = all
          .filter((e) => filter.until === undefined || e.created_at <= filter.until)
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
          .slice(0, 500);
        for (const e of page) socket.send(JSON.stringify(['EVENT', sub, e]));
        socket.send(JSON.stringify(['EOSE', sub]));
      });
    });
    const answer = await fetchDealerEvents([`ws://127.0.0.1:${(relay.address() as AddressInfo).port}`], { authors: [owner.hex] }, 3000);
    expect(answer.events.some((e) => e.id === real.id), 'the real profile is read').toBe(true);
    expect(answer.events.some((e) => e.id === huge.id), 'a frame larger than a profile can be is not kept').toBe(false);
    expect(reqs).toBeLessThanOrEqual(10);
  });
});
