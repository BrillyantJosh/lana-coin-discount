/**
 * A FINANCER'S COMPANY — WHAT THE ADMIN PAGES MAY SAY, AND FROM WHEN.
 *
 * Pinned: the list is read from Direct.Fund's one open address, unsigned and
 * without cookies, at most once per five minutes; every entry is checked, and
 * anything wrong — the read failing, a refusal, another shape, a bad entry —
 * gives the person, exactly as before. A dated row names the company only from
 * the company's `since` on; a row whose date is missing or unreadable keeps the
 * person; only a place with no date at all shows the company as it is now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FINANCER_COMPANIES_CACHE_MS, FINANCER_COMPANIES_URL, companyOf, forgetFinancerCompanies, labelOf,
  loadFinancerCompanies, parseFinancerCompanies, parseUtcTime, representativeText,
} from './financerCompanies';

const BORIS = '816b8dcf'.padEnd(64, '1');
const GORAZD = '4af96237'.padEnd(64, '2');
const SINCE = '2026-10-08T23:50:00Z';
const KROG = 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.';

const entry = (over: Record<string, unknown> = {}) => ({
  hex: BORIS,
  name: KROG,
  registrationNumber: '7593074000',
  taxNumber: '88629830',
  country: 'SI',
  host: 'krogmenjave.com',
  website: 'https://krogmenjave.com/',
  since: SINCE,
  ...over,
});
const answer = (companies: unknown[]) => ({ companies, checkedAt: '2026-11-11T10:00:00Z' });
const listed = parseFinancerCompanies(answer([entry()]));

describe('the list Direct.Fund answers', () => {
  it('keeps a well-formed company under its financer’s key: the name, the host, and from when', () => {
    const boris = listed.get(BORIS);
    expect(boris).toEqual({ hex: BORIS, name: KROG, host: 'krogmenjave.com', since: SINCE, sinceMs: Date.parse(SINCE) });
    expect(listed.size).toBe(1);
  });

  it('leaves out every entry that fails a check, and keeps the good ones beside them', () => {
    const companies = parseFinancerCompanies(answer([
      entry({ hex: BORIS.toUpperCase() }),
      entry({ hex: BORIS.slice(1) }),
      entry({ hex: 816 }),
      entry({ hex: 'npub1'.padEnd(64, 'q') }),
      entry({ hex: 'a'.repeat(64), name: '' }),
      entry({ hex: 'b'.repeat(64), name: '   ' }),
      entry({ hex: 'c'.repeat(64), name: 'x'.repeat(201) }),
      entry({ hex: 'd'.repeat(64), name: { legal: KROG } }),
      entry({ hex: 'e'.repeat(64), since: 'from October' }),
      entry({ hex: 'f'.repeat(64), since: undefined }),
      entry({ hex: '0'.repeat(64), since: 1760000000 }),
      null,
      'krogmenjave.com',
      [BORIS, KROG],
      entry({ hex: GORAZD, name: 'R'.repeat(200), host: 'ravenaplus.com' }),
    ]));
    expect([...companies.keys()]).toEqual([GORAZD]);
    expect(companies.get(GORAZD)?.name).toBe('R'.repeat(200));
  });

  it('a body of any other shape is no list at all', () => {
    for (const body of [null, undefined, 'companies', 42, [], {}, { companies: 'x' }, { companies: { [BORIS]: entry() } }, { offers: [] }]) {
      expect(parseFinancerCompanies(body).size, JSON.stringify(body) ?? String(body)).toBe(0);
    }
  });

  it('a key listed twice is left out altogether — which one is right cannot be told', () => {
    const companies = parseFinancerCompanies(answer([entry(), entry({ name: 'Other d.o.o.' }), entry({ hex: GORAZD })]));
    expect(companies.has(BORIS)).toBe(false);
    expect(companies.has(GORAZD)).toBe(true);
  });

  it('keeps the host only, never Direct.Fund’s `website`; a name is trimmed', () => {
    const companies = parseFinancerCompanies(answer([entry({ host: null, website: 'javascript:alert(1)', name: `  ${KROG}  ` })]));
    expect(companies.get(BORIS)).toMatchObject({ host: null, name: KROG });
    expect(JSON.stringify([...companies.values()])).not.toContain('javascript');
  });
});

describe('times as the Lana databases write them', () => {
  it('reads SQLite’s zoneless time as UTC, and a time with a zone as written', () => {
    expect(parseUtcTime('2026-10-08 23:50:00')).toBe(Date.parse(SINCE));
    expect(parseUtcTime('2026-10-08T23:50')).toBe(Date.parse(SINCE));
    expect(parseUtcTime('2026-10-09T01:50:00+02:00')).toBe(Date.parse(SINCE));
    expect(parseUtcTime(SINCE)).toBe(Date.parse(SINCE));
  });
  it('anything else is no time', () => {
    for (const at of ['', '  ', 'yesterday', null, undefined, 1760000000]) expect(parseUtcTime(at)).toBeNull();
  });
});

describe('which name a place shows', () => {
  it('a place without a date (who a financer is now) shows the company as it is now', () => {
    expect(companyOf(listed, BORIS)?.name).toBe(KROG);
    expect(labelOf(listed, BORIS, 'Boris')).toBe(KROG);
  });

  it('a dated row shows the company from its `since` on, the moment itself included — and the person before', () => {
    expect(companyOf(listed, BORIS, '2026-10-08 23:50:00')?.name).toBe(KROG);
    expect(companyOf(listed, BORIS, '2026-11-11T09:00:00Z')?.name).toBe(KROG);
    // Read as UTC, not as the browser's own time: a minute before is before, wherever the page is open.
    expect(companyOf(listed, BORIS, '2026-10-08 23:49:59')).toBeNull();
    expect(companyOf(listed, BORIS, '2026-09-10T08:00:00Z')).toBeNull();
    expect(labelOf(listed, BORIS, 'Boris', '2026-10-01 12:00:00')).toBe('Boris');
  });

  it('a row whose date is missing or unreadable keeps the person', () => {
    expect(companyOf(listed, BORIS, null)).toBeNull();
    expect(companyOf(listed, BORIS, 'soon')).toBeNull();
    expect(labelOf(listed, BORIS, 'Boris', null)).toBe('Boris');
  });

  it('a key without a company — or no key at all — is the person', () => {
    expect(companyOf(listed, GORAZD)).toBeNull();
    expect(companyOf(listed, null)).toBeNull();
    expect(companyOf(listed, undefined)).toBeNull();
    expect(companyOf(listed, '')).toBeNull();
    expect(labelOf(listed, GORAZD, 'Gorazd')).toBe('Gorazd');
    expect(labelOf(new Map(), BORIS, 'Boris')).toBe('Boris');
  });

  it('finds the company whatever the case of the key it is asked for', () => {
    expect(companyOf(listed, BORIS.toUpperCase())?.name).toBe(KROG);
  });

  it('names the person behind it in the admin pages’ English', () => {
    expect(representativeText('Boris')).toBe('representative: Boris');
  });
});

describe('reading the list', () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let reply: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => answer([entry()]) });

  beforeEach(() => {
    forgetFinancerCompanies();
    calls = [];
    reply = async () => ({ ok: true, status: 200, json: async () => answer([entry()]) });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply();
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetFinancerCompanies();
  });

  it('asks the one open address, unsigned and without a cookie — even with a signing key in this browser', async () => {
    const session = JSON.stringify({ nostrPrivateKey: '01'.repeat(32), expiresAt: Date.now() + 60_000 });
    vi.stubGlobal('localStorage', { getItem: () => session, setItem: () => {}, removeItem: () => {} });
    const companies = await loadFinancerCompanies(0);
    expect(companies.get(BORIS)?.name).toBe(KROG);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(FINANCER_COMPANIES_URL);
    expect(FINANCER_COMPANIES_URL).toBe('https://direct.lana.fund/api/public/financer-companies');
    expect(calls[0].init?.credentials).toBe('omit');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBeNull();
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('once per five minutes: every place and every page in that time shares the one answer', async () => {
    await loadFinancerCompanies(0);
    await loadFinancerCompanies(1_000);
    await loadFinancerCompanies(FINANCER_COMPANIES_CACHE_MS - 1);
    expect(calls).toHaveLength(1);
    await loadFinancerCompanies(FINANCER_COMPANIES_CACHE_MS);
    expect(calls).toHaveLength(2);
  });

  it('a read that fails in any way is an empty list — the person everywhere, never an error', async () => {
    const failures: Array<() => Promise<unknown>> = [
      async () => { throw new TypeError('Failed to fetch'); },
      async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }),
      async () => ({ ok: false, status: 500, json: async () => answer([entry()]) }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
      async () => ({ ok: true, status: 200, json: async () => ({ companies: 'soon' }) }),
      async () => ({ ok: true, status: 200, json: async () => answer([entry({ since: 'tomorrow' })]) }),
    ];
    for (const failure of failures) {
      forgetFinancerCompanies();
      reply = failure;
      const companies = await loadFinancerCompanies(0);
      expect(companies.size).toBe(0);
      expect(labelOf(companies, BORIS, 'Boris', '2026-11-11 09:00:00')).toBe('Boris');
      expect(labelOf(companies, BORIS, 'Boris')).toBe('Boris');
    }
  });
});
