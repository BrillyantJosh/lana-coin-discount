/**
 * THE CONSOLIDATION PANEL ON THE OFFER PAGE.
 *
 * What it must never do: send without a key that belongs to the wallet, send
 * coin VALUES (the server prices from the chain), offer a button while
 * something else in the wallet is unconfirmed, or leave the seller guessing
 * when the consolidation has confirmed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ConsolidateWallet from './ConsolidateWallet';
import { CONSOLIDATE } from '@/copy';

const ADDRESS = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const HEX = 'a'.repeat(64);

vi.mock('@/lib/crypto', () => ({
  convertWifToIds: (wif: string) => {
    if (wif === 'GOOD-WIF') return { walletIdCompressed: ADDRESS, walletIdUncompressed: 'Lother1' };
    if (wif === 'OTHER-WIF') return { walletIdCompressed: 'Lsomeone', walletIdUncompressed: 'Lsomeone2' };
    throw new Error('Invalid WIF');
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const hash = (n: number) => n.toString(16).padStart(64, '0');
const pieces = (count: number, value = 1_000_000) =>
  Array.from({ length: count }, (_, i) => ({ tx_hash: hash(i + 1), tx_pos: 0, value, height: 100 }));

type Read = Record<string, any>;
const walletRead = (over: Read = {}): Read => ({
  success: true, maxInputs: 20, utxoCount: 45, piecesAfterPending: 45, totalLanoshis: 45_000_000,
  balanceLanoshis: 45_000_000, unconfirmedLanoshis: 0, feeRoomLanoshis: null, feeRoomUnclampedLanoshis: null,
  inFlight: 'none', available: pieces(45), confirmingCount: 0, pending: [], ...over,
});

let reads: Read[] = [];
let posted: any[] = [];
let consolidateReply: Read = { success: true, txid: 'f'.repeat(64) };

beforeEach(() => {
  reads = [walletRead()];
  posted = [];
  consolidateReply = { success: true, txid: 'f'.repeat(64) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/api/wallets/consolidation') {
      const next = reads.length > 1 ? reads.shift()! : reads[0];
      return { ok: true, json: async () => next } as any;
    }
    if (url === '/api/wallets/consolidate') {
      posted.push(body);
      return { ok: consolidateReply.success, json: async () => consolidateReply } as any;
    }
    throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const buttons = () => screen.queryAllByRole('button', { name: CONSOLIDATE.batchButton });
const typeKey = (value: string) => fireEvent.change(screen.getByPlaceholderText(CONSOLIDATE.keyPlaceholder), { target: { value } });

describe('ConsolidateWallet', () => {
  it('builds the batches MejmoSeFajn would, and keeps every button off until the key is this wallet\'s', async () => {
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    // 45 pieces of 1,000,000: two full batches of 20, then one of 5.
    expect(buttons()).toHaveLength(3);
    expect(buttons().every(b => (b as HTMLButtonElement).disabled)).toBe(true);

    typeKey('OTHER-WIF');
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.keyMismatch)).toBeInTheDocument());
    expect(buttons().every(b => (b as HTMLButtonElement).disabled)).toBe(true);

    typeKey('GOOD-WIF');
    await waitFor(() => expect(buttons().every(b => !(b as HTMLButtonElement).disabled)).toBe(true));
  });

  it('sends the pieces by NAME only, with the key, and reads the wallet again', async () => {
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(buttons()).toHaveLength(3));
    typeKey('GOOD-WIF');
    await waitFor(() => expect((buttons()[0] as HTMLButtonElement).disabled).toBe(false));
    reads = [walletRead({ inFlight: 'ours', available: pieces(45).slice(20), piecesAfterPending: 26,
      pending: [{ txid: 'f'.repeat(64), inputCount: 20, feeLanoshis: 546600, netLanoshis: 19_453_400, createdAt: '2026-09-13T18:00:00Z' }] })];

    fireEvent.click(buttons()[0]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ hexId: HEX, address: ADDRESS, privateKey: 'GOOD-WIF' });
    expect(posted[0].inputs).toHaveLength(20);
    expect(posted[0].inputs.every((i: any) => Object.keys(i).sort().join() === 'tx_hash,tx_pos')).toBe(true);

    await waitFor(() => expect(screen.getByText(CONSOLIDATE.pendingTitle)).toBeInTheDocument());
    // The next batch is offered at once — the server holds back what the first spent.
    expect(buttons()).toHaveLength(2);
  });

  it('a double press sends once', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} initialKey="GOOD-WIF" />);
    await waitFor(() => expect(buttons()).toHaveLength(3));
    await waitFor(() => expect((buttons()[0] as HTMLButtonElement).disabled).toBe(false));
    const realFetch = (globalThis.fetch as any);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url === '/api/wallets/consolidate') { posted.push(JSON.parse(init.body)); await held; return { ok: true, json: async () => consolidateReply } as any; }
      return realFetch(url, init);
    }));
    fireEvent.click(buttons()[0]);
    fireEvent.click(buttons()[0]);
    await act(async () => { release(); });
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  it('something else unconfirmed in the wallet: says so, and offers no live button', async () => {
    reads = [walletRead({ inFlight: 'other' })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} initialKey="GOOD-WIF" />);
    await waitFor(() => expect(screen.getByText(new RegExp(CONSOLIDATE.otherInFlight.slice(0, 40)))).toBeInTheDocument());
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    expect(buttons().every(b => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('a refusal is shown in the server\'s words, and nothing is claimed as sent', async () => {
    consolidateReply = { success: false, code: 'PIECES_NOT_SPENDABLE', error: 'Some of these pieces are no longer in the wallet.' };
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} initialKey="GOOD-WIF" />);
    await waitFor(() => expect((buttons()[0] as HTMLButtonElement)?.disabled).toBe(false));
    fireEvent.click(buttons()[0]);
    await waitFor(() => expect(screen.getByText('Some of these pieces are no longer in the wallet.')).toBeInTheDocument());
    expect(screen.queryByText(CONSOLIDATE.pendingTitle)).toBeNull();
  });

  it('tells the page when the wallet fits one transfer — and not while it does not', async () => {
    const onSettled = vi.fn();
    const onPendingChange = vi.fn();
    reads = [
      walletRead({ inFlight: 'ours', piecesAfterPending: 26, pending: [{ txid: 'f'.repeat(64), inputCount: 20, feeLanoshis: 546600, netLanoshis: 1, createdAt: '' }] }),
      walletRead({ utxoCount: 26, piecesAfterPending: 26, available: pieces(26), inFlight: 'none', pending: [] }),
      walletRead({ utxoCount: 7, piecesAfterPending: 7, available: pieces(7), inFlight: 'none', pending: [] }),
    ];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} onSettled={onSettled} onPendingChange={onPendingChange} />);
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.pendingTitle)).toBeInTheDocument());
    expect(onPendingChange).toHaveBeenLastCalledWith(true);

    // Confirmed, but 26 pieces still do not fit: not settled yet.
    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(screen.queryByText(CONSOLIDATE.pendingTitle)).toBeNull());
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(onSettled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith(7);
    expect(screen.getByText(CONSOLIDATE.fitsNow)).toBeInTheDocument();
    expect(buttons()).toHaveLength(0);
  });

  it('a wallet that came to fit without this panel ever seeing a consolidation pending still tells the page', async () => {
    const onSettled = vi.fn();
    reads = [walletRead({ inFlight: 'other' }), walletRead({ utxoCount: 3, piecesAfterPending: 3, available: pieces(3) })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} onSettled={onSettled} />);
    await waitFor(() => expect(screen.getByText(new RegExp(CONSOLIDATE.otherInFlight.slice(0, 30)))).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it('with an offer open: only the cheapest consolidation that makes the wallet fit is offered', async () => {
    reads = [walletRead({ utxoCount: 21, piecesAfterPending: 21, available: pieces(21), feeRoomLanoshis: 533_600 })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} initialKey="GOOD-WIF" />);
    await waitFor(() => expect(buttons()).toHaveLength(1));
    expect(screen.getByText('2 pieces into 1')).toBeInTheDocument();
    expect(screen.getByText(CONSOLIDATE.targetIntro)).toBeInTheDocument();
  });

  it('with an offer open and no room for the fee: says so, with the top-up, and offers no button and asks for no key', async () => {
    reads = [walletRead({ utxoCount: 45, piecesAfterPending: 45, available: pieces(45), feeRoomLanoshis: 533_600, feeRoomUnclampedLanoshis: 533_600 })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.tightTitle)).toBeInTheDocument());
    expect(buttons()).toHaveLength(0);
    expect(screen.queryByPlaceholderText(CONSOLIDATE.keyPlaceholder)).toBeNull();
    // 20 + 7 inputs cost 742,200; the room is 533,600; one more input carries the top-up.
    expect(screen.getByText(/Add at least 0\.00235600 LANA/)).toBeInTheDocument();
  });

  it('with the balance unreadable, no top-up figure is invented', async () => {
    reads = [walletRead({ utxoCount: 45, piecesAfterPending: 45, available: pieces(45), feeRoomLanoshis: 0, feeRoomUnclampedLanoshis: null, balanceLanoshis: null, inFlight: 'unknown' })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.tightTitle)).toBeInTheDocument());
    expect(screen.queryByText(/Add at least/)).toBeNull();
    expect(screen.getByText(CONSOLIDATE.tightCannot)).toBeInTheDocument();
  });

  it('a payment arriving holds nothing: a wallet that fits counts as fitting, and the transfer is not held', async () => {
    const onSettled = vi.fn();
    const onPendingChange = vi.fn();
    reads = [walletRead({ utxoCount: 20, piecesAfterPending: 20, available: pieces(20), inFlight: 'other', unconfirmedLanoshis: 250_000_000 })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} onSettled={onSettled} onPendingChange={onPendingChange} />);
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(20));
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('a spend on its way, not ours, does hold the transfer', async () => {
    const onPendingChange = vi.fn();
    const onSettled = vi.fn();
    reads = [walletRead({ utxoCount: 20, piecesAfterPending: 20, available: pieces(20), inFlight: 'other', unconfirmedLanoshis: -250_000_000 })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} onSettled={onSettled} onPendingChange={onPendingChange} />);
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(true));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('an unanswered broadcast: the note stands while it is pending, says so when its pieces come back, and goes when it confirmed', async () => {
    const txid = 'c'.repeat(64);
    consolidateReply = { success: false, code: 'BROADCAST_UNCERTAIN', txid, error: 'The network did not answer in time.' };
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} initialKey="GOOD-WIF" />);
    await waitFor(() => expect((buttons()[0] as HTMLButtonElement)?.disabled).toBe(false));
    const pendingRead = walletRead({ inFlight: 'ours', piecesAfterPending: 26, pending: [{ txid, inputCount: 20, feeLanoshis: 546600, netLanoshis: 1, createdAt: '' }] });
    reads = [pendingRead, pendingRead];
    fireEvent.click(buttons()[0]);
    await waitFor(() => expect(posted).toHaveLength(1));
    const sentKeys = new Set(posted[0].inputs.map((i: any) => `${i.tx_hash}:${i.tx_pos}`));
    const remaining = pieces(45).filter(u => !sentKeys.has(`${u.tx_hash}:${u.tx_pos}`));
    pendingRead.available = remaining;
    await waitFor(() => expect(screen.getByText('The network did not answer in time.')).toBeInTheDocument());

    // Still pending on a later read: the note stands.
    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.pendingTitle)).toBeInTheDocument());
    expect(screen.getByText('The network did not answer in time.')).toBeInTheDocument();

    // Its pieces are back and nothing is pending: it did not go through.
    reads = [walletRead()];
    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(screen.getByText(CONSOLIDATE.uncertainFailed)).toBeInTheDocument());

    // …and on another path its pieces are simply gone: it confirmed, and the note goes.
    reads = [walletRead({ available: remaining, utxoCount: 26, piecesAfterPending: 26 })];
    fireEvent.click(screen.getByRole('button', { name: CONSOLIDATE.checkAgain }));
    await waitFor(() => expect(screen.queryByText(CONSOLIDATE.uncertainFailed)).toBeNull());
  });

  it('a wallet of dust worth more than one fee in total still gets its explanation', async () => {
    reads = [walletRead({ utxoCount: 25, piecesAfterPending: 25, available: pieces(25, 10_000) })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(screen.getByText('25 pieces cannot be consolidated')).toBeInTheDocument());
    expect(buttons()).toHaveLength(0);
  });

  it('a single healthy piece left over is not called worthless', async () => {
    reads = [walletRead({ utxoCount: 21, piecesAfterPending: 21, available: pieces(21, 15_532_366_071) })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(buttons()).toHaveLength(1));
    expect(screen.queryByText(/cannot be consolidated/)).toBeNull();
    expect(screen.queryByText(/cost more than they are worth/)).toBeNull();
    expect(screen.getByText(/1 piece left for a later round/)).toBeInTheDocument();
  });

  it('what no consolidation can pay for is said, not offered', async () => {
    reads = [walletRead({ utxoCount: 25, available: pieces(25, 20) })];
    render(<ConsolidateWallet address={ADDRESS} hexId={HEX} />);
    await waitFor(() => expect(screen.getByText('25 pieces cannot be consolidated')).toBeInTheDocument());
    expect(screen.getByText(/cost more than they are worth/)).toBeInTheDocument();
    expect(buttons()).toHaveLength(0);
    expect(screen.queryByPlaceholderText(CONSOLIDATE.keyPlaceholder)).toBeNull();
  });
});
