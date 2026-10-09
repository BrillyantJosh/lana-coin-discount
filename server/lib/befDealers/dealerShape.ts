/**
 * KIND 30972 "BEF Dealer Profile" — every rule a reader checks on one event
 * apart from its signature and its author: the content, the tags, and how the
 * tags mirror the content.
 *
 * WHY HERE. The KIND says an event that breaks one of its rules is dropped as
 * if it was never sent: it is never the profile, and the version before it
 * stands. Every reader must read by the same rules, or two readers show two
 * different firms. This is a port, rule for rule, of checkDealerShape in
 * krog-menjave/server/lib/dealerShape.ts (itself the reference
 * lana-nostr-kinds-bef/src/lib/befDealers.ts without nostr-tools), with the
 * roles of spec v1.2.0, the payout wallet of spec v1.4.0, the receive wallet
 * of spec v1.5.0, the receive wallets per currency of spec v1.6.0 and the
 * LanaPays.Us payout wallets per currency of spec v1.7.0 added.
 *
 * v1.2.0 (5 Oct 2026) — WHO BUYS AND WHO SELLS. content.roles says what the
 * firm does with LANA: ["sells"] it only sells LANA to people, ["buys"] it only
 * buys LANA from people, ["sells", "buys"] it does both — each at most once and
 * in that order, never empty. "sells" is what BEF Explorer calls a seller (the
 * buy table), "buys" what it calls a treasury purchaser (the sell table). The
 * tags carry the same as ["t", "sells-lana"] and ["t", "buys-lana"] so a relay
 * can filter on them; the content is the word, and the tags must say exactly
 * what it says. Spec 1.2.0 read two content versions: "1.0.0", which states
 * no roles (and may carry neither the key nor the tags), and "1.1.0", where
 * roles are required (since 1.4.0 also "1.2.0", since 1.5.0 "1.3.0", since
 * 1.6.0 "1.4.0", since 1.7.0 "1.5.0", below). A profile whose roles are not
 * stated is a valid profile — but BEF Explorer lists nobody without them
 * (./dealers.ts), because it cannot say which table such a firm belongs in.
 *
 * v1.4.0 (6 Oct 2026) — THE PAYOUT WALLET. content.payout_wallet names the
 * LANA wallet the firm pays Mandate LANA out from to its buyers: a LANA
 * address (Base58Check, version byte 0x30, 34 characters starting with L, a
 * checksum that holds), written exactly as the address — never a key. It is
 * optional, public, the last key of the content, and it exists only in
 * content.version "1.2.0" (since 1.5.0 also in "1.3.0", before
 * receive_wallet): a writer writes "1.2.0" when the profile names only a
 * payout wallet (since 1.5.0 "1.3.0" when it also names a receive wallet)
 * and "1.1.0" when it names none. A reader takes "1.2.0" (roles required as
 * in "1.1.0", payout_wallet optional), "1.1.0" and "1.0.0" (since 1.5.0 also "1.3.0");
 * in the last two payout_wallet is a key they do not have, and the event is
 * invalid. Without "1.2.0" here, a firm that names its payout wallet would
 * drop off the companies list. BEF Explorer reads the wallet
 * (DealerProfile.payoutWallet) and does not show it: the companies page shows
 * no wallet of any firm.
 *
 * v1.5.0 (6 Oct 2026) — THE RECEIVE WALLET. content.receive_wallet names the
 * LANA wallet the firm RECEIVES the LANA of the sales people make to it (KIND
 * 87071): the same address rule as payout_wallet (exactly a LANA address,
 * never a key), and it may be the same address. It is optional, public, and
 * exists only in content.version "1.3.0" ("1.2.0" with receive_wallet added,
 * the last key — after payout_wallet when both are named): a writer writes
 * "1.3.0" exactly when the profile names a receive wallet (with or without a
 * payout wallet), "1.2.0" when it names only a payout wallet and "1.1.0" when
 * it names neither. A reader takes "1.3.0" with or without either key (roles
 * required as in "1.1.0"); in "1.2.0" receive_wallet is a key it does not
 * have, in "1.1.0" and "1.0.0" both are, and the event is invalid. Without
 * "1.3.0" here, a firm that names its receive wallet would drop off the
 * companies list. BEF Explorer reads the wallet (DealerProfile.receiveWallet)
 * and, as the payout wallet, neither keeps nor shows it.
 *
 * v1.6.0 (9 Oct 2026) — A RECEIVE WALLET PER CURRENCY. content.receive_wallets
 * names, per currency of a sale, the LANA wallet the firm receives that sale's
 * LANA in: an object from an ISO 4217 code (three capital letters) to a LANA
 * address, each value under exactly receive_wallet's rule (a LANA address,
 * never a key — a key is refused with receive_wallet's own sentence). It has
 * 1 to 20 entries, each code once, written in alphabetical order of the codes;
 * the same address may serve several currencies, and may be receive_wallet's
 * or payout_wallet's. It exists only in content.version "1.4.0" ("1.3.0" with
 * receive_wallets added, after receive_wallet), where it is required: a writer
 * writes "1.4.0" exactly when it names at least one currency's wallet, and
 * otherwise as before ("1.3.0", "1.2.0" or "1.1.0"). receive_wallet stays
 * optional in "1.4.0" as the DEFAULT for currencies without their own entry.
 * THE ONE RULE, the same in every reader and writer: the wallet for a sale in
 * currency C is receive_wallets[C], else receive_wallet, else none
 * (receiveWalletFor). A reader takes "1.4.0" (roles required as in "1.1.0");
 * in "1.3.0" and lower receive_wallets is a key it does not have, and the
 * event is invalid. Without "1.4.0" here, a firm that names a wallet per
 * currency would drop off the companies list. JSON.parse keeps only the last
 * of a key written twice, so whether a code is written twice is read from the
 * text itself (writtenKeysOf). BEF Explorer reads the wallets
 * (DealerProfile.receiveWallets) and, as the other wallets, neither keeps nor
 * shows them. (Since 1.7.0 receive_wallets is also a key of "1.5.0", optional
 * there, below.)
 *
 * v1.7.0 (9 Oct 2026) — A LANAPAYS.US PAYOUT WALLET PER CURRENCY. Brilly,
 * 9 Oct 2026: when the firm settles what it owes its buyers, it pays from its
 * own LanaPays.Us wallet named in its profile — one for each currency — and
 * that wallet must be of the right Split. content.payout_wallets names, per
 * currency of a purchase, the LANA wallet the firm pays that purchase's
 * Mandate LANA out from: an object from an ISO 4217 code (three capital
 * letters) to a LANA address, under exactly receive_wallets' shape rules — 1
 * to 20 entries, each code written once, in alphabetical order of the codes,
 * each value a LANA address and never a key (a key is refused with
 * payout_wallet's own sentence, PAYOUT_WALLET_KEY_REFUSAL). It exists only in
 * content.version "1.5.0" ("1.4.0" with payout_wallets added as the last key,
 * after receive_wallets), where it is REQUIRED; receive_wallets, required in
 * "1.4.0", is optional in "1.5.0" (and read by the same rules when named), so
 * "1.5.0" holds everything "1.4.0" may hold plus payout_wallets. A writer
 * writes "1.5.0" exactly when a currency has a payout wallet, and otherwise
 * as before. The single payout_wallet stays readable in "1.5.0", but there it
 * is NOT the wallet anything is paid out from: THE RULE for a purchase in
 * currency C is payout_wallets[C], else none — no default, never
 * payout_wallet (payoutWalletFor). The KIND also requires each of these
 * wallets to be one the LANA Registrar holds as type LanaPays.Us, of THIS
 * Split (its split_created equals the split of the newest verified KIND
 * 38888), and not frozen; otherwise buying LANA from the firm in C is closed.
 * Only the firm's own site can ask the Registrar, so that part binds the
 * firm's site: this reader is pure, checks the shape only, and never drops a
 * profile for it. In "1.4.0" and lower payout_wallets is a key the version
 * does not have, and the event is invalid. Without "1.5.0" here, a firm that
 * names its payout wallets would drop off the companies list. BEF Explorer
 * reads them (DealerProfile.payoutWallets) and, as the other wallets, neither
 * keeps nor shows them.
 *
 * Pure: no database, no relay, no clock.
 */
import { PAYMENT_SCHEMES, PAYMENT_SCOPES, fieldProblem, isPaymentScheme, schemeFields } from './bankSchemes.ts';
import { isLanaAddress } from './lanaAddress.ts';

export const DEALER_KIND = 30972;
/** content.version of a profile that states no roles (spec 1.0.0 and 1.1.0). */
export const CONTENT_VERSION_WITHOUT_ROLES = '1.0.0';
/** content.version of a profile with roles and no payout wallet (spec 1.2.0 on) — what a writer writes when it names none. */
export const CONTENT_VERSION_WITH_ROLES = '1.1.0';
/** content.version of a profile with roles that may name a payout wallet (spec 1.4.0) — what a writer writes when it names one and no receive wallet. */
export const CONTENT_VERSION_WITH_PAYOUT_WALLET = '1.2.0';
/** content.version of a profile with roles that may name a receive wallet and a payout wallet (spec 1.5.0) — what a writer writes when it names a receive wallet. */
export const CONTENT_VERSION_WITH_RECEIVE_WALLET = '1.3.0';
/** content.version of a profile with roles that names a receive wallet per currency (spec 1.6.0) — what a writer writes when it names at least one; receive_wallet and payout_wallet stay optional in it. */
export const CONTENT_VERSION_WITH_RECEIVE_WALLETS = '1.4.0';
/** content.version of a profile with roles that names a LanaPays.Us payout wallet per currency (spec 1.7.0) — what a writer writes when it names at least one; every other wallet key stays optional in it, receive_wallets included. */
export const CONTENT_VERSION_WITH_PAYOUT_WALLETS = '1.5.0';
/** Every content.version a reader takes. */
export const READ_CONTENT_VERSIONS: readonly string[] = [
  CONTENT_VERSION_WITHOUT_ROLES,
  CONTENT_VERSION_WITH_ROLES,
  CONTENT_VERSION_WITH_PAYOUT_WALLET,
  CONTENT_VERSION_WITH_RECEIVE_WALLET,
  CONTENT_VERSION_WITH_RECEIVE_WALLETS,
  CONTENT_VERSION_WITH_PAYOUT_WALLETS,
];
/** A reader ignores an event dated more than this far ahead of its own clock (15 minutes). */
export const FUTURE_TOLERANCE_S = 15 * 60;
export const CONTENT_MAX_BYTES = 16 * 1024;
export const DEALER_T_TAG = 'bef-dealer';
export const ALT_PREFIX = 'BEF dealer profile: ';
export const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

export type DealerRole = 'sells' | 'buys';
/** The order roles are written in. */
export const DEALER_ROLES: readonly DealerRole[] = ['sells', 'buys'];
/** The t tag each role is mirrored in. */
export const ROLE_T_TAGS: Record<DealerRole, string> = { sells: 'sells-lana', buys: 'buys-lana' };

const LIMITS = {
  name: 200,
  street: 200,
  postal_code: 20,
  city: 100,
  phone: 40,
  registration_number: 40,
  tax_number: 40,
  person_name: 200,
  label: 100,
  url: 500,
  owners: 50,
  payment_methods: 20,
  receive_wallets: 20,
  payout_wallets: 20,
} as const;

const HEX64 = /^[0-9a-f]{64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHARE = /^\d{1,3}(\.\d{1,4})?$/;
const PHONE = /^\+?[0-9 ()./-]{3,40}$/;
const METHOD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type DealerStatus = 'active' | 'retired';

/**
 * What BEF Explorer keeps of a valid profile. The whole event is checked, but
 * only this is read out of it: never the owners, their shares, the director,
 * the telephone, the registration numbers or a bank account — of the accounts,
 * only which currencies they are in.
 */
export interface DealerProfile {
  /** The slug (the d tag). */
  d: string;
  /** "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0" or "1.5.0". */
  version: string;
  status: DealerStatus;
  name: string;
  address: { street: string; postal_code: string; city: string; country: string };
  website: string | null;
  logo: string | null;
  /** null: the profile states no roles (content.version "1.0.0"). */
  roles: DealerRole[] | null;
  /** The distinct currencies of its bank accounts, in alphabetical order. */
  currencies: string[];
  /**
   * The LANA wallet it pays Mandate LANA out from (content.payout_wallet,
   * content.version "1.2.0", "1.3.0" or "1.4.0"), exactly as written; null
   * when the profile names none. In "1.5.0" it is still read, but it is NOT
   * the wallet anything is paid out from there: that is payoutWallets, per
   * currency (payoutWalletFor), never this one. Public, read only — not kept
   * in the mirror and not shown.
   */
  payoutWallet: string | null;
  /**
   * The LANA wallet it receives the LANA of sales to it in
   * (content.receive_wallet, content.version "1.3.0" or "1.4.0"), exactly as
   * written; null when the profile names none. In "1.4.0" it is the DEFAULT:
   * the wallet of the currencies receiveWallets names none for. Public, read
   * only — not kept in the mirror and not shown.
   */
  receiveWallet: string | null;
  /**
   * The LANA wallet it receives the LANA of a sale in, per currency of the
   * sale (content.receive_wallets, content.version "1.4.0", or "1.5.0" where
   * it is optional): ISO 4217 code → address, exactly as written, in
   * alphabetical order of the codes; null when the profile names none. Which
   * wallet a sale in a currency goes to is receiveWalletFor. Public, read only
   * — not kept in the mirror and not shown.
   */
  receiveWallets: Readonly<Record<string, string>> | null;
  /**
   * The LanaPays.Us wallet it pays the Mandate LANA of a purchase out from,
   * per currency of the purchase (content.payout_wallets, content.version
   * "1.5.0", where it is required): ISO 4217 code → address, exactly as
   * written, in alphabetical order of the codes; null when the profile names
   * none. Which wallet a purchase in a currency is paid from is
   * payoutWalletFor — no default. Whether the Registrar holds each as a
   * LanaPays.Us wallet of this Split, not frozen, only the firm's own site can
   * ask; this reader checks the shape. Public, read only — not kept in the
   * mirror and not shown.
   */
  payoutWallets: Readonly<Record<string, string>> | null;
}

export type DealerShape = { ok: true; profile: DealerProfile } | { ok: false; errors: string[] };

/* ── text ─────────────────────────────────────────────────────────────────── */

/** Control characters, bidi overrides and isolates, zero-width characters and the BOM. */
function isStrippedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** The one written form of a text: NFC, no control or bidi characters, trimmed. A text in any other form is refused. */
export function writtenForm(value: string): string {
  let out = '';
  for (const ch of value.normalize('NFC')) {
    if (!isStrippedCodePoint(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim();
}

/** https only, a host with a dot, no user or password in the URL, no spaces. */
export function httpsUrlProblem(value: string, what: string): string | null {
  if (value.length > LIMITS.url) return `${what} is longer than ${LIMITS.url} characters`;
  if (/\s/.test(value)) return `${what} contains spaces`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${what} is not a valid URL`;
  }
  if (url.protocol !== 'https:') return `${what} must start with https://`;
  if (url.username || url.password) return `${what} must not contain a user name or password`;
  if (!url.hostname || !url.hostname.includes('.')) return `${what} has no proper host name`;
  return null;
}

function isRealDate(ymd: string): boolean {
  if (!DATE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1800 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "25.5" → 255000 (ten-thousandths of a percent), so shares add up without floating point. */
function shareUnits(share: string): number {
  const [whole, frac = ''] = share.split('.');
  return parseInt(whole, 10) * 10000 + parseInt((frac + '0000').slice(0, 4), 10);
}

/* ── the payout wallet (1.4.0), the receive wallet (1.5.0), receive (1.6.0) and payout (1.7.0) wallets per currency */

/**
 * A text shaped like a KEY rather than a wallet address: a run of 50–53
 * Base58 characters (a private key in WIF is 51 characters, or 52 for a
 * compressed key, whatever its first character) or 64 hex characters, with or
 * without 0x (a private key or a Nostr key in hex). A LANA address is 34
 * characters, so nothing shaped like this is ever a payout wallet. Only the
 * shape is looked at — the value is never decoded, kept or repeated.
 */
export function looksLikeKey(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{50,53}$/.test(value) || /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

/** What is said instead when a key was put where the payout wallet's address belongs. The key itself is never repeated. */
export const PAYOUT_WALLET_KEY_REFUSAL =
  'payout_wallet looks like a KEY (a private key in WIF or in hex), not a wallet address: it is not put into the profile — never publish a private key. Write the address of the wallet: 34 characters, starting with L';

/** The same, for the receive wallet's field (spec 1.5.0, word for word the reference's). */
export const RECEIVE_WALLET_KEY_REFUSAL =
  'receive_wallet looks like a KEY (a private key in WIF or in hex), not a wallet address: it is not put into the profile — never publish a private key. Write the address of the wallet: 34 characters, starting with L';

/**
 * The one wallet rule of the kind, for the key it is written under: a LANA
 * address — Base58Check with the version byte 0x30, 34 characters starting
 * with L, whose checksum holds — written exactly (no spaces, no other form of
 * the same key). The message never repeats the value. `key` is where it is
 * written: payout_wallet, receive_wallet, receive_wallets.<code> (1.6.0) or
 * payout_wallets.<code> (1.7.0).
 */
function walletProblem(key: string, keyRefusal: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${key} must be text: the address of a LANA wallet`;
  if (looksLikeKey(value)) return keyRefusal;
  if (!isLanaAddress(value)) {
    return `${key} must be the address of a LANA wallet: Base58Check with the version byte 0x30 — 34 characters starting with L — and a checksum that holds`;
  }
  return null;
}

/** Why a value cannot be content.payout_wallet, or null when it can (walletProblem). */
export function payoutWalletProblem(value: unknown): string | null {
  return walletProblem('payout_wallet', PAYOUT_WALLET_KEY_REFUSAL, value);
}

/** 1.5.0 — why a value cannot be content.receive_wallet, or null when it can: exactly payout_wallet's rule (walletProblem). */
export function receiveWalletProblem(value: unknown): string | null {
  return walletProblem('receive_wallet', RECEIVE_WALLET_KEY_REFUSAL, value);
}

/**
 * The shape of a wallet per currency, for the object written under `member`
 * (receive_wallets of 1.6.0, payout_wallets of 1.7.0): an object of 1 to 20
 * entries, each key an ISO 4217 code (three capital letters) written once,
 * the keys in alphabetical order, each value exactly the wallet rule
 * (walletProblem; a key is refused with `keyRefusal`, never repeated).
 * `version` is the content.version the member is required in, named when it
 * is empty. `writtenCodes` are the codes as the text writes them, each time it
 * writes them (writtenKeysOf) — the only place a code written twice can be
 * seen; without it, only what JSON.parse kept is checked. A code is repeated
 * in a message only when it is short (at most 8 characters), so nothing shaped
 * like a key is ever repeated.
 */
function currencyWalletsProblems(
  member: 'receive_wallets' | 'payout_wallets',
  keyRefusal: string,
  version: string,
  value: unknown,
  writtenCodes?: readonly string[],
): string[] {
  if (!isPlainObject(value)) return [`${member} must be an object: a currency code (ISO 4217, e.g. EUR) to the address of a LANA wallet`];
  const codes = Object.keys(value);
  if (codes.length === 0) {
    return [`${member} is empty: it names at least one currency and its wallet (a profile that names none is not content.version "${version}")`];
  }
  const problems: string[] = [];
  const limit = LIMITS[member];
  if (codes.length > limit) problems.push(`${member} names more than ${limit} currencies: at most ${limit}`);
  const shown = (code: string) => (code.length <= 8 ? ` ${JSON.stringify(code)}` : '');
  for (const code of codes) {
    if (!CURRENCY.test(code)) {
      problems.push(`${member} has a key${shown(code)} that is not a currency code: each key is an ISO 4217 code, three capital letters (e.g. EUR)`);
      continue;
    }
    const problem = walletProblem(`${member}.${code}`, keyRefusal, value[code]);
    if (problem && !problems.includes(problem)) problems.push(problem);
  }
  const seen = new Set<string>();
  for (const code of writtenCodes ?? codes) {
    if (seen.has(code)) problems.push(`${member} names${shown(code) || ' a currency'} twice: each currency at most once`);
    seen.add(code);
  }
  const sorted = [...codes].sort();
  if (codes.join() !== sorted.join()) {
    problems.push(`${member} must be written in alphabetical order of the currency codes (e.g. EUR, GBP, USD)`);
  }
  return problems;
}

/**
 * 1.6.0 — why content.receive_wallets cannot be read, or [] when it can
 * (currencyWalletsProblems): 1 to 20 entries, each an ISO 4217 code written
 * once, in alphabetical order, each value exactly receive_wallet's rule — a
 * key is refused with RECEIVE_WALLET_KEY_REFUSAL, never repeated.
 */
export function receiveWalletsProblems(value: unknown, writtenCodes?: readonly string[]): string[] {
  return currencyWalletsProblems('receive_wallets', RECEIVE_WALLET_KEY_REFUSAL, CONTENT_VERSION_WITH_RECEIVE_WALLETS, value, writtenCodes);
}

/**
 * 1.7.0 — why content.payout_wallets cannot be read, or [] when it can: the
 * same shape as receive_wallets (currencyWalletsProblems), each value exactly
 * payout_wallet's rule — a key is refused with PAYOUT_WALLET_KEY_REFUSAL word
 * for word, never repeated. That the Registrar holds each wallet as
 * LanaPays.Us of this Split, not frozen, is not a shape rule: only the firm's
 * own site can ask it.
 */
export function payoutWalletsProblems(value: unknown, writtenCodes?: readonly string[]): string[] {
  return currencyWalletsProblems('payout_wallets', PAYOUT_WALLET_KEY_REFUSAL, CONTENT_VERSION_WITH_PAYOUT_WALLETS, value, writtenCodes);
}

/**
 * 1.6.0 — THE ONE RULE for which wallet receives the LANA of a sale in
 * `currency`: the profile's own wallet for that currency
 * (receive_wallets[currency]), else its default (receive_wallet), else none
 * (null — selling in that currency is closed). Only an exact ISO 4217 code
 * finds an entry; anything else gets the default.
 */
export function receiveWalletFor(
  profile: { receiveWallet: string | null; receiveWallets: Readonly<Record<string, string>> | null },
  currency: string,
): string | null {
  const own = profile.receiveWallets;
  if (own && CURRENCY.test(currency) && Object.prototype.hasOwnProperty.call(own, currency)) return own[currency];
  return profile.receiveWallet ?? null;
}

/**
 * 1.7.0 — THE RULE for which wallet the firm pays the Mandate LANA of a
 * purchase in `currency` out from: its own wallet for that currency
 * (payout_wallets[currency]), else none (null — buying LANA from the firm in
 * that currency is closed). There is NO default: payout_wallet is never used
 * for it, not even when a "1.5.0" profile still names one — and a profile
 * below "1.5.0" names no payout wallet per currency, so the rule gives it none
 * in every currency. Only an exact ISO 4217 code the object itself holds
 * finds an entry (never one inherited, such as "constructor"). This is the
 * shape's half of the rule; the other half —
 * the Registrar holds the wallet as LanaPays.Us, of this Split, not frozen —
 * only the firm's own site can check.
 */
export function payoutWalletFor(profile: { payoutWallets: Readonly<Record<string, string>> | null }, currency: string): string | null {
  const own = profile.payoutWallets;
  if (own && CURRENCY.test(currency) && Object.prototype.hasOwnProperty.call(own, currency)) return own[currency];
  return null;
}

/**
 * The keys of the object written under `member` at the top of a JSON text, as
 * the text writes them: in its order, a key written twice listed twice, each
 * decoded as JSON.parse decodes it. One entry per time `member` is written at
 * the top — null when its value there is not an object. JSON.parse keeps only
 * the last of a key written twice, so this is the only place it shows. The
 * text must already be valid JSON (it is read only after JSON.parse took it).
 */
export function writtenKeysOf(raw: string, member: string): (string[] | null)[] {
  const found: (string[] | null)[] = [];
  let i = 0;
  const space = () => {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++;
  };
  const text = (): string => {
    const start = i;
    i++;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(raw.slice(start, i)) as string;
  };
  const skip = (): void => {
    space();
    if (raw[i] === '"') {
      text();
      return;
    }
    if (raw[i] === '{' || raw[i] === '[') {
      let depth = 0;
      while (i < raw.length) {
        const ch = raw[i];
        if (ch === '"') {
          text();
          continue;
        }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
        i++;
        if (depth === 0) return;
      }
      return;
    }
    while (i < raw.length && !',}] \t\n\r'.includes(raw[i])) i++;
  };
  /** Each member of the object at i: its key, and what is done with its value. */
  const members = (onMember: (key: string) => void): void => {
    i++;
    space();
    if (raw[i] === '}') {
      i++;
      return;
    }
    while (i < raw.length) {
      space();
      const key = text();
      space();
      i++; // the colon
      space();
      onMember(key);
      space();
      if (raw[i] === ',') {
        i++;
        continue;
      }
      i++; // the closing brace
      return;
    }
  };
  space();
  if (raw[i] !== '{') return found;
  members((key) => {
    if (key !== member) return skip();
    if (raw[i] !== '{') {
      found.push(null);
      return skip();
    }
    const keys: string[] = [];
    members((inner) => {
      keys.push(inner);
      skip();
    });
    found.push(keys);
  });
  return found;
}

/* ── content ──────────────────────────────────────────────────────────────── */

const CONTENT_KEYS_WITHOUT_ROLES = [
  'version', 'status', 'name', 'address', 'phone', 'registration_number', 'tax_number', 'founded', 'director', 'owners',
  'website', 'logo', 'payment_methods',
];
const CONTENT_KEYS_WITH_ROLES = [...CONTENT_KEYS_WITHOUT_ROLES, 'roles'];
/** "1.2.0": "1.1.0" with payout_wallet added (the last key a writer writes; a reader does not depend on the order). */
const CONTENT_KEYS_WITH_PAYOUT_WALLET = [...CONTENT_KEYS_WITH_ROLES, 'payout_wallet'];
/** "1.3.0": "1.2.0" with receive_wallet added (written last, after payout_wallet; a reader does not depend on the order). */
const CONTENT_KEYS_WITH_RECEIVE_WALLET = [...CONTENT_KEYS_WITH_PAYOUT_WALLET, 'receive_wallet'];
/** "1.4.0": "1.3.0" with receive_wallets added (written last, after receive_wallet; a reader does not depend on the order of the content's keys). */
const CONTENT_KEYS_WITH_RECEIVE_WALLETS = [...CONTENT_KEYS_WITH_RECEIVE_WALLET, 'receive_wallets'];
/** "1.5.0": "1.4.0" with payout_wallets added (written last, after receive_wallets; a reader does not depend on the order of the content's keys). */
const CONTENT_KEYS_WITH_PAYOUT_WALLETS = [...CONTENT_KEYS_WITH_RECEIVE_WALLETS, 'payout_wallets'];
const ADDRESS_KEYS = ['street', 'postal_code', 'city', 'country'];
const METHOD_KEYS = ['id', 'scope', 'country', 'scheme', 'currency', 'label', 'fields', 'primary'];

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push(`${where} has an unknown key "${key}"`);
}

/** A text that must already be in its written form. Returns the value ('' when missing and not required). */
function readText(obj: Record<string, unknown>, key: string, max: number, where: string, required: boolean, errors: string[]): string {
  const value = obj[key];
  if (value === undefined) {
    if (required) errors.push(`${where} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    errors.push(`${where} must be text`);
    return '';
  }
  if (writtenForm(value) !== value) errors.push(`${where} has control or bidi characters or surrounding spaces`);
  if (value.length > max) errors.push(`${where} is longer than ${max} characters`);
  if (required && !value) errors.push(`${where} is required`);
  return value;
}

function readHex(value: unknown, where: string, errors: string[]): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !HEX64.test(value)) {
    errors.push(`${where} must be 64 lowercase hex characters`);
    return '';
  }
  return value;
}

/** Every bank account rule. Returns the currencies of the accounts, each once. */
function readPaymentMethods(value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push('payment_methods must be a list');
    return [];
  }
  if (value.length > LIMITS.payment_methods) errors.push(`at most ${LIMITS.payment_methods} bank accounts`);
  const ids = new Set<string>();
  const currencies = new Set<string>();
  const primaries: { currency: string; scope: string }[] = [];
  value.forEach((raw, i) => {
    const where = `bank account ${i + 1}`;
    if (!isPlainObject(raw)) {
      errors.push(`${where} is not an object`);
      return;
    }
    unknownKeys(raw, METHOD_KEYS, where, errors);
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!METHOD_ID.test(id)) errors.push(`${where}: id must be 1–64 letters, digits, _ or -`);
    else if (ids.has(id)) errors.push(`${where}: id "${id}" is used twice`);
    ids.add(id);
    const scope = typeof raw.scope === 'string' ? raw.scope : '';
    if (!(PAYMENT_SCOPES as string[]).includes(scope)) errors.push(`${where}: scope must be collect, payout or both`);
    if (!COUNTRY.test(typeof raw.country === 'string' ? raw.country : '')) errors.push(`${where}: country must be an ISO 3166-1 alpha-2 code`);
    const currency = typeof raw.currency === 'string' ? raw.currency : '';
    if (!CURRENCY.test(currency)) errors.push(`${where}: currency must be an ISO 4217 code`);
    else currencies.add(currency);
    readText(raw, 'label', LIMITS.label, `${where}: label`, false, errors);
    if (typeof raw.primary !== 'boolean') errors.push(`${where}: primary must be true or false`);
    if (!isPaymentScheme(raw.scheme)) {
      errors.push(`${where}: scheme must be one of ${Object.keys(PAYMENT_SCHEMES).join(', ')}`);
    } else if (!isPlainObject(raw.fields)) {
      errors.push(`${where}: fields must be an object`);
    } else {
      const scheme = raw.scheme;
      const allowed = schemeFields(scheme);
      unknownKeys(raw.fields, allowed, `${where} (${scheme}) fields`, errors);
      for (const field of allowed) {
        const v = raw.fields[field];
        if (v === undefined || v === '') {
          if (PAYMENT_SCHEMES[scheme].requiredFields.includes(field)) errors.push(`${where}: ${field} is required for ${scheme}`);
          continue;
        }
        if (typeof v !== 'string') {
          errors.push(`${where}: ${field} must be text`);
          continue;
        }
        if (writtenForm(v) !== v) {
          errors.push(`${where}: ${field} has control or bidi characters or surrounding spaces`);
          continue;
        }
        const problem = fieldProblem(scheme, field, v);
        if (problem) errors.push(`${where}: ${problem}`);
      }
    }
    if (raw.primary === true) primaries.push({ currency, scope });
  });
  // The KIND 0 rule: one primary account per currency and direction.
  for (const direction of ['collect', 'payout']) {
    const count = new Map<string, number>();
    for (const m of primaries) if (m.scope === direction || m.scope === 'both') count.set(m.currency, (count.get(m.currency) ?? 0) + 1);
    for (const [currency, n] of count) {
      if (n > 1) errors.push(`${n} primary ${currency} accounts to ${direction === 'collect' ? 'collect to' : 'pay out from'}; at most one`);
    }
  }
  return [...currencies].sort();
}

/** content.roles of a "1.1.0", "1.2.0", "1.3.0", "1.4.0" or "1.5.0" profile: non-empty, each role at most once, sells before buys. */
function readRoles(value: unknown, errors: string[]): DealerRole[] | null {
  if (value === undefined) {
    errors.push(
      `roles is required in content.version "${CONTENT_VERSION_WITH_ROLES}", "${CONTENT_VERSION_WITH_PAYOUT_WALLET}", "${CONTENT_VERSION_WITH_RECEIVE_WALLET}", "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}" and "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}"`,
    );
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('roles must be a non-empty list: ["sells"], ["buys"] or ["sells", "buys"]');
    return null;
  }
  const roles: DealerRole[] = [];
  for (const role of value) {
    if (role !== 'sells' && role !== 'buys') {
      errors.push('roles may hold only "sells" and "buys"');
      return null;
    }
    if (roles.includes(role)) {
      errors.push(`roles names "${role}" twice`);
      return null;
    }
    roles.push(role);
  }
  if (roles.join() !== DEALER_ROLES.filter((r) => roles.includes(r)).join()) {
    errors.push('roles are written in the order "sells", "buys"');
    return null;
  }
  return roles;
}

interface ReadContent {
  version: string;
  status: DealerStatus;
  name: string;
  address: DealerProfile['address'];
  director: string;
  owners: string[];
  website: string | null;
  logo: string | null;
  roles: DealerRole[] | null;
  currencies: string[];
  payoutWallet: string | null;
  receiveWallet: string | null;
  receiveWallets: Record<string, string> | null;
  payoutWallets: Record<string, string> | null;
}

/** The content JSON: every rule a reader can check. */
function readContent(raw: string, errors: string[]): ReadContent | null {
  if (new TextEncoder().encode(raw).length > CONTENT_MAX_BYTES) {
    errors.push(`content is larger than ${CONTENT_MAX_BYTES} bytes`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push('content is not JSON');
    return null;
  }
  if (!isPlainObject(parsed)) {
    errors.push('content is not a JSON object');
    return null;
  }
  const c = parsed;
  const version = typeof c.version === 'string' ? c.version : '';
  // "1.2.0" is "1.1.0" (roles required) that may also name a payout wallet;
  // "1.3.0" is "1.2.0" that may also name a receive wallet; "1.4.0" is
  // "1.3.0" that names a receive wallet per currency; "1.5.0" is "1.4.0" that
  // names a LanaPays.Us payout wallet per currency — receive_wallets, which
  // "1.4.0" requires, is optional in it.
  const withPayoutWallets = version === CONTENT_VERSION_WITH_PAYOUT_WALLETS;
  const receiveWalletsRequired = version === CONTENT_VERSION_WITH_RECEIVE_WALLETS;
  const withReceiveWallets = receiveWalletsRequired || withPayoutWallets;
  const withReceiveWallet = version === CONTENT_VERSION_WITH_RECEIVE_WALLET || withReceiveWallets;
  const withPayoutWallet = version === CONTENT_VERSION_WITH_PAYOUT_WALLET || withReceiveWallet;
  const withRoles = version === CONTENT_VERSION_WITH_ROLES || withPayoutWallet;
  if (!READ_CONTENT_VERSIONS.includes(version)) {
    errors.push(
      `content.version must be "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}", "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}", "${CONTENT_VERSION_WITH_RECEIVE_WALLET}", "${CONTENT_VERSION_WITH_PAYOUT_WALLET}", "${CONTENT_VERSION_WITH_ROLES}" or "${CONTENT_VERSION_WITHOUT_ROLES}"`,
    );
  }
  // A "1.0.0" profile states no roles: a roles key in it is an unknown key.
  // payout_wallet is a key only "1.2.0" to "1.5.0" have, receive_wallet one
  // only "1.3.0" to "1.5.0" have, receive_wallets one only "1.4.0" and "1.5.0"
  // have, payout_wallets one only "1.5.0" has — in the others they are
  // unknown too.
  const allowed = withPayoutWallets
    ? CONTENT_KEYS_WITH_PAYOUT_WALLETS
    : withReceiveWallets
      ? CONTENT_KEYS_WITH_RECEIVE_WALLETS
      : withReceiveWallet
        ? CONTENT_KEYS_WITH_RECEIVE_WALLET
        : withPayoutWallet
          ? CONTENT_KEYS_WITH_PAYOUT_WALLET
          : withRoles
            ? CONTENT_KEYS_WITH_ROLES
            : CONTENT_KEYS_WITHOUT_ROLES;
  for (const key of Object.keys(c)) {
    if (allowed.includes(key)) continue;
    if (key === 'payout_wallet') {
      errors.push(
        `content.version ${JSON.stringify(c.version)?.slice(0, 20)} has no payout_wallet: a profile that names a payout wallet is content.version "${CONTENT_VERSION_WITH_PAYOUT_WALLET}" (or "${CONTENT_VERSION_WITH_RECEIVE_WALLET}", "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}" or "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}")`,
      );
    } else if (key === 'receive_wallet') {
      errors.push(
        `content.version ${JSON.stringify(c.version)?.slice(0, 20)} has no receive_wallet: a profile that names a receive wallet is content.version "${CONTENT_VERSION_WITH_RECEIVE_WALLET}" (or "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}" or "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}")`,
      );
    } else if (key === 'receive_wallets') {
      errors.push(
        `content.version ${JSON.stringify(c.version)?.slice(0, 20)} has no receive_wallets: a profile that names a receive wallet per currency is content.version "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}" (or "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}")`,
      );
    } else if (key === 'payout_wallets') {
      errors.push(
        `content.version ${JSON.stringify(c.version)?.slice(0, 20)} has no payout_wallets: a profile that names a LanaPays.Us payout wallet per currency is content.version "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}"`,
      );
    } else {
      errors.push(`content has an unknown key "${key}"`);
    }
  }
  const status = c.status as DealerStatus;
  if (status !== 'active' && status !== 'retired') errors.push('content.status must be active or retired');

  const name = readText(c, 'name', LIMITS.name, 'name', true, errors);
  let address = { street: '', postal_code: '', city: '', country: '' };
  if (!isPlainObject(c.address)) {
    errors.push('address is required (with at least the country)');
  } else {
    unknownKeys(c.address, ADDRESS_KEYS, 'address', errors);
    address = {
      street: readText(c.address, 'street', LIMITS.street, 'street', false, errors),
      postal_code: readText(c.address, 'postal_code', LIMITS.postal_code, 'postal code', false, errors),
      city: readText(c.address, 'city', LIMITS.city, 'city', false, errors),
      country: typeof c.address.country === 'string' ? c.address.country : '',
    };
    if (!COUNTRY.test(address.country)) errors.push('country must be an ISO 3166-1 alpha-2 code (e.g. SI)');
  }
  const phone = readText(c, 'phone', LIMITS.phone, 'phone', false, errors);
  if (phone && (!PHONE.test(phone) || phone.replace(/\D/g, '').length < 3)) errors.push('phone may contain only digits, spaces, + ( ) - / .');
  readText(c, 'registration_number', LIMITS.registration_number, 'registration number', true, errors);
  readText(c, 'tax_number', LIMITS.tax_number, 'tax number', false, errors);
  const founded = readText(c, 'founded', 10, 'date of founding', false, errors);
  if (founded && !isRealDate(founded)) errors.push('date of founding must be a real date YYYY-MM-DD');

  let director = '';
  if (c.director !== undefined) {
    if (!isPlainObject(c.director)) errors.push('director must be an object');
    else {
      unknownKeys(c.director, ['name', 'hex'], 'director', errors);
      readText(c.director, 'name', LIMITS.person_name, "director's name", false, errors);
      director = readHex(c.director.hex, "director's Nostr hex", errors);
    }
  }

  // Owners are checked, never kept: only their keys, to compare with the p tags.
  const owners: string[] = [];
  if (c.owners !== undefined) {
    if (!Array.isArray(c.owners)) errors.push('owners must be a list');
    else {
      if (c.owners.length > LIMITS.owners) errors.push(`at most ${LIMITS.owners} owners`);
      const seen = new Set<string>();
      c.owners.forEach((o, i) => {
        const where = `owner ${i + 1}`;
        if (!isPlainObject(o)) {
          errors.push(`${where} is not an object`);
          return;
        }
        unknownKeys(o, ['name', 'hex', 'share_percent'], where, errors);
        const oname = readText(o, 'name', LIMITS.person_name, `${where}: name`, false, errors);
        const hex = readHex(o.hex, `${where}: Nostr hex`, errors);
        if (!oname && !hex) errors.push(`${where} needs a name or a Nostr hex`);
        if (hex && seen.has(hex)) errors.push(`${where}: the same Nostr hex is listed twice`);
        if (hex) {
          seen.add(hex);
          owners.push(hex);
        }
        const share = typeof o.share_percent === 'string' ? o.share_percent : '';
        if (!SHARE.test(share) || shareUnits(share) > 100 * 10000) {
          errors.push(`${where}: share must be a number from 0 to 100 (at most 4 decimals), as text`);
        }
      });
    }
  }

  let website: string | null = null;
  if (c.website !== undefined) {
    const value = typeof c.website === 'string' ? c.website : '';
    const problem = httpsUrlProblem(value, 'website');
    if (problem) errors.push(problem);
    else website = value;
  }
  let logo: string | null = null;
  if (c.logo !== undefined) {
    const value = typeof c.logo === 'string' ? c.logo : '';
    const problem = httpsUrlProblem(value, 'logo');
    if (problem) errors.push(problem);
    else logo = value;
  }
  const currencies = readPaymentMethods(c.payment_methods, errors);
  const roles = withRoles ? readRoles(c.roles, errors) : null;
  // 1.4.0: optional in "1.2.0" to "1.5.0" (in the other versions it was
  // refused above as a key they do not have). In "1.5.0" it is read but is not
  // the wallet anything is paid out from: payout_wallets is (payoutWalletFor).
  let payoutWallet: string | null = null;
  if (withPayoutWallet && c.payout_wallet !== undefined) {
    const problem = payoutWalletProblem(c.payout_wallet);
    if (problem) errors.push(problem);
    else payoutWallet = c.payout_wallet as string;
  }
  // 1.5.0: optional in "1.3.0" to "1.5.0" (refused above in every other
  // version). It may be the payout wallet's address. In "1.4.0" and "1.5.0" it
  // is the default: the wallet of the currencies receive_wallets names none for.
  let receiveWallet: string | null = null;
  if (withReceiveWallet && c.receive_wallet !== undefined) {
    const problem = receiveWalletProblem(c.receive_wallet);
    if (problem) errors.push(problem);
    else receiveWallet = c.receive_wallet as string;
  }
  // 1.6.0: required, and never empty, in "1.4.0"; optional in "1.5.0" (1.7.0),
  // and read by exactly the same rules when named there (refused above in
  // every other version) — a writer writes "1.4.0" only when it names at
  // least one currency's wallet. A key written twice at the top is refused for
  // this key too: which of the two is the profile's wallets cannot be told.
  let receiveWallets: Record<string, string> | null = null;
  if (withReceiveWallets) {
    if (c.receive_wallets === undefined) {
      if (receiveWalletsRequired) {
        errors.push(
          `receive_wallets is required in content.version "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}": at least one currency and its wallet (a profile that names none is "${CONTENT_VERSION_WITH_RECEIVE_WALLET}" or lower)`,
        );
      }
    } else {
      const written = writtenKeysOf(raw, 'receive_wallets');
      if (written.length > 1) errors.push('content names receive_wallets twice: it is written once');
      const last = written.length ? written[written.length - 1] : null;
      const problems = receiveWalletsProblems(c.receive_wallets, last ?? undefined);
      if (problems.length) errors.push(...problems);
      else if (written.length <= 1) receiveWallets = { ...(c.receive_wallets as Record<string, string>) };
    }
  }
  // 1.7.0: required, and never empty, in "1.5.0" (refused above in every
  // other version) — a writer writes "1.5.0" only when a currency has a
  // LanaPays.Us payout wallet. The same shape as receive_wallets, a key
  // refused with payout_wallet's own sentence; written twice at the top is
  // refused too. Whether the Registrar holds each wallet as LanaPays.Us of
  // this Split, not frozen, is the firm's own site's to check, not a reader's.
  let payoutWallets: Record<string, string> | null = null;
  if (withPayoutWallets) {
    if (c.payout_wallets === undefined) {
      errors.push(
        `payout_wallets is required in content.version "${CONTENT_VERSION_WITH_PAYOUT_WALLETS}": at least one currency and its wallet (a profile that names none is "${CONTENT_VERSION_WITH_RECEIVE_WALLETS}" or lower)`,
      );
    } else {
      const written = writtenKeysOf(raw, 'payout_wallets');
      if (written.length > 1) errors.push('content names payout_wallets twice: it is written once');
      const last = written.length ? written[written.length - 1] : null;
      const problems = payoutWalletsProblems(c.payout_wallets, last ?? undefined);
      if (problems.length) errors.push(...problems);
      else if (written.length <= 1) payoutWallets = { ...(c.payout_wallets as Record<string, string>) };
    }
  }

  return { version, status, name, address, director, owners, website, logo, roles, currencies, payoutWallet, receiveWallet, receiveWallets, payoutWallets };
}

/* ── tags ─────────────────────────────────────────────────────────────────── */

/** Tags against the content they mirror. Returns d. */
function readTags(tags: unknown, content: ReadContent | null, errors: string[]): string {
  // Every tag a list of texts (a relay frame can carry anything that still signs).
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
    errors.push('every tag must be a list of texts');
    return '';
  }
  const list = tags as string[][];
  const named = (n: string) => list.filter((t) => t[0] === n);
  for (const t of list) {
    if (!['d', 'name', 'country', 'p', 't', 'alt'].includes(t[0])) errors.push(`unknown tag "${t[0]}"`);
  }
  const one = (n: string): string | null => {
    const found = named(n);
    if (found.length !== 1 || found[0].length !== 2) {
      errors.push(`exactly one ["${n}", value] tag is required`);
      return null;
    }
    return found[0][1];
  };
  const d = one('d') ?? '';
  if (d && !SLUG_PATTERN.test(d)) errors.push('d must be 2–40 characters a–z, 0–9 or -');
  const nameTag = one('name');
  const countryTag = one('country');
  const alt = one('alt');

  // t tags: exactly one "bef-dealer", and one per role the content states.
  const tValues: string[] = [];
  for (const t of named('t')) {
    if (t.length !== 2) {
      errors.push('every t tag must be ["t", value]');
      continue;
    }
    tValues.push(t[1]);
  }
  if (tValues.filter((v) => v === DEALER_T_TAG).length !== 1) errors.push(`exactly one ["t", "${DEALER_T_TAG}"] tag is required`);
  const roleTags = Object.values(ROLE_T_TAGS);
  for (const v of tValues) {
    if (v !== DEALER_T_TAG && !roleTags.includes(v)) errors.push(`unknown t tag "${v}"`);
  }
  for (const v of roleTags) {
    if (tValues.filter((x) => x === v).length > 1) errors.push(`["t", "${v}"] appears twice`);
  }

  // p "admin" tags (1.0.0) are checked for their form only: they name no one.
  const directorTags: string[] = [];
  const ownerTags: string[] = [];
  for (const t of named('p')) {
    if (t.length !== 4 || t[2] !== '' || !HEX64.test(t[1]) || !['admin', 'director', 'owner'].includes(t[3])) {
      errors.push('every p tag must be ["p", <64 lowercase hex>, "", "admin" | "director" | "owner"]');
      continue;
    }
    if (t[3] === 'director') directorTags.push(t[1]);
    else if (t[3] === 'owner') ownerTags.push(t[1]);
  }

  if (content) {
    if (nameTag !== null && nameTag !== content.name) errors.push('the name tag differs from content.name');
    if (countryTag !== null && countryTag !== content.address.country) errors.push('the country tag differs from content.address.country');
    if (alt !== null && alt !== `${ALT_PREFIX}${content.name}`) errors.push(`alt must be "${ALT_PREFIX}<name>"`);
    const expectDirector = content.director ? [content.director] : [];
    if (directorTags.join() !== expectDirector.join()) errors.push('the director p tag must match content.director.hex (one tag, or none when it is empty)');
    if (ownerTags.join() !== content.owners.join()) errors.push('the owner p tags must match the owners with a Nostr hex, in the same order');
    // The content is the word; the role tags must say exactly what it says —
    // and a profile that states no roles carries none.
    let roleTagsMatch = true;
    for (const role of DEALER_ROLES) {
      const stated = content.roles?.includes(role) ?? false;
      const tagged = tValues.includes(ROLE_T_TAGS[role]);
      if (stated !== tagged) {
        roleTagsMatch = false;
        errors.push(stated ? `roles say "${role}": the ["t", "${ROLE_T_TAGS[role]}"] tag is required` : `["t", "${ROLE_T_TAGS[role]}"] is not in content.roles`);
      }
    }
    // …and in the KIND's order: "bef-dealer" first, then one per role in the
    // order of content.roles. The reference (befDealers.ts readTags) refuses any
    // other order; accepting one here would let BEF Explorer take as a dealer's
    // newest profile an event every other reader drops.
    const expectT = [DEALER_T_TAG, ...(content.roles ?? []).map((r) => ROLE_T_TAGS[r])];
    if (roleTagsMatch && JSON.stringify(tValues) !== JSON.stringify(expectT)) {
      errors.push(`the t tags must be ${expectT.map((v) => `"${v}"`).join(', ')} — "${DEALER_T_TAG}", then one per role of content.roles, in that order`);
    }
  }
  return d;
}

/**
 * Every shape rule of a 30972 except the signature, the author and the date:
 * the kind, the tags, the content, and how they mirror each other. On success,
 * what BEF Explorer keeps of it (DealerProfile).
 */
export function checkDealerShape(event: { kind: number; tags: unknown; content: unknown }): DealerShape {
  const errors: string[] = [];
  if (event.kind !== DEALER_KIND) errors.push(`kind must be ${DEALER_KIND}`);
  let content: ReadContent | null = null;
  if (typeof event.content === 'string') content = readContent(event.content, errors);
  else errors.push('content must be text');
  const d = readTags(event.tags, content, errors);
  if (errors.length || !content) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      d,
      version: content.version,
      status: content.status,
      name: content.name,
      address: content.address,
      website: content.website,
      logo: content.logo,
      roles: content.roles,
      currencies: content.currencies,
      payoutWallet: content.payoutWallet,
      receiveWallet: content.receiveWallet,
      receiveWallets: content.receiveWallets,
      payoutWallets: content.payoutWallets,
    },
  };
}
