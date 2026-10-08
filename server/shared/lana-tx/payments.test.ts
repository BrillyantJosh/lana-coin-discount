// @vitest-environment node
/**
 * payments.ts: the one rule from "what each purchase gets" to the outputs of a
 * payout — one output per wallet, where that wallet first appears — and every
 * allocation it refuses. The browser builds with this rule and the server checks
 * with it, so these cases are what both sides agree a payout is.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import { base58CheckDecode, base58CheckEncode } from './address.ts';
import { DUST_LANOSHIS } from './fee.ts';
import { LANOSHI_STEP, MAX_PAY_OUTPUTS, paymentsOf, type Allocation, type AllocationProblemCode } from './payments.ts';
import { LANA, throwawayAddress } from './fixtures/wallets.ts';

const codes = (r: ReturnType<typeof paymentsOf>): AllocationProblemCode[] => (r.ok === true ? [] : r.problems.map((p) => p.code));

describe('paymentsOf(): one output per wallet', () => {
  it('each wallet once, where it first appears, holding the sum of its allocations', () => {
    const [a, b, c] = [throwawayAddress(), throwawayAddress(), throwawayAddress()];
    const r = paymentsOf([
      { address: a, lanoshis: 10n * LANA },
      { address: b, lanoshis: 2_500_000n },
      { address: a, lanoshis: 123_456_000n },
      { address: c, lanoshis: DUST_LANOSHIS },
      { address: b, lanoshis: 1_000n },
    ]);
    assert.ok(r.ok, r.ok === true ? '' : JSON.stringify(r.problems));
    if (!r.ok) return;
    assert.deepEqual(r.pay, [
      { address: a, lanoshis: 10n * LANA + 123_456_000n },
      { address: b, lanoshis: 2_501_000n },
      { address: c, lanoshis: DUST_LANOSHIS },
    ]);
    assert.equal(r.paying, 10n * LANA + 123_456_000n + 2_501_000n + DUST_LANOSHIS);
  });

  it('the order of the allocations is the order of the outputs', () => {
    const wallets = Array.from({ length: 6 }, throwawayAddress);
    const r = paymentsOf(wallets.map((address, i) => ({ address, lanoshis: BigInt(i + 1) * LANA })));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.pay.map((p) => p.address), wallets);
  });

  it('two small allocations to one wallet may together reach dust; alone each would be refused', () => {
    const a = throwawayAddress();
    assert.deepEqual(codes(paymentsOf([{ address: a, lanoshis: 300_000n }])), ['BELOW_DUST']);
    const both = paymentsOf([
      { address: a, lanoshis: 300_000n },
      { address: a, lanoshis: 200_000n },
    ]);
    assert.ok(both.ok);
    if (both.ok) assert.deepEqual(both.pay, [{ address: a, lanoshis: DUST_LANOSHIS }]);
    const under = paymentsOf([
      { address: a, lanoshis: 300_000n },
      { address: a, lanoshis: 199_000n },
    ]);
    assert.deepEqual(codes(under), ['BELOW_DUST']);
    if (under.ok === false) assert.equal(under.problems[0].index, 0, 'named by the wallet’s first allocation');
  });

  it(`every allocation is a whole number of ${LANOSHI_STEP} lanoshis: the purchase book counts 5 decimals`, () => {
    const a = throwawayAddress();
    assert.equal(LANOSHI_STEP, 1_000n);
    assert.ok(paymentsOf([{ address: a, lanoshis: 12_345_678_000n }]).ok);
    assert.deepEqual(codes(paymentsOf([{ address: a, lanoshis: 12_345_678_001n }])), ['NOT_STEP']);
    assert.deepEqual(codes(paymentsOf([{ address: a, lanoshis: 12_345_678_999n }])), ['NOT_STEP']);
  });

  it(`at most ${MAX_PAY_OUTPUTS} wallets in one payout; the same wallet many times is still one`, () => {
    const wallets = Array.from({ length: MAX_PAY_OUTPUTS + 1 }, throwawayAddress);
    assert.ok(paymentsOf(wallets.slice(0, MAX_PAY_OUTPUTS).map((address) => ({ address, lanoshis: LANA }))).ok);
    assert.deepEqual(codes(paymentsOf(wallets.map((address) => ({ address, lanoshis: LANA })))), ['TOO_MANY_OUTPUTS']);
    const one = paymentsOf(Array.from({ length: 200 }, () => ({ address: wallets[0], lanoshis: LANA })));
    assert.ok(one.ok);
    if (one.ok) assert.deepEqual(one.pay, [{ address: wallets[0], lanoshis: 200n * LANA }]);
  });

  it('refuses what is not an allocation, each with its code and its place', () => {
    const a = throwawayAddress();
    // The same 20 bytes under Bitcoin's version byte: a valid checksum, another network.
    const payload = base58CheckDecode(a)!;
    payload[0] = 0x00;
    const bitcoin = base58CheckEncode(payload);
    const typo = a.slice(0, 10) + (a[10] === 'x' ? 'y' : 'x') + a.slice(11);
    const cases: [string, unknown[], AllocationProblemCode[]][] = [
      ['nothing', [], ['EMPTY']],
      ['a mistyped address', [{ address: typo, lanoshis: LANA }], ['BAD_ADDRESS']],
      ['a Bitcoin address', [{ address: bitcoin, lanoshis: LANA }], ['BAD_ADDRESS']],
      ['an address with a space', [{ address: ` ${a}`, lanoshis: LANA }], ['BAD_ADDRESS']],
      ['no address', [{ lanoshis: LANA }], ['BAD_ADDRESS']],
      ['zero', [{ address: a, lanoshis: 0n }], ['NOT_POSITIVE']],
      ['a negative amount', [{ address: a, lanoshis: -LANA }], ['NOT_POSITIVE']],
      ['a float', [{ address: a, lanoshis: 1.5 }], ['NOT_POSITIVE']],
      ['a string', [{ address: a, lanoshis: '100000000' }], ['NOT_POSITIVE']],
      ['two problems at once', [{ address: typo, lanoshis: LANA }, { address: a, lanoshis: 1_500n }], ['BAD_ADDRESS', 'NOT_STEP']],
    ];
    for (const [name, list, want] of cases) {
      const r = paymentsOf(list as Allocation[]);
      assert.deepEqual(codes(r), want, name);
    }
    const r = paymentsOf([{ address: a, lanoshis: LANA }, { address: typo, lanoshis: LANA }]);
    if (r.ok === false) assert.equal(r.problems[0].index, 1);
    else assert.fail('a mistyped address was paid');
  });
});
