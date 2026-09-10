/**
 * TREASURY MANDATE — do we want to buy this, at all, right now?
 *
 * This is the decision that did not exist before. Until now a seller signed,
 * the coins left their wallet, and an obligation was booked in the same HTTP
 * request; every check along the way judged the SELLER (rating, freeze, split
 * window, minimum), never our own appetite. The company decided when to pay,
 * never whether to buy — which is the shape of a standing liquidity service,
 * not of a buyer acquiring for its own treasury.
 *
 * The Proprietary Treasury Acquisition Framework (v1.0, 18 Aug 2026) turns
 * that around: Lana.discount internally decides the quantity, capital budget,
 * acquisition window and risk appetite (§3 stage 1), a seller submits an offer
 * that "creates no right to execution" (§3 stage 3), and only after our
 * decision (§3 stage 5) is any LANA transferred (§3 stage 7). Transactions
 * outside normal thresholds require elevated approval (§13).
 *
 * So this module answers exactly one question, and it must be able to answer
 * NO. A mandate that always says yes is not a mandate.
 *
 * Pure by design — no database, no clock, no network — so
 * every branch is unit-testable and the same verdict can be reused by the
 * submit endpoint, the admin queue and any future audit.
 */

/**
 * The kinds of LANA we treat differently, because they carry different risk
 * and different provenance quality.
 *
 * `lanapays` — issued by the payment system itself; the registrar stamps its
 *   split, its history is ours, and the owner has said we acquire these
 *   without a size limit.
 * `other` — anything else, including a person's own main wallet.
 * `crowdfund` — RETIRED with the old settlement order (4 Sep 2026). The
 *   literal stays in the type only so offers stored under it still read; no
 *   new offer is classified as it and no settings screen lists it.
 */
export type WalletClass = 'lanapays' | 'crowdfund' | 'other';

export type MandateOutcome = 'accept' | 'review' | 'decline';

export interface MandateSettings {
  /** Do we acquire in this currency at all? */
  currencyEnabled: boolean;
  /** Do we acquire this class of asset at all? */
  classEnabled: boolean;
  /**
   * How much of our own money we commit without a person looking, in the
   * settlement currency. It is the PURCHASE PRICE — the figure the seller is
   * quoted and the treasury later pays — not the reference gross behind it:
   *   null → no ceiling, accept any size
   *   0    → never automatic; every offer goes to a human
   *   > 0  → automatic up to and including this purchase price, above it a human
   */
  autoCap: number | null;
  /** Days from acceptance by which we owe the purchase price (§7). */
  dueDays: number;
}

export interface MandateVerdict {
  outcome: MandateOutcome;
  /** Machine-readable, safe to branch on and to store on the offer. */
  code:
    | 'WITHIN_MANDATE'
    | 'ABOVE_AUTO_CAP'
    | 'MANUAL_ONLY'
    | 'UNMEASURABLE'
    | 'CURRENCY_CLOSED'
    | 'CLASS_CLOSED';
  /** Shown to the seller. Says what is true without promising anything. */
  reason: string;
  autoCap: number | null;
  dueDays: number;
}

/**
 * The outer bound the framework itself names for deferred settlement (§7
 * offers T+3, T+7 or up to T+15). Used only when a class has no configured
 * horizon — never to override one that is set.
 */
export const DEFAULT_DUE_DAYS = 15;

/** Every class we still acquire, in the order an admin screen lists them. */
export const WALLET_CLASSES: WalletClass[] = ['lanapays', 'other'];

/** Labels for the live classes; a retired class prints its raw name. */
export const CLASS_LABELS: Partial<Record<WalletClass, string>> = {
  lanapays: 'LanaPays.Us',
  other: 'Other',
};

// ─── settings keys ────────────────────────────────────────────────────────
// Namespaced per currency and class so the owner can open EUR and close GBP,
// or take LanaPays.Us without limit while capping everything else, without any
// of those choices being entangled.

export const currencyEnabledKey = (currency: string) =>
  `acq_${currency.toUpperCase()}_enabled`;
export const classEnabledKey = (currency: string, cls: WalletClass) =>
  `acq_${currency.toUpperCase()}_${cls}_enabled`;
export const autoCapKey = (currency: string, cls: WalletClass) =>
  `acq_${currency.toUpperCase()}_${cls}_auto_cap`;
export const dueDaysKey = (currency: string, cls: WalletClass) =>
  `acq_${currency.toUpperCase()}_${cls}_due_days`;

/** app_settings stores strings; 'true'/'1' are true, anything else is false. */
function readBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * An unset cap is NOT the same as a cap of zero:
 *   ''  / missing → null → no ceiling
 *   '0'           → 0    → nothing is automatic
 * Anything unparseable is treated as 0 — the cautious end — because a typo in
 * a settings field must not silently remove the ceiling.
 */
function readCap(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function readDueDays(raw: string | undefined | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DUE_DAYS;
}

/**
 * Turn the flat app_settings map into the mandate for one (currency, class).
 * Kept pure and separate from the database read so the tests can hand it a
 * plain object.
 */
export function readMandateSettings(
  settings: Record<string, string>,
  currency: string,
  cls: WalletClass,
): MandateSettings {
  return {
    currencyEnabled: readBool(settings[currencyEnabledKey(currency)], false),
    classEnabled: readBool(settings[classEnabledKey(currency, cls)], false),
    autoCap: readCap(settings[autoCapKey(currency, cls)]),
    dueDays: readDueDays(settings[dueDaysKey(currency, cls)]),
  };
}

/**
 * The decision itself.
 *
 * `purchasePriceFiat` is the money that would leave the treasury: the
 * reference value AFTER the discount that applies to this offer — the round's
 * discount on the mandate path, the class discount otherwise — and, on a
 * counteroffer, the price of the amount we would actually take rather than of
 * the amount that was asked for. It is a fiat figure for the same reason it
 * always was: an admin sets "700 EUR" rather than a LANA quantity that means
 * something different every week.
 *
 * IT USED TO BE THE REFERENCE GROSS, the market value before the discount, and
 * that was documented here as deliberate. It is deliberate no longer, because
 * the gross is the one number nobody is shown. The admin types into a field
 * labelled "Automatic up to (EUR)" under a sentence reading "Anything larger
 * goes to a person to decide"; the seller is quoted a Purchase Price. Weighing
 * a third, invisible figure against that field made all three disagree on one
 * screen: OFF-2026-059 was priced at EUR 645.40 under a ceiling of EUR 700 and
 * still went to a person, because its gross was EUR 827.44. The owner asked
 * why twice. The settings screen's own sentence is the specification, so the
 * ceiling is now the cheque.
 *
 * The consequence is intended, not incidental: at a discount of d, offers up
 * to cap / (1 − d) of market value are now automatic where cap used to be the
 * whole of it — roughly 28 % more market value at a 22 % round discount, 43 %
 * more at the 30 % class discount. An owner who wants the old tightness types
 * a smaller number, and now the number they type is the one they are risking.
 */
export function decideAcquisition(input: {
  walletClass: WalletClass;
  currency: string;
  /** What we would pay, after the discount. Never the pre-discount gross. */
  purchasePriceFiat: number;
  settings: MandateSettings;
}): MandateVerdict {
  const { settings } = input;
  const base = { autoCap: settings.autoCap, dueDays: settings.dueDays };
  const cur = input.currency.toUpperCase();

  // Closed is closed, and the seller is told plainly. This is the sentence
  // that makes the whole model true rather than decorative: there is no
  // general obligation to buy LANA merely because a holder wishes to sell it.
  if (!settings.currencyEnabled) {
    return {
      ...base, outcome: 'decline', code: 'CURRENCY_CLOSED',
      reason: `Lana.discount is not acquiring LANA settled in ${cur} at the moment.`,
    };
  }
  if (!settings.classEnabled) {
    return {
      ...base, outcome: 'decline', code: 'CLASS_CLOSED',
      reason: `Lana.discount is not acquiring ${CLASS_LABELS[input.walletClass] ?? input.walletClass} holdings at the moment.`,
    };
  }

  // We cannot weigh what we cannot measure, so a person does. A price that is
  // not a positive number — no reference rate, an amount that rounds away to
  // nothing, a discount of 100 % — is not a cheque anyone should sign without
  // looking, whatever the ceiling says.
  if (!Number.isFinite(input.purchasePriceFiat) || input.purchasePriceFiat <= 0) {
    return {
      ...base, outcome: 'review', code: 'UNMEASURABLE',
      reason: 'This proposal is under financial review.',
    };
  }

  if (settings.autoCap === null) {
    return {
      ...base, outcome: 'accept', code: 'WITHIN_MANDATE',
      reason: '',
    };
  }
  if (settings.autoCap === 0) {
    return {
      ...base, outcome: 'review', code: 'MANUAL_ONLY',
      reason: 'This proposal is under financial review.',
    };
  }
  if (input.purchasePriceFiat <= settings.autoCap) {
    return {
      ...base, outcome: 'accept', code: 'WITHIN_MANDATE',
      reason: '',
    };
  }
  return {
    ...base, outcome: 'review', code: 'ABOVE_AUTO_CAP',
    reason: 'This proposal is above the current acquisition threshold and is under financial review.',
  };
}

/**
 * Defaults written once, on migration, so an existing seller is not stopped by
 * a setting nobody has chosen yet: LanaPays.Us open and uncapped (the owner's
 * instruction, and the class whose provenance we can actually establish),
 * everything else open but capped so it reaches a person. The 500 is 500 EUR
 * of our own money — the purchase price we would pay — not 500 EUR of market
 * value; see decideAcquisition for why those are not the same number.
 */
export const DEFAULT_AUTO_CAP_OTHER = 500;

export function defaultMandateRows(currency: string): Array<{ key: string; value: string }> {
  const cur = currency.toUpperCase();
  const rows: Array<{ key: string; value: string }> = [
    { key: currencyEnabledKey(cur), value: 'true' },
  ];
  for (const cls of WALLET_CLASSES) {
    rows.push({ key: classEnabledKey(cur, cls), value: 'true' });
    rows.push({
      key: autoCapKey(cur, cls),
      // Empty string is "no ceiling" — see readCap.
      value: cls === 'lanapays' ? '' : String(DEFAULT_AUTO_CAP_OTHER),
    });
    rows.push({ key: dueDaysKey(cur, cls), value: String(DEFAULT_DUE_DAYS) });
  }
  return rows;
}
