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

/**
 * The number handed in is the PURCHASE PRICE — what the treasury would pay
 * after the discount — not the reference gross. See `decideAcquisition`.
 */
const decide = (purchasePriceFiat: number, settings: MandateSettings, walletClass: WalletClass = 'other') =>
  decideAcquisition({ walletClass, currency: 'EUR', purchasePriceFiat, settings });

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

/**
 * THE CEILING IS THE CHEQUE, NOT THE MARKET VALUE.
 *
 * OFF-2026-059: 3,232.188 LANA, reference gross EUR 827.44, round discount
 * 22 %, purchase price EUR 645.40 — and an auto cap of EUR 700 under a
 * sentence reading "Anything larger goes to a person to decide". It went to a
 * person anyway, because the cap was weighed against the gross, the one figure
 * nobody is ever shown. These tests pin the fixed reading to those exact
 * numbers, so anyone who "tidies" the call site back to the gross has to
 * delete a test that names a real offer.
 */
describe('the ceiling weighs what we pay, not what it is worth', () => {
  /**
   * The arithmetic priceAcquisition does, repeated here on purpose: it keeps
   * the figures in this file the ones from the screenshot rather than a
   * rounded retelling of them, without this pure module importing the router.
   */
  const priced = (lana: number, rate: number, discountPercent: number) => {
    const grossFiat = Math.round(lana * rate * 100) / 100;
    const discountFiat = Math.round(grossFiat * discountPercent / 100 * 100) / 100;
    return { grossFiat, purchasePriceFiat: Math.round((grossFiat - discountFiat) * 100) / 100 };
  };

  it('OFF-2026-059 sits inside a EUR 700 ceiling, because EUR 645.40 is what we pay', () => {
    const p = priced(3232.188, 0.256, 22);
    expect(p.grossFiat).toBe(827.44);
    expect(p.purchasePriceFiat).toBe(645.40);

    const s = open({ autoCap: 700 });
    expect(decide(p.purchasePriceFiat, s, 'lanapays').outcome).toBe('accept');
    expect(decide(p.purchasePriceFiat, s, 'lanapays').code).toBe('WITHIN_MANDATE');
    // The old reading, kept only so the change is written down: the same offer
    // judged on its gross is above the very same ceiling.
    expect(decide(p.grossFiat, s, 'lanapays').code).toBe('ABOVE_AUTO_CAP');
  });

  it('the ceiling still bites — a price above it goes to a person, discount or no discount', () => {
    const p = priced(3600, 0.256, 22);           // gross 921.60 → we would pay 718.85
    expect(p.purchasePriceFiat).toBe(718.85);
    expect(decide(p.purchasePriceFiat, open({ autoCap: 700 }), 'lanapays').code).toBe('ABOVE_AUTO_CAP');
  });

  it('the extra room the change buys is exactly cap / (1 - discount), and no more', () => {
    // At a 30 % class discount a EUR 500 ceiling now reaches EUR 714.28 of
    // market value — the last cent below cap / 0.7 — and stops there.
    const s = open({ autoCap: 500 });
    expect(decide(priced(2790, 0.256, 30).purchasePriceFiat, s).outcome).toBe('accept');   // gross 714.24 → 499.97
    expect(decide(priced(2800, 0.256, 30).purchasePriceFiat, s).code).toBe('ABOVE_AUTO_CAP'); // gross 716.80 → 501.76
  });

  it('a 100 % discount is not a free automatic yes — a price of zero is unmeasurable', () => {
    const p = priced(1000, 0.256, 100);
    expect(p.purchasePriceFiat).toBe(0);
    expect(decide(p.purchasePriceFiat, open({ autoCap: 700 })).code).toBe('UNMEASURABLE');
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
    expect(decideAcquisition({ walletClass: 'lanapays', currency: 'EUR', purchasePriceFiat: 1e6, settings: s }).outcome)
      .toBe('accept');
  });

  it('caps the other classes so a large one reaches a person', () => {
    for (const cls of ['other'] as WalletClass[]) {
      const s = readMandateSettings(map, 'EUR', cls);
      expect(s.autoCap).toBe(DEFAULT_AUTO_CAP_OTHER);
      expect(decideAcquisition({ walletClass: cls, currency: 'EUR', purchasePriceFiat: 100, settings: s }).outcome)
        .toBe('accept');
      expect(decideAcquisition({ walletClass: cls, currency: 'EUR', purchasePriceFiat: 5000, settings: s }).outcome)
        .toBe('review');
    }
  });

  it('gives every class a settlement horizon', () => {
    for (const cls of ['lanapays', 'other'] as WalletClass[]) {
      expect(readMandateSettings(map, 'EUR', cls).dueDays).toBe(DEFAULT_DUE_DAYS);
    }
  });
});
