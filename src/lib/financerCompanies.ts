/**
 * A FINANCER'S COMPANY, ON THE ADMIN PAGES — display only.
 *
 * Owner, 11 Nov 2026: the two financers are companies now. Where a person acts
 * as a financer — who paid a batch, who settles a purchase, whose mandate it
 * is — the admin pages show the company, with the person beside it as its
 * representative, and a click on the company opens its website
 * (src/components/FinancerCompanyName.tsx).
 *
 * Direct.Fund owns the company data and lists every verified company of a
 * current financer at one open address. This site only reads that list, in the
 * browser, once per page load, and keeps it five minutes. Nothing about money,
 * signing, sign-in, Nostr events or what this site's server answers changes.
 *
 * Every failure — no answer, a refusal, a body of another shape, an entry that
 * fails a check below — leaves the page exactly as it was: the person. Never a
 * blank, never an error.
 *
 * DATED. A row with a date shows the company only from the company's `since`
 * on: before it the person financed it, and the row keeps saying so. A row
 * whose date cannot be read keeps the person too. Only a place with no date at
 * all (who a financer is now) shows the company as it is now, and only such a
 * place may leave the date out.
 */
import { useEffect, useMemo, useState } from 'react';

/** The one source, the same for every Lana app. Open and read-only. */
export const FINANCER_COMPANIES_URL = 'https://direct.lana.fund/api/public/financer-companies';

/** Direct.Fund keeps the list five minutes itself; asking more often would read the same answer. */
export const FINANCER_COMPANIES_CACHE_MS = 5 * 60_000;

/** A Direct.Fund that does not answer must not hold the list up longer than this. */
const ANSWER_WITHIN_MS = 10_000;

export interface FinancerCompany {
  /** The financer's own key — the person's — 64 lowercase hex. */
  hex: string;
  /** The company's legal name. */
  name: string;
  /** The host Direct.Fund verified. A link is only ever made from it, by companyWebsiteUrl. */
  host: string | null;
  /** From when the company is the financer: as Direct.Fund wrote it, and in ms. */
  since: string;
  sinceMs: number;
}

/** Financer key → company. */
export type FinancerCompanies = ReadonlyMap<string, FinancerCompany>;

const NO_COMPANIES: FinancerCompanies = new Map();
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_NAME = 200;

/**
 * A time as the Lana databases write it. SQLite's `YYYY-MM-DD HH:MM:SS` has no
 * zone and is UTC — a browser would read it as local time — so it is read as
 * UTC; a time with a zone is read as written. Null when it cannot be read.
 */
export function parseUtcTime(at: unknown): number | null {
  if (typeof at !== 'string') return null;
  const s = at.trim();
  if (!s) return null;
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const ms = Date.parse(naive ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Direct.Fund's answer, every entry checked: the key 64 lowercase hex, a name
 * of 1–200 characters, a `since` that reads as a time. An entry that fails is
 * left out, never repaired. A key listed twice is left out altogether: which of
 * the two is right cannot be told from here, and the person is never wrong.
 * Only the host is kept of the address; Direct.Fund's `website` is not read.
 */
export function parseFinancerCompanies(body: unknown): Map<string, FinancerCompany> {
  const out = new Map<string, FinancerCompany>();
  const list = body && typeof body === 'object' ? (body as { companies?: unknown }).companies : undefined;
  if (!Array.isArray(list)) return out;
  const twice = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { hex, name, host, since } = entry as Record<string, unknown>;
    if (typeof hex !== 'string' || !HEX64.test(hex)) continue;
    if (typeof name !== 'string' || name.length > MAX_NAME || !name.trim()) continue;
    const sinceMs = parseUtcTime(since);
    if (sinceMs === null) continue;
    if (out.has(hex) || twice.has(hex)) {
      out.delete(hex);
      twice.add(hex);
      continue;
    }
    out.set(hex, { hex, name: name.trim(), host: typeof host === 'string' ? host : null, since: String(since), sinceMs });
  }
  return out;
}

let cache: { at: number; answer: Promise<FinancerCompanies>; value: FinancerCompanies | null } | null = null;

async function readCompanies(): Promise<FinancerCompanies> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_WITHIN_MS);
  try {
    // A plain fetch, never signedFetch: nothing of this session goes to another site, not even a cookie.
    const res = await fetch(FINANCER_COMPANIES_URL, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) return NO_COMPANIES;
    return parseFinancerCompanies(await res.json());
  } catch {
    return NO_COMPANIES;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The list, read once and kept five minutes. A failed read is kept as long:
 * meanwhile every place shows the person, as it did before there was a list.
 */
export function loadFinancerCompanies(nowMs: number = Date.now()): Promise<FinancerCompanies> {
  if (cache && nowMs - cache.at < FINANCER_COMPANIES_CACHE_MS) return cache.answer;
  const entry = { at: nowMs, answer: readCompanies(), value: null as FinancerCompanies | null };
  entry.answer.then(value => { entry.value = value; });
  cache = entry;
  return entry.answer;
}

/** What is already known without asking — or nothing. */
function knownCompanies(nowMs: number = Date.now()): FinancerCompanies {
  return cache && nowMs - cache.at < FINANCER_COMPANIES_CACHE_MS && cache.value ? cache.value : NO_COMPANIES;
}

/** Forget what was read, so the next page load asks again. For tests: each one starts from nothing. */
export function forgetFinancerCompanies(): void {
  cache = null;
}

/**
 * The company to show for a financer's key, or null — then the page shows the
 * person, as it always has. `at` is the row's date (its purchase, its batch):
 * the company only from its `since` on. Leave `at` out ONLY where there is no
 * date at all; a row whose date is missing passes null, and keeps the person.
 */
export function companyOf(
  companies: FinancerCompanies,
  hex: string | null | undefined,
  at?: string | null,
): FinancerCompany | null {
  if (typeof hex !== 'string' || !hex) return null;
  const company = companies.get(hex.trim().toLowerCase());
  if (!company) return null;
  if (at === undefined) return company;
  const ms = parseUtcTime(at);
  return ms !== null && ms >= company.sinceMs ? company : null;
}

/** As text: the company's name where it applies, otherwise the person's name exactly as the page gives it. */
export function labelOf(
  companies: FinancerCompanies,
  hex: string | null | undefined,
  personName: string,
  at?: string | null,
): string {
  return companyOf(companies, hex, at)?.name ?? personName;
}

/** The person behind a company, in the admin pages' English. */
export function representativeText(person: string): string {
  return `representative: ${person}`;
}

export interface FinancerCompanyLookup {
  /** See companyOf. */
  companyFor: (hex: string | null | undefined, at?: string | null) => FinancerCompany | null;
  /** See labelOf. */
  labelFor: (hex: string | null | undefined, personName: string, at?: string | null) => string;
}

/** A page's one way to the companies: read when it opens, then the same answer for every place on it. */
export function useFinancerCompanies(): FinancerCompanyLookup {
  const [companies, setCompanies] = useState<FinancerCompanies>(() => knownCompanies());
  useEffect(() => {
    let alive = true;
    loadFinancerCompanies().then(found => { if (alive) setCompanies(found); });
    return () => { alive = false; };
  }, []);
  return useMemo<FinancerCompanyLookup>(() => ({
    companyFor: (hex, at) => companyOf(companies, hex, at),
    labelFor: (hex, personName, at) => labelOf(companies, hex, personName, at),
  }), [companies]);
}
