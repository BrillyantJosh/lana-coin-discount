/**
 * THE MANDATE MUST BE ABLE TO SAY NO.
 *
 * That is the whole point of this module, and the property most easily lost:
 * a mandate wired so that every path ends in 'accept' looks compliant in a
 * screenshot and is worth nothing, because the framework's own test (§15) asks
 * whether we are buying because WE want the asset — and a buyer that never
 * declines is not choosing.
 *
 * So these tests spend most of their weight on the refusals and on the exact
 * meaning of an unset field, since "no ceiling" and "no automatic acceptance"
 * are both spelled with an empty-ish value and mean opposite things.
 */
import { describe, it, expect } from 'vitest';
import {
  decideAcquisition,
  readMandateSettings,
  defaultMandateRows,
  DEFAULT_DUE_DAYS,
  DEFAULT_AUTO_CAP_OTHER,
  currencyEnabledKey,
  classEnabledKey,
  autoCapKey,
  dueDaysKey,
  type MandateSettings,
  type WalletClass,
} from './treasuryMandate';

const open = (over: Partial<MandateSettings> = {}): MandateSettings => ({
  currencyEnabled: true,
  classEnabled: true,
  autoCap: null,
  dueDays: 15,
  ...over,
});

const decide = (fiatValue: number, settings: MandateSettings, walletClass: WalletClass = 'other') =>
  decideAcquisition({ walletClass, currency: 'EUR', fiatValue, settings });

describe('a closed door is a real answer', () => {
  it('declines every offer in a currency we do not acquire in', () => {
    const v = decide(10, open({ currencyEnabled: false }));
    expect(v.outcome).toBe('decline');
    expect(v.code).toBe('CURRENCY_CLOSED');
    expect(v.reason).toContain('EUR');
  });

  it('declines a class we are not acquiring, and names it', () => {
    const v = decide(10, open({ classEnabled: false }), 'other');
    expect(v.outcome).toBe('decline');
    expect(v.code).toBe('CLASS_CLOSED');
    expect(v.reason).toContain('Other');
  });

  it('a closed currency closes it for every class, whatever the caps say', () => {
    for (const cls of ['lanapays', 'other'] as WalletClass[]) {
      expect(decide(1, open({ currencyEnabled: false, autoCap: null }), cls).outcome).toBe('decline');
    }
  });
});

describe('the ceiling', () => {
  it('no ceiling accepts any size', () => {
    expect(decide(1, open({ autoCap: null })).outcome).toBe('accept');
    expect(decide(9_999_999, open({ autoCap: null })).outcome).toBe('accept');
  });

  it('a ceiling of zero sends everything to a person', () => {
    // Distinct from "no ceiling" on purpose — these are the two settings most
    // easily confused, and confusing them either removes the limit entirely or
    // stops the business dead.
    expect(decide(1, open({ autoCap: 0 })).outcome).toBe('review');
    expect(decide(1, open({ autoCap: 0 })).code).toBe('MANUAL_ONLY');
  });

  it('accepts up to and including the ceiling, reviews above it', () => {
    const s = open({ autoCap: 500 });
    expect(decide(499.99, s).outcome).toBe('accept');
    expect(decide(500, s).outcome).toBe('accept');
    expect(decide(500.01, s).outcome).toBe('review');
    expect(decide(500.01, s).code).toBe('ABOVE_AUTO_CAP');
  });

  it('an unmeasurable proposal is reviewed, never auto-accepted', () => {
    for (const bad of [NaN, Infinity, 0, -5]) {
      const v = decide(bad, open({ autoCap: null }));
      expect(v.outcome).toBe('review');
      expect(v.code).toBe('UNMEASURABLE');
    }
  });

  it('carries the settlement horizon into every verdict', () => {
    expect(decide(10, open({ dueDays: 3 })).dueDays).toBe(3);
    expect(decide(10, open({ dueDays: 7, autoCap: 0 })).dueDays).toBe(7);
    expect(decide(10, open({ dueDays: 7, currencyEnabled: false })).dueDays).toBe(7);
  });
});

describe('reading the settings map', () => {
  const key = (c: string, cls: WalletClass) => ({
    cur: currencyEnabledKey(c), en: classEnabledKey(c, cls),
    cap: autoCapKey(c, cls), due: dueDaysKey(c, cls),
  });

  it('a missing setting is CLOSED, not open', () => {
    // Nobody should start acquiring a new currency because a row was never
    // written. Opening is a deliberate act.
    const s = readMandateSettings({}, 'EUR', 'other');
    expect(s.currencyEnabled).toBe(false);
    expect(s.classEnabled).toBe(false);
  });

  it('distinguishes an empty cap (no ceiling) from a zero cap (never automatic)', () => {
    const k = key('EUR', 'lanapays');
    expect(readMandateSettings({ [k.cap]: '' }, 'EUR', 'lanapays').autoCap).toBeNull();
    expect(readMandateSettings({}, 'EUR', 'lanapays').autoCap).toBeNull();
    expect(readMandateSettings({ [k.cap]: '0' }, 'EUR', 'lanapays').autoCap).toBe(0);
  });

  it('treats a nonsense cap as zero, not as no ceiling', () => {
    // A typo must fail towards a person looking, never towards an open door.
    const k = key('EUR', 'other');
    expect(readMandateSettings({ [k.cap]: 'abc' }, 'EUR', 'other').autoCap).toBe(0);
    expect(readMandateSettings({ [k.cap]: '-1' }, 'EUR', 'other').autoCap).toBe(0);
  });

  it('falls back to the framework horizon when none is set', () => {
    expect(readMandateSettings({}, 'EUR', 'other').dueDays).toBe(DEFAULT_DUE_DAYS);
    const k = key('EUR', 'other');
    expect(readMandateSettings({ [k.due]: '0' }, 'EUR', 'other').dueDays).toBe(DEFAULT_DUE_DAYS);
    expect(readMandateSettings({ [k.due]: '7' }, 'EUR', 'other').dueDays).toBe(7);
  });

  it('is case-insensitive about the currency', () => {
    const s = readMandateSettings({ [currencyEnabledKey('EUR')]: 'true' }, 'eur', 'other');
    expect(s.currencyEnabled).toBe(true);
  });

  it('keeps currencies and classes independent', () => {
    const settings: Record<string, string> = {
      [currencyEnabledKey('EUR')]: 'true',
      [classEnabledKey('EUR', 'lanapays')]: 'true',
      [classEnabledKey('EUR', 'other')]: 'false',
      [currencyEnabledKey('GBP')]: 'false',
    };
    expect(readMandateSettings(settings, 'EUR', 'lanapays').classEnabled).toBe(true);
    expect(readMandateSettings(settings, 'EUR', 'other').classEnabled).toBe(false);
    expect(readMandateSettings(settings, 'GBP', 'lanapays').currencyEnabled).toBe(false);
  });
});

describe('the defaults written on migration', () => {
  const rows = defaultMandateRows('eur');
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  it('opens the currency', () => {
    expect(map[currencyEnabledKey('EUR')]).toBe('true');
  });

  it('takes LanaPays.Us without a ceiling — the owner said so', () => {
    expect(map[classEnabledKey('EUR', 'lanapays')]).toBe('true');
    expect(map[autoCapKey('EUR', 'lanapays')]).toBe('');
    const s = readMandateSettings(map, 'EUR', 'lanapays');
    expect(s.autoCap).toBeNull();
    expect(decideAcquisition({ walletClass: 'lanapays', currency: 'EUR', fiatValue: 1e6, settings: s }).outcome)
      .toBe('accept');
  });

  it('caps the other classes so a large one reaches a person', () => {
    for (const cls of ['other'] as WalletClass[]) {
      const s = readMandateSettings(map, 'EUR', cls);
      expect(s.autoCap).toBe(DEFAULT_AUTO_CAP_OTHER);
      expect(decideAcquisition({ walletClass: cls, currency: 'EUR', fiatValue: 100, settings: s }).outcome)
        .toBe('accept');
      expect(decideAcquisition({ walletClass: cls, currency: 'EUR', fiatValue: 5000, settings: s }).outcome)
        .toBe('review');
    }
  });

  it('gives every class a settlement horizon', () => {
    for (const cls of ['lanapays', 'other'] as WalletClass[]) {
      expect(readMandateSettings(map, 'EUR', cls).dueDays).toBe(DEFAULT_DUE_DAYS);
    }
  });
});
