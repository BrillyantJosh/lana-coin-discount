// @vitest-environment node
/**
 * shape.ts: real lana.discount transactions are exactly the shape, the builder
 * rebuilds them byte for byte, and every way out of the shape has its own code.
 *
 * The rebuild is the point. Given the same coins and the same payments, the
 * builder produces the transaction lana.discount produced: once the original
 * signatures are put back into the inputs, the bytes are identical. So the
 * change rule, the output order, the fee and the envelope here are not a
 * guess at what the chain accepts; they are what it accepted.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import { addressOfPublicKey, addressOfScript, scriptOfAddress } from './address.ts';
import { decodeTx, encodeTxHex, p2pkhScriptSigHex, parseP2pkhScriptSig, SEQUENCE_FINAL } from './codec.ts';
import { DUST_LANOSHIS, feeCeiling, feeFor, MAX_INPUTS } from './fee.ts';
import {
  buildUnsignedTx,
  checkShape,
  DEFAULT_MAX_AGE_SEC,
  DEFAULT_MAX_AHEAD_SEC,
  prevoutFromRawTx,
  type Payment,
  type Prevout,
  type ShapeProblemCode,
  type ShapeRules,
} from './shape.ts';

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};

/** A throwaway address nobody holds a key to after this process ends. */
const throwaway = () => addressOfPublicKey(secp.getPublicKey(secp.utils.randomSecretKey(), true));
const OTHER = throwaway();

/** A mainnet case with its prevouts (from re-hashed parents) and the rules it was sent under. */
function load(name: string) {
  const c = mainnet.cases.find((x) => x.name === name)!;
  const raw = mainnet.transactions[c.txid];
  const tx = decodeTx(raw);
  const prevouts = tx.inputs.map((i) => prevoutFromRawTx(mainnet.transactions[i.prevTxid], i.prevTxid, i.vout));
  // Every case sends its change last, back to the sending wallet; the rest are the payments.
  const pay: Payment[] = tx.outputs.slice(0, -1).map((o) => ({ address: addressOfScript(o.scriptPubKeyHex)!, lanoshis: o.value }));
  const rules: ShapeRules = {
    from: c.from,
    pay,
    change: c.from,
    maxFee: feeCeiling(MAX_INPUTS, pay.length),
    nowSec: tx.nTime + 60,
    signed: true,
  };
  return { c, raw, tx, prevouts, rules };
}

const codes = (r: ReturnType<typeof checkShape>): ShapeProblemCode[] => (r.ok === true ? [] : r.problems.map((p) => p.code));
const LD_CASES = ['ld-auto-send', 'ld-batch-send', 'ld-consolidation', 'wallet-12-inputs'];

describe('mainnet transactions built by the ·150 rule are exactly the shape', () => {
  for (const name of LD_CASES) {
    it(name, () => {
      const { c, tx, prevouts, rules } = load(name);
      const r = checkShape(tx, prevouts, rules);
      assert.ok(r.ok, JSON.stringify(codes(r)));
      assert.equal(r.txid, c.txid);
      assert.equal(r.fee, feeFor(tx.inputs.length, tx.outputs.length));
      assert.equal(r.change, tx.outputs[tx.outputs.length - 1].value);
    });
  }

  it('the consolidation is the shape with no payments: one output, back to the same wallet', () => {
    const { rules } = load('ld-consolidation');
    assert.deepEqual(rules.pay, []);
  });

  it('the lana-cards payment is refused for one reason only: its fee is below the formula', () => {
    const { tx, prevouts, rules } = load('lc-card-payment');
    assert.deepEqual(codes(checkShape(tx, prevouts, rules)), ['FEE_BELOW_RULE']);
  });
});

describe('the builder rebuilds them byte for byte', () => {
  for (const name of LD_CASES) {
    it(name, () => {
      const { raw, tx, prevouts, rules } = load(name);
      const built = buildUnsignedTx({ from: rules.from, pay: rules.pay, change: rules.change, coins: prevouts, nTime: tx.nTime, maxFee: rules.maxFee });
      assert.ok(built.ok, JSON.stringify(built.ok === false && built.problems));
      assert.deepEqual(built.prevScriptsHex, prevouts.map((p) => p.scriptPubKeyHex));
      built.tx.inputs.forEach((input, i) => (input.scriptSigHex = tx.inputs[i].scriptSigHex));
      assert.equal(encodeTxHex(built.tx), raw);
    });
  }

  it('the lana-cards payment rebuilt by this rule gives back less change: the ·150 fee', () => {
    const { tx, prevouts, rules } = load('lc-card-payment');
    const built = buildUnsignedTx({ from: rules.from, pay: rules.pay, change: rules.change, coins: prevouts, nTime: tx.nTime, maxFee: rules.maxFee });
    assert.ok(built.ok);
    assert.equal(built.tx.outputs[1].value, tx.outputs[1].value - (feeFor(4, 2) - 79_800n));
  });
});

describe('a check refuses, with its own code, every way out of the shape', () => {
  const base = () => load('ld-batch-send');
  /** Mutate a fresh copy, check it, and require `expected` among the problems; returns them all. */
  const refused = (expected: ShapeProblemCode, mutate: (x: ReturnType<typeof base>) => void): ShapeProblemCode[] => {
    const x = base();
    mutate(x);
    const got = codes(checkShape(x.tx, x.prevouts, x.rules));
    assert.ok(got.includes(expected), `expected ${expected}, got ${JSON.stringify(got)}`);
    return got;
  };
  const refuse = (expected: ShapeProblemCode, mutate: (x: ReturnType<typeof base>) => void): void => {
    refused(expected, mutate);
  };

  it('the unchanged transaction passes', () => {
    const { tx, prevouts, rules } = base();
    assert.ok(checkShape(tx, prevouts, rules).ok);
  });

  // The rules: what was expected.
  it('a payment to a different address', () => refuse('OUTPUT_ADDRESS', (x) => ((x.rules.pay as Payment[])[0] = { ...x.rules.pay[0], address: OTHER })));
  it('a payment of a different amount', () => refuse('OUTPUT_VALUE', (x) => ((x.rules.pay as Payment[])[1] = { ...x.rules.pay[1], lanoshis: x.rules.pay[1].lanoshis + 1n })));
  it('a payment missing from the expectation', () => refuse('OUTPUT_COUNT', (x) => (x.rules.pay = x.rules.pay.slice(1))));
  it('change expected elsewhere than the sending wallet', () => refuse('CHANGE_NOT_SOURCE', (x) => (x.rules.change = OTHER)));
  it('a different sending wallet', () => {
    const got = refused('INPUT_NOT_FROM_SOURCE', (x) => {
      x.rules.from = OTHER;
      x.rules.change = OTHER;
    });
    assert.ok(got.includes('PUBKEY_NOT_SOURCE') && got.includes('CHANGE_ADDRESS'));
  });
  it('a fee above maxFee', () => refuse('FEE_ABOVE_MAX', (x) => (x.rules.maxFee = feeFor(1, 5) - 1n)));
  it('an nTime too old for the checker’s clock', () => refuse('NTIME_TOO_OLD', (x) => (x.rules.nowSec = x.tx.nTime + DEFAULT_MAX_AGE_SEC + 1)));
  it('an nTime too far ahead of the checker’s clock', () => refuse('NTIME_AHEAD', (x) => (x.rules.nowSec = x.tx.nTime - DEFAULT_MAX_AHEAD_SEC - 1)));
  it('signatures where an unsigned transaction was expected', () => refuse('NOT_UNSIGNED', (x) => (x.rules.signed = false)));
  it('an anchor outpoint that is not spent', () => refuse('ANCHOR_MISSING', (x) => (x.rules.anchors = [{ txid: x.tx.inputs[0].prevTxid, vout: x.tx.inputs[0].vout + 1 }])));
  it('a payment back to the sending wallet', () => refuse('PAY_TO_SOURCE', (x) => ((x.rules.pay as Payment[])[0] = { ...x.rules.pay[0], address: x.rules.from })));
  it('a payment below dust', () => refuse('PAY_BELOW_DUST', (x) => ((x.rules.pay as Payment[])[0] = { ...x.rules.pay[0], lanoshis: DUST_LANOSHIS - 1n })));
  it('an address that is not one', () => refuse('BAD_ADDRESS', (x) => ((x.rules.pay as Payment[])[0] = { ...x.rules.pay[0], address: 'L' + x.rules.pay[0].address.slice(2) })));
  it('prevouts that do not match the inputs one to one', () => refuse('BAD_RULES', (x) => (x.prevouts = [])));
  it('rules that make no sense: a negative age, a coin without a value', () => {
    refuse('BAD_RULES', (x) => (x.rules.maxAgeSec = -1));
    refuse('BAD_RULES', (x) => (x.prevouts = [{ ...x.prevouts[0], value: 5 as unknown as bigint }]));
  });
  it('an object that is not a transaction: no inputs, a field out of range (refused, never thrown)', () => {
    const x = base();
    assert.deepEqual(codes(checkShape({ ...x.tx, inputs: [] }, [], x.rules)), ['MALFORMED']);
    assert.deepEqual(codes(checkShape({ ...x.tx, nTime: -1 }, x.prevouts, x.rules)), ['MALFORMED']);
    assert.deepEqual(codes(checkShape({ ...x.tx, outputs: [] }, x.prevouts, x.rules)), ['MALFORMED']);
  });

  it('an anchor that is spent passes', () => {
    const { tx, prevouts, rules } = base();
    assert.ok(checkShape(tx, prevouts, { ...rules, anchors: [{ txid: tx.inputs[0].prevTxid, vout: tx.inputs[0].vout }] }).ok);
  });

  // The transaction: what was built.
  it('another version', () => refuse('VERSION', (x) => (x.tx.version = 2)));
  it('a locktime', () => refuse('LOCKTIME', (x) => (x.tx.locktime = 5)));
  it('an input that is not final', () => refuse('SEQUENCE', (x) => (x.tx.inputs[0].sequence = 0)));
  it('an unreadable scriptSig', () => refuse('SCRIPTSIG', (x) => (x.tx.inputs[0].scriptSigHex = x.tx.inputs[0].scriptSigHex.slice(2))));
  it('a hash type other than SIGHASH_ALL (outputs or inputs could be changed by anyone)', () =>
    refuse('HASHTYPE', (x) => {
      const sig = parseP2pkhScriptSig(x.tx.inputs[0].scriptSigHex)!;
      x.tx.inputs[0].scriptSigHex = p2pkhScriptSigHex(sig.signatureDer, sig.publicKey, 0x81);
    }));
  it('the right key in the other form: a compressed key cannot spend an uncompressed address', () =>
    refuse('PUBKEY_NOT_SOURCE', (x) => {
      const sig = parseP2pkhScriptSig(x.tx.inputs[0].scriptSigHex)!;
      assert.equal(sig.publicKey.length, 65);
      const compressed = secp.Point.fromBytes(sig.publicKey).toBytes(true);
      x.tx.inputs[0].scriptSigHex = p2pkhScriptSigHex(sig.signatureDer, compressed, sig.hashType);
    }));
  it('change sent somewhere else', () => refuse('CHANGE_ADDRESS', (x) => (x.tx.outputs[4].scriptPubKeyHex = scriptOfAddress(OTHER))));
  it('one lanoshi of change burnt into the fee', () => refuse('CHANGE_RULE', (x) => (x.tx.outputs[4].value -= 1n)));
  it('one lanoshi less fee than the formula', () => refuse('FEE_BELOW_RULE', (x) => (x.tx.outputs[4].value += 1n)));
  it('the whole change burnt', () => {
    // Four outputs for four payments is a valid count; the change rule is what refuses it.
    const got = refused('CHANGE_RULE', (x) => x.tx.outputs.pop());
    assert.ok(got.includes('FEE_ABOVE_MAX'));
  });
  it('an extra output', () => refuse('OUTPUT_COUNT', (x) => x.tx.outputs.push({ value: DUST_LANOSHIS, scriptPubKeyHex: scriptOfAddress(OTHER) })));
  it('an nTime before a transaction it spends (the chain refuses it)', () =>
    refuse('NTIME_BEFORE_PREVOUT', (x) => {
      x.tx.nTime = x.prevouts[0].txNTime - 1;
      x.rules.nowSec = x.tx.nTime;
    }));
  it('a prevout for another coin', () => refuse('PREVOUT_MISMATCH', (x) => (x.prevouts = [{ ...x.prevouts[0], vout: x.prevouts[0].vout + 1 }])));
  it('a coin not locked to the sending wallet', () => refuse('INPUT_NOT_FROM_SOURCE', (x) => (x.prevouts = [{ ...x.prevouts[0], scriptPubKeyHex: scriptOfAddress(OTHER) }])));
  it('a coin claimed to be worth less than it is (the difference would vanish into change)', () =>
    refuse('FEE_BELOW_RULE', (x) => (x.prevouts = [{ ...x.prevouts[0], value: x.prevouts[0].value - 1n }])));

  it('more inputs than allowed', () => {
    const { tx, prevouts, rules } = load('ld-consolidation');
    assert.ok(checkShape(tx, prevouts, { ...rules, maxInputs: 20 }).ok);
    assert.ok(codes(checkShape(tx, prevouts, { ...rules, maxInputs: 19 })).includes('TOO_MANY_INPUTS'));
  });

  it('the same coin spent twice', () => {
    const { tx, prevouts, rules } = load('ld-consolidation');
    tx.inputs[1] = { ...tx.inputs[0] };
    const p = [...prevouts];
    p[1] = p[0];
    assert.ok(codes(checkShape(tx, p, rules)).includes('DUPLICATE_INPUT'));
  });

  it('two inputs whose prevouts were swapped', () => {
    const { tx, prevouts, rules } = load('ld-consolidation');
    const p = [...prevouts];
    [p[0], p[1]] = [p[1], p[0]];
    assert.ok(codes(checkShape(tx, p, rules)).includes('PREVOUT_MISMATCH'));
  });
});

describe('prevoutFromRawTx believes bytes only after hashing them', () => {
  const { tx } = load('ld-batch-send');
  const parentId = tx.inputs[0].prevTxid;
  const parentRaw = mainnet.transactions[parentId];

  it('reads value, script and nTime of the coin', () => {
    const p = prevoutFromRawTx(parentRaw, parentId, tx.inputs[0].vout);
    const parent = decodeTx(parentRaw);
    assert.deepEqual(p, {
      txid: parentId,
      vout: tx.inputs[0].vout,
      value: parent.outputs[tx.inputs[0].vout].value,
      scriptPubKeyHex: parent.outputs[tx.inputs[0].vout].scriptPubKeyHex,
      txNTime: parent.nTime,
    });
  });

  it('refuses a parent whose bytes were changed, even when they still decode', () => {
    const parent = decodeTx(parentRaw);
    parent.outputs[tx.inputs[0].vout].value *= 100n; // the inflated prevout of spec §5.5 rule 5
    assert.throws(() => prevoutFromRawTx(encodeTxHex(parent), parentId, tx.inputs[0].vout), /hashes to/);
  });

  it('refuses an output the parent does not have', () => {
    const n = decodeTx(parentRaw).outputs.length;
    assert.throws(() => prevoutFromRawTx(parentRaw, parentId, n), /no output/);
    assert.throws(() => prevoutFromRawTx(parentRaw, parentId, -1), /no output/);
  });
});

describe('the builder refuses what the checker would', () => {
  const NOW = 1_790_000_000;
  const from = throwaway();
  const coin = (lanoshis: bigint, k = 0): Prevout => ({
    txid: crypto.createHash('sha256').update(`coin ${k} ${lanoshis}`).digest('hex'),
    vout: k % 3,
    value: lanoshis,
    scriptPubKeyHex: scriptOfAddress(from),
    txNTime: NOW - 600,
  });
  const args = (over: Partial<Parameters<typeof buildUnsignedTx>[0]> = {}) => ({
    from,
    pay: [{ address: OTHER, lanoshis: 1_000_000_000n }],
    change: from,
    coins: [coin(700_000_000n, 1), coin(400_000_000n, 2)],
    nTime: NOW,
    maxFee: feeCeiling(MAX_INPUTS, 1),
    ...over,
  });
  const problem = (r: ReturnType<typeof buildUnsignedTx>) => (r.ok === true ? [] : r.problems.map((p) => p.code));

  it('builds: payment first, change back to the source, fee by the formula', () => {
    const r = buildUnsignedTx(args());
    assert.ok(r.ok);
    assert.equal(r.tx.version, 1);
    assert.equal(r.tx.locktime, 0);
    assert.equal(r.tx.nTime, NOW);
    assert.deepEqual(r.tx.inputs.map((i) => [i.scriptSigHex, i.sequence]), [['', SEQUENCE_FINAL], ['', SEQUENCE_FINAL]]);
    assert.deepEqual(r.tx.outputs.map((o) => addressOfScript(o.scriptPubKeyHex)), [OTHER, from]);
    assert.equal(r.fee, feeFor(2, 2));
    assert.equal(r.change, 1_100_000_000n - 1_000_000_000n - feeFor(2, 2));
  });

  it('not enough coins', () => assert.deepEqual(problem(buildUnsignedTx(args({ coins: [coin(1_000_000_000n)] }))), ['INSUFFICIENT']));
  it('no coins', () => assert.deepEqual(problem(buildUnsignedTx(args({ coins: [] }))), ['INSUFFICIENT']));
  it('more than 20 coins', () => {
    const coins = Array.from({ length: 21 }, (_, k) => coin(100_000_000n, k));
    assert.ok(problem(buildUnsignedTx(args({ coins }))).includes('TOO_MANY_INPUTS'));
    assert.ok(buildUnsignedTx(args({ coins: coins.slice(0, 20) })).ok);
  });
  it('a coin of another wallet', () =>
    assert.ok(problem(buildUnsignedTx(args({ coins: [coin(2_000_000_000n), { ...coin(1n, 9), scriptPubKeyHex: scriptOfAddress(OTHER) }] }))).includes('INPUT_NOT_FROM_SOURCE')));
  it('change anywhere but the source', () => assert.ok(problem(buildUnsignedTx(args({ change: OTHER }))).includes('CHANGE_NOT_SOURCE')));
  it('a fee above maxFee', () => assert.ok(problem(buildUnsignedTx(args({ maxFee: feeFor(2, 2) - 1n }))).includes('FEE_ABOVE_MAX')));
  it('an nTime before a coin’s own transaction', () =>
    assert.ok(problem(buildUnsignedTx(args({ coins: [{ ...coin(2_000_000_000n), txNTime: NOW + 1 }] }))).includes('NTIME_BEFORE_PREVOUT')));
  it('a payment below dust', () => assert.deepEqual(problem(buildUnsignedTx(args({ pay: [{ address: OTHER, lanoshis: 1n }] }))), ['PAY_BELOW_DUST']));
  it('a source that is not an address', () => assert.deepEqual(problem(buildUnsignedTx(args({ from: 'nope' }))), ['BAD_ADDRESS']));
  it('an nTime that is not a u32', () => assert.deepEqual(problem(buildUnsignedTx(args({ nTime: 2 ** 32 }))), ['MALFORMED']));
  it('a coin without a value', () => assert.deepEqual(problem(buildUnsignedTx(args({ coins: [{ ...coin(1n), value: -1n }] }))), ['BAD_RULES']));
  it('a payment to the source', () => assert.ok(problem(buildUnsignedTx(args({ pay: [{ address: from, lanoshis: 1_000_000_000n }] }))).includes('PAY_TO_SOURCE')));

  it('whatever it builds, the checker accepts: 3,000 random coin sets and payments', () => {
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % k;
    };
    const payees = Array.from({ length: 4 }, throwaway);
    let built = 0;
    for (let i = 0; i < 3000; i++) {
      const coins = Array.from({ length: 1 + rnd(MAX_INPUTS) }, (_, k) => coin(BigInt(1 + rnd(2_000_000_000)), i * 100 + k));
      const pay = Array.from({ length: rnd(4) }, (_, k) => ({ address: payees[k], lanoshis: DUST_LANOSHIS + BigInt(rnd(1_000_000_000)) }));
      const r = buildUnsignedTx({ from, pay, change: from, coins, nTime: NOW, maxFee: feeCeiling(MAX_INPUTS, pay.length) });
      if (r.ok === false) {
        assert.deepEqual(r.problems.map((p) => p.code), ['INSUFFICIENT']);
        continue;
      }
      built++;
      const again = checkShape(decodeTx(encodeTxHex(r.tx)), coins, { from, pay, change: from, maxFee: feeCeiling(MAX_INPUTS, pay.length), nowSec: NOW, signed: false });
      assert.ok(again.ok, JSON.stringify(again.ok === false && again.problems));
      const totalIn = coins.reduce((s, c) => s + c.value, 0n);
      const paid = pay.reduce((s, p) => s + p.lanoshis, 0n);
      assert.equal(paid + r.change + r.fee, totalIn);
    }
    assert.ok(built > 1000, `only ${built} of 3000 were buildable`);
  });
});

describe('lana-tx holds no key and opens no connection', () => {
  /**
   * The files that hold no key: they import only each other and @noble/hashes.
   * select.ts and payments.ts came with the payout (Krog Menjave, 6. 10. 2026).
   */
  const PURE = ['address.ts', 'bytes.ts', 'codec.ts', 'fee.ts', 'payments.ts', 'select.ts', 'shape.ts', 'sighash.ts'];
  /**
   * The files that sign or verify a signature, each with the only libraries it
   * may import besides its neighbours: signature.ts is the fleet's signer, pinned
   * byte for byte (signature.pin.test.ts); verify.ts checks a finished
   * transaction with the same two libraries; payout.ts signs a payout in the
   * admin's browser through signature.ts and derives the key's public key.
   */
  const SIGNING: Record<string, string[]> = {
    'signature.ts': ['@noble/secp256k1', 'elliptic'],
    'verify.ts': ['@noble/secp256k1', 'elliptic'],
    'payout.ts': ['@noble/secp256k1'],
  };
  const dir = new URL('.', import.meta.url);
  const importsOf = (src: string) =>
    [...src.matchAll(/^import[\s\S]*? from '([^']+)';$/gm), ...src.matchAll(/^export [^;]*? from '([^']+)';$/gm)].map((m) => m[1]);
  const codeOf = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('the library files are exactly these, and import only each other, @noble/hashes and what signing needs', () => {
    const libs = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    assert.deepEqual(libs.sort(), [...PURE, ...Object.keys(SIGNING)].sort());
    for (const f of libs) {
      const src = fs.readFileSync(new URL(f, dir), 'utf8');
      for (const spec of importsOf(src)) {
        const allowed = /^\.\/[a-z]+\.ts$/.test(spec) || spec.startsWith('@noble/hashes/') || (SIGNING[f] ?? []).includes(spec);
        assert.ok(allowed, `${f} imports ${spec}`);
      }
    }
  });

  it('every library file runs in a browser, and none sends, stores or prints anything', () => {
    // The payout is signed in the admin's browser (payout.ts): no Node global on that path, and
    // nothing here may carry a key anywhere — the page announces the finished transaction itself.
    const libs = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of libs) {
      const code = codeOf(f);
      assert.ok(!/\b(?:Buffer|process|require|global|__dirname|__filename)\b/.test(code), `${f} uses a Node global`);
      assert.ok(!/\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document|console)\b/.test(code), `${f} sends, stores or prints`);
      assert.ok(!/from 'node:|from '(?:fs|path|crypto|net|tls|http|https|os|child_process)'/.test(code), `${f} imports a Node module`);
    }
  });

  it('nothing here signs: no secp256k1 import, no private key parameter', () => {
    for (const f of PURE) {
      // Comments may name the signer; code may not reach it.
      const code = codeOf(f);
      assert.ok(!code.includes('secp256k1'), f);
      assert.ok(!/privateKey|secretKey|\bwif\b/i.test(code), f);
    }
  });
});
