// @vitest-environment node
/**
 * codec.ts on mainnet bytes, and on every way bytes can be wrong.
 *
 * The fixture holds 38 public mainnet transactions (shared/lana-tx/fixtures/,
 * fetched read-only with blockchain.transaction.get and identical on both
 * Electrum servers): a lana.discount auto-send with 99 outputs, a manual batch,
 * a 20-input consolidation, a 12-input wallet transfer, a card.lanapays.us
 * payment, and every transaction those spend. For all 38: decode, then encode,
 * gives the same bytes, and the txid recomputed from them is the id the chain
 * knows them by.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addressOfPublicKey } from './address.ts';
import {
  decodeTx,
  encodeTx,
  encodeTxHex,
  encodeVarint,
  isStrictDer,
  MAX_VALUE,
  outpointKey,
  p2pkhScriptSigHex,
  parseP2pkhScriptSig,
  SEQUENCE_FINAL,
  SIGHASH_ALL,
  txidOf,
  txidOfRaw,
  type LanaTx,
} from './codec.ts';

interface MainnetCase {
  name: string;
  txid: string;
  from: string;
}
const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: MainnetCase[];
  transactions: Record<string, string>;
};
const raw = (name: string) => mainnet.transactions[mainnet.cases.find((c) => c.name === name)!.txid];

/** A small valid transaction to break in controlled ways. */
function sampleTx(): LanaTx {
  return {
    version: 1,
    nTime: 1_790_000_000,
    inputs: [{ prevTxid: 'ab'.repeat(32), vout: 3, scriptSigHex: '', sequence: SEQUENCE_FINAL }],
    outputs: [{ value: 123_456_789n, scriptPubKeyHex: `76a914${'11'.repeat(20)}88ac` }],
    locktime: 0,
  };
}

describe('mainnet transactions', () => {
  it('the fixture holds the five cases and every transaction they spend', () => {
    assert.equal(mainnet.cases.length, 5);
    assert.equal(Object.keys(mainnet.transactions).length, 38);
    for (const c of mainnet.cases) {
      for (const input of decodeTx(mainnet.transactions[c.txid]).inputs) {
        assert.ok(mainnet.transactions[input.prevTxid], `${c.name}: spent transaction ${input.prevTxid} is in the fixture`);
      }
    }
  });

  it('decode then encode gives back the same bytes, for all 38', () => {
    for (const [txid, hex] of Object.entries(mainnet.transactions)) {
      const tx = decodeTx(hex);
      assert.equal(encodeTxHex(tx), hex, txid);
      assert.deepEqual(encodeTx(decodeTx(encodeTx(tx))), encodeTx(tx), txid);
    }
  });

  it('the txid recomputed from the bytes is the id the chain knows them by, for all 38', () => {
    for (const [txid, hex] of Object.entries(mainnet.transactions)) {
      assert.equal(txidOfRaw(hex), txid);
      assert.equal(txidOf(decodeTx(hex)), txid);
    }
  });

  it('reads nTime straight after the version, where a Bitcoin parser would look for the input count', () => {
    const hex = raw('ld-auto-send');
    const tx = decodeTx(hex);
    assert.equal(tx.version, 1);
    assert.equal(tx.nTime, 1788425328); // 2026-09-03T08:48:48Z, the auto-send the brain counted as 98 orders
    assert.equal(hex.slice(8, 16), '7034996a'); // the same number, little-endian, bytes 4..8
    assert.equal(tx.inputs.length, 1);
    assert.equal(tx.outputs.length, 99);
    assert.equal(tx.locktime, 0);
  });

  it('reads the 20-input consolidation input by input, sequences final', () => {
    const tx = decodeTx(raw('ld-consolidation'));
    assert.equal(tx.inputs.length, 20);
    assert.equal(tx.outputs.length, 1);
    assert.equal(tx.outputs[0].value, 39438180618455n);
    for (const input of tx.inputs) assert.equal(input.sequence, SEQUENCE_FINAL);
    assert.equal(new Set(tx.inputs.map((i) => outpointKey(i.prevTxid, i.vout))).size, 20);
  });

  it('prints prevout txids in display order, as Electrum and explorers do', () => {
    // Same reading as lana-cards server/lib/lanaTx.test.ts on the same payment.
    const tx = decodeTx(raw('lc-card-payment'));
    assert.equal(tx.inputs[0].prevTxid, '693c74a74e5362d6df1191c52916fa349dabbf86e7233cf85f52e32b7acd95bc');
    assert.equal(tx.inputs[0].vout, 78);
    assert.equal(tx.inputs[1].vout, 80);
    assert.equal(tx.inputs[3].vout, 1);
    assert.equal(tx.outputs[0].value, 7813000000n);
    assert.equal(tx.outputs[0].scriptPubKeyHex, '76a914adab57725ac3652a4aaf779c79ff2e1e1814ca7688ac');
  });

  it('reads amounts as exact bigints, even above 2^53', () => {
    // 2,497,407,858,442 lanoshis of change: a float would still hold it, the type says it never has to.
    const tx = decodeTx(raw('ld-batch-send'));
    assert.equal(tx.outputs[4].value, 2497407858442n);
    assert.equal(typeof tx.outputs[4].value, 'bigint');
  });
});

describe('P2PKH unlocking scripts on mainnet', () => {
  it('every input of every case is <strict DER ‖ SIGHASH_ALL> <key of the sending wallet>', () => {
    for (const c of mainnet.cases) {
      for (const [i, input] of decodeTx(mainnet.transactions[c.txid]).inputs.entries()) {
        const sig = parseP2pkhScriptSig(input.scriptSigHex);
        assert.ok(sig, `${c.name} input ${i}`);
        assert.equal(sig.hashType, SIGHASH_ALL);
        assert.ok(isStrictDer(sig.signatureDer));
        assert.equal(addressOfPublicKey(sig.publicKey), c.from, `${c.name} input ${i}`);
      }
    }
  });

  it('reads both key forms: 65 bytes in lana.discount’s wallet, 33 in the card payer’s', () => {
    const ld = parseP2pkhScriptSig(decodeTx(raw('ld-auto-send')).inputs[0].scriptSigHex)!;
    assert.equal(ld.publicKey.length, 65);
    const lc = parseP2pkhScriptSig(decodeTx(raw('lc-card-payment')).inputs[0].scriptSigHex)!;
    assert.equal(lc.publicKey.length, 33);
    assert.equal(Buffer.from(lc.publicKey).toString('hex'), '0380b27f21a404c0c95bf45336e4c8aad2d35e9c10a96c3409d91ca35826e0cf18');
  });

  it('rebuilding a scriptSig from its parts gives back the same script', () => {
    for (const input of decodeTx(raw('wallet-12-inputs')).inputs) {
      const sig = parseP2pkhScriptSig(input.scriptSigHex)!;
      assert.equal(p2pkhScriptSigHex(sig.signatureDer, sig.publicKey, sig.hashType), input.scriptSigHex);
    }
  });

  it('refuses anything that is not exactly two pushes of a strict signature and a key', () => {
    const good = decodeTx(raw('lc-card-payment')).inputs[0].scriptSigHex;
    const sig = parseP2pkhScriptSig(good)!;
    const sigHex = Buffer.from(sig.signatureDer).toString('hex') + '01';
    const pubHex = Buffer.from(sig.publicKey).toString('hex');
    const push = (h: string) => (h.length / 2).toString(16).padStart(2, '0') + h;
    assert.ok(parseP2pkhScriptSig(push(sigHex) + push(pubHex)));
    assert.equal(parseP2pkhScriptSig(''), null);
    assert.equal(parseP2pkhScriptSig(good + '00'), null, 'trailing byte');
    assert.equal(parseP2pkhScriptSig(push(sigHex)), null, 'signature only');
    assert.equal(parseP2pkhScriptSig(push(sigHex) + push(pubHex) + push(pubHex)), null, 'three pushes');
    assert.equal(parseP2pkhScriptSig('4c' + push(sigHex) + push(pubHex)), null, 'OP_PUSHDATA1');
    assert.equal(parseP2pkhScriptSig(push(sigHex) + push('06' + pubHex.slice(2))), null, 'not a 02/03 key');
    assert.equal(parseP2pkhScriptSig(push(sigHex) + push(pubHex.slice(0, 64))), null, 'short key');
    assert.equal(parseP2pkhScriptSig(push('31' + sigHex.slice(2)) + push(pubHex)), null, 'not DER');
    assert.equal(parseP2pkhScriptSig(good.toUpperCase()), null, 'hex is lowercase in this library');
  });
});

describe('strict DER (BIP66)', () => {
  // r = 1, s = 1: the smallest well-formed signature.
  const minimal = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);

  it('accepts minimal positive integers, with a 00 pad only before a high bit', () => {
    assert.ok(isStrictDer(minimal));
    assert.ok(isStrictDer(Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x80, 0x02, 0x01, 0x01])));
  });

  it('refuses a negative integer, a needless pad, a wrong length, a zero-length integer', () => {
    assert.ok(!isStrictDer(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01])), 'R negative');
    assert.ok(!isStrictDer(Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01])), 'R padded');
    assert.ok(!isStrictDer(Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x02, 0x00, 0x01])), 'S padded');
    assert.ok(!isStrictDer(Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])), 'total length');
    assert.ok(!isStrictDer(Uint8Array.from([0x30, 0x06, 0x02, 0x00, 0x02, 0x02, 0x01, 0x01])), 'R empty');
    assert.ok(!isStrictDer(Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])), 'not a sequence');
    assert.ok(!isStrictDer(minimal.subarray(0, 7)), 'truncated');
  });
});

describe('decode refuses what it could not give back byte for byte', () => {
  const hex = encodeTxHex(sampleTx());

  it('the sample itself round-trips', () => {
    assert.deepEqual(decodeTx(hex), sampleTx());
    assert.equal(encodeTxHex(decodeTx(hex.toUpperCase())), hex, 'either hex case reads the same bytes');
  });

  it('a varint not in its shortest form', () => {
    // input count 1 written as fd 01 00
    assert.throws(() => decodeTx(hex.slice(0, 16) + 'fd0100' + hex.slice(18)), /non-canonical varint/);
    // script length 0 written as fd 00 00
    const at = 16 + 2 + 64 + 8;
    assert.throws(() => decodeTx(hex.slice(0, at) + 'fd0000' + hex.slice(at + 2)), /non-canonical varint/);
  });

  it('truncated bytes, trailing bytes, no inputs, no outputs', () => {
    assert.throws(() => decodeTx(hex.slice(0, -2)), /truncated/);
    assert.throws(() => decodeTx(hex + '00'), /trailing bytes/);
    assert.throws(() => decodeTx(hex.slice(0, 16) + '00' + hex.slice(18)), /no inputs/);
    // From the end: locktime (8 hex), script (50), its length (2), value (16), then the output count.
    const outAt = hex.length - 8 - 50 - 2 - 16 - 2;
    assert.equal(hex.slice(outAt, outAt + 2), '01');
    assert.throws(() => decodeTx(hex.slice(0, outAt) + '00' + hex.slice(-8)), /no outputs/);
  });

  it('a count the bytes could never hold, before allocating anything for it', () => {
    assert.throws(() => decodeTx(hex.slice(0, 16) + 'feffffff7f' + hex.slice(18)), /does not fit/);
  });

  it('a value above 2^63 − 1', () => {
    const tx = decodeTx(hex);
    tx.outputs[0].value = MAX_VALUE;
    const max = encodeTxHex(tx);
    assert.equal(decodeTx(max).outputs[0].value, MAX_VALUE);
    const over = max.replace('ffffffffffffff7f', '0000000000000080');
    assert.throws(() => decodeTx(over), /out of range/);
  });

  it('anything that is not hex', () => {
    assert.throws(() => decodeTx(''), /not hex/);
    assert.throws(() => decodeTx(hex + '0'), /not hex/);
    assert.throws(() => decodeTx(' ' + hex.slice(1)), /not hex/);
    assert.throws(() => decodeTx(hex.slice(0, -2) + 'zz'), /not hex/);
  });
});

describe('encode refuses what decode could not have produced', () => {
  const broken: [string, (tx: LanaTx) => void][] = [
    ['an uppercase txid', (tx) => (tx.inputs[0].prevTxid = 'AB'.repeat(32))],
    ['a short txid', (tx) => (tx.inputs[0].prevTxid = 'ab'.repeat(31))],
    ['a number value', (tx) => (tx.outputs[0].value = 5 as unknown as bigint)],
    ['a negative value', (tx) => (tx.outputs[0].value = -1n)],
    ['a value above 2^63 − 1', (tx) => (tx.outputs[0].value = MAX_VALUE + 1n)],
    ['an nTime above u32', (tx) => (tx.nTime = 2 ** 32)],
    ['a fractional vout', (tx) => (tx.inputs[0].vout = 1.5)],
    ['an odd-length script', (tx) => (tx.outputs[0].scriptPubKeyHex = 'abc')],
    ['an uppercase script', (tx) => (tx.outputs[0].scriptPubKeyHex = tx.outputs[0].scriptPubKeyHex.toUpperCase())],
    ['no inputs', (tx) => (tx.inputs = [])],
    ['no outputs', (tx) => (tx.outputs = [])],
  ];
  for (const [what, breakIt] of broken) {
    it(what, () => {
      const tx = sampleTx();
      breakIt(tx);
      assert.throws(() => encodeTx(tx));
    });
  }
});

describe('varints and edge outputs', () => {
  it('writes each size in its shortest form and reads it back', () => {
    for (const n of [0, 0xfc, 0xfd, 0xffff, 0x10000]) {
      const tx = sampleTx();
      tx.outputs[0].scriptPubKeyHex = 'ab'.repeat(n);
      const bytes = encodeTx(tx);
      assert.deepEqual(decodeTx(bytes), tx, `script of ${n} bytes`);
    }
    assert.deepEqual([...encodeVarint(0xfc)], [0xfc]);
    assert.deepEqual([...encodeVarint(0xfd)], [0xfd, 0xfd, 0x00]);
    assert.deepEqual([...encodeVarint(0x10000)], [0xfe, 0x00, 0x00, 0x01, 0x00]);
    assert.throws(() => encodeVarint(-1));
    assert.throws(() => encodeVarint(2 ** 32));
  });

  it('reads an empty zero-value output, as a coinstake carries first, so such a coin’s parent still decodes', () => {
    const tx = sampleTx();
    tx.outputs.unshift({ value: 0n, scriptPubKeyHex: '' });
    assert.deepEqual(decodeTx(encodeTx(tx)), tx);
  });

  it('a P2PKH scriptSig is two pushes of the parts, nothing else', () => {
    const der = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    const pub = Uint8Array.from([0x02, ...new Uint8Array(32).fill(7)]);
    const script = p2pkhScriptSigHex(der, pub);
    assert.equal(script, '09' + '300602010102010101' + '21' + Buffer.from(pub).toString('hex'));
    assert.deepEqual(parseP2pkhScriptSig(script), { signatureDer: der, hashType: SIGHASH_ALL, publicKey: pub });
    assert.throws(() => p2pkhScriptSigHex(der.subarray(0, 7), pub), /strict DER/);
    assert.throws(() => p2pkhScriptSigHex(der, pub.subarray(0, 32)), /public key/);
  });
});
