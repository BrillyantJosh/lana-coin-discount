import { vi } from 'vitest';
import type { BuyingDealersAnswer } from '@/lib/sellingClosed';

/**
 * GET /api/buying-dealers as it answered on 8 Oct 2026, read from the relays:
 * the two BEF dealers whose own signed KIND 30972 says they buy LANA.
 */
export const TWO_FIRMS: BuyingDealersAnswer = {
  status: 'read',
  readAt: '2026-10-08T12:00:00.000Z',
  staleSince: null,
  directoryUrl: 'https://befexplorer.com/companies',
  buyers: [
    {
      slug: 'krog-menjave', name: 'Krog menjave, trgovanje in kroženje vrednosti d.o.o.', host: 'krogmenjave.com',
      website: 'https://krogmenjave.com/', registerUrl: 'https://krogmenjave.com/prijava',
      sellUrl: 'https://krogmenjave.com/ko-kreacija/prodaj', eventId: '1'.repeat(64), signedAt: '2026-10-05T15:31:00.000Z',
    },
    {
      slug: 'ravena-plus', name: 'Ravena Plus d.o.o.', host: 'ravenaplus.com',
      website: 'https://ravenaplus.com/', registerUrl: 'https://ravenaplus.com/prijava',
      sellUrl: 'https://ravenaplus.com/ko-kreacija/prodaj', eventId: '2'.repeat(64), signedAt: '2026-10-08T08:12:00.000Z',
    },
  ],
};

export const NO_FIRM: BuyingDealersAnswer = {
  status: 'unknown', readAt: null, staleSince: null, directoryUrl: 'https://befexplorer.com/companies', buyers: [],
};

/**
 * fetch, answering /api/buying-dealers with `dealers` and every other URL with
 * `other(url)` (an empty object by default; undefined makes that request fail).
 * `dealers: 'fail'` makes that one request fail, `'hang'` leaves it open.
 */
export function stubFetch(dealers: BuyingDealersAnswer | 'fail' | 'hang', other: (url: string) => unknown = () => ({})) {
  const fn = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/buying-dealers')) {
      if (dealers === 'fail') return Promise.reject(new Error('offline'));
      if (dealers === 'hang') return new Promise(() => { /* never */ });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(dealers) } as Response);
    }
    const body = other(u);
    // undefined: that request fails, as on a page whose other sources are down.
    if (body === undefined) return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
