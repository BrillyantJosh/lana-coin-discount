// @vitest-environment node
/**
 * THE EXACT BALANCE MUST SURVIVE THE JOURNEY OUT OF ELECTRUM.
 *
 * `fetchBatchBalances` has always answered in LANA rounded to two decimals —
 * a display figure. On 10 Sept 2026 that figure was gating money: the route
 * decided whether a wallet was being emptied from it, and handed the chain an
 * EXACT ceiling computed from it. Rounding to 0.01 LANA is rounding to a
 * million lanoshis, roughly six network fees, so the two disagreed and a
 * transfer that would have worked became a permanent refusal.
 *
 * The chain's own integer was there all along, in the same reply. This file
 * puts a real socket in front of a real parse and proves it comes through
 * unrounded, and that the rounded figure is still printed beside it for the
 * displays that have always read it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { fetchBatchBalances } from './electrum';
import { verifiedBalanceReading, verifiedBalanceLanoshis } from '../routes/acquisitions';

/** Mitja Opalk's wallet, 10 September 2026. */
const W = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const EXACT_LANOSHIS = 326_179_687_500;   // 3,261.796875 LANA
const PRINTED_LANA = 3261.8;              // what two decimals make of it

/** An electrum that answers `blockchain.address.get_balance` and nothing else. */
function fakeElectrum(reply: (address: string) => any) {
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        socket.write(JSON.stringify({ id: req.id, result: reply(req.params[0]) }) + '\n');
      }
    });
  });
  return new Promise<{ host: string; port: number; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    }));
  });
}

const open: Array<() => void> = [];
afterAll(() => { for (const close of open) close(); });

const ask = async (reply: (address: string) => any, addresses = [W]) => {
  const s = await fakeElectrum(reply);
  open.push(s.close);
  return fetchBatchBalances([{ host: s.host, port: s.port }], addresses);
};

describe('fetchBatchBalances carries the chain\'s own integer, not only the printed figure', () => {
  it('the production wallet comes back to the lanoshi', async () => {
    const [b] = await ask(() => ({ confirmed: EXACT_LANOSHIS, unconfirmed: 0 }));
    expect(b.balanceLanoshis).toBe(EXACT_LANOSHIS);
    expect(b.confirmedLanoshis).toBe(EXACT_LANOSHIS);
    expect(b.unconfirmedLanoshis).toBe(0);
    // The printed figure is unchanged — and 312,500 lanoshis adrift, which is
    // what a sweep ceiling used to be computed from.
    expect(b.balance).toBe(PRINTED_LANA);
    expect(Math.round(b.balance * 100_000_000) - EXACT_LANOSHIS).toBe(312_500);
  });

  it('unconfirmed coins are counted in both figures', async () => {
    const [b] = await ask(() => ({ confirmed: EXACT_LANOSHIS, unconfirmed: 173_700 }));
    expect(b.balanceLanoshis).toBe(EXACT_LANOSHIS + 173_700);
    expect(b.unconfirmedLanoshis).toBe(173_700);
    // A top-up of exactly the network fee. The printed figure cannot see it.
    expect(b.balance).toBe(PRINTED_LANA);
  });

  it('an answer that is not two numbers carries no exact figure at all', async () => {
    const [b] = await ask(() => ({ confirmed: 'lots', unconfirmed: 0 }));
    expect(b.balanceLanoshis).toBeUndefined();
  });
});

describe('verifiedBalanceReading — what may gate money, and what may not', () => {
  const entry = (over: Record<string, unknown>) => [{ wallet_id: W, balance: PRINTED_LANA, status: 'active', ...over }] as any;

  it('the exact integer is preferred and marked exact', () => {
    const r = verifiedBalanceReading(entry({ balanceLanoshis: EXACT_LANOSHIS }), W);
    expect(r).toEqual({ lanoshis: EXACT_LANOSHIS, exact: true });
  });

  it('without it, the printed figure is used and marked as NOT exact', () => {
    const r = verifiedBalanceReading(entry({}), W);
    expect(r).toEqual({ lanoshis: 326_180_000_000, exact: false });
    // 0.003125 LANA out — the whole of the dead band.
    expect(r!.lanoshis - EXACT_LANOSHIS).toBe(312_500);
  });

  it('still fails closed on every answer that does not state THIS wallet\'s balance', () => {
    expect(verifiedBalanceReading(entry({ error: 'No response' }), W)).toBeNull();
    expect(verifiedBalanceReading([], W)).toBeNull();
    expect(verifiedBalanceReading(entry({ wallet_id: 'LSomeoneElse' }), W)).toBeNull();
    expect(verifiedBalanceReading(entry({ balance: 'n/a' }), W)).toBeNull();
    expect(verifiedBalanceReading(null, W)).toBeNull();
  });

  it('an unreadable exact figure falls back rather than throwing the whole reading away', () => {
    const r = verifiedBalanceReading(entry({ balanceLanoshis: Number.NaN }), W);
    expect(r).toEqual({ lanoshis: 326_180_000_000, exact: false });
  });

  it('the plain-number form the displays use is unchanged', () => {
    expect(verifiedBalanceLanoshis(entry({ balanceLanoshis: EXACT_LANOSHIS }), W)).toBe(EXACT_LANOSHIS);
    expect(verifiedBalanceLanoshis([], W)).toBeNull();
  });
});
