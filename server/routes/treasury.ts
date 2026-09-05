/**
 * /api/treasury — the financing-round mandates, from three sides.
 *
 *   public   GET /rounds?split=           dates, state, totals. NO discount,
 *                                          NO hexes, NO names: the public page
 *                                          says WHEN the treasury accepts
 *                                          proposals from a round, and never
 *                                          shows a figure that could read as a
 *                                          standing rate (BEF P08 §4).
 *   brain    GET /round-terms?split=      Bearer ldk_ — the terms to echo into
 *                                          KIND 30960 (informational there;
 *                                          authoritative here).
 *            POST /mandates/ingest        Bearer ldk_ — the push road.
 *   admin    GET/PUT /admin/rounds        one date + one discount per round
 *            GET /admin/mandates          the worklist that replaces
 *                                          the old expecting-cash-out report
 *            POST /admin/mandates/:d/release
 *            POST /admin/mandates/sync
 *
 * Nothing here moves money. The gate that does — evaluateRoundMandate inside
 * POST /api/acquisitions/offers — reads the same tables these routes write.
 */
import { Router, type Request, type Response } from 'express';
import {
  getDbHandle, getAppSetting, getSplitFromDb,
  getElectrumServersFromDb, getRelaysFromDb, getExchangeRatesFromDb,
} from '../db/index.js';
import { LAST_SYNC_SETTING_KEY } from '../db/roundMandateSchema.js';
import { requireAdmin } from '../lib/adminAuth.js';
import { requireApiKey } from '../lib/apiKeyAuth.js';
import { DIRECT_FUND_URL } from '../lib/directFund.js';
import { fetchBatchBalances as realFetchBatchBalances } from '../lib/electrum.js';
import {
  roundState, validateRoundTerms, remainingOf, type RoundTerms,
} from '../lib/roundMandate.js';
import { ingestMandateEvent, pullRoundMandates, listMandatesForSplit, loadRoundTerms, loadReleases } from '../lib/roundMandateSync.js';
import { consumedByMandate, offerRowsForFunding, offerTotalsByMandate } from '../lib/acquisitionOffer.js';
import { fundingByRound } from '../lib/roundFunding.js';
import { BUYBACK_SPLIT_OFFSET } from '../lib/buybackSplit.js';

const db = () => getDbHandle();
const LANA = 100_000_000;
const toLana = (lanoshis: number) => Math.round(lanoshis) / LANA;
/** After this long without a verified relay sync the worklist says so. */
const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

function parseSplitParam(raw: unknown, fallback: number | null): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function currentSplitNumber(): number | null {
  return parseInt(getSplitFromDb() || '') || null;
}

function termsRows(split: number) {
  return (db().prepare('SELECT round, opens_at, discount_percent, updated_by, updated_at FROM acquisition_rounds WHERE split = ? ORDER BY round').all(split) as any[]);
}

export interface TreasuryDeps {
  /** Injectable so the worklist test can stand in for electrum. */
  fetchBatchBalances?: typeof realFetchBatchBalances;
}

export function createTreasuryRouter(deps: TreasuryDeps = {}): Router {
  const router = Router();
  const fetchBatchBalances = deps.fetchBatchBalances || realFetchBatchBalances;

  // ── public ──────────────────────────────────────────────────────────

  router.get('/rounds', (req: Request, res: Response) => {
    const currentSplit = currentSplitNumber();
    // Default to the split whose mandates are (or will next be) in the window.
    const split = parseSplitParam(req.query.split, currentSplit === null ? null : currentSplit - BUYBACK_SPLIT_OFFSET);
    if (split === null) return res.status(400).json({ error: 'split must be a positive integer' });

    const terms = loadRoundTerms(db(), split);
    const mandates = listMandatesForSplit(db(), split).filter(m => m.status === 'announced');
    const dTags = mandates.map(m => m.dTag);
    const consumed = consumedByMandate(db(), dTags);
    const totals = offerTotalsByMandate(db(), dTags);
    const now = Math.floor(Date.now() / 1000);

    const rounds = [1, 2, 3].map(round => {
      const rows = mandates.filter(m => m.round === round);
      const t = terms.find(x => x.round === round);
      let expected = 0, remaining = 0, accepted = 0, settled = 0;
      for (const m of rows) {
        expected += m.lanaReceivedLanoshis;
        remaining += remainingOf(m, consumed);
        const tot = totals.get(m.dTag);
        accepted += tot?.accepted || 0;
        settled += tot?.settled || 0;
      }
      const state = roundState({
        split, round, status: 'announced', currentSplit,
        terms: t ? { round, opensAt: t.opensAt, discountPercent: t.discountPercent } : undefined,
        released: false, remainingLanoshis: remaining, now,
      });
      return {
        round,
        opensAt: t?.opensAt ? new Date(t.opensAt * 1000).toISOString() : null,
        // A round nobody was published into has no state worth reading; and
        // 'terms_missing' on a public page can only mean "no date" — the
        // discount is not shown here.
        state: rows.length === 0 ? 'no_mandates' : state.state,
        mandateCount: rows.length,
        expectedLana: toLana(expected),
        remainingLana: toLana(remaining),
        acceptedLana: toLana(accepted),
        settledLana: toLana(settled),
      };
    });

    return res.json({
      split,
      currentSplit,
      note: 'A round date opens a treasury mandate; it creates no right to sell (BEF P08 §8).',
      rounds,
    });
  });

  // ── brain (Bearer) ──────────────────────────────────────────────────

  router.get('/round-terms', (req: Request, res: Response) => {
    if (!requireApiKey(req, res)) return;
    const split = parseSplitParam(req.query.split, null);
    if (split === null) return res.status(400).json({ error: 'split must be a positive integer' });
    const terms = loadRoundTerms(db(), split);
    const released = (db().prepare(`
      SELECT r.d_tag FROM acquisition_mandate_releases r
      JOIN acquisition_mandates m ON m.d_tag = r.d_tag WHERE m.split = ?
    `).all(split) as any[]).map(r => r.d_tag);
    return res.json({
      split,
      rounds: [1, 2, 3].map(round => {
        const t = terms.find(x => x.round === round);
        return { round, opensAt: t?.opensAt ?? null, discountPercent: t?.discountPercent ?? null };
      }),
      released,
    });
  });

  router.post('/mandates/ingest', (req: Request, res: Response) => {
    const auth = requireApiKey(req, res);
    if (!auth) return;
    const event = req.body?.event;
    if (!event || typeof event !== 'object') return res.status(400).json({ error: 'event is required' });
    const r = ingestMandateEvent(db(), event);
    if (!r.stored && !r.dTag) {
      // Rejected outright — the brain should hear it, loudly.
      console.warn(`[lana-discount] Mandate ingest from ${auth.appName} rejected: ${r.reason}`);
      return res.status(400).json({ stored: false, error: r.reason });
    }
    return res.json({ stored: r.stored, dTag: r.dTag, reason: r.reason ?? null });
  });

  // ── admin: round terms ──────────────────────────────────────────────

  /**
   * Prefill from direct.lana.fund's public rounds (fee_percent) — a
   * suggestion into EMPTY fields only. A stored discount is the admin's
   * decision and is never overwritten by a fetch.
   */
  async function directFundFees(): Promise<{ fees: Map<number, number>; reachable: boolean }> {
    const fees = new Map<number, number>();
    try {
      const resp = await fetch(`${DIRECT_FUND_URL}/api/public/rounds`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return { fees, reachable: false };
      const data: any = await resp.json();
      const byCur: Record<string, any[]> = data?.by_currency || {};
      // One discount per round for all currencies (owner's decision 2); EUR
      // is the reference listing, any other currency only fills a gap.
      const order = ['EUR', ...Object.keys(byCur).filter(c => c !== 'EUR')];
      for (const cur of order) {
        for (const r of byCur[cur] || []) {
          const round = Number(r?.round);
          const fee = Number(r?.fee_percent);
          if (Number.isInteger(round) && round >= 1 && round <= 3 && Number.isFinite(fee) && fee > 0 && !fees.has(round)) {
            fees.set(round, fee);
          }
        }
      }
      return { fees, reachable: true };
    } catch {
      return { fees, reachable: false };
    }
  }

  router.get('/admin/rounds', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const currentSplit = currentSplitNumber();
    const split = parseSplitParam(req.query.split, currentSplit);
    if (split === null) return res.status(400).json({ error: 'split must be a positive integer' });

    const stored = termsRows(split);
    const df = await directFundFees();
    const rounds = [1, 2, 3].map(round => {
      const row = stored.find(r => Number(r.round) === round);
      const storedDiscount = row?.discount_percent ?? null;
      const suggested = df.fees.get(round) ?? null;
      return {
        round,
        opensAt: row?.opens_at ?? null,
        discountPercent: storedDiscount,
        // Filled ONLY where the stored field is empty.
        prefillDiscountPercent: storedDiscount === null ? suggested : null,
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    });
    return res.json({
      split,
      currentSplit,
      directFundReachable: df.reachable,
      rounds,
    });
  });

  router.put('/admin/rounds', (req: Request, res: Response) => {
    const adminHex = requireAdmin(req, res);
    if (!adminHex) return;
    const split = parseSplitParam(req.body?.split, null);
    if (split === null) return res.status(400).json({ error: 'split must be a positive integer' });

    const v = validateRoundTerms(req.body?.rounds);
    if (!v.ok) return res.status(400).json({ error: v.error, warnings: v.warnings });

    const upsert = db().prepare(`
      INSERT INTO acquisition_rounds (split, round, opens_at, discount_percent, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(split, round) DO UPDATE SET
        opens_at = excluded.opens_at, discount_percent = excluded.discount_percent,
        updated_by = excluded.updated_by, updated_at = datetime('now')
    `);
    db().transaction(() => {
      for (const r of v.rows) upsert.run(split, r.round, r.opensAt, r.discountPercent, adminHex);
    })();
    console.log(`[lana-discount] Round terms for Split ${split} set by ${adminHex.slice(0, 12)}… (${v.rows.map(r => `R${r.round}:${r.opensAt ?? '-'}/${r.discountPercent ?? '-'}%`).join(' ')})`);
    return res.json({ ok: true, split, rounds: termsRows(split), warnings: v.warnings });
  });

  // ── admin: worklist ─────────────────────────────────────────────────

  /**
   * The default split is the one whose mandates are in the window — but only if
   * it has terms. Split 7 was settled the old way and deliberately has none, so
   * opening on it showed an empty page and a zero cost for the whole treasury.
   * When the live-window split has no terms and the upcoming one does, the
   * upcoming one is the useful answer. An explicit ?split= always wins.
   */
  const defaultAdminSplit = (currentSplit: number | null): number | null => {
    if (currentSplit === null) return null;
    const liveWindow = currentSplit - BUYBACK_SPLIT_OFFSET;
    if (termsRows(liveWindow).length > 0) return liveWindow;
    if (termsRows(currentSplit).length > 0) return currentSplit;
    return liveWindow;
  };

  router.get('/admin/mandates', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const currentSplit = currentSplitNumber();
    const split = parseSplitParam(req.query.split, defaultAdminSplit(currentSplit));
    if (split === null) return res.status(400).json({ error: 'split must be a positive integer' });
    const currencyFilter = String(req.query.currency || '').toUpperCase() || null;
    const roundFilter = req.query.round ? Number(req.query.round) : null;

    const terms = loadRoundTerms(db(), split);
    const termsByRound = new Map<number, RoundTerms>(terms.map(t => [t.round, t]));
    const allForSplit = listMandatesForSplit(db(), split);
    let mandates = allForSplit;
    if (roundFilter) mandates = mandates.filter(m => m.round === roundFilter);
    if (currencyFilter) mandates = mandates.filter(m => m.wallets.some(w => w.currency === currencyFilter));
    const dTags = mandates.map(m => m.dTag);
    const consumed = consumedByMandate(db(), dTags);
    const totals = offerTotalsByMandate(db(), dTags);
    const releases = new Map<string, any>(
      (dTags.length
        ? db().prepare(`SELECT * FROM acquisition_mandate_releases WHERE d_tag IN (${dTags.map(() => '?').join(',')})`).all(...dTags)
        : []).map((r: any) => [r.d_tag, r]),
    );
    const offersByRef = new Map<string, any[]>();
    if (dTags.length) {
      const rows = db().prepare(`
        SELECT offer_ref, mandate_ref, status, lana_amount_lanoshis, proposed_lana_lanoshis, currency,
               purchase_price_fiat, created_at, accepted_at, settlement_due_at, decision_reason, mandate_code
          FROM acquisition_offers WHERE mandate_ref IN (${dTags.map(() => '?').join(',')}) ORDER BY created_at ASC
      `).all(...dTags) as any[];
      for (const o of rows) {
        if (!offersByRef.has(o.mandate_ref)) offersByRef.set(o.mandate_ref, []);
        offersByRef.get(o.mandate_ref)!.push({
          offerRef: o.offer_ref, status: o.status, lanaAmount: toLana(o.lana_amount_lanoshis),
          proposedLanaAmount: o.proposed_lana_lanoshis === null ? null : toLana(o.proposed_lana_lanoshis),
          currency: o.currency, purchasePrice: o.purchase_price_fiat, createdAt: o.created_at,
          acceptedAt: o.accepted_at, settlementDueAt: o.settlement_due_at,
          decisionReason: o.decision_reason, mandateCode: o.mandate_code,
        });
      }
    }

    // On-chain balances, chunked so one failed batch cannot sink the list
    // (same shape as the report this replaced).
    const allWallets = [...new Set(mandates.flatMap(m => m.wallets.map(w => w.address)))];
    const balByWallet = new Map<string, number>();
    const unavailable = new Set<string>();
    let balancesPartial = false;
    if (allWallets.length) {
      const electrumServers = getElectrumServersFromDb();
      const CHUNK = 40;
      for (let i = 0; i < allWallets.length; i += CHUNK) {
        const chunk = allWallets.slice(i, i + CHUNK);
        try {
          const balances = await fetchBatchBalances(electrumServers, chunk);
          for (const b of balances) balByWallet.set(b.wallet_id, b.balance || 0);
        } catch (err: any) {
          console.warn('[lana-discount] mandates balance chunk failed:', err.message);
          for (const w of chunk) unavailable.add(w);
          balancesPartial = true;
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const agg = { expected: 0, remaining: 0, proposed: 0, accepted: 0, settled: 0 };
    const rows = mandates.map(m => {
      const remaining = remainingOf(m, consumed);
      const tot = totals.get(m.dTag) || { proposed: 0, accepted: 0, settled: 0 };
      const release = releases.get(m.dTag) || null;
      const state = roundState({
        split: m.split, round: m.round, status: m.status, currentSplit,
        terms: termsByRound.get(m.round), released: !!release, remainingLanoshis: remaining, now,
      });
      const warnings: string[] = [];
      // A re-allocation after acceptance can shrink lana_received below what
      // we already agreed to buy; the cap then reads negative and someone
      // must look.
      if (tot.accepted + tot.settled > m.lanaReceivedLanoshis) warnings.push('ACCEPTED_EXCEEDS_RECEIVED');
      if (m.status === 'announced') {
        agg.expected += m.lanaReceivedLanoshis; agg.remaining += remaining;
        agg.proposed += tot.proposed; agg.accepted += tot.accepted; agg.settled += tot.settled;
      }
      return {
        mandateRef: m.dTag,
        eventId: m.eventId,
        status: m.status,
        split: m.split,
        round: m.round,
        financerHex: m.financerHex,
        wallets: m.wallets.map(w => ({
          address: w.address, currency: w.currency, fundSettingId: w.fundSettingId,
          lanaReceived: toLana(w.lanaLanoshis),
          onchainLana: balByWallet.has(w.address) ? balByWallet.get(w.address) : null,
          balanceUnavailable: unavailable.has(w.address),
        })),
        currencies: [...new Set(m.wallets.map(w => w.currency))],
        expectedLana: toLana(m.lanaReceivedLanoshis),
        expectedLanoshis: m.lanaReceivedLanoshis,
        proposedLana: toLana(tot.proposed), proposedLanoshis: tot.proposed,
        acceptedLana: toLana(tot.accepted), acceptedLanoshis: tot.accepted,
        settledLana: toLana(tot.settled), settledLanoshis: tot.settled,
        remainingLana: toLana(remaining), remainingLanoshis: remaining,
        state: state.state,
        opensAt: state.opensAt === null ? null : new Date(state.opensAt * 1000).toISOString(),
        discountPercent: state.discountPercent,
        released: release ? { by: release.released_by, reason: release.reason, at: release.released_at } : null,
        warnings,
        offers: offersByRef.get(m.dTag) || [],
      };
    });

    const fundingDTags = allForSplit.filter(m => m.status === 'announced').map(m => m.dTag);
    const funding = fundingByRound({
      split,
      currentSplit,
      mandates: allForSplit.map(m => ({
        dTag: m.dTag, round: m.round, split: m.split, status: m.status,
        wallets: m.wallets.map(w => ({ currency: w.currency, lanaLanoshis: w.lanaLanoshis })),
      })),
      offers: offerRowsForFunding(db(), fundingDTags),
      terms: terms.map(t => ({ round: t.round, discountPercent: t.discountPercent })),
      rates: getExchangeRatesFromDb(),
    });

    const lastSync = getAppSetting(LAST_SYNC_SETTING_KEY) || null;
    const lastSyncMs = lastSync ? Date.parse(lastSync) : NaN;
    return res.json({
      split,
      currentSplit,
      lastSyncAt: lastSync,
      degraded: {
        noEvents: mandates.length === 0,
        noTerms: terms.length === 0,
        splitUnknown: currentSplit === null,
        staleSync: !Number.isFinite(lastSyncMs) || Date.now() - lastSyncMs > STALE_SYNC_MS,
        balancesPartial,
      },
      totals: {
        expectedLana: toLana(agg.expected), remainingLana: toLana(agg.remaining),
        proposedLana: toLana(agg.proposed), acceptedLana: toLana(agg.accepted), settledLana: toLana(agg.settled),
      },
      rounds: [1, 2, 3].map(round => {
        const t = termsByRound.get(round);
        return { round, opensAt: t?.opensAt ? new Date(t.opensAt * 1000).toISOString() : null, discountPercent: t?.discountPercent ?? null };
      }),
      // What each round costs, per currency, over the whole Split — unaffected
      // by the round/currency filters above.
      funding,
      mandates: rows,
      updated_at: new Date().toISOString(),
    });
  });

  router.post('/admin/mandates/:dTag/release', (req: Request, res: Response) => {
    const adminHex = requireAdmin(req, res);
    if (!adminHex) return;
    const dTag = String(req.params.dTag || '');
    const released = req.body?.released;
    const reason = String(req.body?.reason || '').trim();
    if (typeof released !== 'boolean') return res.status(400).json({ error: 'released must be true or false' });
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });
    const mandate = db().prepare('SELECT d_tag, status FROM acquisition_mandates WHERE d_tag = ?').get(dTag) as any;
    if (!mandate) return res.status(404).json({ error: 'No such mandate.' });

    if (released) {
      db().prepare(`
        INSERT INTO acquisition_mandate_releases (d_tag, released_by, reason, released_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(d_tag) DO UPDATE SET released_by = excluded.released_by, reason = excluded.reason, released_at = datetime('now')
      `).run(dTag, adminHex, reason);
    } else {
      db().prepare('DELETE FROM acquisition_mandate_releases WHERE d_tag = ?').run(dTag);
    }
    console.log(`[lana-discount] Mandate ${dTag} ${released ? 'released' : 'release withdrawn'} by ${adminHex.slice(0, 12)}…: ${reason}`);
    const row = db().prepare('SELECT * FROM acquisition_mandate_releases WHERE d_tag = ?').get(dTag) as any;
    return res.json({ ok: true, dTag, released: !!row, release: row ? { by: row.released_by, reason: row.reason, at: row.released_at } : null });
  });

  router.post('/admin/mandates/sync', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await pullRoundMandates(db(), getRelaysFromDb());
      return res.json({ ok: true, ...r, lastSyncAt: getAppSetting(LAST_SYNC_SETTING_KEY) || null });
    } catch (err: any) {
      console.error('[lana-discount] Manual mandate sync failed:', err.message);
      return res.status(502).json({ error: 'Relay sync failed', detail: err.message });
    }
  });

  return router;
}
