// @vitest-environment node
/**
 * A payout read on the chain (server/lib/lanaTx.ts, chainPayment.ts) — the
 * transaction's own bytes, and what the Electrum servers of KIND 38888 say of
 * it — against a fake chain on 127.0.0.1 (fakeChain.ts): no network. What is
 * proven:
 *
 *   the bytes are read in the Peercoin layout, nTime after the version: a
 *   real public transaction of the LANA chain (height 1,067,325, captured on
 *   6. 10. 2026) reads whole, hashes to its own id, and its three outputs are
 *   exactly its values in lanoshis; anything but exactly one transaction —
 *   not hex, cut short, a byte too many — is refused;
 *
 *   only an exact P2PKH output to the wallet's key hash counts toward what it
 *   pays the wallet (several add up; any other script never);
 *
 *   the merkle branch reaches the block's root, at any position, odd levels
 *   repeated as Bitcoin does; a block of one transaction is its own root;
 *
 *   confirmed only when proven: the wallet's history holds it in a block, the
 *   bytes hash to the id asked, the branch reaches the header's root on the
 *   SAME server — and ANOTHER server holds that block with the same root; one
 *   server's word never confirms a payout: a lone server that makes up a header
 *   whose root is the transaction's own id (an empty branch "proves" any
 *   transaction) is "unknown", and beside an honest server the transaction is
 *   what that server says (in the mempool: "unconfirmed"); a server whose block
 *   at that height has another root vouches for nothing; confirmations = the
 *   lower tip − height + 1;
 *
 *   fail closed: pays nothing is definite (from the bytes); in the mempool or
 *   missing from the history is "unconfirmed"; "not_found" only when every
 *   server gave the −5; a silent, closing or lying server (another
 *   transaction's bytes, a branch that does not reach the root) is
 *   "unknown" — the next server is asked; no server, or a mistyped wallet or
 *   id, asks nothing and is "unknown".
 *
 * lana.discount (8. 10. 2026): Krog Menjave's server/tests/chainPayment.test.ts
 * (origin/main a46f618) under vitest — its runner import and paths changed.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createPaymentReader, isSignatureOnlyScript, lanoshisPaidToKey, machineOfAddress } from './chainPayment.ts';
import type { ElectrumServer } from './electrumSession.ts';
import { LANA, parentPaying, parentWithOutputs, throwawayAddress, throwawayWallet as keyWallet } from '../../shared/lana-tx/fixtures/wallets.ts';
import { p2pkScriptHex, scriptOfAddress } from '../../shared/lana-tx/address.ts';
import { encodeTxHex, p2pkhScriptSigHex, SEQUENCE_FINAL } from '../../shared/lana-tx/codec.ts';
import { bytesToHex } from '../../shared/lana-tx/bytes.ts';
import { lanaAddressHash160 } from './lanaAddress.ts';
import { lanoshisPaidTo, merkleRootOf, p2pkhScript, parseLanaTx, txidOfRaw } from './lanaTx.ts';
import { addTx, fakeElectrumChain, merkleOf, newChain, rawTx, throwawayWallet, type ChainMode } from './fakeChain.ts';

// node:test, which these tests were written for, sets no time limit; the fake servers' timeouts add up past vitest's 5 s.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Every fake server listens on 127.0.0.1 — one machine, by the address a connection reaches (the reader's default).
 * Where a test needs two machines, each fake stands for one of its own: told apart by its port, by this test's word.
 */
const byPort = (remoteAddress: string, server: ElectrumServer) => `${machineOfAddress(remoteAddress)}#${server.port}`;

/** A real, public transaction of the LANA chain (height 1,067,325), as blockchain.transaction.get answered it on 6. 10. 2026. */
const REAL_TX =
  '01000000865fc36a017bc6ca1707c3fd43a4ad4324d28d277c3d290ef90c12d3ae8e00396e6206bd00020000006b483045022100b073d9d43ed3f695cd49438a33ced1140637c1820748882f50b4fb49fa27ca4f02206d3363436877e1e7712b5384a2275c84423b1dde7f15ffea9c85fd318fde782101210384e3c3ce8da66522e8b001f48865288c829076b65acdb164bb619db2764526d8ffffffff030086a06e1f0000001976a914db06e13e9ca8636a28ff53d9fa27a4130cf2aa2a88ac00d6117e030000001976a914606cfa258df29a05b48b59c38f31bab8a1d6ae1488ac6412cc48650000001976a9149bf0ab820847f586fab6a9afe912b65c9cf532be88ac00000000';
const REAL_TXID = '83997c402737c5cd902c904ba3faa80f5da785fd4669614058febb81174561d7';

test('the bytes in the Peercoin layout: a real transaction reads whole, hashes to its id, its outputs exact', () => {
  const tx = parseLanaTx(REAL_TX);
  assert.equal(txidOfRaw(REAL_TX), REAL_TXID, 'sha256d of the bytes, reversed, is the id');
  assert.deepEqual([tx.version, tx.nTime, tx.inputs, tx.locktime], [1, 1_791_188_870, 1, 0], 'nTime right after the version');
  assert.deepEqual(tx.outputs.map((o) => o.lanoshis), [135_000_000_000n, 15_000_000_000n, 435_013_030_500n]);
  assert.ok(tx.outputs.every((o) => /^76a914[0-9a-f]{40}88ac$/.test(o.script)), 'every output P2PKH');
  // What it pays each output's key hash, exactly; nothing to a key hash it does not name.
  for (const o of tx.outputs) assert.equal(lanoshisPaidTo(tx, o.script.slice(6, 46)), o.lanoshis);
  assert.equal(lanoshisPaidTo(tx, '00'.repeat(20)), 0n);
  // Anything but exactly one transaction is refused.
  assert.throws(() => parseLanaTx(`${REAL_TX}00`), /trailing bytes/);
  assert.throws(() => parseLanaTx(REAL_TX.slice(0, -2)), /truncated/);
  assert.throws(() => parseLanaTx('nothex'), /not hex/);
  assert.throws(() => parseLanaTx(`${REAL_TX}0`), /not hex/);
  // A Bitcoin reader would take nTime's first byte (0x86 = 134) for the number of inputs: here it is the time.
  assert.equal(parseInt(REAL_TX.slice(8, 10), 16), 0x86);
});

test('only an exact P2PKH output to the wallet counts; several add up; the merkle branch reaches the root at any position', () => {
  const wallet = throwawayWallet();
  const other = throwawayWallet();
  const h160 = lanaAddressHash160(wallet)!;
  const raw = rawTx(1_791_300_000, [
    { wallet, lanoshis: 1_000_000_000n },
    { wallet: other, lanoshis: 7n },
    { wallet, lanoshis: 25n },
    // The same key hash in another script (pay-to-script-hash): never counted.
    { script: `a914${h160}87`, lanoshis: 999n },
  ]);
  assert.equal(lanoshisPaidTo(parseLanaTx(raw), h160), 1_000_000_025n);
  assert.equal(p2pkhScript(h160), `76a914${h160}88ac`);
  assert.equal(lanaAddressHash160(`${wallet.slice(0, -1)}${wallet.endsWith('a') ? 'b' : 'a'}`), null, 'a mistyped wallet has no key hash');
  // Merkle: one transaction is its own root; three, five — every position reaches the root.
  const id = txidOfRaw(raw);
  assert.equal(merkleRootOf(id, [], 0), id);
  for (const size of [2, 3, 5, 8]) {
    const ids = Array.from({ length: size }, (_, i) => (i === size - 1 ? id : txidOfRaw(rawTx(1_791_000_000 + i, [{ wallet: other, lanoshis: BigInt(i + 1) }]))));
    for (let pos = 0; pos < size; pos++) {
      const { root, branch } = merkleOf(ids, pos);
      assert.equal(merkleRootOf(ids[pos], branch, pos), root, `${size} transactions, position ${pos}`);
    }
    const { root, branch } = merkleOf(ids, 0);
    assert.notEqual(merkleRootOf(ids[0], branch, 1), root, 'the wrong position does not reach it');
  }
});

test('confirmed only when proven — in a block, the bytes its own, the branch reaching the header’s root, and another server holding that block', async () => {
  const chain = newChain(1_067_542);
  const wallet = throwawayWallet();
  const raw = rawTx(1_791_188_870, [{ wallet: throwawayWallet(), lanoshis: 5n }, { wallet, lanoshis: 4_725_922_131_000n }]);
  const txid = addTx(chain, raw, { height: 1_067_325, timestamp: 1_791_190_912, others: 2, pos: 2 });
  const fake = await fakeElectrumChain(chain);
  const peer = await fakeElectrumChain(chain);
  const both = (mode: ChainMode) => {
    fake.mode.value = mode;
    peer.mode.value = mode;
  };
  try {
    const reader = createPaymentReader({ servers: () => [fake.at, peer.at], timeoutMs: 1000, machineOf: byPort });
    const read = await reader.read(txid.toUpperCase(), wallet);
    // `inputs`: the address each input spends from, read from its signature script — "" for one that is no P2PKH spend
    // (the made-up input here; 6. 10. 2026, for the sales' check that the LANA came from the seller's wallet only).
    assert.deepEqual(read, { state: 'confirmed', lanoshis: 4_725_922_131_000n, height: 1_067_325, confirmations: 218, nTime: 1_791_188_870, blockTime: 1_791_190_912, inputs: [''] });
    assert.deepEqual(fake.seen.map((r) => r.method), [
      'blockchain.headers.subscribe',
      'blockchain.address.get_history',
      'blockchain.transaction.get',
      'blockchain.block.get_header',
      'blockchain.transaction.get_merkle',
    ]);
    assert.deepEqual(fake.seen[1].params, [wallet], 'the plain address (these servers have no scripthash)');
    assert.deepEqual(fake.seen[2].params, [txid], 'the id lower-cased; the raw hex is what comes back');
    // The other server is asked only for that block (and its tip): it holds the same root.
    assert.deepEqual(peer.seen.map((r) => [r.method, r.params]), [['blockchain.headers.subscribe', []], ['blockchain.block.get_header', [1_067_325]]]);
    // The same server alone: its word is not enough — unknown, try again.
    assert.deepEqual(await createPaymentReader({ servers: () => [fake.at], timeoutMs: 1000 }).read(txid, wallet), { state: 'unknown' });
    // Confirmations: the lower of the two tips.
    const ahead = await fakeElectrumChain({ ...chain, tip: chain.tip + 50 });
    try {
      const lower = await createPaymentReader({ servers: () => [ahead.at, fake.at], timeoutMs: 1000, machineOf: byPort }).read(txid, wallet);
      assert.equal(lower.state === 'confirmed' && lower.confirmations, 218);
    } finally {
      await ahead.close();
    }
    // Pays the wallet nothing: definite, from the bytes.
    const elsewhere = addTx(chain, rawTx(1_791_188_900, [{ wallet: throwawayWallet(), lanoshis: 10n }]), { height: 1_067_400 });
    assert.deepEqual(await reader.read(elsewhere, wallet), { state: 'pays_nothing', nTime: 1_791_188_900 });
    // In the mempool: unconfirmed — wait for a confirmation.
    const waiting = addTx(chain, rawTx(1_791_270_000, [{ wallet, lanoshis: 300n }]), 'mempool');
    assert.deepEqual(await reader.read(waiting, wallet), { state: 'unconfirmed', lanoshis: 300n, nTime: 1_791_270_000, inputs: [''] });
    // The history not holding it (a server that has not seen it yet): unconfirmed, never "not paid".
    both('no_history');
    assert.equal((await reader.read(txid, wallet)).state, 'unconfirmed');
    // Another transaction's bytes: unknown. A branch that does not reach the root: unknown.
    both('wrong_tx');
    assert.equal((await reader.read(txid, wallet)).state, 'unknown');
    both('bad_merkle');
    assert.equal((await reader.read(txid, wallet)).state, 'unknown');
    // The other server's block at that height has another root: it vouches for nothing — unknown.
    fake.mode.value = 'normal';
    peer.mode.value = 'other_root';
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    // The −5 of every server: not found.
    both('not_found');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'not_found' });
  } finally {
    await fake.close();
    await peer.close();
  }
});

test('one server cannot make up a confirmation: a header whose root is the transaction’s own id, with an empty branch, is never believed alone', async () => {
  const chain = newChain(1_067_542);
  const wallet = throwawayWallet();
  // Paid to the wallet, but only in the mempool — and dropped there, for all anyone knows.
  const txid = addTx(chain, rawTx(1_791_270_000, [{ wallet, lanoshis: 500_000_000_000n }]), 'mempool');
  const forger = await fakeElectrumChain(chain, { value: 'forged' });
  const honest = await fakeElectrumChain(chain);
  try {
    // The forgery itself "checks" on its own server: an empty branch at position 0 reaches the transaction's own id.
    assert.equal(merkleRootOf(txid, [], 0), txid);
    // Alone: nothing is proven.
    assert.deepEqual(await createPaymentReader({ servers: () => [forger.at], timeoutMs: 300 }).read(txid, wallet), { state: 'unknown' });
    assert.ok(forger.seen.some((r) => r.method === 'blockchain.transaction.get_merkle'), 'it was asked, and answered its forgery');
    // Beside an honest server: that block is not on the honest chain — the transaction is what the honest server says.
    const reader = createPaymentReader({ servers: () => [forger.at, honest.at], timeoutMs: 300, machineOf: byPort });
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unconfirmed', lanoshis: 500_000_000_000n, nTime: 1_791_270_000, inputs: [''] });
    // A real block at that height, without this transaction: its root is another — still unconfirmed.
    addTx(chain, rawTx(1_791_269_000, [{ wallet: throwawayWallet(), lanoshis: 1n }]), { height: chain.tip - 3, others: 3 });
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unconfirmed', lanoshis: 500_000_000_000n, nTime: 1_791_270_000, inputs: [''] });
    assert.ok(honest.seen.some((r) => r.method === 'blockchain.block.get_header' && (r.params as number[])[0] === chain.tip - 3), 'the honest server was asked for the forger’s block');
  } finally {
    await forger.close();
    await honest.close();
  }
});

test('fail closed: silent, closing — unknown; the next server is asked; not found only when every server says so; nothing asked for a mistyped id or wallet', async () => {
  const chain = newChain();
  const wallet = throwawayWallet();
  const txid = addTx(chain, rawTx(1_791_188_870, [{ wallet, lanoshis: 1_000n }]), { height: 1_067_500 });
  const first = await fakeElectrumChain(chain, { value: 'silent' });
  const second = await fakeElectrumChain(chain, { value: 'normal' });
  const third = await fakeElectrumChain(chain, { value: 'normal' });
  const all = [first, second, third];
  const modes = (...m: ChainMode[]) => all.forEach((s, i) => (s.mode.value = m[i]));
  try {
    const reader = createPaymentReader({ servers: () => all.map((s) => s.at), timeoutMs: 150, machineOf: byPort });
    // The first is silent: the second proves it, and the third holds its block.
    const read = await reader.read(txid, wallet);
    assert.equal(read.state, 'confirmed');
    assert.deepEqual(first.seen.slice(0, 3).map((r) => r.method), ['blockchain.headers.subscribe', 'blockchain.address.get_history', 'blockchain.transaction.get'], 'the first was asked');
    assert.deepEqual(third.seen.map((r) => r.method), ['blockchain.headers.subscribe', 'blockchain.block.get_header'], 'the third, only for the block');
    // Only one server answers: its word alone — unknown, try again.
    modes('silent', 'normal', 'silent');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    // Every one silent or closing: unknown — try again, never "not paid".
    modes('silent', 'silent', 'silent');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    modes('close', 'close', 'close');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    // −5 from some and silence from one: unknown — saying that no server that answered holds it. −5 from every one: not found.
    modes('not_found', 'silent', 'not_found');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown', notFoundByAllReachable: true });
    modes('not_found', 'not_found', 'not_found');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'not_found' });
    // Nothing is asked for a mistyped id or wallet, nor without servers.
    const connections = () => all.reduce((n, s) => n + s.stats.connections, 0);
    const before = connections();
    assert.deepEqual(await reader.read('nothex', wallet), { state: 'unknown' });
    assert.deepEqual(await reader.read(txid, `${wallet.slice(0, -1)}${wallet.endsWith('a') ? 'b' : 'a'}`), { state: 'unknown' });
    assert.deepEqual(await createPaymentReader({ servers: () => [], timeoutMs: 150 }).read(txid, wallet), { state: 'unknown' });
    assert.equal(connections(), before);
  } finally {
    for (const s of all) await s.close();
  }
});

test('"not found by every server that answered": −5 from some, silence from the rest — never when one answered its bytes or anything else (review of 8. 10. 2026)', async () => {
  const chain = newChain();
  const wallet = throwawayWallet();
  const txid = addTx(chain, rawTx(1_791_188_871, [{ wallet, lanoshis: 1_000n }]), { height: 1_067_500 });
  const all = [await fakeElectrumChain(chain), await fakeElectrumChain(chain), await fakeElectrumChain(chain)];
  const modes = (...m: ChainMode[]) => all.forEach((s, i) => (s.mode.value = m[i]));
  try {
    const reader = createPaymentReader({ servers: () => all.map((s) => s.at), timeoutMs: 150, machineOf: byPort });
    const reachable = { state: 'unknown', notFoundByAllReachable: true };
    // Silent, or closing on it: said nothing of the transaction.
    modes('silent', 'not_found', 'close');
    assert.deepEqual(await reader.read(txid, wallet), reachable);
    modes('not_found', 'get_silent', 'not_found');
    assert.deepEqual(await reader.read(txid, wallet), reachable);
    // One server holds its bytes and proves it, alone — the other that answers knows neither it nor its block, the
    // third is silent: not "not found".
    const elsewhere = await fakeElectrumChain(newChain());
    try {
      modes('normal', 'silent', 'silent');
      const beside = createPaymentReader({ servers: () => [elsewhere.at, all[0].at, all[1].at], timeoutMs: 150, machineOf: byPort });
      assert.deepEqual(await beside.read(txid, wallet), { state: 'unknown' });
      assert.deepEqual(await createPaymentReader({ servers: () => [elsewhere.at, all[1].at], timeoutMs: 150, machineOf: byPort }).read(txid, wallet), reachable, 'without it: −5 and silence');
    } finally {
      await elsewhere.close();
    }
    // Another transaction's bytes, a branch that does not reach the root: an answer — not silence.
    modes('not_found', 'wrong_tx', 'silent');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    modes('not_found', 'bad_merkle', 'silent');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
    // Nobody said −5: nothing is said.
    modes('silent', 'silent', 'close');
    assert.deepEqual(await reader.read(txid, wallet), { state: 'unknown' });
  } finally {
    for (const s of all) await s.close();
  }
});

test('another MACHINE, by the address its connection reached: two names of one node, or two ports of it, never confirm each other; one that does not connect vouches for nothing (electrum1 = electrum3, 8. 10. 2026; recheck of 9. 10. 2026)', async () => {
  const chain = newChain(1_067_542);
  const wallet = throwawayWallet();
  const txid = addTx(chain, rawTx(1_791_188_872, [{ wallet, lanoshis: 7_000n }]), { height: 1_067_400, others: 2, pos: 1 });
  const one = await fakeElectrumChain(chain);
  // The same node under another port: an alias that answers as it does.
  const alias = await fakeElectrumChain(chain);
  const honest = await fakeElectrumChain(chain);
  // Every name connects to the fake server on its port, whatever the name — and no name is looked up: none of these
  // resolves, so a reader that judged by its own lookup let each stand for itself (electrum3 vouched for electrum1).
  const connect = (s: ElectrumServer) => net.createConnection({ host: '127.0.0.1', port: s.port });
  const electrum1 = { host: 'electrum1.lanacoin.test', port: one.at.port };
  const electrum3 = { host: 'electrum3.lanacoin.test', port: one.at.port };
  const electrum2 = { host: 'electrum2.lanacoin.test', port: honest.at.port };
  try {
    // electrum2 silent: electrum1 proves it, and electrum3 — the same machine — would agree with anything it says.
    honest.mode.value = 'silent';
    const sameMachine = createPaymentReader({ servers: () => [electrum1, electrum2, electrum3], timeoutMs: 300, connect });
    assert.deepEqual(await sameMachine.read(txid, wallet), { state: 'unknown' }, 'one node under two names never confirms');
    assert.ok(one.seen.filter((r) => r.method === 'blockchain.block.get_header').length >= 2, 'electrum3 was asked, and answered from the same machine');
    // Another port of that machine is that machine: the port never makes it a second one.
    assert.deepEqual(await createPaymentReader({ servers: () => [one.at, alias.at], timeoutMs: 300 }).read(txid, wallet), { state: 'unknown' }, 'one node on two ports never confirms');
    // A name nothing answers for: no connection, so no word.
    const nowhere = { host: 'electrum3.invalid', port: alias.at.port };
    assert.deepEqual(await createPaymentReader({ servers: () => [one.at, nowhere], timeoutMs: 300 }).read(txid, wallet), { state: 'unknown' });
    // Two machines (each port its own, by this test's word): electrum3 is still electrum1; electrum2's word counts.
    const told = createPaymentReader({ servers: () => [electrum1, electrum2, electrum3], timeoutMs: 300, connect, machineOf: byPort });
    assert.deepEqual(await told.read(txid, wallet), { state: 'unknown' });
    honest.mode.value = 'normal';
    assert.equal((await told.read(txid, wallet)).state, 'confirmed');
    // By the address alone, every one of them is 127.0.0.1 — one machine, whichever answers.
    assert.deepEqual(await sameMachine.read(txid, wallet), { state: 'unknown' });
    // The address as one machine: an IPv4-mapped IPv6 address is the IPv4 one; case never matters.
    assert.equal(machineOfAddress('::FFFF:193.164.140.162'), '193.164.140.162');
    assert.equal(machineOfAddress('2001:DB8::1'), '2001:db8::1');
    assert.equal(machineOfAddress('193.164.140.162'), '193.164.140.162');
  } finally {
    await one.close();
    await alias.close();
    await honest.close();
  }
});

test('a coinstake — an empty first output, then <public key> OP_CHECKSIG — pays the address of that key, compressed or not, and is proven in a block like any payment (recheck of 9. 10. 2026)', async () => {
  const chain = newChain(1_067_542);
  const fake = await fakeElectrumChain(chain);
  const peer = await fakeElectrumChain(chain);
  try {
    const reader = createPaymentReader({ servers: () => [fake.at, peer.at], timeoutMs: 1000, machineOf: byPort });
    for (const compressed of [true, false]) {
      const staker = keyWallet(compressed);
      const stake = p2pkScriptHex(staker.publicKey);
      assert.equal(stake.length, compressed ? 2 + 66 + 2 : 2 + 130 + 2);
      const raw = rawTx(compressed ? 1_791_188_873 : 1_791_188_874, [{ script: '', lanoshis: 0n }, { script: stake, lanoshis: 1_234n * LANA }]);
      const txid = addTx(chain, raw, { height: compressed ? 1_067_410 : 1_067_411, others: 1, pos: 1 });
      assert.deepEqual(await reader.read(txid, staker.address), {
        state: 'confirmed', lanoshis: 1_234n * LANA, height: compressed ? 1_067_410 : 1_067_411, confirmations: compressed ? 133 : 132,
        nTime: compressed ? 1_791_188_873 : 1_791_188_874, blockTime: 1_791_190_912, inputs: [''],
      }, compressed ? 'a compressed key' : 'an uncompressed key');
      // Another key's address: nothing paid to it.
      assert.deepEqual(await reader.read(txid, throwawayWallet()), { state: 'pays_nothing', nTime: compressed ? 1_791_188_873 : 1_791_188_874 });
      // The other form of the same key is another address (another hash160): nothing paid to it either.
      const otherForm = keyWallet(!compressed, staker.privateKey);
      assert.deepEqual(await reader.read(txid, otherForm.address), { state: 'pays_nothing', nTime: compressed ? 1_791_188_873 : 1_791_188_874 });
    }
    // P2PKH and pay-to-public-key outputs of one key add up; another key's, or the same hash in another script, never.
    const key = keyWallet(true);
    const h160 = lanaAddressHash160(key.address)!;
    const tx = parseLanaTx(rawTx(1_791_188_875, [
      { script: '', lanoshis: 0n },
      { script: p2pkScriptHex(key.publicKey), lanoshis: 5n },
      { wallet: key.address, lanoshis: 7n },
      { script: p2pkScriptHex(keyWallet(true).publicKey), lanoshis: 11n },
      { script: `a914${h160}87`, lanoshis: 13n },
    ]));
    assert.equal(lanoshisPaidToKey(tx, h160), 12n);
    assert.equal(lanoshisPaidToKey(tx, h160.toUpperCase()), 12n);
    assert.equal(lanoshisPaidTo(tx, h160), 7n, 'P2PKH alone, as before');
  } finally {
    await fake.close();
    await peer.close();
  }
});

test('a pay-to-public-key input — a staking reward of the LANA desktop wallet — is read from the coin it spends: the address of that key (review of 7. 10. 2026)', async () => {
  const chain = newChain(1_067_542);
  const seller = keyWallet(true);
  const other = keyWallet(true);
  const receive = throwawayAddress();
  // A signature in strict DER (r and s made up): the reader never checks it — in a block, the chain did.
  const der = Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22)]);
  const signatureOnly = `${(der.length + 1).toString(16)}${bytesToHex(der)}01`;
  assert.equal(isSignatureOnlyScript(signatureOnly), true);
  assert.equal(isSignatureOnlyScript(p2pkhScriptSigHex(der, seller.publicKey)), false, 'a P2PKH spend names its key itself');
  assert.equal(isSignatureOnlyScript(''), false);
  // The seller's reward (paid to their PUBLIC KEY), another key's reward, and an ordinary coin of the seller's.
  const reward = parentWithOutputs([{ value: 300n * LANA, scriptPubKeyHex: p2pkScriptHex(seller.publicKey) }], 1_791_000_000);
  const theirs = parentWithOutputs([{ value: 300n * LANA, scriptPubKeyHex: p2pkScriptHex(other.publicKey) }], 1_791_000_000);
  const plain = parentPaying(seller.address, [100n * LANA], 1_791_000_000);
  addTx(chain, reward.raw, { height: 1_067_300 });
  addTx(chain, theirs.raw, { height: 1_067_301 });
  addTx(chain, plain.raw, { height: 1_067_302 });
  const spend = (inputs: { prevTxid: string; scriptSigHex: string }[], height: number) =>
    addTx(
      chain,
      encodeTxHex({
        version: 1,
        nTime: 1_791_100_000 + height,
        inputs: inputs.map((i) => ({ prevTxid: i.prevTxid, vout: 0, scriptSigHex: i.scriptSigHex, sequence: SEQUENCE_FINAL })),
        outputs: [{ value: 350n * LANA, scriptPubKeyHex: scriptOfAddress(receive) }],
        locktime: 0,
      }),
      { height },
    );
  const fake = await fakeElectrumChain(chain);
  const peer = await fakeElectrumChain(chain);
  try {
    const reader = createPaymentReader({ servers: () => [fake.at, peer.at], timeoutMs: 1000, machineOf: byPort });
    // An ordinary coin and a reward of the seller's own key: both the seller's.
    const mine = spend([{ prevTxid: plain.txid, scriptSigHex: p2pkhScriptSigHex(der, seller.publicKey) }, { prevTxid: reward.txid, scriptSigHex: signatureOnly }], 1_067_400);
    const read = await reader.read(mine, receive);
    assert.equal(read.state, 'confirmed');
    assert.deepEqual(read.state === 'confirmed' && read.inputs, [seller.address, seller.address]);
    assert.ok(fake.seen.some((r) => r.method === 'blockchain.transaction.get' && (r.params as string[])[0] === reward.txid), 'the reward read from its own transaction');
    // Another key's reward: that key's address — not the seller's.
    const foreign = spend([{ prevTxid: theirs.txid, scriptSigHex: signatureOnly }], 1_067_401);
    const readForeign = await reader.read(foreign, receive);
    assert.deepEqual(readForeign.state === 'confirmed' && readForeign.inputs, [other.address]);
    // A coin no server has, or one that is no reward (its script P2PKH): nothing is guessed — "".
    const unknownCoin = spend([{ prevTxid: 'ab'.repeat(32), scriptSigHex: signatureOnly }], 1_067_402);
    const readUnknown = await reader.read(unknownCoin, receive);
    assert.deepEqual(readUnknown.state === 'confirmed' && readUnknown.inputs, ['']);
    const notReward = spend([{ prevTxid: plain.txid, scriptSigHex: signatureOnly }], 1_067_403);
    const readNotReward = await reader.read(notReward, receive);
    assert.deepEqual(readNotReward.state === 'confirmed' && readNotReward.inputs, ['']);
  } finally {
    await fake.close();
    await peer.close();
  }
});
