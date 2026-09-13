// @vitest-environment node
/**
 * THE RULES BEFORE A MERGE IS SIGNED.
 *
 * Each case is a way a merge has already gone wrong somewhere in the fleet, or
 * a way the head start on a second merge could turn into a double spend:
 * values taken from the request, a piece a merge in flight has already spent,
 * a wallet with something else unconfirmed, and a figure that is one lanoshi
 * away from being explained by our own merges.
 */
import { describe, it, expect } from 'vitest';
import {
  assessWallet, decideConsolidation, broadcastOutcome, rowToRecorded, outpointKey, PENDING_WINDOW_HOURS, JUST_SENT_SECONDS,
  feeRoomLanoshis, walletGateVerdict,
  type ChainUtxo, type RecordedConsolidation,
} from './consolidation';
import { consolidationFee, MAX_INPUTS } from './consolidationPlan';
import { BACKING_TOLERANCE_LANOSHIS } from './acquisitionBacking';

const NOW = 1_800_000_000;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const piece = (n: number, value = 1_000_000, height = 100): ChainUtxo => ({ tx_hash: hash(n), tx_pos: 0, value, height });
const pieces = (from: number, count: number, value = 1_000_000) => Array.from({ length: count }, (_, i) => piece(from + i, value));
const names = (list: ChainUtxo[]) => list.map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos }));

const merge = (txid: number, spent: ChainUtxo[], createdAt = NOW - 60): RecordedConsolidation => {
  const total = spent.reduce((s, u) => s + u.value, 0);
  const fee = consolidationFee(spent.length);
  return { txid: hash(txid), inputs: spent, inputCount: spent.length, totalLanoshis: total, feeLanoshis: fee, netLanoshis: total - fee, createdAt };
};

describe('where the wallet stands', () => {
  it('nothing unconfirmed: every confirmed piece can be merged, and nothing is pending', () => {
    const chain = [...pieces(1, 25), piece(99, 5_000, 0)];
    const a = assessWallet({ chain, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });
    expect(a.inFlight).toBe('none');
    expect(a.available).toHaveLength(25);
    expect(a.confirming).toHaveLength(1);
    expect(a.pending).toHaveLength(0);
  });

  it('our merge in flight, and its fee is the whole unconfirmed figure: ours, and its pieces are held back', () => {
    const chain = pieces(1, 45);
    const first = merge(500, chain.slice(0, 20));
    const a = assessWallet({ chain, unconfirmedLanoshis: -first.feeLanoshis, recorded: [first], nowSeconds: NOW });
    expect(a.inFlight).toBe('ours');
    expect(a.pending.map(p => p.txid)).toEqual([first.txid]);
    expect(a.available).toHaveLength(25);
    expect(a.available.some(u => a.busy.has(outpointKey(u)))).toBe(false);
  });

  it('ONE LANOSHI that our merges do not explain makes it someone else\'s — a wait', () => {
    const chain = pieces(1, 45);
    const first = merge(500, chain.slice(0, 20));
    for (const off of [-1, 1]) {
      expect(assessWallet({ chain, unconfirmedLanoshis: -first.feeLanoshis + off, recorded: [first], nowSeconds: NOW }).inFlight).toBe('other');
    }
  });

  it('two merges of ours in flight explain the figure only together', () => {
    const chain = pieces(1, 45);
    const a1 = merge(500, chain.slice(0, 20));
    const a2 = merge(501, chain.slice(20, 40));
    expect(assessWallet({ chain, unconfirmedLanoshis: -(a1.feeLanoshis + a2.feeLanoshis), recorded: [a1, a2], nowSeconds: NOW }).inFlight).toBe('ours');
    expect(assessWallet({ chain, unconfirmedLanoshis: -a1.feeLanoshis, recorded: [a1, a2], nowSeconds: NOW }).inFlight).toBe('other');
  });

  it('unconfirmed movement with no merge of ours: someone else\'s', () => {
    expect(assessWallet({ chain: pieces(1, 30), unconfirmedLanoshis: -250_000_000, recorded: [], nowSeconds: NOW }).inFlight).toBe('other');
    expect(assessWallet({ chain: pieces(1, 30), unconfirmedLanoshis: 250_000_000, recorded: [], nowSeconds: NOW }).inFlight).toBe('other');
  });

  it('a balance that cannot be read is unknown — never none', () => {
    expect(assessWallet({ chain: pieces(1, 30), unconfirmedLanoshis: null, recorded: [], nowSeconds: NOW }).inFlight).toBe('unknown');
  });

  it('a merge whose output is listed as confirmed is done, whatever else is listed', () => {
    const chain = pieces(1, 30);
    const done = merge(500, chain.slice(0, 20));
    const withOutput = [...chain.slice(20), { tx_hash: done.txid, tx_pos: 0, value: done.netLanoshis, height: 101 }, ...chain.slice(0, 1)];
    const a = assessWallet({ chain: withOutput, unconfirmedLanoshis: -5, recorded: [done], nowSeconds: NOW });
    expect(a.pending).toHaveLength(0);
    expect(a.busy.size).toBe(0);
  });

  it('a merge none of whose pieces is still listed is not holding anything', () => {
    const chain = pieces(1, 30);
    const gone = merge(500, pieces(1000, 20));
    const a = assessWallet({ chain, unconfirmedLanoshis: -gone.feeLanoshis, recorded: [gone], nowSeconds: NOW });
    expect(a.pending).toHaveLength(0);
    expect(a.inFlight).toBe('other');
  });

  it('with nothing unconfirmed, a merge older than a few minutes hides nothing — it confirmed or never went in', () => {
    const chain = pieces(1, 30);
    const remembered = merge(500, chain.slice(0, 20), NOW - JUST_SENT_SECONDS - 1);
    const a = assessWallet({ chain, unconfirmedLanoshis: 0, recorded: [remembered], nowSeconds: NOW });
    expect(a.inFlight).toBe('none');
    expect(a.available).toHaveLength(30);
  });

  it('with nothing unconfirmed YET, a merge sent a moment ago still holds its pieces — the balance lags the broadcast', () => {
    const chain = pieces(1, 30);
    const justSent = merge(500, chain.slice(0, 20), NOW - 5);
    const a = assessWallet({ chain, unconfirmedLanoshis: 0, recorded: [justSent], nowSeconds: NOW });
    expect(a.inFlight).toBe('ours');
    expect(a.available).toHaveLength(10);
    expect(decideConsolidation(names(chain.slice(0, 20)), a)).toMatchObject({ ok: false, code: 'PIECES_ALREADY_MERGING' });
  });

  it('a balance nobody can read still holds back what we just spent', () => {
    const chain = pieces(1, 30);
    const justSent = merge(500, chain.slice(0, 20));
    const a = assessWallet({ chain, unconfirmedLanoshis: null, recorded: [justSent], nowSeconds: NOW });
    expect(a.inFlight).toBe('unknown');
    expect(a.busy.size).toBe(20);
  });

  it('a merge older than the window holds nothing', () => {
    const chain = pieces(1, 30);
    const old = merge(500, chain.slice(0, 20), NOW - PENDING_WINDOW_HOURS * 3600 - 1);
    const a = assessWallet({ chain, unconfirmedLanoshis: -old.feeLanoshis, recorded: [old], nowSeconds: NOW });
    expect(a.pending).toHaveLength(0);
    expect(a.inFlight).toBe('other');
  });
});

describe('may these pieces be merged now', () => {
  const chain = pieces(1, 45);
  const clean = assessWallet({ chain, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });

  it('the values come from the chain — a request claiming more is priced at what the chain says', () => {
    const lying = chain.slice(0, 20).map(u => ({ ...u, value: 999_999_999_999 }));
    const d = decideConsolidation(lying, clean);
    expect(d.ok).toBe(true);
    if (d.ok !== true) return;
    expect(d.totalLanoshis).toBe(20 * 1_000_000);
    expect(d.feeLanoshis).toBe(consolidationFee(20));
    expect(d.netLanoshis).toBe(20 * 1_000_000 - consolidationFee(20));
    expect(d.inputs.every(u => u.value === 1_000_000)).toBe(true);
  });

  it('one piece, too many pieces, a piece twice, a malformed piece', () => {
    expect(decideConsolidation(names(chain.slice(0, 1)), clean)).toMatchObject({ ok: false, code: 'TOO_FEW_PIECES' });
    expect(decideConsolidation(names(chain.slice(0, MAX_INPUTS + 1)), clean)).toMatchObject({ ok: false, code: 'TOO_MANY_PIECES' });
    expect(decideConsolidation([...names(chain.slice(0, 3)), names(chain)[0]], clean)).toMatchObject({ ok: false, code: 'DUPLICATE_PIECES' });
    expect(decideConsolidation([{ tx_hash: 'nothex', tx_pos: 0 }, names(chain)[1]], clean)).toMatchObject({ ok: false, code: 'INVALID_INPUTS' });
    expect(decideConsolidation('all of them', clean)).toMatchObject({ ok: false, code: 'INVALID_INPUTS' });
  });

  it('the double press: pieces our merge in flight already spent are refused, though the chain still lists them', () => {
    const first = merge(500, chain.slice(0, 20));
    const wallet = assessWallet({ chain, unconfirmedLanoshis: -first.feeLanoshis, recorded: [first], nowSeconds: NOW });
    expect(decideConsolidation(names(chain.slice(0, 20)), wallet)).toMatchObject({ ok: false, httpStatus: 409, code: 'PIECES_ALREADY_MERGING' });
    // …and one shared piece is enough.
    expect(decideConsolidation(names([...chain.slice(19, 21)]), wallet)).toMatchObject({ ok: false, code: 'PIECES_ALREADY_MERGING' });
  });

  it('the head start: a second merge of other pieces goes while ours confirms', () => {
    const first = merge(500, chain.slice(0, 20));
    const wallet = assessWallet({ chain, unconfirmedLanoshis: -first.feeLanoshis, recorded: [first], nowSeconds: NOW });
    expect(decideConsolidation(names(chain.slice(20, 40)), wallet)).toMatchObject({ ok: true });
  });

  it('something else moving, or a balance nobody can read: nothing is signed', () => {
    const other = assessWallet({ chain, unconfirmedLanoshis: -1, recorded: [], nowSeconds: NOW });
    expect(decideConsolidation(names(chain.slice(0, 20)), other)).toMatchObject({ ok: false, httpStatus: 409, code: 'WALLET_HAS_PENDING_TRANSACTION' });
    const unknown = assessWallet({ chain, unconfirmedLanoshis: null, recorded: [], nowSeconds: NOW });
    expect(decideConsolidation(names(chain.slice(0, 20)), unknown)).toMatchObject({ ok: false, httpStatus: 503, code: 'WALLET_UNREADABLE' });
  });

  it('a piece not in the wallet, or not yet confirmed, is refused', () => {
    expect(decideConsolidation([...names(chain.slice(0, 5)), { tx_hash: hash(9999), tx_pos: 0 }], clean))
      .toMatchObject({ ok: false, code: 'PIECES_NOT_SPENDABLE' });
    const young = [...chain, piece(777, 5_000_000, 0)];
    const wallet = assessWallet({ chain: young, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });
    expect(decideConsolidation(names([young[0], young[young.length - 1]]), wallet)).toMatchObject({ ok: false, code: 'PIECES_NOT_SPENDABLE' });
  });

  it('pieces worth less than the fee to merge them are refused, to the lanoshi', () => {
    const fee2 = consolidationFee(2);
    const edge = [piece(1, fee2 + 1000 - 1, 100), piece(2, 0 + 0, 100)];
    const w1 = assessWallet({ chain: edge, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });
    expect(decideConsolidation(names(edge), w1)).toMatchObject({ ok: false, code: 'MERGE_CANNOT_PAY_FEE' });
    const enough = [piece(1, fee2 + 1000, 100), piece(2, 0, 100)];
    const w2 = assessWallet({ chain: enough, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });
    expect(decideConsolidation(names(enough), w2)).toMatchObject({ ok: true, netLanoshis: 1000 });
  });
});

describe('what the broadcast said', () => {
  it('only a 64-hex id is a transaction', () => {
    expect(broadcastOutcome('A'.repeat(64))).toEqual({ ok: true, txid: 'a'.repeat(64) });
    expect(broadcastOutcome("{u'message': u'TX rejected', u'code': -22}")).toMatchObject({ ok: false, rejected: true });
    expect(broadcastOutcome({ code: -26 })).toMatchObject({ ok: false, rejected: false });
    expect(broadcastOutcome(null)).toMatchObject({ ok: false });
    expect(broadcastOutcome('abc')).toMatchObject({ ok: false, rejected: false });
  });
});

describe('a stored row', () => {
  it('reads back as the merge it recorded; an unreadable one holds nothing', () => {
    const r = rowToRecorded({
      txid: hash(5), inputs_json: JSON.stringify([{ tx_hash: hash(1), tx_pos: 2, value: 3 }]), input_count: 1,
      total_lanoshis: 3, fee_lanoshis: 1, net_lanoshis: 2, created_at: '2026-09-13 18:00:00',
    });
    expect(r).toMatchObject({ txid: hash(5), inputCount: 1, feeLanoshis: 1, createdAt: Date.UTC(2026, 8, 13, 18) / 1000 });
    expect(rowToRecorded({ txid: 'x', inputs_json: '{broken', created_at: '' }).inputs).toEqual([]);
  });
});

describe('the room an open offer leaves', () => {
  it('nothing promised: no limit', () => {
    expect(feeRoomLanoshis(5_000_000_000, 0)).toBeNull();
  });
  it('down to the backing tolerance and not a lanoshi past it', () => {
    const balance = 23_000_000_000;
    const agreed = balance - 33_600;                    // Max
    expect(feeRoomLanoshis(balance, agreed)).toBe(33_600 + BACKING_TOLERANCE_LANOSHIS);
    expect(feeRoomLanoshis(balance, balance + BACKING_TOLERANCE_LANOSHIS + 1)).toBe(0);
  });
  it('an unreadable balance with an offer open leaves no room', () => {
    expect(feeRoomLanoshis(null, 1)).toBe(0);
  });
  it('a fee one lanoshi over the room is refused; at the room it goes', () => {
    const chain = pieces(1, 45);
    const wallet = assessWallet({ chain, unconfirmedLanoshis: 0, recorded: [], nowSeconds: NOW });
    const fee = consolidationFee(20);
    expect(decideConsolidation(names(chain.slice(0, 20)), wallet, { feeRoomLanoshis: fee - 1 }))
      .toMatchObject({ ok: false, httpStatus: 409, code: 'MERGE_WOULD_UNDERCUT_OFFER' });
    expect(decideConsolidation(names(chain.slice(0, 20)), wallet, { feeRoomLanoshis: fee })).toMatchObject({ ok: true });
    expect(decideConsolidation(names(chain.slice(0, 20)), wallet, { feeRoomLanoshis: null })).toMatchObject({ ok: true });
  });
});

describe('the gate', () => {
  const ADDRESS = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
  const clear = { blocked: false };
  it('a wallet on the account\'s own list, unfrozen, passes', () => {
    expect(walletGateVerdict({ address: ADDRESS, listedWallets: [{ walletId: ADDRESS.toLowerCase() }], freeze: clear })).toEqual({ blocked: false });
  });
  it('naming an account whose list does not carry the wallet is refused — that is how a freeze would be dodged', () => {
    expect(walletGateVerdict({ address: ADDRESS, listedWallets: [{ walletId: 'Lsomeoneelse' }], freeze: clear }))
      .toMatchObject({ blocked: true, httpStatus: 403, code: 'WALLET_NOT_OWNED' });
  });
  it('an unreadable list is a wait, never a pass', () => {
    expect(walletGateVerdict({ address: ADDRESS, listedWallets: [], freeze: clear })).toMatchObject({ blocked: true, httpStatus: 503, code: 'WALLET_OWNERSHIP_UNVERIFIABLE' });
    expect(walletGateVerdict({ address: ADDRESS, listedWallets: null, freeze: clear })).toMatchObject({ blocked: true, code: 'WALLET_OWNERSHIP_UNVERIFIABLE' });
  });
  it('a freeze a sale would meet stops it', () => {
    expect(walletGateVerdict({ address: ADDRESS, listedWallets: [{ walletId: ADDRESS }], freeze: { blocked: true, code: 'WALLET_FROZEN', reason: 'frozen' } }))
      .toMatchObject({ blocked: true, httpStatus: 403, code: 'WALLET_FROZEN' });
  });
});
