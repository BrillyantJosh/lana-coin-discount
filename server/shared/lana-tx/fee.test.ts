// @vitest-environment node
/**
 * fee.ts: LD's formula, proven on mainnet and against LD's own function, and a
 * change rule that loses nothing and never flips back to a refusal.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeTx } from './codec.ts';
import { actualFee, DUST_LANOSHIS, feeCeiling, feeFor, MAX_INPUTS, settle } from './fee.ts';
import { prevoutFromRawTx } from './shape.ts';

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};

/** What a mainnet case really paid the network: its re-hashed prevouts minus its outputs. */
function paidFee(name: string): { fee: bigint; inputs: number; outputs: number } {
  const c = mainnet.cases.find((x) => x.name === name)!;
  const tx = decodeTx(mainnet.transactions[c.txid]);
  const values = tx.inputs.map((i) => prevoutFromRawTx(mainnet.transactions[i.prevTxid], i.prevTxid, i.vout).value);
  return { fee: actualFee(tx, values), inputs: tx.inputs.length, outputs: tx.outputs.length };
}

/**
 * Pinned copy of lana-coin-discount server/lib/transaction.ts @f6b7ed3, lines
 * 457-458 and 529-531, byte for byte apart from the names (spec Q15). If LD ever
 * changes its fee, this copy does not follow; the parity test then says which of
 * the two to believe is a decision, not an accident.
 */
const LD_MAX_INPUTS = 20;
const LD_DUST_THRESHOLD = 500000; // 0.005 LANA = 500,000 lanoshis
function ldEstimateFeeLanoshis(inputCount: number, outputCount: number): number {
  return Math.floor((inputCount * 180 + outputCount * 34 + 10) * 100 * 1.5);
}

describe('the formula', () => {
  it('(180·in + 34·out + 10) · 150 lanoshis', () => {
    assert.equal(feeFor(1, 1), 33_600n);
    assert.equal(feeFor(1, 2), 38_700n);
    assert.equal(feeFor(20, 2), 551_700n); // "~0.0055 LANA per 20-input tx", spec §5.1
    assert.equal(typeof feeFor(3, 2), 'bigint');
  });

  it('is LD’s estimateFeeLanoshis exactly, over 1–500 inputs × 1–300 outputs', () => {
    for (let n = 1; n <= 500; n++) {
      for (let m = 1; m <= 300; m++) {
        if (feeFor(n, m) !== BigInt(ldEstimateFeeLanoshis(n, m))) assert.fail(`differs at ${n} in, ${m} out`);
      }
    }
  });

  it('LD’s limits: 20 inputs, dust 500,000 lanoshis', () => {
    assert.equal(MAX_INPUTS, LD_MAX_INPUTS);
    assert.equal(DUST_LANOSHIS, BigInt(LD_DUST_THRESHOLD));
  });

  it('the ceiling for one payment of up to 20 inputs is the spec’s maxFee, 1,051,700', () => {
    assert.equal(feeCeiling(20, 1), 1_051_700n);
    assert.equal(feeCeiling(20, 1), feeFor(20, 2) + DUST_LANOSHIS);
  });

  it('refuses counts that are not positive integers', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => feeFor(bad, 1));
      assert.throws(() => feeFor(1, bad));
    }
  });
});

describe('what mainnet transactions really paid', () => {
  it('lana.discount pays exactly the formula: auto-send, batch and consolidation', () => {
    for (const [name, inputs, outputs, fee] of [
      ['ld-auto-send', 1, 99, 533_400n],
      ['ld-batch-send', 1, 5, 54_000n],
      ['ld-consolidation', 20, 1, 546_600n],
    ] as const) {
      const paid = paidFee(name);
      assert.deepEqual(paid, { fee, inputs, outputs }, name);
      assert.equal(paid.fee, feeFor(inputs, outputs), name);
    }
  });

  it('so does the 12-input wallet transfer', () => {
    const paid = paidFee('wallet-12-inputs');
    assert.equal(paid.fee, 335_700n);
    assert.equal(paid.fee, feeFor(12, 2));
  });

  it('lana-cards’ browser payment paid ·100, a third less than this formula: the two rules really differ', () => {
    const paid = paidFee('lc-card-payment');
    assert.equal(paid.fee, 79_800n);
    assert.equal(paid.fee, (180n * 4n + 34n * 2n + 10n) * 100n);
    assert.ok(paid.fee < feeFor(4, 2));
  });
});

describe('the change rule', () => {
  /** Every invariant of one settlement. */
  function invariants(totalIn: bigint, paying: bigint, n: number, m: number) {
    const s = settle(totalIn, paying, n, m);
    if (s.ok === false) {
      assert.ok(s.shortBy > 0n);
      return s;
    }
    assert.equal(paying + s.change + s.fee, totalIn, 'nothing appears or disappears');
    assert.ok(s.change === 0n || s.change >= DUST_LANOSHIS, 'change is none or at least dust');
    assert.equal(s.outputs, m + (s.change > 0n ? 1 : 0));
    assert.ok(s.fee >= feeFor(n, s.outputs), 'never below the formula');
    if (s.change > 0n) assert.equal(s.fee, feeFor(n, s.outputs), 'with change, exactly the formula');
    assert.ok(s.fee < feeFor(n, m + 1) + DUST_LANOSHIS, 'never burns what could have been change');
    assert.ok(s.fee <= feeCeiling(n, m));
    return s;
  }

  it('the exact boundaries, one lanoshi either side', () => {
    for (const n of [1, 5, 20]) {
      for (const m of [1, 3]) {
        const paying = 1_234_567_890n * BigInt(m);
        const bare = paying + feeFor(n, m); // just enough, no change
        const withChange = paying + feeFor(n, m + 1) + DUST_LANOSHIS; // first total with change

        assert.deepEqual(settle(bare - 1n, paying, n, m), { ok: false, code: 'INSUFFICIENT', shortBy: 1n });
        assert.deepEqual(settle(bare, paying, n, m), { ok: true, change: 0n, fee: feeFor(n, m), outputs: m });
        assert.deepEqual(settle(withChange - 1n, paying, n, m), {
          ok: true,
          change: 0n,
          fee: feeFor(n, m + 1) + DUST_LANOSHIS - 1n,
          outputs: m,
        });
        assert.deepEqual(settle(withChange, paying, n, m), { ok: true, change: DUST_LANOSHIS, fee: feeFor(n, m + 1), outputs: m + 1 });
        for (let d = -3n; d <= 3n; d++) {
          invariants(bare + d, paying, n, m);
          invariants(withChange + d, paying, n, m);
        }
      }
    }
  });

  it('a consolidation (no payments) needs its one output to be at least dust', () => {
    for (const n of [2, 20]) {
      const first = feeFor(n, 1) + DUST_LANOSHIS;
      assert.deepEqual(settle(first - 1n, 0n, n, 0), { ok: false, code: 'INSUFFICIENT', shortBy: 1n });
      assert.deepEqual(settle(first, 0n, n, 0), { ok: true, change: DUST_LANOSHIS, fee: feeFor(n, 1), outputs: 1 });
    }
  });

  it('one lanoshi more never turns a payment into a refusal, and change never shrinks: walked one lanoshi at a time', () => {
    const n = 3;
    const m = 1;
    const paying = 777_000_000n;
    const from = paying + feeFor(n, m) - 10n;
    const to = paying + feeFor(n, m + 1) + DUST_LANOSHIS + 10n;
    let wasOk = false;
    let lastChange = -1n;
    for (let total = from; total <= to; total++) {
      const s = settle(total, paying, n, m);
      if (wasOk) assert.ok(s.ok, `refused at ${total} after accepting less`);
      if (s.ok) {
        assert.ok(s.change >= lastChange, `change shrank at ${total}`);
        assert.equal(paying + s.change + s.fee, total);
        lastChange = s.change;
        wasOk = true;
      }
    }
    assert.ok(wasOk);
  });

  it('random settlements keep every invariant', () => {
    let seed = 0x2545f491;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % k;
    };
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + rnd(MAX_INPUTS);
      const m = rnd(4);
      const paying = m === 0 ? 0n : BigInt(m) * (DUST_LANOSHIS + BigInt(rnd(1_000_000_000)));
      const totalIn = paying + BigInt(rnd(3_000_000));
      invariants(totalIn, paying, n, m);
    }
  });

  it('refuses inputs that make no sense', () => {
    assert.throws(() => settle(-1n, 0n, 1, 0));
    assert.throws(() => settle(10n, -1n, 1, 1));
    assert.throws(() => settle(10 as unknown as bigint, 1n, 1, 1));
    assert.throws(() => settle(10n, 5n, 1, 0), /exactly when/);
    assert.throws(() => settle(10n, 0n, 1, 1), /exactly when/);
    assert.throws(() => settle(10n, 5n, 0, 1));
  });
});

describe('actualFee', () => {
  it('needs one non-negative value per input', () => {
    const tx = decodeTx(mainnet.transactions[mainnet.cases[0].txid]);
    assert.throws(() => actualFee(tx, []));
    assert.throws(() => actualFee(tx, [-1n]));
  });
});
