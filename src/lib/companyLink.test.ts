// @vitest-environment node
/**
 * THE ONE RULE FOR A COMPANY'S LINK, PINNED.
 *
 * src/lib/companyLink.ts is the same file, byte for byte, in every Lana app that
 * shows a financer's company (owner, 11 Nov 2026). Its md5 (`md5 -q`) is pinned
 * here, so this copy cannot drift from the others by an edit made in one app
 * only: change the rule in every app, then every pin.
 *
 * lana.discount keeps the session's signing key in the browser, so a link that
 * ran code instead of opening a page could take it. What may come out is
 * https://<a plain public host>/ — or nothing, and then the name is plain text.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPANY_LINK_REFERRER_POLICY, COMPANY_LINK_REL, companyWebsiteUrl, isPunycodeHost, safeCompanyHost } from './companyLink';

const COMPANY_LINK_MD5 = '82b539d70cbc6ccf2de9baf2668f5905';

describe('companyLink.ts', () => {
  it('is the fleet’s copy, byte for byte', () => {
    const bytes = readFileSync(fileURLToPath(new URL('./companyLink.ts', import.meta.url)));
    expect(createHash('md5').update(bytes).digest('hex')).toBe(COMPANY_LINK_MD5);
  });

  it('links a plain public host, and only ever as https://<host>/', () => {
    expect(companyWebsiteUrl('krogmenjave.com')).toBe('https://krogmenjave.com/');
    expect(companyWebsiteUrl('  KrogMenjave.COM ')).toBe('https://krogmenjave.com/');
    expect(companyWebsiteUrl('www.ravenaplus.com')).toBe('https://www.ravenaplus.com/');
    expect(safeCompanyHost('RavenaPlus.com')).toBe('ravenaplus.com');
  });

  it('gives no link for anything that could run code, carry more than a host, or lead somewhere private', () => {
    const refused: unknown[] = [
      'javascript:alert(1)', 'data:text/html,<script>x</script>', 'https://krogmenjave.com/', 'krogmenjave.com/path',
      'krogmenjave.com:8080', 'user@krogmenjave.com', 'krogmenjave.com?x=1', 'krogmenjave.com#x',
      '127.0.0.1', '10.0.0.1', '[::1]', 'localhost', 'intranet.local', 'db.internal', 'shop.onion', 'a.test',
      '-krog.com', 'krog-.com', 'krog menjave.com', 'krogmenjave', 'krogmenjave.c0m', '',
      null, undefined, 42, { host: 'krogmenjave.com' },
    ];
    for (const host of refused) {
      expect(companyWebsiteUrl(host), String(host)).toBeNull();
    }
  });

  it('says when a host has an internationalised label, so it is shown as it is', () => {
    expect(companyWebsiteUrl('xn--krg-menjave-xyz.com')).toBe('https://xn--krg-menjave-xyz.com/');
    expect(isPunycodeHost('xn--krg-menjave-xyz.com')).toBe(true);
    expect(isPunycodeHost('krogmenjave.com')).toBe(false);
    expect(isPunycodeHost('javascript:alert(1)')).toBe(false);
  });

  it('every company link opens with no opener, no referrer and no endorsement', () => {
    expect(COMPANY_LINK_REL).toBe('noopener noreferrer nofollow');
    expect(COMPANY_LINK_REFERRER_POLICY).toBe('no-referrer');
  });
});
