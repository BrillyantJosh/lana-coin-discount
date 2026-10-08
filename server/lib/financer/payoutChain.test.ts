// @vitest-environment node
/**
 * The payout wallet on the chain (server/lib/payoutChain.ts), against fake
 * Electrum servers on 127.0.0.1 that answer as electrum1/2.lanacoin.com did on
 * 6. 10. 2026 — nothing leaves this machine. What is proven:
 *
 *   a broadcast counts as sent only when the answer is exactly the id computed
 *   here; a refusal in words (a Python repr in `result`) is "refused" only when
 *   no server holds the transaction — one that holds it is "known", as good as
 *   sent; another id, silence, a closed connection: "unknown", never "refused";
 *   no server listed: nothing is asked;
 *
 *   a refusal is FINAL only when every listed server refused it in words and
 *   every one then said it does not know it: one silent on the broadcast, or
 *   one that could not say whether it holds it, leaves it not final — that
 *   server's node may have taken it (review of 6. 10. 2026);
 *
 *   it goes to every server at once: a server whose node is down — reads
 *   answered from its own index, the broadcast never — does not keep the
 *   bytes from the next one;
 *
 *   a wallet is read in full or not at all (balance, coins, history), from the
 *   next server when one is silent;
 *
 *   raw transactions are believed only when their bytes hash to the id asked:
 *   a server that answers another transaction is caught, and the next asked.
 *
 * lana.discount (8. 10. 2026): Krog Menjave's server/tests/payoutChain.test.ts
 * (origin/main a46f618) under vitest — its runner import and paths changed.
 */
import { test, afterAll as after, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPayoutChain, replyText } from './payoutChain.ts';
import { addTx, fakeElectrumChain, newChain, rawTx, throwawayWallet } from './fakeChain.ts';
import { parentPaying, LANA } from '../../shared/lana-tx/fixtures/wallets.ts';
import { txidOfRaw } from '../../shared/lana-tx/codec.ts';

// node:test, which these tests were written for, sets no time limit; the fake servers' timeouts add up past vitest's 5 s.
vi.setConfig({ testTimeout: 60_000 });

const chain = newChain(1_068_000);
const servers: Awaited<ReturnType<typeof fakeElectrumChain>>[] = [];
const serve = async (on = chain) => {
  const s = await fakeElectrumChain(on);
  servers.push(s);
  return s;
};
after(async () => {
  for (const s of servers) await s.close();
});

const reader = (list: { host: string; port: number }[], broadcastTimeoutMs = 300) =>
  createPayoutChain({ servers: () => list, stateTimeoutMs: 300, rawTimeoutMs: 300, broadcastTimeoutMs });

test('a broadcast: the exact id — sent; refused in words and held by nobody — refused; held by a server — known; another id, silence, a closed connection — unknown', async () => {
  const a = await serve();
  const b = await serve();
  const one = reader([a.at, b.at]);
  const tx = rawTx(1_791_000_000, [{ wallet: throwawayWallet(), lanoshis: 5n * LANA }]);
  const txid = txidOfRaw(tx);

  chain.broadcast = 'refuse';
  const refused = await one.broadcast(tx, txid);
  assert.equal(refused.kind, 'refused');
  assert.equal((refused as { final: boolean }).final, true, 'both refused it, neither knows it: it did not go');
  assert.match((refused as { detail: string }).detail, /TX rejected/, 'the server’s own words, kept');

  chain.broadcast = 'other_id';
  assert.equal((await one.broadcast(tx, txid)).kind, 'unknown', 'another id is no answer anyone can read');

  chain.broadcast = 'accept';
  assert.deepEqual(await one.broadcast(tx, txid), { kind: 'accepted', server: `${a.at.host}:${a.at.port}` });
  assert.ok(chain.raws.has(txid), 'in the mempool now');

  // The node refuses it in words now — but a server holds it: it went.
  chain.broadcast = 'refuse';
  const known = await one.broadcast(tx, txid);
  assert.equal(known.kind, 'known');

  // Silence: it may have gone through.
  chain.broadcast = 'silent';
  const fresh = rawTx(1_791_000_001, [{ wallet: throwawayWallet(), lanoshis: 6n * LANA }]);
  const silent = await one.broadcast(fresh, txidOfRaw(fresh));
  assert.equal(silent.kind, 'unknown');
  chain.broadcast = 'accept';

  // A server that closes at once: the next one is asked straight away.
  a.mode.value = 'close';
  const next = await one.broadcast(fresh, txidOfRaw(fresh));
  assert.deepEqual(next, { kind: 'accepted', server: `${b.at.host}:${b.at.port}` });
  a.mode.value = 'normal';

  // None listed: nothing is asked, nothing is said to have gone.
  assert.equal((await reader([]).broadcast(fresh, txidOfRaw(fresh))).kind, 'unknown');
  // The words kept are one short line.
  assert.equal(replyText({ result: `a\nb${'x'.repeat(500)}` }).length, 200);
  assert.ok(!replyText({ error: 'a\u0000b' }).includes('\u0000'));
});

test('a wallet is read in full or not at all: balance, confirmed coins (one spent in the mempool still listed), history; the next server when one is silent', async () => {
  const quiet = await serve();
  const good = await serve();
  quiet.mode.value = 'silent';
  const wallet = throwawayWallet();
  const p1 = parentPaying(wallet, [7n * LANA, 3n * LANA], 1_791_000_000);
  addTx(chain, p1.raw, { height: 1_067_990 });
  const pending = parentPaying(wallet, [1n * LANA], 1_791_000_100);
  addTx(chain, pending.raw, 'mempool');
  const state = await reader([quiet.at, good.at]).state(wallet);
  assert.ok(state);
  assert.equal(state.server, `${good.at.host}:${good.at.port}`);
  assert.deepEqual(state.balance, { confirmed: 10n * LANA, unconfirmed: 1n * LANA });
  assert.deepEqual(
    state.unspent.map((c) => [c.txid, c.vout, c.value, c.height]).sort(),
    [
      [p1.txid, 0, 7n * LANA, 1_067_990],
      [p1.txid, 1, 3n * LANA, 1_067_990],
    ].sort(),
  );
  assert.deepEqual([state.history.get(p1.txid), state.history.get(pending.txid)], [1_067_990, 0]);
  // Nobody answers: unknown, never an empty wallet.
  assert.equal(await reader([quiet.at]).state(wallet), null);
});

test('raw transactions: only bytes that hash to the id asked; a server that answers another transaction is caught, the next one asked', async () => {
  const liar = await serve();
  const honest = await serve();
  liar.mode.value = 'wrong_tx';
  const p = parentPaying(throwawayWallet(), [2n * LANA], 1_791_000_000);
  addTx(chain, p.raw, { height: 1_067_991 });
  assert.deepEqual([...(await reader([liar.at]).rawTxs([p.txid])).entries()], [], 'never believed');
  const found = await reader([liar.at, honest.at]).rawTxs([p.txid, 'zz', p.txid]);
  assert.deepEqual([...found.entries()], [[p.txid, p.raw]]);
});

test('a refusal is final only when every server refused it in words and every one then said it does not know it — a silent or unreadable server leaves it open', async () => {
  const a = await serve();
  const b = await serve();
  const one = reader([a.at, b.at]);
  const tx = rawTx(1_791_000_200, [{ wallet: throwawayWallet(), lanoshis: 9n * LANA }]);
  const txid = txidOfRaw(tx);
  chain.broadcast = 'refuse';
  try {
    // One server silent on the broadcast (its node down, or slow — it may still take it): refused in words by the other, not final.
    a.mode.value = 'broadcast_hangs';
    const silentOne = await one.broadcast(tx, txid);
    assert.deepEqual([silentOne.kind, (silentOne as { final: boolean }).final], ['refused', false]);
    // Both refused it, but one could not say whether it holds it (it never answered transaction.get): not final.
    a.mode.value = 'get_silent';
    const unreadable = await one.broadcast(tx, txid);
    assert.deepEqual([unreadable.kind, (unreadable as { final: boolean }).final], ['refused', false]);
    // One closed at once: not final either.
    a.mode.value = 'close';
    assert.equal(((await one.broadcast(tx, txid)) as { final: boolean }).final, false);
    // Both refused it, both said they do not know it: final.
    a.mode.value = 'normal';
    const final = await one.broadcast(tx, txid);
    assert.deepEqual([final.kind, (final as { final: boolean }).final], ['refused', true]);
  } finally {
    a.mode.value = 'normal';
    chain.broadcast = 'accept';
  }
});

test('to every server at once: a first server whose broadcast hangs (its node down, its reads still answered) never keeps the bytes from the next one', async () => {
  const down = await serve();
  const healthy = await serve();
  down.mode.value = 'broadcast_hangs';
  const one = reader([down.at, healthy.at], 5000);
  const tx = rawTx(1_791_000_300, [{ wallet: throwawayWallet(), lanoshis: 4n * LANA }]);
  const txid = txidOfRaw(tx);
  // Its reads still answered: the wallet reads from it, as on 6. 10. 2026's outage of a node behind its Electrum server.
  assert.ok(await reader([down.at]).state(throwawayWallet()));
  const started = Date.now();
  const sent = await one.broadcast(tx, txid);
  assert.deepEqual(sent, { kind: 'accepted', server: `${healthy.at.host}:${healthy.at.port}` });
  assert.ok(Date.now() - started < 2500, `taken by the healthy one at once, not after the silent one's ${5000} ms`);
  assert.ok(chain.raws.has(txid));
  down.mode.value = 'normal';
});
