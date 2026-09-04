// @vitest-environment node
/**
 * NOTHING GETS INTO acquisition_mandates WITHOUT PROVING ITSELF.
 *
 * A row here opens a treasury cap, so the door checks the author (pinned),
 * the id (recomputed), the signature (Schnorr) and the contract (rules 2–4),
 * and lets the newest event per d win. Events are really signed with keys
 * the test holds; the pin is injected so a held key can play LanaPays.us.
 * Removing the pin check must make the "wrong author" test fail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  parseMandate30960, ingestMandateEvent, pullRoundMandates, listMandatesForHex,
  LANAPAYS_PROCESSOR_PUBKEY, CLOSED_REASONS,
} from './roundMandateSync';
import { verifyEventSignature } from './nostr';
import { LAST_SYNC_SETTING_KEY } from '../db/roundMandateSchema';
import { createMandateTestDb, makeKey, mandateEvent, mandateTags, signEvent, MANDATE_NOTE, type TestKey } from './roundMandateTestKit';

const HEX = 'f'.repeat(64);
const W1 = 'LKs7QqC2TVJ4y92waNrBjVZQB2oFhcmZqB';
const W2 = 'LdY5W1Qm6xXoTmr3hjCkGyeJ7YqTx6Zv4t';
const spec = (over: Partial<Parameters<typeof mandateEvent>[1]> = {}): Parameters<typeof mandateEvent>[1] => ({
  split: 8, round: 1, hex: HEX,
  wallets: [{ address: W1, currency: 'EUR', lana: '32527.97', fundSettingId: '52' }],
  ...over,
});

let db: Database.Database;
let lanapays: TestKey;
let stranger: TestKey;
const ingest = (e: any) => ingestMandateEvent(db, e, { authorizedPubkey: lanapays.pub });
const stored = (d: string) => db.prepare('SELECT * FROM acquisition_mandates WHERE d_tag = ?').get(d) as any;

beforeEach(() => {
  db = createMandateTestDb();
  lanapays = makeKey();
  stranger = makeKey();
});

describe('verifyEventSignature', () => {
  it('accepts a genuinely signed event', () => {
    expect(verifyEventSignature(mandateEvent(lanapays, spec()))).toBe(true);
  });
  it('a tampered tag changes the id → rejected', () => {
    const e = mandateEvent(lanapays, spec());
    e.tags = e.tags.map(t => (t[0] === 'lana_received' ? ['lana_received', '99999999.00000000'] : t));
    expect(verifyEventSignature(e)).toBe(false);
  });
  it('a signature from another key over the same id → rejected', () => {
    const e = mandateEvent(lanapays, spec());
    const forged = signEvent(stranger, { kind: e.kind, tags: e.tags, content: e.content, created_at: e.created_at });
    expect(verifyEventSignature({ ...e, sig: forged.sig })).toBe(false);
  });
  it('malformed input is false, never a throw', () => {
    expect(verifyEventSignature(null as any)).toBe(false);
    expect(verifyEventSignature({ ...mandateEvent(lanapays, spec()), sig: 'nope' })).toBe(false);
    expect(verifyEventSignature({ ...mandateEvent(lanapays, spec()), tags: [['d', 1 as any]] })).toBe(false);
  });
});

describe('parseMandate30960 — the contract, rules 2–4', () => {
  it('reads an announced event into a row, shares in lanoshis', () => {
    const r = parseMandate30960(mandateEvent(lanapays, spec({
      wallets: [
        { address: W1, currency: 'EUR', lana: '32527.97', fundSettingId: '52' },
        { address: W2, currency: 'gbp', lana: '100', fundSettingId: '61' },
      ],
    })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.dTag).toBe(`8:1:${HEX}`);
    expect(r.row.lanaReceivedLanoshis).toBe(3262797000000);
    expect(r.row.wallets).toEqual([
      { address: W1, currency: 'EUR', lanaLanoshis: 3252797000000, fundSettingId: '52' },
      { address: W2, currency: 'GBP', lanaLanoshis: 10000000000, fundSettingId: '61' },
    ]);
    expect(r.row.status).toBe('announced');
  });

  it('rule 2: d must be split:round:p', () => {
    const tags = mandateTags(spec()).map(t => (t[0] === 'd' ? ['d', `8:2:${HEX}`] : t));
    const e = signEvent(lanapays, { kind: 30960, tags, content: '{}', created_at: 1 });
    expect(parseMandate30960(e)).toEqual({ ok: false, reason: 'd does not equal split:round:p' });
  });

  it('rule 3: the totals must agree with the wallet shares to the lanoshi', () => {
    const swap = (name: string, value: string) =>
      signEvent(lanapays, { kind: 30960, content: '{}', created_at: 1, tags: mandateTags(spec()).map(t => (t[0] === name ? [name, value] : t)) });
    expect(parseMandate30960(swap('lana_received', '32527.98000000')).ok).toBe(false);
    expect(parseMandate30960(swap('lana_received_lanoshis', '3252797000001')).ok).toBe(false);
    expect(parseMandate30960(swap('lana_received', '32527.97')).ok).toBe(false); // not 8dp
  });

  it('rule 4: a closed event must carry no cap-like tags', () => {
    expect(parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed' }))).ok).toBe(true);
    const r = parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed', extra: [['lana_received', '1.00000000']] })));
    expect(r).toEqual({ ok: false, reason: 'closed event carries lana_received' });
  });

  /**
   * An announced event OPENS a cap, so each required tag is required: an
   * event missing one is not read, whoever signed it. Removing any single
   * check from the parser fails exactly one case here.
   */
  describe('required tags on an announced event', () => {
    const cases: Array<[string, Partial<Parameters<typeof mandateEvent>[1]>, RegExp]> = [
      ['e (the Split event)', { omit: ['e'] }, /needs e/],
      ['snapshot_at', { omit: ['snapshot_at'] }, /snapshot_at/],
      ['lanapays_pubkey', { omit: ['lanapays_pubkey'] }, /needs lanapays_pubkey/],
      ['bef_version', { omit: ['bef_version'] }, /bef_version/],
    ];
    for (const [name, over, reason] of cases) {
      it(`missing ${name} → rejected`, () => {
        const r = parseMandate30960(mandateEvent(lanapays, spec(over)));
        expect(r.ok).toBe(false);
        if (r.ok === false) expect(r.reason).toMatch(reason);
      });
    }

    it('lanapays_pubkey that is not the pin → rejected (another publisher\'s idea of a mandate)', () => {
      const r = parseMandate30960(mandateEvent(lanapays, spec({ omit: ['lanapays_pubkey'], extra: [['lanapays_pubkey', stranger.pub]] })));
      expect(r).toEqual({ ok: false, reason: 'lanapays_pubkey is not the LanaPays.us processor key' });
    });

    it('e that is not a 64-hex id, snapshot_at that is not a number → rejected', () => {
      expect(parseMandate30960(mandateEvent(lanapays, spec({ omit: ['e'], extra: [['e', 'split-8']] }))).ok).toBe(false);
      expect(parseMandate30960(mandateEvent(lanapays, spec({ omit: ['snapshot_at'], extra: [['snapshot_at', 'yesterday']] }))).ok).toBe(false);
    });

    it('with every required tag present, the same event is read', () => {
      expect(parseMandate30960(mandateEvent(lanapays, spec())).ok).toBe(true);
    });
  });

  describe('closed_reason on a tombstone', () => {
    it('must be present', () => {
      const r = parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed', omit: ['closed_reason'] })));
      expect(r).toEqual({ ok: false, reason: 'closed event has no closed_reason' });
    });
    it('must be one of the contract\'s three', () => {
      expect(CLOSED_REASONS).toEqual(['window_ended', 'financer_request', 'superseded']);
      for (const reason of CLOSED_REASONS) {
        expect(parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed', closedReason: reason }))).ok).toBe(true);
      }
      const r = parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed', closedReason: 'because' })));
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.reason).toMatch(/closed_reason must be one of/);
    });
    it('a tombstone missing an informational tag is still read — rejecting it would keep a cap OPEN', () => {
      expect(parseMandate30960(mandateEvent(lanapays, spec({ status: 'closed', omit: ['bef_version', 'snapshot_at'] }))).ok).toBe(true);
    });
  });

  /**
   * TAGS ARE AUTHORITATIVE. The brain mirrors the tags into `content` for
   * human readers — the repeatable `a` as an array of strings, `wallet` and
   * `indicative` as arrays of value-arrays. The parser must read none of it:
   * the exact brain shape parses, and so does content that contradicts the
   * tags or is not JSON at all.
   */
  describe('content is a mirror, never a source', () => {
    const brainContent = (hex: string) => JSON.stringify({
      d: `8:1:${hex}`, p: hex, split: '8', round: '1', status: 'announced',
      lana_received: '32527.97000000', lana_received_lanoshis: '3252797000000',
      wallet: [[W1, 'EUR', '32527.97000000', '52']],
      a: [`30938:${'d'.repeat(64)}:52`],
      e: 'e'.repeat(64), snapshot_at: '1757000000',
      lanapays_pubkey: LANAPAYS_PROCESSOR_PUBKEY, bef_version: 'P08-1.0',
      acquisition_discount_percent: '22',
      indicative: [['EUR', '0.256', 'projected_next_split', '6495.19', '22']],
      projected_return_percent: '30.00',
      projection_basis: '(2/1.2)*(1-d/100)-1; assumes the Split lands at x2; a projection, not a promise',
      purchases: '7',
      non_binding: true, note: MANDATE_NOTE,
    });

    it('the brain\'s exact content shape parses and ingests', () => {
      const e = mandateEvent(lanapays, spec({ content: brainContent(HEX) }));
      const r = parseMandate30960(e);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.row.lanaReceivedLanoshis).toBe(3252797000000);
      expect(ingest(e)).toEqual({ stored: true, dTag: `8:1:${HEX}` });
    });

    it('content that contradicts the tags changes nothing; the tags are what was read', () => {
      const lying = JSON.stringify({ lana_received: '99999999.00000000', wallet: [[W2, 'EUR', '99999999.00000000', '1']], status: 'closed' });
      const r = parseMandate30960(mandateEvent(lanapays, spec({ content: lying })));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.row.status).toBe('announced');
      expect(r.row.lanaReceivedLanoshis).toBe(3252797000000);
      expect(r.row.wallets[0].address).toBe(W1);
    });

    it('content that is not JSON at all is no obstacle', () => {
      expect(parseMandate30960(mandateEvent(lanapays, spec({ content: 'not json {' }))).ok).toBe(true);
      expect(parseMandate30960(mandateEvent(lanapays, spec({ content: '' }))).ok).toBe(true);
    });
  });

  it('refuses the obvious: wrong kind, bad round, bad status, uppercase hex', () => {
    expect(parseMandate30960({ ...mandateEvent(lanapays, spec()), kind: 30961 }).ok).toBe(false);
    expect(parseMandate30960(mandateEvent(lanapays, spec({ round: 4 as any }))).ok).toBe(false);
    const badStatus = signEvent(lanapays, { kind: 30960, content: '{}', created_at: 1, tags: mandateTags(spec()).map(t => (t[0] === 'status' ? ['status', 'open'] : t)) });
    expect(parseMandate30960(badStatus).ok).toBe(false);
    expect(parseMandate30960(mandateEvent(lanapays, spec({ hex: HEX.toUpperCase() }))).ok).toBe(false);
  });
});

describe('ingestMandateEvent — the one door', () => {
  it('stores a verified event from the pinned author', () => {
    const r = ingest(mandateEvent(lanapays, spec()));
    expect(r).toEqual({ stored: true, dTag: `8:1:${HEX}` });
    const row = stored(`8:1:${HEX}`);
    expect(row.lana_received_lanoshis).toBe(3252797000000);
    expect(row.status).toBe('announced');
    expect(JSON.parse(row.wallets_json)).toHaveLength(1);
  });

  it('REJECTS a perfectly valid event from anyone but the pinned author', () => {
    const r = ingest(mandateEvent(stranger, spec()));
    expect(r.stored).toBe(false);
    expect(r.reason).toMatch(/author/);
    expect(stored(`8:1:${HEX}`)).toBeUndefined();
  });

  it('without an injected pin, only the real LanaPays.us key is accepted', () => {
    const r = ingestMandateEvent(db, mandateEvent(lanapays, spec()));
    expect(r.stored).toBe(false);
    expect(LANAPAYS_PROCESSOR_PUBKEY).toBe('79730aba75d71584e8a4f9d0cc1173085e75590ce489760078d2bf6f5210d692');
  });

  it('rejects a tampered tag (id no longer matches)', () => {
    const e = mandateEvent(lanapays, spec());
    e.tags = e.tags.map(t => (t[0] === 'wallet' ? ['wallet', W2, 'EUR', '32527.97000000', '52'] : t));
    expect(ingest(e).reason).toMatch(/signature/);
    expect(stored(`8:1:${HEX}`)).toBeUndefined();
  });

  it('rejects a bad signature', () => {
    const e = mandateEvent(lanapays, spec());
    e.sig = e.sig.replace(/^../, e.sig.startsWith('00') ? 'ff' : '00');
    expect(ingest(e).reason).toMatch(/signature/);
  });

  it('rejects a contract violation even when properly signed', () => {
    const e = mandateEvent(lanapays, spec({ status: 'closed', extra: [['wallet', W1, 'EUR', '1.00000000', '1']] }));
    expect(ingest(e)).toEqual({ stored: false, reason: 'closed event carries wallet' });
  });

  it('newest created_at wins; an older one arriving later is ignored', () => {
    const d = `8:1:${HEX}`;
    ingest(mandateEvent(lanapays, spec({ createdAt: 100 })));
    const newer = ingest(mandateEvent(lanapays, spec({ createdAt: 200, wallets: [{ address: W1, currency: 'EUR', lana: '40000', fundSettingId: '52' }] })));
    expect(newer.stored).toBe(true);
    expect(stored(d).lana_received_lanoshis).toBe(4000000000000);
    const older = ingest(mandateEvent(lanapays, spec({ createdAt: 150 })));
    expect(older.stored).toBe(false);
    expect(older.dTag).toBe(d);
    expect(stored(d).lana_received_lanoshis).toBe(4000000000000);
    expect(stored(d).event_created_at).toBe(200);
  });

  it('a closed tombstone overwrites and removes the wallets', () => {
    const d = `8:1:${HEX}`;
    ingest(mandateEvent(lanapays, spec({ createdAt: 100 })));
    expect(ingest(mandateEvent(lanapays, spec({ createdAt: 300, status: 'closed' }))).stored).toBe(true);
    const row = stored(d);
    expect(row.status).toBe('closed');
    expect(row.wallets_json).toBe('[]');
    expect(row.lana_received_lanoshis).toBe(0);
    expect(listMandatesForHex(db, HEX)[0].wallets).toEqual([]);
  });

  it('the same event twice is a no-op, not an error', () => {
    const e = mandateEvent(lanapays, spec());
    expect(ingest(e).stored).toBe(true);
    expect(ingest(e)).toMatchObject({ stored: false, dTag: `8:1:${HEX}` });
  });
});

describe('pullRoundMandates', () => {
  it('asks for kind 30960 by the pinned author only, ingests each, and stamps the sync time only when something verified', async () => {
    let filter: any = null;
    const events = [mandateEvent(lanapays, spec()), mandateEvent(stranger, spec({ hex: 'e'.repeat(64) }))];
    // The production pin is not a key we hold, so the relay answer is routed
    // through the injectable ingest pin by pointing the query stub at ours.
    const query = async (_relays: string[], f: any) => { filter = f; return events; };
    const r = await pullRoundMandates(db, ['wss://relay.test'], { query, setSetting: (k, v) => db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(k, v) });
    expect(filter).toEqual({ kinds: [30960], authors: [LANAPAYS_PROCESSOR_PUBKEY], limit: 1000 });
    // Neither of our keys is the production pin, so nothing is stored, and
    // nothing verified → no sync stamp: silence is not "in sync".
    expect(r).toEqual({ seen: 2, stored: 0, rejected: 2 });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LAST_SYNC_SETTING_KEY)).toBeUndefined();
  });

  it('no relays → nothing asked, nothing stamped', async () => {
    expect(await pullRoundMandates(db, [])).toEqual({ seen: 0, stored: 0, rejected: 0 });
  });
});
