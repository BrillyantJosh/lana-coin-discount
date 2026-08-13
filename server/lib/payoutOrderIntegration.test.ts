// @vitest-environment node
//
// Node, not the suite's default jsdom: fetchFinancingOrder passes an
// AbortSignal, and jsdom's AbortSignal is a different class from the one
// Node's fetch accepts — every request would fail with "Expected signal to be
// an instance of AbortSignal", the fetch would fail OPEN, and these tests
// would pass while proving nothing.

/**
 * DOES THE BLOCKING ACTUALLY WORK, END TO END?
 *
 * payoutOrder.test.ts proves the pure logic given a priority map. This one
 * proves the CHAIN that builds that map from a real Direct Fund payload:
 *
 *   HTTP /api/admin/financing-order  →  fetchFinancingOrder (+ cache)
 *     →  getFinancingRankMap  (THE SWITCH: financing_rank ?? rank)
 *       →  computeAllBlocks   (per currency, + crowd band)
 *         →  the block map the 409 guard and the GET annotations read
 *
 * Both functions are imported from routes/api.ts itself — not reimplemented —
 * so a regression in the wiring fails here even if the pure module is fine.
 * A stub Direct Fund serves rows whose registration order is the REVERSE of
 * the financing order, which is the only way to tell the two apart.
 *
 * The financing cache is module-level and keyed by currency, so each scenario
 * uses its OWN currency. Reusing one would serve the previous payload.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/** rows[currency] — what the stub Direct Fund answers for ?currency=X. */
const rows: Record<string, any[]> = {};
let server: http.Server;
let api: typeof import('../routes/api.js');

/** One financing-order row, shaped like Direct Fund's real response. */
const row = (opts: {
  hex: string; name: string; rank: number; financing_rank?: number; round?: number;
  is_last_budget?: boolean; currency: string;
}) => ({
  rank: opts.rank,
  ...(opts.financing_rank !== undefined ? { financing_rank: opts.financing_rank } : {}),
  round: opts.round ?? 1,
  nostr_hex_id: opts.hex,
  name: opts.name,
  financed_amount: 5000,
  invested_amount: 0,
  allocatable_amount: 5000,
  currency: opts.currency,
  is_last_budget: opts.is_last_budget ?? false,
  privileged: false,
  cash_only: false,
  financing_now: true,
});

/** A seller with one completed sale still owing `remaining` in `currency`. */
const seller = (hexId: string, displayName: string, currency: string, remaining: number) => ({
  hexId, displayName,
  sales: [{ status: 'completed', currency, remaining }],
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '', 'http://x');
    const cur = url.searchParams.get('currency') || '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ split: 8, currency: cur || null, order: rows[cur] || [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;

  // Read at module scope in api.ts — must be set BEFORE the import.
  process.env.DIRECT_FUND_URL = `http://127.0.0.1:${port}`;
  api = await import('../routes/api.js');
});

afterAll(() => { server?.close(); });

describe('the payout block is built from the FINANCING order, through the real chain', () => {
  it('EUR: the round 1 head blocks the earlier-registered round 2 investor', async () => {
    // The live split-8 shape: A registered first (rank 1) but their remaining
    // money is in round 2, so the allocator reaches B and C first.
    rows.EUR = [
      row({ hex: 'aa', name: 'Anze',  rank: 1, financing_rank: 3, round: 2, currency: 'EUR' }),
      row({ hex: 'bb', name: 'Bojan', rank: 2, financing_rank: 1, round: 1, currency: 'EUR' }),
      row({ hex: 'cc', name: 'Cvet',  rank: 3, financing_rank: 2, round: 1, currency: 'EUR' }),
    ];

    // The switch itself: the map must carry financing_rank, not rank.
    const { rankByHex, nameByHex } = await api.getFinancingRankMap('EUR');
    expect([...rankByHex.entries()].sort()).toEqual([['aa', 3], ['bb', 1], ['cc', 2]]);
    expect(nameByHex.get('bb')).toBe('Bojan');

    const users = [
      seller('aa', 'Anze', 'EUR', 100),
      seller('bb', 'Bojan', 'EUR', 100),
      seller('cc', 'Cvet', 'EUR', 100),
    ];
    const blocks = await api.computeAllBlocks(users);

    // Bojan finances round 1 and is head — payable.
    expect(blocks.get('bb|EUR')).toEqual({ blocked: false, blockedByHex: null, blockedByName: null });
    // Anze registered FIRST; under the old order he would have been head.
    expect(blocks.get('aa|EUR')).toEqual({ blocked: true, blockedByHex: 'bb', blockedByName: 'Bojan' });
    expect(blocks.get('cc|EUR')).toEqual({ blocked: true, blockedByHex: 'bb', blockedByName: 'Bojan' });
  });

  it('GBP: paying the head out hands the queue to the next round 1 financier', async () => {
    rows.GBP = [
      row({ hex: 'aa', name: 'Anze',  rank: 1, financing_rank: 3, round: 2, currency: 'GBP' }),
      row({ hex: 'bb', name: 'Bojan', rank: 2, financing_rank: 1, round: 1, currency: 'GBP' }),
      row({ hex: 'cc', name: 'Cvet',  rank: 3, financing_rank: 2, round: 1, currency: 'GBP' }),
    ];
    const users = [
      seller('aa', 'Anze', 'GBP', 100),
      seller('bb', 'Bojan', 'GBP', 0),     // settled → out of the queue
      seller('cc', 'Cvet', 'GBP', 100),
    ];
    const blocks = await api.computeAllBlocks(users);
    expect(blocks.get('cc|GBP')?.blocked).toBe(false);
    expect(blocks.get('aa|GBP')).toMatchObject({ blocked: true, blockedByName: 'Cvet' });
  });

  it('USD: without financing_rank it degrades to exact registration order', async () => {
    // An older Direct Fund, or a cached row from before the deploy.
    rows.USD = [
      { ...row({ hex: 'aa', name: 'Anze',  rank: 1, currency: 'USD' }), financing_rank: undefined },
      { ...row({ hex: 'bb', name: 'Bojan', rank: 2, currency: 'USD' }), financing_rank: undefined },
    ];
    const { rankByHex } = await api.getFinancingRankMap('USD');
    expect([...rankByHex.entries()].sort()).toEqual([['aa', 1], ['bb', 2]]);

    const blocks = await api.computeAllBlocks([
      seller('aa', 'Anze', 'USD', 100),
      seller('bb', 'Bojan', 'USD', 100),
    ]);
    expect(blocks.get('aa|USD')?.blocked).toBe(false);
    expect(blocks.get('bb|USD')).toMatchObject({ blocked: true, blockedByName: 'Anze' });
  });

  it('CHF: the sweeper is paid last among financiers, whatever its round', async () => {
    rows.CHF = [
      row({ hex: 'sw', name: 'Sweeper', rank: 1, financing_rank: 2, round: 1, is_last_budget: true, currency: 'CHF' }),
      row({ hex: 'bb', name: 'Bojan',   rank: 2, financing_rank: 1, round: 2, currency: 'CHF' }),
    ];
    const blocks = await api.computeAllBlocks([
      seller('sw', 'Sweeper', 'CHF', 100),
      seller('bb', 'Bojan', 'CHF', 100),
    ]);
    expect(blocks.get('bb|CHF')?.blocked).toBe(false);
    expect(blocks.get('sw|CHF')).toMatchObject({ blocked: true, blockedByName: 'Bojan' });
  });

  it('SEK: a non-financier waits for every financier, in either round', async () => {
    rows.SEK = [
      row({ hex: 'aa', name: 'Anze',  rank: 1, financing_rank: 2, round: 2, currency: 'SEK' }),
      row({ hex: 'bb', name: 'Bojan', rank: 2, financing_rank: 1, round: 1, currency: 'SEK' }),
    ];
    const blocks = await api.computeAllBlocks([
      seller('aa', 'Anze', 'SEK', 100),
      seller('bb', 'Bojan', 'SEK', 100),
      seller('zz', 'Zdenka', 'SEK', 100),   // never financed
    ]);
    expect(blocks.get('zz|SEK')).toMatchObject({ blocked: true, blockedByName: 'Bojan' });
  });

  it('NOK: a Direct Fund outage fails OPEN — nobody is frozen', async () => {
    rows.NOK = [];   // empty payload = the outage/stale-empty shape
    const blocks = await api.computeAllBlocks([
      seller('aa', 'Anze', 'NOK', 100),
      seller('bb', 'Bojan', 'NOK', 100),
    ]);
    expect(blocks.get('aa|NOK')?.blocked).toBe(false);
    expect(blocks.get('bb|NOK')?.blocked).toBe(false);
  });

  it('DKK: currencies are independent — a EUR head never blocks a DKK seller', async () => {
    rows.DKK = [row({ hex: 'dd', name: 'Dani', rank: 1, financing_rank: 1, round: 1, currency: 'DKK' })];
    const blocks = await api.computeAllBlocks([
      seller('dd', 'Dani', 'DKK', 100),
      seller('bb', 'Bojan', 'EUR', 100),   // head of another currency
    ]);
    expect(blocks.get('dd|DKK')?.blocked).toBe(false);
  });
});
