// @vitest-environment node
/**
 * A SLOW ANSWER IS STILL AN ANSWER.
 *
 * connectElectrum set an 8-second socket timeout to bound connecting, and never
 * took it off. Every call therefore had an 8-second IDLE limit: an electrum that
 * took nine seconds to answer a broadcast had its socket destroyed under it,
 * the call waited out its own 45 seconds, and the caller reported a failure for
 * a transaction the network had already taken. Found by the review of the
 * consolidation route, 13 Sept 2026; the transfer route broadcasts the same way.
 */
import { describe, it, expect } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { electrumCall } from './electrum';

function server(onRequest: (socket: net.Socket, req: any) => void) {
  const srv = net.createServer(socket => {
    socket.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) onRequest(socket, JSON.parse(line));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise<{ host: string; port: number; close: () => void }>(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({
      host: '127.0.0.1', port: (srv.address() as AddressInfo).port, close: () => srv.close(),
    }));
  });
}

describe('electrumCall', () => {
  it('waits for an answer slower than the 8-second connect limit', async () => {
    const txid = 'ab'.repeat(32);
    const e = await server((socket, req) => {
      setTimeout(() => { if (!socket.destroyed) socket.write(JSON.stringify({ id: req.id, result: txid }) + '\n'); }, 9_000);
    });
    try {
      await expect(electrumCall('blockchain.transaction.broadcast', ['00'], [e], 20_000)).resolves.toBe(txid);
    } finally {
      e.close();
    }
  }, 25_000);

  it('a connection closed without an answer fails at once, not after the full timeout', async () => {
    const e = await server(socket => { socket.destroy(); });
    const started = Date.now();
    try {
      await expect(electrumCall('blockchain.address.get_balance', ['x'], [e], 20_000)).rejects.toThrow(/closed before answering/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      e.close();
    }
  });
});
