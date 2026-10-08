// @vitest-environment node
/**
 * sighash.ts: every input's digest commits to every input, proven on the chain.
 *
 * The strongest evidence a sighash is right is that the network accepted
 * signatures over it. For all 38 inputs of the five mainnet cases, the digest
 * computed here (with each prevout script read from its re-hashed parent) is
 * the one the input's signature verifies against, by @noble/secp256k1 and by
 * elliptic. Only public keys and public signatures are used: nothing here
 * derives, or could derive, a private key.
 *
 * Then the counter-proof: lana-pays-us's old server builder (functions.ts,
 * Q11) hashed only the input being signed while the count said n. On a
 * single-input transaction that is the same bytes, which is why it went
 * unnoticed; on every multi-input mainnet case its digest is refused by every
 * signature.
 *
 * Last, a round trip with throwaway keys: built by shape.ts, signed by
 * signature.ts (the fleet's nonce-safe signer), encoded, decoded, checked and
 * verified input by input.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import elliptic from 'elliptic';
import { bytesToHex, equalBytes } from './bytes.ts';
import { addressOfPublicKey, scriptOfAddress } from './address.ts';
import { decodeTx, encodeTx, encodeTxHex, p2pkhScriptSigHex, parseP2pkhScriptSig, SEQUENCE_FINAL, txidOfRaw, type LanaTx } from './codec.ts';
import { sighash, sighashes, sighashPreimage, SIGHASH_ALL } from './sighash.ts';
import { buildUnsignedTx, checkShape, prevoutFromRawTx } from './shape.ts';
import { feeCeiling } from './fee.ts';
import { signLanaSighash } from './signature.ts';

const ec = new elliptic.ec('secp256k1');

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};
const caseTx = (name: string) => decodeTx(mainnet.transactions[mainnet.cases.find((c) => c.name === name)!.txid]);
/** The script input i spends, read from its parent's own bytes (the parent is re-hashed to its txid first). */
const prevScript = (tx: LanaTx, i: number) =>
  prevoutFromRawTx(mainnet.transactions[tx.inputs[i].prevTxid], tx.inputs[i].prevTxid, tx.inputs[i].vout).scriptPubKeyHex;

/** Strict DER → 64-byte r ‖ s, for noble (which takes compact signatures only). */
function derToCompact(der: Uint8Array): Uint8Array {
  const lenR = der[3];
  const r = BigInt('0x' + bytesToHex(der.subarray(4, 4 + lenR)));
  const s = BigInt('0x' + bytesToHex(der.subarray(6 + lenR)));
  return Uint8Array.from(Buffer.from(r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0'), 'hex'));
}

/** Both libraries, as signature.ts verifies its own signatures. */
function verifies(der: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): { noble: boolean; elliptic: boolean } {
  return {
    noble: secp.verify(derToCompact(der), digest, publicKey, { prehash: false }),
    elliptic: ec.keyFromPublic(bytesToHex(publicKey), 'hex').verify(bytesToHex(digest), Array.from(der)),
  };
}

/**
 * The digest lana-pays-us server/routes/functions.ts @ef07a04 (buildAndSignTransaction)
 * signed: version, nTime, the input COUNT n, then ONLY input i with the script,
 * the outputs, locktime and hash type. Written out here as the shape that must
 * fail; it exists nowhere outside this test.
 */
function lpuShapeSighash(tx: LanaTx, i: number, scriptCodeHex: string): Uint8Array {
  const onlyThisInput = encodeTx({ ...tx, inputs: [{ ...tx.inputs[i], scriptSigHex: scriptCodeHex }] });
  onlyThisInput[8] = tx.inputs.length; // LPU wrote the real count as one byte
  const type = Uint8Array.of(SIGHASH_ALL, 0, 0, 0);
  return Uint8Array.from(crypto.createHash('sha256').update(crypto.createHash('sha256').update(Buffer.concat([onlyThisInput, type])).digest()).digest());
}

describe('mainnet signatures verify against these digests', () => {
  it('all 38 inputs of the five cases, by noble and by elliptic', () => {
    let inputs = 0;
    for (const c of mainnet.cases) {
      const tx = decodeTx(mainnet.transactions[c.txid]);
      for (let i = 0; i < tx.inputs.length; i++) {
        const sig = parseP2pkhScriptSig(tx.inputs[i].scriptSigHex)!;
        const v = verifies(sig.signatureDer, sighash(tx, i, prevScript(tx, i)), sig.publicKey);
        assert.deepEqual(v, { noble: true, elliptic: true }, `${c.name} input ${i}`);
        inputs++;
      }
    }
    assert.equal(inputs, 38);
  });

  it('the digest of one input does not verify another input’s signature', () => {
    const tx = caseTx('wallet-12-inputs');
    const sig0 = parseP2pkhScriptSig(tx.inputs[0].scriptSigHex)!;
    assert.deepEqual(verifies(sig0.signatureDer, sighash(tx, 1, prevScript(tx, 1)), sig0.publicKey), { noble: false, elliptic: false });
  });
});

describe('the lana-pays-us shape (one input in the preimage, count n) must not be copied', () => {
  it('on a single-input transaction it is the same digest, which is why it went unnoticed', () => {
    for (const name of ['ld-auto-send', 'ld-batch-send']) {
      const tx = caseTx(name);
      assert.equal(tx.inputs.length, 1);
      assert.ok(equalBytes(lpuShapeSighash(tx, 0, prevScript(tx, 0)), sighash(tx, 0, prevScript(tx, 0))), name);
    }
  });

  it('on every multi-input mainnet case, no signature verifies against it', () => {
    for (const name of ['ld-consolidation', 'wallet-12-inputs', 'lc-card-payment']) {
      const tx = caseTx(name);
      assert.ok(tx.inputs.length > 1);
      for (let i = 0; i < tx.inputs.length; i++) {
        const sig = parseP2pkhScriptSig(tx.inputs[i].scriptSigHex)!;
        const wrong = lpuShapeSighash(tx, i, prevScript(tx, i));
        assert.ok(!equalBytes(wrong, sighash(tx, i, prevScript(tx, i))), `${name} input ${i}`);
        assert.deepEqual(verifies(sig.signatureDer, wrong, sig.publicKey), { noble: false, elliptic: false }, `${name} input ${i}`);
      }
    }
  });
});

describe('one digest commits to every input and every output', () => {
  const base = caseTx('wallet-12-inputs');
  const script0 = prevScript(base, 0);
  const z0 = sighash(base, 0, script0);
  const changed = (mutate: (tx: LanaTx) => void) => {
    const tx: LanaTx = structuredClone(base);
    mutate(tx);
    return !equalBytes(sighash(tx, 0, script0), z0);
  };

  it('another input’s outpoint, vout or sequence changes input 0’s digest', () => {
    assert.ok(changed((tx) => (tx.inputs[5].prevTxid = '00'.repeat(32))));
    assert.ok(changed((tx) => (tx.inputs[5].vout += 1)));
    assert.ok(changed((tx) => (tx.inputs[11].sequence = 0)));
  });

  it('adding, removing or reordering inputs changes it', () => {
    assert.ok(changed((tx) => tx.inputs.pop()));
    assert.ok(changed((tx) => tx.inputs.push({ ...tx.inputs[3], vout: 99 })));
    assert.ok(changed((tx) => ([tx.inputs[1], tx.inputs[2]] = [tx.inputs[2], tx.inputs[1]])));
  });

  it('any output, nTime, version or locktime changes it', () => {
    assert.ok(changed((tx) => (tx.outputs[1].value += 1n)));
    assert.ok(changed((tx) => (tx.outputs[0].scriptPubKeyHex = tx.outputs[1].scriptPubKeyHex)));
    assert.ok(changed((tx) => tx.outputs.pop()));
    assert.ok(changed((tx) => (tx.nTime += 1)));
    assert.ok(changed((tx) => (tx.version = 2)));
    assert.ok(changed((tx) => (tx.locktime = 1)));
  });

  it('other inputs’ signatures are not in it, so the order of signing does not matter', () => {
    assert.ok(!changed((tx) => (tx.inputs[5].scriptSigHex = '')));
    assert.ok(!changed((tx) => (tx.inputs[5].scriptSigHex = tx.inputs[6].scriptSigHex)));
  });

  it('each input has its own digest', () => {
    const all = sighashes(base, base.inputs.map((_, i) => prevScript(base, i)));
    assert.equal(new Set(all.map(bytesToHex)).size, 12);
  });

  it('the preimage lists every input’s outpoint, the spent script once, and ends with the hash type', () => {
    const pre = bytesToHex(sighashPreimage(base, 0, script0));
    for (const input of base.inputs) {
      const outpoint = Buffer.from(input.prevTxid, 'hex').reverse().toString('hex') + Buffer.from(Uint32Array.of(input.vout).buffer).toString('hex');
      assert.ok(pre.includes(outpoint), `outpoint ${input.prevTxid}:${input.vout}`);
    }
    assert.equal(pre.split(script0).length - 1, 1 + base.outputs.filter((o) => o.scriptPubKeyHex === script0).length);
    assert.ok(pre.endsWith('01000000'));
    assert.equal(pre.slice(8, 16), bytesToHex(encodeTx(base).subarray(4, 8)), 'nTime is in it');
  });
});

describe('refusals', () => {
  const tx = caseTx('lc-card-payment');
  const script = prevScript(tx, 0);
  it('any hash type but SIGHASH_ALL', () => {
    for (const t of [0, 2, 3, 0x81]) assert.throws(() => sighash(tx, 0, script, t), /SIGHASH_ALL/);
  });
  it('an input index that does not exist', () => {
    for (const i of [-1, 4, 1.5]) assert.throws(() => sighash(tx, i, script), /out of range/);
  });
  it('a script that is not P2PKH', () => {
    assert.throws(() => sighash(tx, 0, script + 'ab'), /P2PKH/);
    assert.throws(() => sighash(tx, 0, `21${'02'.repeat(33)}ac`), /P2PKH/);
  });
  it('a script list that does not match the inputs', () => {
    assert.throws(() => sighashes(tx, [script]), /one prevout script per input/);
  });
});

describe('round trip with throwaway keys: build, sign with signature.ts, encode, decode, check, verify', () => {
  const NOW = 1_790_000_000;
  for (const compressed of [true, false]) {
    it(`${compressed ? 'compressed' : 'uncompressed'} key`, async () => {
      const secret = secp.utils.randomSecretKey(); // throwaway, never leaves this test
      const pub = secp.getPublicKey(secret, compressed);
      const from = addressOfPublicKey(pub);
      const to = addressOfPublicKey(secp.getPublicKey(secp.utils.randomSecretKey(), true));

      // Three parents paying `from`, each encoded and re-hashed like a fetched transaction.
      const parents = [3n, 1n, 2n].map((lana, k) =>
        encodeTxHex({
          version: 1,
          nTime: NOW - 1000 + k,
          inputs: [{ prevTxid: crypto.randomBytes(32).toString('hex'), vout: k, scriptSigHex: '', sequence: SEQUENCE_FINAL }],
          outputs: [{ value: lana * 100_000_000n, scriptPubKeyHex: scriptOfAddress(from) }],
          locktime: 0,
        }),
      );
      const coins = parents.map((raw) => prevoutFromRawTx(raw, txidOfRaw(raw), 0));
      const pay = [{ address: to, lanoshis: 450_000_000n }];
      const maxFee = feeCeiling(20, 1);
      const built = buildUnsignedTx({ from, pay, change: from, coins, nTime: NOW, maxFee });
      assert.ok(built.ok, JSON.stringify(built.ok === false && built.problems));

      const tx = built.tx;
      const digests = sighashes(tx, built.prevScriptsHex);
      for (let i = 0; i < tx.inputs.length; i++) {
        const der = await signLanaSighash(bytesToHex(secret), digests[i], pub);
        tx.inputs[i].scriptSigHex = p2pkhScriptSigHex(der, pub);
      }

      const raw = encodeTxHex(tx);
      const decoded = decodeTx(raw);
      assert.equal(encodeTxHex(decoded), raw);
      const checked = checkShape(decoded, coins, { from, pay, change: from, maxFee, nowSec: NOW, signed: true });
      assert.ok(checked.ok, JSON.stringify(checked.ok === false && checked.problems));
      assert.equal(checked.txid, txidOfRaw(raw));

      for (let i = 0; i < decoded.inputs.length; i++) {
        const sig = parseP2pkhScriptSig(decoded.inputs[i].scriptSigHex)!;
        assert.deepEqual(verifies(sig.signatureDer, sighash(decoded, i, coins[i].scriptPubKeyHex), sig.publicKey), { noble: true, elliptic: true });
      }

      // One lanoshi moved after signing: no signature holds any more.
      const tampered: LanaTx = structuredClone(decoded);
      tampered.outputs[0].value += 1n;
      tampered.outputs[1].value -= 1n;
      for (let i = 0; i < tampered.inputs.length; i++) {
        const sig = parseP2pkhScriptSig(tampered.inputs[i].scriptSigHex)!;
        assert.deepEqual(verifies(sig.signatureDer, sighash(tampered, i, coins[i].scriptPubKeyHex), sig.publicKey), { noble: false, elliptic: false });
      }
    });
  }
});
