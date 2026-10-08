// @vitest-environment node
/**
 * A wallet's LANA over Electrum (server/lib/financer/electrumSession.ts), against fake Electrum
 * servers on 127.0.0.1 — nothing leaves this machine. What is proven:
 *
 *   the servers are only those of the list given (in lana.discount the
 *   kind_38888 table's, db/index.ts getElectrumServersFromDb), host and port
 *   checked;
 *
 *   the question is `blockchain.address.get_balance` with the plain LANA
 *   address — never a scripthash (the LANA servers speak the old protocol);
 *
 *   the answer is exact: the live answer of 5. 10. 2026 (283984375 lanoshi)
 *   is 2.83984375 LANA to the last digit; answers out of order go to the right
 *   address; a payment out not yet confirmed is a negative figure apart;
 *
 *   unknown is never 0: an error (a string, as these servers send it, or an
 *   object), no result, a figure that is not a whole number, a server that
 *   closes, one that is down, or one that stays silent — the address is
 *   absent; a closed connection ends the wait at once, silence at the timeout;
 *
 *   a dead first server falls over to the next, which is asked only what is
 *   still unanswered; with no server listed nothing is asked;
 *
 *   one slow address never blanks another: an answer counts (and is
 *   remembered) the moment it arrives, and a caller with a deadline gets what
 *   is known by then — each address on its own;
 *
 *   the next server has a real chance: two servers' time fits in the page's
 *   wait; a server that answered nothing is asked last for a minute (still
 *   asked when the others do not answer), then first again in its order; the
 *   server is chosen when a connection slot is free, so with five people at
 *   once and the first server silent, every balance comes within the wait;
 *
 *   answers are reused a short while (an unknown never), the same address is
 *   asked once at a time, and only a few connections are open at once.
 *
 * lana.discount (8. 10. 2026): Krog Menjave's server/tests/electrum.test.ts
 * (origin/main a46f618) under vitest. Its first test read the servers from a
 * KIND 38888 event; here it reads them from the list getElectrumServersFromDb()
 * gives, by the same rules. The rest is unchanged but for the runner import and
 * the paths.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { BALANCE_SERVER_REST_MS, BALANCE_TIMEOUT_MS, GET_BALANCE, createBalanceReader, electrumServersFrom, lanaText, readBalanceReply, type ElectrumServer } from './electrumSession.ts';

// node:test, which these tests were written for, sets no time limit; the fake servers' timeouts add up past vitest's 5 s.
vi.setConfig({ testTimeout: 60_000 });

/** Krog Menjave's page waits this long for a balance (its routes/buy.ts BALANCE_WAIT_MS): two servers' time must fit. */
const BALANCE_WAIT_MS = 6000;

const A = 'LTTDqYuL24LAcpkwPmuwB9CzfiAcdEYinK';
const B = 'LbQ1oJ6Z5w8Kf3QmTy9pXr2VuN4sA7cDeF';
const C = 'LZx9YwVu8Ts7Rq6Po5Nm4Lk3Ji2Hg1FeDc';
const D = 'LcGT73RnXXwMUUyaMoHeZnVPYTa28j9F3f';

type Request = { id: number; method: string; params: unknown[] };
type Answer = object | null | 'close';

/**
 * A minimal Electrum server: newline-delimited JSON-RPC. `answer` decides what
 * goes back for each request (null: nothing; 'close': hang up). With
 * `waitFor`, nothing is sent until that many requests arrived, and then in
 * reverse order. `delayMs` holds every answer back that long.
 */
async function fakeElectrum(answer: (request: Request) => Answer, options: { waitFor?: number; delayMs?: number } = {}) {
  const seen: Request[] = [];
  const stats = { connections: 0, open: 0, maxOpen: 0 };
  const server = net.createServer((socket) => {
    stats.connections++;
    stats.open++;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    socket.on('close', () => stats.open--);
    socket.on('error', () => {});
    let buffer = '';
    const held: object[] = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Request;
        seen.push(request);
        const reply = answer(request);
        // Hang up — after whatever was already answered.
        if (reply === 'close') return void socket.end(held.splice(0).map((r) => `${JSON.stringify(r)}\n`).join(''));
        if (reply) held.push(reply);
      }
      if (options.waitFor && seen.length < options.waitFor) return;
      const out = options.waitFor ? held.splice(0).reverse() : held.splice(0);
      const send = () => socket.writable && socket.write(out.map((r) => `${JSON.stringify(r)}\n`).join(''));
      if (out.length === 0) return;
      if (options.delayMs) setTimeout(send, options.delayMs);
      else send();
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  return { server, seen, stats, at: { host: '127.0.0.1', port } as ElectrumServer, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A port nothing listens on: connecting is refused. */
async function deadServer(): Promise<ElectrumServer> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { host: '127.0.0.1', port };
}

const balanceOf = (lanoshi: Record<string, [number, number]>) => (request: Request) => {
  const address = String(request.params[0]);
  const figures = lanoshi[address];
  return figures ? { id: request.id, result: { confirmed: figures[0], unconfirmed: figures[1] } } : null;
};

test('the servers are only those of the list given — getElectrumServersFromDb()’s — host and port checked', () => {
  // What db/index.ts gives today: the newest kind_38888 row's list, ports parsed, or its fallback of three.
  assert.deepEqual(electrumServersFrom([
    { host: 'electrum1.lanacoin.com', port: 5097 },
    { host: 'electrum2.lanacoin.com', port: 5097 },
  ]), [
    { host: 'electrum1.lanacoin.com', port: 5097 },
    { host: 'electrum2.lanacoin.com', port: 5097 },
  ], 'Split 9 as published');
  assert.deepEqual(electrumServersFrom(null), [], 'no list: no server');
  assert.deepEqual(electrumServersFrom('electrum1.lanacoin.com:5097'), [], 'not a list: no server');
  assert.deepEqual(electrumServersFrom([{ host: 'e.example', port: '5097' }, { host: 'f.example', port: 50002 }]), [
    { host: 'e.example', port: 5097 },
    { host: 'f.example', port: 50002 },
  ], 'a port as digits or as a number');
  const bad = [
    { host: 'bad host', port: 5097 },
    { host: 'x.example', port: 0 },
    { host: 'x.example', port: 70000 },
    { host: 'x.example', port: '' },
    { host: 'x.example' },
    { host: 'x.example', port: NaN },
    { host: 'x.example', port: '50 97' },
    { host: 'http://x.example', port: 5097 },
    null,
    'x.example:5097',
    { host: 'X.Example', port: 5097 },
    { host: 'x.example', port: 5097 },
  ];
  assert.deepEqual(electrumServersFrom(bad), [{ host: 'x.example', port: 5097 }], 'a malformed host or port is not used; one server once');
  const many = Array.from({ length: 12 }, (_, i) => ({ host: `e${i}.example`, port: 5097 }));
  assert.equal(electrumServersFrom(many).length, 8, 'at most eight servers');
});

test('the question is blockchain.address.get_balance with the plain address; the live answer comes through to the last lanoshi', async () => {
  const fake = await fakeElectrum(balanceOf({ [A]: [283984375, 0] }));
  try {
    const reader = createBalanceReader({ servers: () => [fake.at] });
    const got = await reader.balances([A]);
    assert.deepEqual(got.get(A), { confirmed: 283984375n, unconfirmed: 0n });
    assert.equal(lanaText(got.get(A)!.confirmed), '2.83984375', '283984375 lanoshi = 2.83984375 LANA, nothing rounded');
    assert.deepEqual(fake.seen, [{ id: 1, method: 'blockchain.address.get_balance', params: [A] }]);
    assert.equal(GET_BALANCE, 'blockchain.address.get_balance');
    assert.ok(fake.seen.every((r) => !/scripthash/.test(r.method)), 'never a scripthash: the LANA servers answer "unknown method"');
  } finally {
    await fake.close();
  }
  assert.equal(lanaText(1n), '0.00000001');
  assert.equal(lanaText(0n), '0.00000000');
  assert.equal(lanaText(-50000000n), '-0.50000000');
  assert.equal(lanaText(2_100_000_000_000_000n), '21000000.00000000');
});

test('answers out of order go to the right address; a payment out not yet confirmed is its own negative figure', async () => {
  const fake = await fakeElectrum(balanceOf({ [A]: [100_000_000, 0], [B]: [250_000_000, -50_000_000], [C]: [7, 3] }), { waitFor: 3 });
  try {
    const got = await createBalanceReader({ servers: () => [fake.at] }).balances([A, B, C, A]);
    assert.deepEqual(fake.seen.map((r) => r.params[0]), [A, B, C], 'each address asked once');
    assert.deepEqual(got.get(A), { confirmed: 100_000_000n, unconfirmed: 0n });
    assert.deepEqual(got.get(B), { confirmed: 250_000_000n, unconfirmed: -50_000_000n });
    assert.deepEqual(got.get(C), { confirmed: 7n, unconfirmed: 3n });
  } finally {
    await fake.close();
  }
});

test('an error, no result, or anything but two whole numbers is unknown — absent, never 0', async () => {
  const replies: Record<string, (id: number) => object> = {
    [A]: (id) => ({ id, error: 'startswith first arg must be str, unicode, or tuple, not NoneType' }),
    [B]: (id) => ({ id, error: { code: 1, message: 'bad' } }),
    [C]: (id) => ({ id, result: { confirmed: 1.5, unconfirmed: 0 } }),
    [D]: (id) => ({ id, result: { confirmed: '500', unconfirmed: 0 } }),
  };
  const fake = await fakeElectrum((r) => replies[String(r.params[0])]?.(r.id) ?? null);
  try {
    const got = await createBalanceReader({ servers: () => [fake.at], timeoutMs: 1500 }).balances([A, B, C, D]);
    assert.equal(got.size, 0, 'nothing turned into 0');
  } finally {
    await fake.close();
  }
  assert.equal(readBalanceReply(undefined), null);
  assert.equal(readBalanceReply({ result: null }), null);
  assert.equal(readBalanceReply({ result: { confirmed: 5 } }), null, 'both figures, or none');
  assert.equal(readBalanceReply({ result: { confirmed: 2 ** 53, unconfirmed: 0 } }), null, 'beyond an exact whole number');
  assert.equal(readBalanceReply({ result: { confirmed: -1, unconfirmed: 0 } }), null, 'a confirmed balance below 0');
  assert.equal(readBalanceReply({ result: { confirmed: 5, unconfirmed: 0 }, error: 'x' }), null);
  assert.deepEqual(readBalanceReply({ result: { confirmed: 5, unconfirmed: -2 }, error: null }), { confirmed: 5n, unconfirmed: -2n });
});

test('a server that hangs up ends the wait at once; silence ends at the timeout — nothing known either way', async () => {
  const closing = await fakeElectrum(() => 'close');
  try {
    const started = Date.now();
    const got = await createBalanceReader({ servers: () => [closing.at], timeoutMs: 4000 }).balances([A]);
    assert.equal(got.size, 0);
    assert.ok(Date.now() - started < 1500, `a closed connection is not waited out (${Date.now() - started} ms)`);
  } finally {
    await closing.close();
  }
  const silent = await fakeElectrum(() => null);
  try {
    const started = Date.now();
    const got = await createBalanceReader({ servers: () => [silent.at], timeoutMs: 300 }).balances([A]);
    const took = Date.now() - started;
    assert.equal(got.size, 0);
    assert.ok(took >= 280 && took < 2000, `silence ends at the timeout (${took} ms)`);
  } finally {
    await silent.close();
  }
});

test('a dead first server falls over to the next, which is asked only what is still unanswered; no server listed — nothing asked', async () => {
  const dead = await deadServer();
  const second = await fakeElectrum(balanceOf({ [A]: [42, 0] }));
  try {
    const got = await createBalanceReader({ servers: () => [dead, second.at], timeoutMs: 2000 }).balances([A]);
    assert.deepEqual(got.get(A), { confirmed: 42n, unconfirmed: 0n });
  } finally {
    await second.close();
  }
  // The first answers A and hangs up; the second is asked for B only.
  const first = await fakeElectrum((r) => (r.params[0] === A ? { id: r.id, result: { confirmed: 1, unconfirmed: 0 } } : 'close'));
  const next = await fakeElectrum(balanceOf({ [A]: [999, 0], [B]: [2, 0] }));
  try {
    const got = await createBalanceReader({ servers: () => [first.at, next.at], timeoutMs: 2000 }).balances([A, B]);
    assert.deepEqual([got.get(A)?.confirmed, got.get(B)?.confirmed], [1n, 2n]);
    assert.deepEqual(next.seen.map((r) => r.params[0]), [B], 'what was answered is not asked again');
  } finally {
    await first.close();
    await next.close();
  }
  let connected = 0;
  const none = createBalanceReader({ servers: () => [], connect: () => (connected++, new net.Socket()) });
  assert.equal((await none.balances([A])).size, 0);
  assert.equal(connected, 0, 'no server in KIND 38888: nothing is asked, every balance unknown');
});

test('answers are reused a short while, an unknown never; one question per address at a time; only LANA addresses are asked', async () => {
  let clock = 1_000_000;
  let up = true;
  const fake = await fakeElectrum((r) => (up ? { id: r.id, result: { confirmed: 5, unconfirmed: 0 } } : null), { delayMs: 50 });
  try {
    const reader = createBalanceReader({ servers: () => [fake.at], timeoutMs: 400, cacheMs: 30_000, now: () => clock });
    await Promise.all([reader.balances([A]), reader.balances([A]), reader.balances([A])]);
    assert.equal(fake.stats.connections, 1, 'the same address asked at once: one question');
    clock += 29_000;
    assert.equal((await reader.balances([A])).get(A)?.confirmed, 5n);
    assert.equal(fake.stats.connections, 1, 'within 30 s: from memory');
    clock += 2_000;
    up = false;
    assert.equal((await reader.balances([A])).size, 0, 'after 30 s asked again — and silence is unknown');
    assert.equal(fake.stats.connections, 2);
    assert.equal((await reader.balances([A])).size, 0);
    assert.equal(fake.stats.connections, 3, 'an unknown is never kept: asked again');
    await reader.balances(['not an address', 'L0OIl', '']);
    assert.equal(fake.stats.connections, 3, 'nothing but a LANA address is ever asked');
  } finally {
    await fake.close();
  }
});

test('asked fresh (a wallet to be registered must be empty now): never from memory, never joined to a question already on its way', async () => {
  let clock = 1_000_000;
  let lanoshi = 0;
  const fake = await fakeElectrum((r) => ({ id: r.id, result: { confirmed: lanoshi, unconfirmed: 0 } }), { delayMs: 50 });
  try {
    const reader = createBalanceReader({ servers: () => [fake.at], timeoutMs: 400, cacheMs: 30_000, now: () => clock });
    assert.equal((await reader.balances([A])).get(A)?.confirmed, 0n);
    lanoshi = 400_000;
    clock += 1_000;
    assert.equal((await reader.balances([A])).get(A)?.confirmed, 0n, 'a plain question: the 0 remembered');
    assert.equal(fake.stats.connections, 1);
    assert.equal((await reader.balances([A], { fresh: true })).get(A)?.confirmed, 400_000n, 'fresh: asked anew');
    assert.equal(fake.stats.connections, 2);
    assert.equal((await reader.balances([A])).get(A)?.confirmed, 400_000n, 'and what it learned is remembered');
    assert.equal(fake.stats.connections, 2);
    // A question already on its way may have been asked before the LANA arrived: a fresh one does not wait for its answer.
    clock += 60_000;
    const plain = reader.balances([A]);
    const fresh = reader.balances([A], { fresh: true });
    await Promise.all([plain, fresh]);
    assert.equal(fake.stats.connections, 4, 'its own question');
  } finally {
    await fake.close();
  }
});

test('only a few connections are open at once, across everyone', async () => {
  const fake = await fakeElectrum((r) => ({ id: r.id, result: { confirmed: 1, unconfirmed: 0 } }), { delayMs: 80 });
  try {
    // Counted where the connections are made: a socket is open until this side destroys it.
    const sockets: net.Socket[] = [];
    let most = 0;
    const connect = (server: ElectrumServer) => {
      const socket = net.createConnection({ host: server.host, port: server.port });
      sockets.push(socket);
      most = Math.max(most, sockets.filter((s) => !s.destroyed).length);
      return socket;
    };
    const reader = createBalanceReader({ servers: () => [fake.at], maxConcurrent: 2, connect });
    const got = await Promise.all([A, B, C, D].map((address) => reader.balances([address])));
    assert.ok(got.every((m) => m.size === 1));
    assert.equal(sockets.length, 4);
    assert.equal(most, 2, 'at most 2 at once — and 2 were used');
    assert.ok(sockets.every((s) => s.destroyed), 'every connection closed');
  } finally {
    await fake.close();
  }
});

test('one slow address never blanks another: an answer counts the moment it arrives, and a deadline returns what is known by then', async () => {
  // The server answers A at once and never B, on the same connection.
  const fake = await fakeElectrum(balanceOf({ [A]: [283984375, 0] }));
  try {
    const reader = createBalanceReader({ servers: () => [fake.at], timeoutMs: 1200 });
    const started = Date.now();
    const got = await reader.balances([A, B], { waitMs: 250 });
    const took = Date.now() - started;
    assert.deepEqual([...got.keys()], [A], 'A known, B unknown — absent, never 0');
    assert.deepEqual(got.get(A), { confirmed: 283984375n, unconfirmed: 0n });
    assert.ok(took >= 200 && took < 900, `the deadline, not the server's whole time (${took} ms)`);
    // A is remembered at once — while the connection still waits for B.
    const again = await reader.balances([A], { waitMs: 50 });
    assert.equal(again.get(A)?.confirmed, 283984375n);
    assert.equal(fake.stats.connections, 1, 'from memory: no new question');
    // Without a deadline the caller waits for every address to settle.
    const whole = Date.now();
    const all = await reader.balances([A, C]);
    assert.deepEqual([...all.keys()], [A]);
    assert.ok(Date.now() - whole >= 1000, 'without waitMs: until C settles (unknown at the timeout)');
  } finally {
    await fake.close();
  }
});

test('the next server has a real chance: two fit in the page’s wait; a server that answered nothing is asked last for a minute', async () => {
  assert.ok(BALANCE_TIMEOUT_MS * 2 <= BALANCE_WAIT_MS, `two servers' time (${BALANCE_TIMEOUT_MS} ms each) fits in the page's wait (${BALANCE_WAIT_MS} ms)`);
  let clock = 1_000_000;
  let firstUp = false;
  let secondUp = true;
  const first = await fakeElectrum((r) => (firstUp ? { id: r.id, result: { confirmed: 1, unconfirmed: 0 } } : null));
  const second = await fakeElectrum((r) => (secondUp ? { id: r.id, result: { confirmed: 2, unconfirmed: 0 } } : null));
  try {
    const reader = createBalanceReader({ servers: () => [first.at, second.at], timeoutMs: 300, cacheMs: 1, now: () => clock });
    const timed = async (address: string) => {
      const started = Date.now();
      const got = await reader.balances([address]);
      return { confirmed: got.get(address)?.confirmed ?? null, took: Date.now() - started };
    };
    // The first is silent: waited out once, the second answers.
    const one = await timed(A);
    assert.equal(one.confirmed, 2n);
    assert.ok(one.took >= 280, `the silent server waited out once (${one.took} ms)`);
    assert.equal(first.stats.connections, 1);
    // Within the minute the silent server is asked last: nobody waits for it first.
    clock += 1000;
    const two = await timed(B);
    assert.equal(two.confirmed, 2n);
    assert.ok(two.took < 250, `the answering server first (${two.took} ms)`);
    assert.equal(first.stats.connections, 1, 'the resting server not asked while the other answers');
    // Resting is not dropped: when the others do not answer, it is still asked.
    clock += 1000;
    secondUp = false;
    firstUp = true;
    const three = await timed(C);
    assert.equal(three.confirmed, 1n, 'asked last — and its answer counts');
    assert.equal(first.stats.connections, 2);
    // It answered: back in its place. The other answered nothing: it rests now.
    clock += 1000;
    const four = await timed(D);
    assert.equal(four.confirmed, 1n);
    assert.ok(four.took < 250, `the server that answered is first again (${four.took} ms)`);
    // After the minute the order of KIND 38888 again.
    clock += BALANCE_SERVER_REST_MS + 1;
    secondUp = true;
    const connections = second.stats.connections;
    await timed(A);
    assert.equal(first.stats.connections, 4, 'the first, in its place');
    assert.equal(second.stats.connections, connections, 'it answered: the second not needed');
  } finally {
    await first.close();
    await second.close();
  }
});

test('five people at once while the first server is silent: every balance within the page’s wait, and the fifth does not wait for the silent one', async () => {
  const E = 'LhELDsp1it9AbcDEFghiJKLmnoPQRstu';
  const silent = await fakeElectrum(() => null);
  const second = await fakeElectrum((r) => ({ id: r.id, result: { confirmed: 7, unconfirmed: 0 } }));
  try {
    // 1:10 of production: 250 ms a server (2.5 s), the page waits 600 ms (6 s), 4 connections at once.
    const reader = createBalanceReader({ servers: () => [silent.at, second.at], timeoutMs: 250, maxConcurrent: 4 });
    const started = Date.now();
    const got = await Promise.all([A, B, C, D, E].map((address) => reader.balances([address], { waitMs: 600 })));
    const took = Date.now() - started;
    assert.deepEqual(got.map((m) => m.size), [1, 1, 1, 1, 1], 'every one of the five has a balance');
    assert.ok(took < 600, `within the page's wait (${took} ms)`);
    assert.equal(silent.stats.connections, 4, 'the fifth, given a slot after the silence was found, asked the answering server first');
  } finally {
    await silent.close();
    await second.close();
  }
});
