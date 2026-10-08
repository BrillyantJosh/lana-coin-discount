// @vitest-environment node
/**
 * A FINANCER PAYS ONLY FROM A WALLET THE REGISTRAR VOUCHES FOR.
 *
 * LANA sent from a wallet the registrar does not know freezes its RECIPIENTS
 * (frozen_unreg_Lanas) — every merchant, caretaker and customer of the
 * purchase. So the check is fail-closed: registered, type exactly Lana.Discount,
 * registered to this financer, not frozen — every one said explicitly, in
 * either of the two answer shapes — or no.
 */
import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { checkFinancerWallet, judgeRegistrarAnswer } from './registrarWallet';

const OWNER = 'a'.repeat(64);
const WALLET = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const flat = (o: Record<string, unknown> = {}) => ({
  registered: true, frozen: false, freeze_reason: null, wallet_type: 'Lana.Discount', nostr_hex_id: OWNER, split_created: 9, ...o,
});
const nested = (o: Record<string, unknown> = {}) => ({
  success: true, registered: true,
  wallet: { frozen: false, freeze_reason: null, wallet_type: 'Lana.Discount', nostr_hex_id: OWNER, split_created: 9, ...o },
});

describe('judgeRegistrarAnswer', () => {
  it('yes, in both shapes, when all four hold', () => {
    expect(judgeRegistrarAnswer(flat(), OWNER)).toEqual({ ok: true, walletType: 'Lana.Discount', frozen: false });
    expect(judgeRegistrarAnswer(nested(), OWNER)).toEqual({ ok: true, walletType: 'Lana.Discount', frozen: false });
    // The owner hex is compared case-blind.
    expect(judgeRegistrarAnswer(flat({ nostr_hex_id: OWNER.toUpperCase() }), OWNER).ok).toBe(true);
  });

  it('frozen, for any reason, in either shape', () => {
    for (const reason of ['frozen_max_cap', 'frozen_own_person', 'frozen_unreg_Lanas', null]) {
      expect(judgeRegistrarAnswer(flat({ frozen: true, freeze_reason: reason }), OWNER)).toMatchObject({ ok: false, reason: 'WALLET_FROZEN', frozen: true });
      expect(judgeRegistrarAnswer(nested({ frozen: true, freeze_reason: reason }), OWNER)).toMatchObject({ ok: false, reason: 'WALLET_FROZEN' });
    }
  });

  it('not registered — which is also what the proxy says in an outage — is a no, never a clearance', () => {
    expect(judgeRegistrarAnswer({ registered: false }, OWNER)).toMatchObject({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    expect(judgeRegistrarAnswer(flat({ registered: false }), OWNER)).toMatchObject({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    expect(judgeRegistrarAnswer(flat({ registered: 'true' }), OWNER)).toMatchObject({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    for (const junk of [null, undefined, 'ok', 42, [], {}]) {
      expect(judgeRegistrarAnswer(junk, OWNER)).toMatchObject({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    }
  });

  it('a wallet of any other type cannot pay, the near misses included', () => {
    for (const t of ['LanaPays.Us', 'Main Wallet', 'lana.discount', 'Lana.Discount2', '', undefined]) {
      expect(judgeRegistrarAnswer(flat({ wallet_type: t }), OWNER)).toMatchObject({ ok: false, reason: 'WRONG_WALLET_TYPE' });
    }
  });

  it("another person's wallet cannot pay, nor one the registrar names no owner for", () => {
    expect(judgeRegistrarAnswer(flat({ nostr_hex_id: 'b'.repeat(64) }), OWNER)).toMatchObject({ ok: false, reason: 'WRONG_OWNER' });
    expect(judgeRegistrarAnswer(flat({ nostr_hex_id: undefined }), OWNER)).toMatchObject({ ok: false, reason: 'WRONG_OWNER' });
    expect(judgeRegistrarAnswer(flat(), '')).toMatchObject({ ok: false, reason: 'WRONG_OWNER' });
  });
});

describe('checkFinancerWallet', () => {
  const serve = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => server.close(() => r())) };
  };

  it('asks check.lanapays.us for exactly this wallet, and judges the answer', async () => {
    const seen: string[] = [];
    const s = await serve((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(flat())); });
    });
    try {
      expect(await checkFinancerWallet(WALLET, OWNER, { checkBaseUrl: s.base + '/' })).toMatchObject({ ok: true });
      expect(seen).toEqual([`POST /api/check-wallet {"wallet_id":"${WALLET}"}`]);
    } finally { await s.close(); }
  });

  it('an error status, a body that is not JSON, a dead host and a timeout are all REGISTRAR_UNKNOWN', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/slow/api/check-wallet') return; // never answers
      if (req.url === '/bad/api/check-wallet') { res.end('<html>'); return; }
      res.statusCode = 500; res.end('{}');
    });
    try {
      expect(await checkFinancerWallet(WALLET, OWNER, { checkBaseUrl: s.base })).toEqual({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
      expect(await checkFinancerWallet(WALLET, OWNER, { checkBaseUrl: s.base + '/bad' })).toEqual({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
      expect(await checkFinancerWallet(WALLET, OWNER, { checkBaseUrl: s.base + '/slow', timeoutMs: 150 })).toEqual({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
    } finally { await s.close(); }
    expect(await checkFinancerWallet(WALLET, OWNER, { checkBaseUrl: 'http://127.0.0.1:1' })).toEqual({ ok: false, reason: 'REGISTRAR_UNKNOWN' });
  });

  it('no wallet chosen: no question asked', async () => {
    let asked = 0;
    const f = (async () => { asked++; return new Response('{}'); }) as typeof fetch;
    expect(await checkFinancerWallet(null, OWNER, { fetch: f })).toEqual({ ok: false, reason: 'NO_WALLET' });
    expect(await checkFinancerWallet('  ', OWNER, { fetch: f })).toEqual({ ok: false, reason: 'NO_WALLET' });
    expect(asked).toBe(0);
  });
});
