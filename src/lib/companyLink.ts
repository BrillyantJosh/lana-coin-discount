/**
 * COMPANY LINK — the one rule for turning a financing company's website into a
 * link. Byte-identical copy in every Lana app that shows a financer's company;
 * a test in each app pins this file's md5, so the rule cannot drift.
 *
 * The link is ALWAYS built from the host that Direct.Fund verified (the
 * company's own site lists the financer's key in /.well-known/bef-dealer.json
 * and the financer signed the company's profile), never from free text. A host
 * that is not a plain public DNS name gives no link at all.
 *
 * Why so strict: Lana sites keep signing keys in the browser, so a link that
 * runs code instead of opening a page (javascript:, data:, …) could steal them.
 * Here only https://<host>/ can come out, and the host may hold nothing but
 * a–z, 0–9, '-' and dots: no scheme, port, user name, path or IP address.
 */

/** Top-level names that never belong to a public company website. */
const BLOCKED_TLDS = new Set(['local', 'internal', 'localhost', 'lan', 'home', 'corp', 'test', 'invalid', 'example', 'onion']);

/** The host, lowercased, when it is a plain public DNS name; otherwise null. */
export function safeCompanyHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const host = input.trim().toLowerCase();
  if (host.length < 4 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }
  const tld = labels[labels.length - 1];
  // Letters only (or an IDN tld): a numeric last label would be an IPv4 address.
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{1,59}$/.test(tld)) return null;
  if (BLOCKED_TLDS.has(tld)) return null;
  return host;
}

/** https://<host>/ for a safe host, otherwise null (show the name without a link). */
export function companyWebsiteUrl(host: unknown): string | null {
  const safe = safeCompanyHost(host);
  return safe ? `https://${safe}/` : null;
}

/**
 * True when the host has an internationalised label (xn--…). Show the host
 * as it is, next to the name, so a look-alike domain cannot hide behind it.
 */
export function isPunycodeHost(host: unknown): boolean {
  const safe = safeCompanyHost(host);
  return !!safe && safe.split('.').some(label => label.startsWith('xn--'));
}

/** rel for every company link: no opener, no referrer, no endorsement. */
export const COMPANY_LINK_REL = 'noopener noreferrer nofollow';

/** referrerPolicy for every company link. */
export const COMPANY_LINK_REFERRER_POLICY = 'no-referrer';
