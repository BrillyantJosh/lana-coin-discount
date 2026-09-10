import { describe, it, expect } from 'vitest';
import {
  lanapaysOnlyEnabled,
  acquiringFromClass,
  LANAPAYS_ONLY_KEY,
  NOT_ACQUIRING_CODE,
  NOT_ACQUIRING_MESSAGE,
} from './acquisitionScope.js';
import { classifyWallet } from './sellerEligibility.js';
import { OFFER } from '../../src/copy.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('reading the switch', () => {
  it('is OFF for a key nobody has written', () => {
    // The safe state for an unwritten setting is "carry on as before". If this
    // ever flips, a fresh database silently stops acquiring from most people.
    for (const raw of [undefined, null, '', '   ']) expect(lanapaysOnlyEnabled(raw)).toBe(false);
  });

  it('is OFF for anything it does not recognise, including "0" and "false"', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'maybe', 'null']) {
      expect(lanapaysOnlyEnabled(raw), raw).toBe(false);
    }
  });

  it('is ON for the ways a checkbox and a human write it', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      expect(lanapaysOnlyEnabled(raw), raw).toBe(true);
    }
  });
});

describe('who the treasury is acquiring from', () => {
  it('changes nothing at all while the switch is off', () => {
    expect(acquiringFromClass('lanapays', false)).toBe(true);
    expect(acquiringFromClass('other', false)).toBe(true);
    expect(acquiringFromClass(null, false)).toBe(true);
  });

  it('keeps LanaPays.Us open and pauses the rest', () => {
    expect(acquiringFromClass('lanapays', true)).toBe(true);
    expect(acquiringFromClass('other', true)).toBe(false);
  });

  it('treats a class it cannot name as paused — being in scope must be positive', () => {
    expect(acquiringFromClass(null, true)).toBe(false);
    expect(acquiringFromClass(undefined, true)).toBe(false);
  });

  it('agrees with how the registrar types are classified, sub-types included', () => {
    // The registrar issues sub-types like "LanaPays.Us Investors". A sub-type
    // must not be paused by being unlisted.
    for (const t of ['LanaPays.Us', 'lanapays.us', 'LanaPays.Us Investors']) {
      expect(acquiringFromClass(classifyWallet(t), true), t).toBe(true);
    }
    for (const t of ['Main Wallet', 'Wallet', 'Retail', null]) {
      expect(acquiringFromClass(classifyWallet(t), true), String(t)).toBe(false);
    }
  });
});

describe('what the seller is told', () => {
  it('says it is us, not them — never claims a freeze, a fault or a sanction', () => {
    const words = `${NOT_ACQUIRING_MESSAGE} ${OFFER.walletNotAcquiringBody}`.toLowerCase();
    // Not the WORD freeze — the seller-facing copy says "this is not a freeze"
    // on purpose, because that is the thing they will otherwise assume. What
    // must never appear is a claim that one stands.
    for (const bad of ['is frozen', 'wallet is blocked', 'denied', 'not allowed', 'violation', 'suspended']) {
      expect(words, bad).not.toContain(bad);
    }
    expect(words).toContain('at the moment');
    expect(words).toContain('lanapays.us');
    expect(OFFER.walletNotAcquiringBody.toLowerCase()).toContain('not a freeze');
    expect(OFFER.walletNotAcquiringBody.toLowerCase()).toContain('nothing is wrong');
  });

  it('keeps one settings key and one refusal code, so nothing drifts', () => {
    expect(LANAPAYS_ONLY_KEY).toBe('acq_lanapays_only');
    expect(NOT_ACQUIRING_CODE).toBe('WALLET_CLASS_NOT_ACQUIRED');
  });
});

/**
 * The gate and the page must not be able to disagree.
 *
 * This is the exact bug that shipped on 9.9.2026 in the freeze work: the server
 * allowed a wallet, the offer page had its own opinion and greyed it out, and
 * the seller was sent to a door that did not open. The fix was to compute it
 * once on the server and let the page read the answer — and the only way to keep
 * it fixed is to assert that neither side grows a second opinion.
 *
 * It reads the source, because a behavioural test cannot see a NEW rule quietly
 * added in the browser.
 */
describe('the page and the gate answer with the same function', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

  it('the wallet list computes `acquiring` with acquiringFromClass', () => {
    const api = read('server/routes/api.ts');
    expect(api).toContain('acquiring: acquiringFromClass(');
  });

  it('the gate refuses with the same function and the shared code', () => {
    const gate = read('server/lib/sellerEligibility.ts');
    expect(gate).toContain('acquiringFromClass(walletClass');
    expect(gate).toContain('NOT_ACQUIRING_CODE');
  });

  it('the offer page decides nothing itself — it only reads what the server said', () => {
    const page = read('src/pages/SubmitOffer.tsx');
    expect(page).toContain('w.acquiring === false');
    // An absent field means acquiring, so an older server can never make the
    // page grey out a wallet the gate would have allowed.
    expect(page).not.toMatch(/acquiring\s*!==\s*true/);
    expect(page).not.toMatch(/walletType\s*===\s*['"`]Main Wallet/);
  });

  it('the switch is written in exactly one place, and read from settings', () => {
    const treasury = read('server/routes/treasury.ts');
    expect(treasury).toContain('setAppSetting(LANAPAYS_ONLY_KEY');
    expect((treasury.match(/setAppSetting\(LANAPAYS_ONLY_KEY/g) || []).length).toBe(1);
  });

  it('saving round dates alone cannot switch the treasury\'s scope by accident', () => {
    const treasury = read('server/routes/treasury.ts');
    expect(treasury).toContain("hasOwnProperty.call(req.body ?? {}, 'lanapaysOnly')");
  });
});
