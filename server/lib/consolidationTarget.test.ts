// @vitest-environment node
/**
 * WITH AN OFFER OPEN, CONSOLIDATE ONLY WHAT THE TRANSFER NEEDS — AND NEVER
 * INTO A REFUSAL.
 *
 * The review of 13 Sept 2026 reproduced it with the repo's own functions: an
 * accepted Max offer, a wallet of more than 20 pieces, the refusal saying
 * "consolidate them on this page", MejmoSeFajn's 20-piece merge (546,600
 * lanoshis), and then verifyBacking refusing the transfer for good, because a
 * wallet may come up only 500,000 short. The sweep below runs every wallet size
 * from 21 to 60 pieces through the planner the page uses in that case and the
 * backing check the transfer uses, and holds them to one promise: if the page
 * offers the consolidation, the transfer afterwards is backed and fits.
 */
import { describe, it, expect } from 'vitest';
import { buildTargetPlan, topUpToFit } from './consolidationTarget';
import { consolidationFee, MAX_INPUTS, type PlanUtxo } from './consolidationPlan';
import { feeRoomLanoshis } from './consolidation';
import { verifyBacking } from './acquisitionBacking';
import { ESTIMATED_TRANSFER_FEE_LANA } from '../../src/lib/maxOffer';

let id = 0;
const utxo = (value: number, height = 100): PlanUtxo => ({ tx_hash: `t${++id}`.padStart(64, '0'), tx_pos: 0, value, height });
const many = (count: number, value: number) => Array.from({ length: count }, () => utxo(value));

describe('the cheapest consolidation that makes a wallet fit one transfer', () => {
  it('21 pieces: one 2-piece merge, not a 20-piece one', () => {
    const p = buildTargetPlan(many(21, 1_000_000_000), 21);
    expect(p.batches.map(b => b.utxos.length)).toEqual([2]);
    expect(p.totalFee).toBe(consolidationFee(2));
    expect(p).toMatchObject({ reachesTarget: true, piecesAfter: 20 });
  });

  it('23 pieces: one 4-piece merge', () => {
    const p = buildTargetPlan(many(23, 1_000_000_000), 23);
    expect(p.batches.map(b => b.utxos.length)).toEqual([4]);
    expect(p.piecesAfter).toBe(20);
  });

  it('45 pieces: 20 then 7, and no more', () => {
    const p = buildTargetPlan(many(45, 1_000_000_000), 45);
    expect(p.batches.map(b => b.utxos.length)).toEqual([20, 7]);
    expect(p.piecesAfter).toBe(20);
  });

  it('merges already on their way count: a wallet that will fit needs nothing', () => {
    expect(buildTargetPlan(many(25, 1_000_000_000), 20).batches).toHaveLength(0);
  });

  it('dust that cannot pay for itself does not reach the target, and says so', () => {
    const p = buildTargetPlan(many(25, 20), 25);
    expect(p.batches).toHaveLength(0);
    expect(p.reachesTarget).toBe(false);
  });

  it('non-monotone viability: the smallest size that works is found by searching upward', () => {
    // 21 pieces: one funder-less group of 28,750s — n = 2..4 cannot pay, 5 can.
    const input = many(21, 28_750);
    const p = buildTargetPlan(input, 21);
    expect(p.batches[0]?.utxos.length).toBe(5);
    expect(p.reachesTarget).toBe(true);
  });

  it('dust is what gets merged: the funder pays, the smallest pieces go', () => {
    const input = [...many(20, 5_000_000_000), ...many(3, 30)];
    const p = buildTargetPlan(input, 23);
    const chosen = p.batches[0].utxos.map(u => u.value).sort((a, b) => a - b);
    expect(chosen).toEqual([30, 30, 30, 5_000_000_000]);
  });
});

describe('an accepted Max offer — if the page offers it, the transfer afterwards is backed', () => {
  const maxFee = Math.round(ESTIMATED_TRANSFER_FEE_LANA * 100_000_000);
  it('every wallet of 21–60 pieces, at three piece sizes', () => {
    let offeredCount = 0;
    for (let pieces = 21; pieces <= 60; pieces++) {
      for (const pieceValue of [1_000_000_000, 15_532_366_071, 28_750]) {
        const balance = pieces * pieceValue;
        const agreed = balance - maxFee;
        const room = feeRoomLanoshis(balance, agreed)!;
        const plan = buildTargetPlan(many(pieces, pieceValue), pieces);
        if (!(plan.batches.length > 0 && plan.reachesTarget && plan.totalFee <= room)) continue;
        offeredCount++;
        // What the transfer will meet once these merges confirm.
        expect(verifyBacking(balance - plan.totalFee, agreed).ok, `${pieces} × ${pieceValue}`).toBe(true);
        expect(pieces - plan.totalRemoved).toBeLessThanOrEqual(MAX_INPUTS);
      }
    }
    // The sweep must actually exercise the promise, not skip every case.
    expect(offeredCount).toBeGreaterThan(40);
  });

  it('up to 38 pieces of a healthy size can be consolidated inside a Max offer; 39 cannot', () => {
    const fitsFor = (pieces: number) => {
      const plan = buildTargetPlan(many(pieces, 1_000_000_000), pieces);
      const balance = pieces * 1_000_000_000;
      return plan.reachesTarget && plan.totalFee <= feeRoomLanoshis(balance, balance - maxFee)!;
    };
    expect(fitsFor(38)).toBe(true);
    expect(fitsFor(39)).toBe(false);
  });
});

describe('the top-up figure', () => {
  const maxFee = Math.round(ESTIMATED_TRANSFER_FEE_LANA * 100_000_000);
  const roomFor = (pieces: number, value: number) => feeRoomLanoshis(pieces * value, pieces * value - maxFee)!;

  it('is enough, first time, for every wallet of 39–80 pieces — including those whose extra piece needs a whole extra consolidation', () => {
    for (let pieces = 39; pieces <= 80; pieces++) {
      const value = 1_000_000;
      const input = many(pieces, value);
      const room = roomFor(pieces, value);
      const topUp = topUpToFit(input, pieces, room);
      expect(topUp, `${pieces}`).not.toBeNull();
      // Add exactly that, as one piece, and plan again: it must fit.
      const after = buildTargetPlan([...input, utxo(topUp!)], pieces + 1);
      expect(after.reachesTarget, `${pieces}`).toBe(true);
      expect(after.totalFee, `${pieces}`).toBeLessThanOrEqual(room + topUp!);
    }
  });

  it('includes a shortfall that was there before any fee', () => {
    const input = many(25, 1_000_000_000);
    const topUp = topUpToFit(input, 25, -1_000_000)!;
    const after = buildTargetPlan([...input, utxo(topUp)], 26);
    expect(after.totalFee).toBeLessThanOrEqual(-1_000_000 + topUp);
    expect(topUp).toBeGreaterThan(1_000_000);
  });

  it('funds a wallet of dust, and is null only when the pieces are not there to merge', () => {
    // A wallet of dust: the top-up has to fund the consolidation itself — and then it fits.
    const dust = many(30, 20);
    const t = topUpToFit(dust, 30, 0)!;
    expect(t).not.toBeNull();
    const after = buildTargetPlan([...dust, utxo(t)], 31);
    expect(after.reachesTarget).toBe(true);
    expect(after.totalFee).toBeLessThanOrEqual(t);
    expect(topUpToFit([], 30, 0)).toBeNull();                // pieces the planner cannot see cannot be merged
  });
});
