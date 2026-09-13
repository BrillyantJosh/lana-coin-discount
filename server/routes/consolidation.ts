/**
 * /api/wallets — merging a wallet's pieces on lana.discount itself.
 *
 *   POST /consolidation   { address }                               read-only
 *        The wallet's pieces as the chain lists them, which of them can be
 *        merged now, whether a merge of ours is still on its way, and — when
 *        an offer from this wallet is open — how much fee consolidating may
 *        still spend. The page builds its batches from this with the same
 *        planning modules the server prices them with.
 *
 *   POST /consolidate     { hexId, address, privateKey, inputs:[{tx_hash,tx_pos}] }
 *        Merge ONE batch into one output back to the same address, signed here
 *        with the key from the body (the trust model the transfer already
 *        uses: used once, never stored, never logged).
 *
 * Copied from MejmoSeFajn's /consolidate-wallet (owner, 13 Sept 2026), with
 * the checks it lacked; the reasons are in lib/consolidation.ts. In order:
 * the key must belong to the address · one merge per wallet at a time · the
 * wallet on the account's own list, and no freeze a sale would meet · the chain
 * read fresh · the decision (pieces still there, nothing else moving, fee
 * covered, fee inside the room open offers leave, values from the chain) ·
 * sign · broadcast · remember what was spent.
 *
 * Nothing leaves the wallet but the network fee: the only output is the
 * wallet's own address, and the signed transaction is checked for that before
 * it is broadcast.
 */
import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { getDbHandle, getElectrumServersFromDb, getRelaysFromDb, getTrustedSignersFromDb } from '../db/index.js';
import { electrumCall as realElectrumCall, type ElectrumServer } from '../lib/electrum.js';
import {
  buildSignedTx as realBuildSignedTx, base58CheckDecode, hexToUint8Array, isValidLanaAddress, normalizeAddress,
  normalizeWif, privateKeyToPublicKey, privateKeyToUncompressedPublicKey, publicKeyToAddress, sha256d, uint8ArrayToHex,
} from '../lib/transaction.js';
import { readFreeze } from '../lib/sellerEligibility.js';
import { MAX_INPUTS } from '../lib/consolidationPlan.js';
import { BACKING_TOLERANCE_LANOSHIS } from '../lib/acquisitionBacking.js';
import {
  assessWallet, broadcastOutcome, decideConsolidation, feeRoomLanoshis, rowToRecorded, walletGateVerdict,
  PENDING_WINDOW_HOURS, type ChainUtxo, type WalletAssessment,
} from '../lib/consolidation.js';

export type WalletGate = (hexId: string, address: string) =>
  Promise<{ blocked: false } | { blocked: true; httpStatus: number; code: string; reason: string }>;

export interface ConsolidationDeps {
  walletCheckBaseUrl: string;
  db?: () => Database.Database;
  servers?: () => ElectrumServer[];
  electrumCall?: (method: string, params: any[], servers: ElectrumServer[], timeout?: number) => Promise<any>;
  buildSignedTx?: typeof realBuildSignedTx;
  /** Ownership and freeze, as lib/consolidation.ts walletGateVerdict decides them. */
  walletGate?: WalletGate;
  now?: () => number;
}

/** Which of the two addresses a WIF derives this address is, or null when neither. */
export function keyMatchesAddress(privateKey: string, address: string): { compressed: boolean } | null {
  try {
    const bytes = base58CheckDecode(normalizeWif(privateKey));
    const hex = uint8ArrayToHex(bytes.slice(1, 33));
    if (hex.length !== 64) return null;
    if (publicKeyToAddress(privateKeyToPublicKey(hex)) === address) return { compressed: true };
    if (publicKeyToAddress(privateKeyToUncompressedPublicKey(hex)) === address) return { compressed: false };
    return null;
  } catch {
    return null;
  }
}

/** The id a signed transaction will have: sha256d of its bytes, byte-reversed. */
export function txidOf(txHex: string): string {
  return uint8ArrayToHex(sha256d(hexToUint8Array(txHex)).reverse());
}

/**
 * LANA this wallet has promised in offers that are still open: under review,
 * offered and not lapsed, or accepted and not yet transferred. The same states
 * the mandate ledger reserves (acquisitionOffer.ts consumedByMandate).
 */
export function committedLanoshis(db: Database.Database, wallet: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(lana_amount_lanoshis), 0) AS c
      FROM acquisition_offers
     WHERE sender_wallet_id = ?
       AND (status IN ('submitted', 'under_review', 'accepted')
            OR (status = 'offered' AND (offer_expires_at IS NULL OR offer_expires_at > datetime('now'))))
  `).get(wallet) as { c: number } | undefined;
  return Number(row?.c) || 0;
}

export function createConsolidationRouter(deps: ConsolidationDeps): Router {
  const router = Router();
  const db = deps.db || getDbHandle;
  const servers = deps.servers || getElectrumServersFromDb;
  const electrumCall = deps.electrumCall || realElectrumCall;
  const buildSignedTx = deps.buildSignedTx || realBuildSignedTx;
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const walletGate: WalletGate = deps.walletGate || (async (hexId, address) => {
    try {
      const { freeze, listedWallets } = await readFreeze(hexId, address, {
        relays: getRelaysFromDb(),
        trustedRegistrars: getTrustedSignersFromDb().LanaRegistrar || [],
        walletCheckBaseUrl: deps.walletCheckBaseUrl,
      });
      return walletGateVerdict({ address, listedWallets, freeze });
    } catch {
      return { blocked: true, httpStatus: 403, code: 'FREEZE_UNVERIFIABLE', reason: 'Freeze status could not be verified right now. Please try again shortly.' };
    }
  });

  /** Wallets with a merge being signed or broadcast right now. One at a time each. */
  const busyWallets = new Set<string>();

  const recorded = (wallet: string) => (db().prepare(
    `SELECT * FROM wallet_consolidations WHERE wallet_id = ? AND created_at >= datetime('now', ?) ORDER BY created_at`,
  ).all(wallet, `-${PENDING_WINDOW_HOURS} hours`) as any[]).map(rowToRecorded);

  const remember = (address: string, hexId: string | null, txid: string, decision: { inputs: ChainUtxo[]; totalLanoshis: number; feeLanoshis: number; netLanoshis: number }) => {
    try {
      db().prepare(`
        INSERT OR IGNORE INTO wallet_consolidations
          (wallet_id, hex_id, txid, inputs_json, input_count, total_lanoshis, fee_lanoshis, net_lanoshis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        address, hexId, txid,
        JSON.stringify(decision.inputs.map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos, value: u.value }))),
        decision.inputs.length, decision.totalLanoshis, decision.feeLanoshis, decision.netLanoshis,
      );
    } catch (err: any) {
      // A row that cannot be written costs only the head start on the next
      // merge: without it the wallet reads 'other' and waits a block.
      console.error(`[consolidation] ${txid} not recorded:`, err?.message || err);
    }
  };

  /** The chain and our memory, together. Throws when the pieces cannot be read. */
  const readWallet = async (address: string): Promise<{
    chain: ChainUtxo[]; unconfirmed: number | null; balance: number | null; roomBalance: number | null;
    committed: number; assessment: WalletAssessment;
  }> => {
    const list = servers();
    const [utxos, reading] = await Promise.all([
      electrumCall('blockchain.address.listunspent', [address], list),
      electrumCall('blockchain.address.get_balance', [address], list).catch(() => null),
    ]);
    if (!Array.isArray(utxos)) throw new Error('listunspent did not answer with a list');
    const chain: ChainUtxo[] = utxos
      .filter((u: any) => u && typeof u.tx_hash === 'string' && Number.isInteger(u.tx_pos) && Number.isFinite(Number(u.value)))
      .map((u: any) => ({ tx_hash: String(u.tx_hash).toLowerCase(), tx_pos: u.tx_pos, value: Number(u.value), height: Number(u.height) || 0 }));
    const confirmed = reading && typeof reading === 'object' ? Number((reading as any).confirmed) : NaN;
    const pendingFigure = reading && typeof reading === 'object' ? Number((reading as any).unconfirmed) : NaN;
    const unconfirmed = Number.isFinite(pendingFigure) ? pendingFigure : null;
    const balance = Number.isFinite(confirmed) && unconfirmed !== null ? confirmed + unconfirmed : null;
    const assessment = assessWallet({ chain, unconfirmedLanoshis: unconfirmed, recorded: recorded(address), nowSeconds: now() });
    // The balance the fee room is measured from must already carry the fee of
    // every merge of ours still on its way. electrum's figure does once it sees
    // them; in the minutes after a broadcast it may not yet, and then a second
    // merge would be measured against a room the first has already used
    // (review of the fixes, 13 Sept 2026). The lower of the two is the truth in
    // both cases.
    const pendingFees = assessment.pending.reduce((s, p) => s + p.feeLanoshis, 0);
    const roomBalance = balance === null ? null : Math.min(balance, confirmed - pendingFees);
    return { chain, unconfirmed, balance, roomBalance, committed: committedLanoshis(db(), address), assessment };
  };

  // ── read ──────────────────────────────────────────────────────────────
  router.post('/consolidation', async (req: Request, res: Response) => {
    const address = normalizeAddress(String(req.body?.address || ''));
    if (!address || !isValidLanaAddress(address)) return res.status(400).json({ success: false, error: 'A valid wallet address is required.' });
    try {
      const { chain, unconfirmed, balance, roomBalance, committed, assessment } = await readWallet(address);
      const removedByPending = assessment.pending.reduce((s, p) => s + Math.max(0, p.inputCount - 1), 0);
      return res.json({
        success: true,
        address,
        maxInputs: MAX_INPUTS,
        utxoCount: chain.length,
        piecesAfterPending: Math.max(0, chain.length - removedByPending),
        totalLanoshis: chain.reduce((s, u) => s + u.value, 0),
        balanceLanoshis: balance,
        unconfirmedLanoshis: unconfirmed,
        committedLanoshis: committed,
        feeRoomLanoshis: feeRoomLanoshis(roomBalance, committed),
        // Unclamped: below zero when the offers already exceed what the wallet
        // can back, so a top-up figure can include that shortfall too.
        feeRoomUnclampedLanoshis: committed > 0 && roomBalance !== null ? roomBalance + BACKING_TOLERANCE_LANOSHIS - committed : null,
        inFlight: assessment.inFlight,
        available: [...assessment.available].sort((a, b) => b.value - a.value),
        confirmingCount: assessment.confirming.length,
        pending: assessment.pending.map(p => ({
          txid: p.txid, inputCount: p.inputCount, feeLanoshis: p.feeLanoshis, netLanoshis: p.netLanoshis,
          createdAt: new Date(p.createdAt * 1000).toISOString(),
        })),
      });
    } catch (err: any) {
      console.error('[consolidation] wallet read failed:', address.slice(0, 10), err?.message || err);
      return res.status(503).json({ success: false, error: 'The wallet could not be read right now. Please try again in a moment.' });
    }
  });

  // ── merge one batch ───────────────────────────────────────────────────
  router.post('/consolidate', async (req: Request, res: Response) => {
    const hexId = String(req.body?.hexId || '').toLowerCase();
    const address = normalizeAddress(String(req.body?.address || ''));
    const privateKey = String(req.body?.privateKey || '');
    const inputs = req.body?.inputs;

    if (!/^[0-9a-f]{64}$/.test(hexId) || !address || !privateKey || !Array.isArray(inputs)) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', error: 'Missing required fields.' });
    }
    if (!isValidLanaAddress(address)) {
      return res.status(400).json({ success: false, code: 'INVALID_ADDRESS', error: 'That is not a valid wallet address.' });
    }
    const key = keyMatchesAddress(privateKey, address);
    if (!key) {
      return res.status(400).json({ success: false, code: 'KEY_MISMATCH', error: 'This private key does not belong to this wallet. Nothing was sent.' });
    }

    if (busyWallets.has(address)) {
      return res.status(409).json({ success: false, code: 'MERGE_IN_PROGRESS', error: 'A consolidation from this wallet is being sent right now. Wait for it to finish.' });
    }
    busyWallets.add(address);
    try {
      const gate = await walletGate(hexId, address);
      if (gate.blocked === true) {
        console.log(`[consolidation] Blocked (${gate.code}): wallet ${address.slice(0, 10)}…`);
        return res.status(gate.httpStatus).json({ success: false, code: gate.code, error: gate.reason });
      }

      let wallet: Awaited<ReturnType<typeof readWallet>>;
      try {
        wallet = await readWallet(address);
      } catch (err: any) {
        console.error('[consolidation] wallet read failed before signing:', address.slice(0, 10), err?.message || err);
        return res.status(503).json({ success: false, code: 'WALLET_UNREADABLE', error: 'The wallet could not be read right now, so nothing was sent. Please try again in a moment.' });
      }

      const decision = decideConsolidation(inputs, wallet.assessment, { feeRoomLanoshis: feeRoomLanoshis(wallet.roomBalance, wallet.committed) });
      if (decision.ok === false) {
        console.log(`[consolidation] Refused (${decision.code}): wallet ${address.slice(0, 10)}… ${Array.isArray(inputs) ? inputs.length : 0} pieces, in flight: ${wallet.assessment.inFlight}`);
        return res.status(decision.httpStatus).json({ success: false, code: decision.code, error: decision.error });
      }

      const list = servers();
      let built: Awaited<ReturnType<typeof buildSignedTx>>;
      try {
        built = await buildSignedTx(
          decision.inputs, privateKey, [{ address, amount: decision.netLanoshis }],
          decision.feeLanoshis, address, list, key.compressed,
        );
      } catch (err: any) {
        console.error('[consolidation] signing failed:', address.slice(0, 10), err?.message ? String(err.message).slice(0, 200) : err);
        return res.status(500).json({ success: false, code: 'MERGE_FAILED', error: 'The consolidation could not be prepared, and nothing was sent. Please try again in a moment.' });
      }
      // One output, to this wallet. buildSignedTx adds a change output only
      // when inputs − amount − fee exceeds 1,000 lanoshis, which by
      // construction it never does here; if it ever did, something upstream
      // has changed and this is not the transaction that was decided.
      if (built.outputCount !== 1 || built.inputCount !== decision.inputs.length) {
        console.error(`[consolidation] Built tx shape unexpected (${built.inputCount} in / ${built.outputCount} out) — not broadcast`);
        return res.status(500).json({ success: false, code: 'UNEXPECTED_SHAPE', error: 'The consolidation could not be prepared correctly, so nothing was sent.' });
      }
      const localTxid = txidOf(built.txHex);

      // FROM HERE THE TRANSACTION HAS LEFT THIS SERVER. A node's refusal means
      // nothing moved; anything else that goes wrong — a timeout, a dropped
      // connection — means we do not know, and must never be told as "nothing
      // moved" (review, 13 Sept 2026: the network can take it while the answer
      // is lost). Then electrum is asked for the transaction itself, and if it
      // cannot say either, the merge is remembered as possibly on its way so
      // its pieces are held back — for minutes, if it never shows.
      let outcome: ReturnType<typeof broadcastOutcome>;
      let thrown = false;
      try {
        outcome = broadcastOutcome(await electrumCall('blockchain.transaction.broadcast', [built.txHex], list, 45000));
      } catch (err: any) {
        outcome = { ok: false, rejected: false, raw: String(err?.message || err) };
        // Only a silence is uncertain. No connection means nothing was written;
        // electrum's own error object is an answer. Both are "nothing moved".
        thrown = !(err?.notSent || err?.electrumRefused);
      }

      if (outcome.ok === false && outcome.rejected) {
        console.error(`[consolidation] Network refused ${address.slice(0, 10)}…: ${outcome.raw.slice(0, 300)}`);
        return res.status(502).json({
          success: false, code: 'NETWORK_REJECTED',
          error: 'The network refused this consolidation, and nothing moved. Usually another transaction from this wallet got there first — check the wallet again in a few minutes.',
        });
      }

      if (outcome.ok === false) {
        if (!thrown) {
          // electrum answered, and not with a transaction id: its own refusal.
          console.error(`[consolidation] Broadcast not accepted for ${address.slice(0, 10)}…: ${outcome.raw.slice(0, 300)}`);
          return res.status(502).json({
            success: false, code: 'BROADCAST_FAILED',
            error: 'The network did not accept this consolidation, and nothing moved. Please try again in a moment.',
          });
        }
        let seen = false;
        try {
          const tx = await electrumCall('blockchain.transaction.get', [localTxid], list, 15000);
          seen = typeof tx === 'string' && tx.length > 0;
        } catch { /* still unknown */ }
        remember(address, hexId, localTxid, decision);
        if (!seen) {
          console.error(`[consolidation] Broadcast of ${localTxid} unanswered (${outcome.raw.slice(0, 120)}); remembered as possibly sent`);
          return res.status(202).json({
            success: false, code: 'BROADCAST_UNCERTAIN', txid: localTxid,
            error: 'The network did not answer in time, so it is not yet known whether this consolidation went through. Do not send it again — this page checks the wallet and shows it as soon as the network does.',
          });
        }
        outcome = { ok: true, txid: localTxid };
      } else {
        remember(address, hexId, outcome.txid, decision);
      }

      console.log(`[consolidation] Merged ${decision.inputs.length} pieces of ${address.slice(0, 10)}… → ${outcome.txid} (fee ${decision.feeLanoshis})`);
      return res.json({
        success: true,
        txid: outcome.txid,
        inputCount: decision.inputs.length,
        totalLanoshis: decision.totalLanoshis,
        feeLanoshis: decision.feeLanoshis,
        netLanoshis: decision.netLanoshis,
      });
    } catch (err: any) {
      console.error('[consolidation] consolidate failed:', address.slice(0, 10), err?.message ? String(err.message).slice(0, 200) : err);
      return res.status(500).json({ success: false, code: 'MERGE_FAILED', error: 'The consolidation could not be completed. Check the wallet again before trying once more.' });
    } finally {
      busyWallets.delete(address);
    }
  });

  return router;
}
