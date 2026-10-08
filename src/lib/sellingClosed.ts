import { useEffect, useState } from 'react';

/**
 * SELLING LANA ON LANA.DISCOUNT IS CLOSED (8 Oct 2026) — the client's half.
 *
 * The server refuses every step of a sale on its own (server/lib/sellingClosed.ts);
 * this constant only decides what the pages show: the notice naming the firms
 * that buy LANA now instead of the offer form, no wallet list and no field for a
 * private key to sell with. Reopening is a commit that changes both constants.
 */
export const SELLING_CLOSED = true;

/** Where the companies are listed when no firm can be named here. */
export const BEF_DIRECTORY_URL = 'https://befexplorer.com/companies';

/** One firm, as GET /api/buying-dealers names it (server/lib/buyingDealers.ts). */
export interface BuyingDealer {
  slug: string;
  name: string;
  host: string;
  website: string;
  registerUrl: string;
  sellUrl: string;
  eventId: string;
  signedAt: string;
}

export interface BuyingDealersAnswer {
  status: 'read' | 'stale' | 'unknown';
  readAt: string | null;
  staleSince: string | null;
  directoryUrl: string;
  buyers: BuyingDealer[];
}

/** A link this page will put in an href: https, to the firm's own host, nothing else. */
const linkOnHost = (url: unknown, host: string): url is string => {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host && !u.username && !u.password;
  } catch {
    return false;
  }
};

/**
 * The server's answer, taken apart defensively: a firm is shown only when its
 * name is text and every link points at https on its own host. Anything that
 * does not hold up is dropped, never repaired; a whole answer that does not
 * hold up is "unknown".
 */
export function readBuyingDealers(data: unknown): BuyingDealersAnswer {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const directoryUrl = typeof d.directoryUrl === 'string' && /^https:\/\//.test(d.directoryUrl) ? d.directoryUrl : BEF_DIRECTORY_URL;
  const buyers = (Array.isArray(d.buyers) ? d.buyers : []).filter((raw: unknown): raw is BuyingDealer => {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return typeof b.name === 'string' && b.name.trim() !== '' && typeof b.host === 'string' &&
      linkOnHost(b.registerUrl, b.host) && linkOnHost(b.sellUrl, b.host) && linkOnHost(b.website, b.host);
  });
  const status = d.status === 'read' || d.status === 'stale' ? d.status : 'unknown';
  return {
    status,
    readAt: typeof d.readAt === 'string' ? d.readAt : null,
    staleSince: typeof d.staleSince === 'string' ? d.staleSince : null,
    directoryUrl,
    buyers,
  };
}

/**
 * The firms, read once per page. `answer` is null while the request runs;
 * a failed request is an "unknown" answer, so the page still says selling is
 * closed and points at the list of companies.
 */
export function useBuyingDealers(enabled = true): BuyingDealersAnswer | null {
  const [answer, setAnswer] = useState<BuyingDealersAnswer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch('/api/buying-dealers')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (live) setAnswer(readBuyingDealers(data)); })
      .catch(() => { if (live) setAnswer(readBuyingDealers(null)); });
    return () => { live = false; };
  }, [enabled]);
  return answer;
}

export type NoticeLang = 'sl' | 'en';

/**
 * Slovenian for a reader whose browser asks for it, English otherwise. Before
 * sign-in there is no KIND 0 to read a language from, so the browser is all
 * there is; the toggle on the notice overrides it.
 */
export function defaultNoticeLang(): NoticeLang {
  try {
    const langs = typeof navigator !== 'undefined'
      ? (navigator.languages?.length ? navigator.languages : [navigator.language])
      : [];
    return langs.some(l => /^sl\b/i.test(String(l || ''))) ? 'sl' : 'en';
  } catch {
    return 'en';
  }
}
