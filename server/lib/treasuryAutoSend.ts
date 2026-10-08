/**
 * The treasury's auto-send: every 5th heartbeat, the pending LANA legs of the
 * purchases the treasury settles go out of BUYBACK_WIF in one broadcast.
 *
 * Moved here from server/index.ts on 8 Oct 2026, unchanged in what it selects
 * and how it signs (whole purchases, at most 100 outputs, confirmed coins
 * only, the -22 blacklist, the cooldowns, buildSignedTx), so it can run in a
 * test against a fake chain. What changed is the end, after signing:
 *
 *   BEFORE: broadcast; an answer that was a txid → every leg 'sent' and
 *   lana-sent to the brain; anything else → legs left 'pending'. A broadcast
 *   the network took but whose answer did not come in time (a slow yes cut off,
 *   13 Sept 2026) left its legs 'pending', and the next cycle built a NEW
 *   transaction with other coins — the -22 blacklist even made sure of it —
 *   for the same recipients. Both could confirm: the same people paid twice.
 *
 *   NOW (lib/financer/sends.ts, the same machine the financers' sends use):
 *   the signed bytes are RECORDED first, every leg 'pending' → 'sending' with
 *   the txid in one immediate transaction (exactly one row each, or nothing is
 *   sent); then broadcast to every Electrum server at once. A 'sending' leg is
 *   never selected again. The send round (every heartbeat) marks the legs
 *   'sent' once the chain proves the transaction is in a block, tells the brain
 *   (lana-sent, through the outbox), sends the SAME bytes again while it waits,
 *   and releases the legs only on proof that this transaction cannot confirm.
 *   Coins spent by the treasury's own sends on their way are left out of the
 *   next selection (listunspent keeps listing a coin a mempool transaction
 *   spends), and a leg released from a refused send goes out again only in a
 *   send that spends one of that send's coins (must_spend_json).
 *
 * Deploy note: do not deploy lana.discount while a treasury send is announced
 * or in the mempool — the round finishes it after a restart, but a deploy is
 * the one moment nothing is looking.
 */
import type Database from 'better-sqlite3';
import { readAutoSendWindow, selectWholeGroups } from './autoSendSelection.js';
import { tryAcquireSendLock, releaseSendLock, sendLockHolder } from './sendLock.js';
import type { Sends } from './financer/sends.js';

export interface TreasuryAutoSendDeps {
  db: Database.Database;
  sends: Sends;
  electrumServers: () => Array<{ host: string; port: number }>;
  /** BUYBACK_WIF, read at every run. */
  wif: () => string | undefined;
  /** Batches whose own legs prove the LANA went out (server/index.ts settleFinishedBatches). */
  settleFinishedBatches: () => void;
  /** The 'lana_bought' batch with no linked legs (server/index.ts settleOrphanBoughtBatches). */
  settleOrphanBoughtBatches: () => void;
  maxOutputs?: number;
  windowRows?: number;
  now?: () => number;
}

export interface TreasuryAutoSend {
  run(): Promise<void>;
  /** The confirmed balance seen at the last run, in LANA (for a quick look; never a decision). */
  lastKnownBalance(): number;
}

/** One broadcast carries at most this many recipient outputs (the change is extra). */
export const AUTO_SEND_MAX_OUTPUTS = 100;
export const AUTO_SEND_WINDOW_ROWS = 1000;
/** A coin that produced a -22 "TX rejected" is not chosen again for this long. */
export const FAILED_UTXO_TTL = 20 * 60 * 1000;

export function createTreasuryAutoSend(deps: TreasuryAutoSendDeps): TreasuryAutoSend {
  const { db, sends } = deps;
  const now = deps.now ?? Date.now;
  const maxOutputs = deps.maxOutputs ?? AUTO_SEND_MAX_OUTPUTS;
  const windowRows = deps.windowRows ?? AUTO_SEND_WINDOW_ROWS;
  let autoSendSkipUntil = 0; // timestamp — skip auto-send until this time (insufficient balance cooldown)
  let lastKnownBalance = 0; // LANA balance from last Electrum fetch (for quick pre-check)
  // UTXOs that produced a -22 "TX rejected" broadcast. The buyback wallet is SHARED
  // with other services, and electrum1 has no mempool tracking — so listunspent can
  // report a UTXO as unspent when another service's mempool tx already spends it.
  // Spending such a UTXO is rejected as a double-spend; since selection always picks
  // the largest UTXO, the same one loops every cycle. We blacklist failed UTXOs for a
  // while so the next attempt selects different inputs instead of retrying the doomed one.
  const failedUtxos = new Map<string, number>(); // "txid:vout" -> expiry timestamp

  async function run(): Promise<void> {
    // The cooldown check comes FIRST, and deliberately so: it needs no lock, and
    // when it sat below the acquire its `return` left the process-wide send lock
    // taken with no finally above it to give it back. sendLock has no TTL, so one
    // such return would have frozen every payout — auto and manual — until the
    // next restart, behind a log line that reads like ordinary concurrency
    // protection. It never fired only because every cooldown (2, 3 and 5 minutes)
    // is shorter than the 5m03s send cycle, by about three seconds.
    if (now() < autoSendSkipUntil) {
      const remainSec = Math.ceil((autoSendSkipUntil - now()) / 1000);
      console.log(`[lana-discount] Auto-send: insufficient balance cooldown (${remainSec}s remaining) — skipping`);
      return;
    }

    // Prevent concurrent runs
    if (!tryAcquireSendLock('auto-send')) {
      const h = sendLockHolder();
      console.log(`[lana-discount] Auto-send: skipped — ${h?.who ?? 'another sender'} holds the send lock (${Math.round((h?.heldForMs ?? 0) / 1000)}s)`);
      return;
    }

    try {
      const buybackWif = deps.wif();
      if (!buybackWif) return;

      // Send LANA orders that are either:
      // 1. Explicitly authorized by Brain (brain_authorized=1), OR
      // 2. In a batch with incoming_batches.status = 'lana_bought' (admin confirmed receipt)
      // Read a WIDE window of authorized rows, then pick whole purchases from it.
      // The old query took the first 100 ROWS, which could end in the middle of a
      // purchase (its last legs being rows 101-103) — the legs then went out in
      // two broadcasts and the brain recorded one hash for all of them.
      // Only the treasury's own purchases (8 Oct 2026): a financer sends theirs
      // from their own wallet. The query lives in lib/autoSendSelection.ts so the
      // tests run it. A leg in a recorded send is 'sending', never read here.
      const windowRows_ = readAutoSendWindow<any>(db, windowRows);
      const selection = selectWholeGroups(windowRows_, {
        maxOutputs,
        windowTruncated: windowRows_.length >= windowRows,
      });
      if (selection.droppedTail) console.log(`[lana-discount] Auto-send: window full (${windowRows_.length} rows) — purchase ${selection.droppedTail} waits for the next run so it is not sent in part`);
      if (selection.groups[0] && selection.groups[0].length > maxOutputs) console.error(`[lana-discount] Auto-send: purchase ${selection.groups[0][0].transaction_ref} has ${selection.groups[0].length} legs — more than one broadcast normally carries; sending it whole, alone`);
      if (selection.deferredOversized.length) console.warn(`[lana-discount] Auto-send: ${selection.deferredOversized.length} purchase(s) larger than ${maxOutputs} outputs deferred: ${selection.deferredOversized.join(', ')}`);
      let pendingOrders = selection.orders;
      let groups = selection.groups;

      if (pendingOrders.length === 0) {
        // Batches whose own orders prove the LANA went out are closed by
        // settleFinishedBatches() on every cycle, whether or not anything is
        // pending. What is left here is the one case that function refuses to
        // touch: a batch the operator marked 'lana_bought' that has NO linked
        // orders at all, because the batch_ref never matched. That is a guess,
        // not evidence, so it stays behind the idle check and a 10-minute wait.
        deps.settleOrphanBoughtBatches();
        return;
      }

      const { normalizeWif, base58CheckDecode, privateKeyToUncompressedPublicKey, privateKeyToPublicKey, publicKeyToAddress, normalizeAddress, buildSignedTx } = await import('./transaction.js');
      const { electrumCall } = await import('./electrum.js');

      const electrumServers = deps.electrumServers();
      if (electrumServers.length === 0) {
        console.warn('[lana-discount] Auto-send: no electrum servers');
        return;
      }

      // Derive addresses from WIF
      const normalizedKey = normalizeWif(buybackWif);
      const keyBytes = base58CheckDecode(normalizedKey);
      const privKeyHex = Array.from(keyBytes.slice(1, 33)).map(b => b.toString(16).padStart(2, '0')).join('');

      const uncompAddr = publicKeyToAddress(privateKeyToUncompressedPublicKey(privKeyHex));
      const compAddr = publicKeyToAddress(privateKeyToPublicKey(privKeyHex));

      let useAddress = uncompAddr;
      let useCompressed = false;

      let utxos = await electrumCall('blockchain.address.listunspent', [uncompAddr], electrumServers);
      if (!utxos || utxos.length === 0) {
        utxos = await electrumCall('blockchain.address.listunspent', [compAddr], electrumServers);
        if (utxos && utxos.length > 0) { useAddress = compAddr; useCompressed = true; }
      }

      if (!utxos || utxos.length === 0) {
        console.warn('[lana-discount] Auto-send: no UTXOs in buyback wallet');
        autoSendSkipUntil = now() + 3 * 60 * 1000;
        return;
      }

      // Drop expired blacklist entries first, so good UTXOs become spendable
      // again — and so the coin rules below steer clear of exactly what is
      // still on the list.
      const pruneAt = now();
      for (const [k, exp] of failedUtxos) { if (exp <= pruneAt) failedUtxos.delete(k); }

      // The treasury's own sends on their way, and what a leg released from a
      // refused send demands (lib/financer/sends.ts). Purchases whose refused
      // send turned up on the chain after all wait for it. The coin a released
      // leg must spend is never one on the -22 list (review of 8 Oct 2026: the
      // largest coin, spent by a co-tenant in the mempool, got forced into
      // every cycle and chained every new purchase to it); when the list
      // leaves its set nothing, its purchase waits this cycle and the others go.
      // So does a purchase whose refused send went out of the OTHER address
      // (compressed vs uncompressed, chosen above): it waits for that address,
      // and the rest go — it used to skip the whole cycle, every cycle (recheck
      // of 9 Oct 2026). Passing the list is what asks for waiting over refusing.
      const coinRules = await sends.treasuryCoinRules(useAddress, pendingOrders, new Set(failedUtxos.keys()));
      if (coinRules.ok === false) {
        console.warn(`[lana-discount] Auto-send: ${coinRules.error} — skipping this cycle`);
        return;
      }
      const { inFlight, forced, blockedOrderIds, deferredOrderIds } = coinRules.rules;
      const waitFor = (ids: string[], why: string) => {
        if (!ids.length) return;
        const wait = new Set(ids);
        const waiting = groups.filter(g => g.some((o: any) => wait.has(String(o.id))));
        groups = groups.filter(g => !g.some((o: any) => wait.has(String(o.id))));
        console.warn(`[lana-discount] Auto-send: ${waiting.length} purchase(s) ${why}: ${waiting.map(g => g[0].transaction_ref).join(', ')}`);
      };
      waitFor(blockedOrderIds, 'wait for an earlier refused send that is on the chain after all');
      waitFor(deferredOrderIds, `wait: their next send must share a coin with an earlier refused one, and every such coin is blacklisted after a -22, on its way, or in the other treasury address (not ${useAddress})`);
      if (blockedOrderIds.length || deferredOrderIds.length) {
        pendingOrders = groups.flat();
        if (pendingOrders.length === 0) return;
      }

      // Whole purchases only (selectWholeGroups already grouped them); the
      // insufficient-balance branch below picks affordable groups smallest-first.
      const txGroups = groups.slice().sort((a, b) => {
        const sumA = a.reduce((s: number, o: any) => s + o.lana_amount, 0);
        const sumB = b.reduce((s: number, o: any) => s + o.lana_amount, 0);
        return sumA - sumB; // smallest groups first
      });

      let totalLanoshis = pendingOrders.reduce((s: number, o: any) => s + o.lana_amount, 0);
      const totalLana = totalLanoshis / 100_000_000;

      console.log(`[lana-discount] Auto-send LANA: ${pendingOrders.length} orders in ${txGroups.length} groups, ${totalLana.toFixed(3)} LANA total`);

      // Only spend CONFIRMED UTXOs. listunspent also returns the unconfirmed change
      // (height <= 0) created by a just-broadcast send; because selection sorts by
      // value desc, that large unconfirmed change gets picked first and the node
      // rejects the new TX with code -22 ("TX rejected") until the parent confirms.
      // The auto-send then retries the same doomed TX every heartbeat for ~30 min
      // (exactly the pattern seen in the logs). Filtering to height > 0 avoids it;
      // there's normally ample confirmed balance, and if not we just wait one cycle.
      const nowMs = now();

      // Coins a treasury send on its way already spends are not coins (8 Oct 2026).
      const confirmedUtxos = utxos.filter((u: any) => (u.height || 0) > 0 && !inFlight.has(`${u.tx_hash}:${u.tx_pos}`));
      if (confirmedUtxos.length === 0) {
        console.warn('[lana-discount] Auto-send: all UTXOs still unconfirmed (change not yet mined) — cooldown 3min');
        autoSendSkipUntil = nowMs + 3 * 60 * 1000;
        return;
      }
      // A coin a released leg MUST spend goes in first: it is what keeps the
      // refused send and this one from both confirming (never one on the
      // blacklist: the coin rules chose around it, above).
      const forcedUtxos = forced.map(key => confirmedUtxos.find((u: any) => `${u.tx_hash}:${u.tx_pos}` === key)).filter(Boolean);
      if (forcedUtxos.length !== forced.length) {
        console.warn('[lana-discount] Auto-send: a coin a released leg must spend is not listed now — skipping this cycle');
        return;
      }
      // Exclude UTXOs that recently produced a -22 rejection (likely already spent by
      // a co-tenant service's mempool tx that electrum1 hasn't reflected yet).
      const spendableUtxos = confirmedUtxos.filter((u: any) => !failedUtxos.has(`${u.tx_hash}:${u.tx_pos}`) && !forcedUtxos.includes(u));
      if (spendableUtxos.length === 0 && forcedUtxos.length === 0) {
        console.warn(`[lana-discount] Auto-send: all ${confirmedUtxos.length} confirmed UTXOs are blacklisted from recent -22 rejections — cooldown 5min`);
        autoSendSkipUntil = nowMs + 5 * 60 * 1000;
        return;
      }
      utxos = spendableUtxos;

      // Update known balance from UTXOs (confirmed only)
      lastKnownBalance = [...forcedUtxos, ...utxos].reduce((s: number, u: any) => s + u.value, 0) / 100_000_000;

      // Build recipients
      const txRecipients = pendingOrders.map((o: any) => ({
        address: normalizeAddress(o.to_wallet),
        amount: o.lana_amount,
      }));

      // UTXO selection — the forced coins first, then the largest.
      const outputCount = txRecipients.length + 1;
      const sorted = [...forcedUtxos, ...[...utxos].sort((a: any, b: any) => b.value - a.value)];
      let selected: any[] = [];
      let total = 0;
      let fee = 0;

      for (const u of sorted) {
        if (selected.length >= 30) break;
        selected.push(u);
        total += u.value;
        fee = Math.floor((selected.length * 180 + outputCount * 34 + 10) * 150);
        if (selected.length >= forcedUtxos.length && total >= totalLanoshis + fee) break;
      }

      if (total < totalLanoshis + fee) {
        // Try to send whole groups (batches) that we can afford — never split a group
        console.warn(`[lana-discount] Auto-send: insufficient balance for all ${pendingOrders.length} orders (need ${totalLanoshis + fee}, have ${total}). Trying whole groups...`);

        const affordableGroups: any[][] = [];
        let runningTotal = 0;

        for (const group of txGroups) {
          const groupTotal = group.reduce((s: number, o: any) => s + o.lana_amount, 0);
          const newTotal = runningTotal + groupTotal;
          const estInputs = Math.min(5, sorted.length);
          const estOutputs = affordableGroups.reduce((s, g) => s + g.length, 0) + group.length + 1;
          const estFee = Math.floor((estInputs * 180 + estOutputs * 34 + 10) * 150);
          if (newTotal + estFee <= total) {
            affordableGroups.push(group);
            runningTotal = newTotal;
          }
        }

        if (affordableGroups.length === 0) {
          const smallestGroup = txGroups[0];
          const smallestTotal = smallestGroup?.reduce((s: number, o: any) => s + o.lana_amount, 0) || 0;
          // Cooldown for 15 minutes — don't keep retrying when balance is too low
          autoSendSkipUntil = now() + 3 * 60 * 1000;
          console.warn(`[lana-discount] Auto-send: cannot afford even smallest group (${(smallestTotal / 100_000_000).toFixed(3)} LANA, ${smallestGroup?.length} orders, available: ${(total / 100_000_000).toFixed(3)} LANA) — cooldown 3min`);
          return;
        }

        const affordableOrders = affordableGroups.flat();
        console.log(`[lana-discount] Auto-send partial: sending ${affordableGroups.length}/${txGroups.length} groups (${affordableOrders.length} orders, ${(runningTotal / 100_000_000).toFixed(3)} LANA)`);

        // Re-select UTXOs for partial amount only
        selected = [];
        total = 0;
        const partialOutputCount = affordableOrders.length + 1;
        for (const u of sorted) {
          if (selected.length >= 30) break;
          selected.push(u);
          total += u.value;
          fee = Math.floor((selected.length * 180 + partialOutputCount * 34 + 10) * 150);
          if (selected.length >= forcedUtxos.length && total >= runningTotal + fee) break;
        }

        if (total < runningTotal + fee) {
          console.warn('[lana-discount] Auto-send partial: still insufficient after UTXO re-select — skipping');
          return;
        }

        // Replace with affordable subset
        pendingOrders = affordableOrders;
        totalLanoshis = runningTotal;

        // Rebuild recipients for partial set
        txRecipients.length = 0;
        txRecipients.push(...affordableOrders.map((o: any) => ({
          address: normalizeAddress(o.to_wallet),
          amount: o.lana_amount,
        })));
      }

      // Build and sign — then RECORD, and only then broadcast.
      const { txHex } = await buildSignedTx(selected, buybackWif, txRecipients, fee, useAddress, electrumServers, useCompressed);
      const recorded = await sends.recordTreasurySend({ rawTx: txHex, wallet: useAddress, orders: pendingOrders, feeLanoshis: fee });
      if (recorded.ok === false) {
        // Nothing was broadcast: a leg changed while the transaction was built
        // (a cancel, a redirect), or a coin is in a send on its way.
        console.warn(`[lana-discount] Auto-send: transaction not recorded (${recorded.code}: ${recorded.error}) — nothing broadcast`);
        return;
      }
      const txHash = recorded.txid;
      const outcome = await sends.broadcastRecorded(txHash);

      if (!outcome || (outcome.kind !== 'accepted' && outcome.kind !== 'known')) {
        console.error(`[lana-discount] Auto-send broadcast of ${txHash}: ${outcome ? `${outcome.kind}${'detail' in outcome ? ` — ${outcome.detail}` : ''}` : 'not sent'} (recorded: the send round sends the same bytes again, or releases its legs only on proof)`);
        // Blacklist the inputs we just tried — a -22 here almost always means one of
        // these UTXOs is already (mempool-)spent by a co-tenant of the shared buyback
        // wallet, but electrum1 still lists it as unspent. Excluding them lets the next
        // attempt pick different inputs instead of looping on the same doomed TX every
        // 5 min. Short cooldown so we don't immediately rebuild the identical failure.
        // (Its legs are no longer pending: they are 'sending' until the round finishes
        // or releases this transaction, so the next attempt never pays them again.)
        const exp = now() + FAILED_UTXO_TTL;
        for (const u of selected) failedUtxos.set(`${u.tx_hash}:${u.tx_pos}`, exp);
        autoSendSkipUntil = now() + 2 * 60 * 1000;
        console.warn(`[lana-discount] Blacklisted ${selected.length} UTXO(s) for ${FAILED_UTXO_TTL / 60000}min after -22; cooldown 2min`);
        return;
      }

      const sentLana = totalLanoshis / 100_000_000;
      // The legs stay 'sending': the send round marks them 'sent', and tells the
      // brain (lana-sent, through the outbox), once the chain proves this
      // transaction is in a block.
      console.log(`[lana-discount] Auto-send LANA TX: ${txHash} (${pendingOrders.length} recipients, ${sentLana.toFixed(3)} LANA) — broadcast; its legs are sent once it confirms`);

      // Close whatever this broadcast finished, from the evidence, plus the
      // orphan case. Both used to be written out here a second time, with their
      // own copy of the rules.
      deps.settleFinishedBatches();
      deps.settleOrphanBoughtBatches();
    } catch (err: any) {
      console.error('[lana-discount] Auto-send LANA error:', err.message);
    } finally {
      releaseSendLock('auto-send');
    }
  }

  return { run, lastKnownBalance: () => lastKnownBalance };
}
