/**
 * Bank account schemes of KIND 30972 (BEF Dealer Profile) payment_methods — the
 * registry the fleet uses for KIND 0 payment_methods and KIND 30901.
 *
 * PORTED, reader half only, from krog-menjave/server/lib/bankSchemes.ts (5 Oct
 * 2026), itself a port of lana-nostr-kinds-bef/src/lib/bankSchemes.ts. The KIND
 * says an event that breaks one of its rules is dropped as if it was never
 * sent, and every reader must drop the same events, or BEF Explorer would show
 * a version of a firm that the firm's own site does not. So a bank account is
 * checked here exactly as there — field by field, check digits included —
 * although BEF Explorer never shows one: it only reads which currencies a
 * dealer's accounts are in. When the registry changes there, it changes here.
 *
 * Pure: no database, no network.
 */

export type PaymentScope = 'collect' | 'payout' | 'both';
export const PAYMENT_SCOPES: PaymentScope[] = ['collect', 'payout', 'both'];

export type PaymentScheme =
  | 'EU.IBAN'
  | 'UK.ACCT_SORT'
  | 'US.ACH'
  | 'AU.BSB'
  | 'CA.TRANSIT'
  | 'MX.CLABE'
  | 'BR.PIX'
  | 'IN.IFSC'
  | 'JP.ZENGIN'
  | 'ZA.BRANCH'
  | 'SG.BANK_BRANCH';

export const PAYMENT_SCHEMES: Record<PaymentScheme, { requiredFields: string[]; optionalFields: string[] }> = {
  'EU.IBAN': { requiredFields: ['iban'], optionalFields: ['bic', 'account_holder'] },
  'UK.ACCT_SORT': { requiredFields: ['account_number', 'sort_code'], optionalFields: ['account_holder'] },
  'US.ACH': { requiredFields: ['routing_number', 'account_number', 'account_type'], optionalFields: [] },
  'AU.BSB': { requiredFields: ['bsb', 'account_number'], optionalFields: ['account_holder'] },
  'CA.TRANSIT': { requiredFields: ['institution_number', 'transit_number', 'account_number'], optionalFields: [] },
  'MX.CLABE': { requiredFields: ['clabe'], optionalFields: [] },
  'BR.PIX': { requiredFields: ['pix_key'], optionalFields: [] },
  'IN.IFSC': { requiredFields: ['ifsc', 'account_number'], optionalFields: ['account_holder'] },
  'JP.ZENGIN': { requiredFields: ['bank_code', 'branch_code', 'account_number'], optionalFields: [] },
  'ZA.BRANCH': { requiredFields: ['branch_code', 'account_number'], optionalFields: [] },
  'SG.BANK_BRANCH': { requiredFields: ['bank_code', 'branch_code', 'account_number'], optionalFields: [] },
};

export function isPaymentScheme(value: unknown): value is PaymentScheme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_SCHEMES, value);
}

/** The fields of one scheme, required first, in registry order. */
export function schemeFields(scheme: PaymentScheme): string[] {
  const s = PAYMENT_SCHEMES[scheme];
  return [...s.requiredFields, ...s.optionalFields];
}

const formatFieldName = (fieldName: string): string =>
  ({ iban: 'IBAN', bic: 'BIC / SWIFT', bsb: 'BSB', ifsc: 'IFSC', clabe: 'CLABE', pix_key: 'PIX key' } as Record<string, string>)[fieldName] ??
  fieldName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

/** IBAN length by country (SWIFT IBAN registry) for the countries a dealer is likely to bank in. Others: 15–34. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, BA: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24,
  FI: 18, FR: 27, GB: 22, GE: 22, GR: 27, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, RS: 22, SA: 24, SE: 24,
  SI: 19, SK: 24, SM: 27, TR: 26, UA: 29, XK: 20,
};

/** ISO 13616 MOD-97: move the first four characters to the end, letters to 10–35, remainder must be 1. */
export function ibanChecksumOk(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** ABA routing number checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
function abaChecksumOk(routing: string): boolean {
  const d = routing.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** CLABE: weights 3,7,1 over the first 17 digits, each product mod 10; check digit = (10 − sum mod 10) mod 10. */
function clabeChecksumOk(clabe: string): boolean {
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(clabe[i]) * weights[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

/** The one written form of a field value: IBAN, BIC and IFSC without spaces and in capitals; everything else trimmed. */
function normalizeFieldValue(field: string, value: string): string {
  const trimmed = value.trim();
  if (field === 'iban' || field === 'bic' || field === 'ifsc') return trimmed.replace(/\s+/g, '').toUpperCase();
  if (field === 'account_type') return trimmed.toLowerCase();
  return trimmed;
}

const MAX_FIELD_CHARS: Record<string, number> = { account_holder: 140, pix_key: 100 };

/** What is wrong with one field value of one scheme, in English, or null when it is fine. */
export function fieldProblem(scheme: PaymentScheme, field: string, value: string): string | null {
  const name = formatFieldName(field);
  if (value !== normalizeFieldValue(field, value)) return `${name} is not in its normal form (spaces or lower case)`;
  if (value.length > (MAX_FIELD_CHARS[field] ?? 40)) return `${name} is too long`;
  switch (field) {
    case 'iban': {
      const expected = IBAN_LENGTH[value.slice(0, 2)];
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return 'IBAN must be 2 letters, 2 check digits and 11–30 letters or digits';
      if (expected && value.length !== expected) return `an IBAN from ${value.slice(0, 2)} has ${expected} characters, this one has ${value.length}`;
      if (!ibanChecksumOk(value)) return 'IBAN checksum (MOD-97) does not match — a character is wrong';
      return null;
    }
    case 'bic':
      return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value) ? null : 'BIC must have 8 or 11 characters (e.g. LJBASI2X)';
    case 'sort_code':
      return /^\d{2}-\d{2}-\d{2}$/.test(value) ? null : 'Sort code must be NN-NN-NN';
    case 'routing_number':
      if (!/^\d{9}$/.test(value)) return 'Routing number must be 9 digits';
      return abaChecksumOk(value) ? null : 'Routing number checksum does not match';
    case 'account_type':
      return value === 'checking' || value === 'savings' ? null : 'Account type must be checking or savings';
    case 'bsb':
      return /^\d{6}$/.test(value) ? null : 'BSB must be 6 digits';
    case 'institution_number':
      return /^\d{3}$/.test(value) ? null : 'Institution number must be 3 digits';
    case 'transit_number':
      return /^\d{5}$/.test(value) ? null : 'Transit number must be 5 digits';
    case 'clabe':
      if (!/^\d{18}$/.test(value)) return 'CLABE must be 18 digits';
      return clabeChecksumOk(value) ? null : 'CLABE check digit does not match';
    case 'ifsc':
      return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value) ? null : 'IFSC must be 4 letters, 0 and 6 letters or digits';
    case 'account_number':
      if (scheme === 'UK.ACCT_SORT') return /^\d{8}$/.test(value) ? null : 'A UK account number has 8 digits';
      return /^[0-9A-Za-z][0-9A-Za-z -]{0,33}$/.test(value) ? null : 'Account number may contain only letters, digits, spaces and dashes';
    case 'bank_code':
    case 'branch_code':
      return /^[0-9A-Za-z-]{1,11}$/.test(value) ? null : `${name} may contain only letters, digits and dashes`;
    case 'account_holder':
    case 'pix_key':
      return value.length > 0 ? null : `${name} is empty`;
    default:
      return `${name} is not a field of ${scheme}`;
  }
}
