/**
 * Test-only: throwaway keys, signed KIND 30972 profiles built the way a
 * dealer's own /admin writes them, and relays and dealer sites that live in
 * memory. Nothing here reaches a relay or a website.
 *
 * Ported from bef-explorer/server/tests/dealerHelpers.ts (a7d3702):
 * dealerContent, dealerTags, fakeRelays and fakeSites are theirs verbatim;
 * keys and signatures come from ../roundMandateTestKit (the same Schnorr), and
 * `directory()` stands in for BEF's mirror table — it holds what the last good
 * read listed and hands it back as `held`, as ../buyingDealers.ts does.
 */
import { makeKey, signEvent, type TestKey } from '../roundMandateTestKit.js';
import { ALT_PREFIX, DEALER_KIND, ROLE_T_TAGS, type DealerRole } from './dealerShape.ts';
import { lanaAddressOf } from './lanaAddress.ts';
import { parseWellKnown, type WellKnownAnswer } from './wellKnown.ts';
import { readDealers, type DealerEventsAnswer, type DealerFilter, type DealerRead, type ListedDealer } from './dealers.ts';
import type { Verified38888 } from './systemParams.ts';
import type { NostrEvent } from './relayRead.ts';

export const NOW_MS = Date.UTC(2026, 9, 5, 12, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

/** A valid IBAN (MOD-97) of each kind used below — test values, nobody's account. */
export const TEST_IBAN = { EUR: 'SI56191000000123438', GBP: 'GB29NWBK60161331926819', USD: 'DE89370400440532013000' } as const;

/** A well-formed LANA address (Base58Check 0x30) of a made-up public key — a test value, nobody's wallet. */
export const TEST_PAYOUT_WALLET = lanaAddressOf(Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? 0x02 : i)));
/** Another one, for the receive wallet (spec 1.5.0) — a test value, nobody's wallet. */
export const TEST_RECEIVE_WALLET = lanaAddressOf(Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? 0x03 : 100 + i)));

export type Identity = TestKey & { hex: string };
export const newIdentity = (): Identity => {
  const key = makeKey();
  return { ...key, hex: key.pub };
};

export interface ContentInput {
  version?: string;
  status?: 'active' | 'retired';
  name?: string;
  host?: string;
  website?: string | null;
  logo?: string | null;
  roles?: DealerRole[] | null;
  currencies?: ('EUR' | 'GBP' | 'USD')[];
  ownerHex?: string;
  directorHex?: string;
  payoutWallet?: string;
  receiveWallet?: string;
  extra?: Record<string, unknown>;
}

/** The content a dealer's /admin writes (bef-explorer dealerHelpers.ts, verbatim). */
export function dealerContent(input: ContentInput = {}): Record<string, unknown> {
  const host = input.host ?? 'krogmenjave.test';
  const version = input.version ?? (input.receiveWallet !== undefined ? '1.3.0' : input.payoutWallet !== undefined ? '1.2.0' : '1.1.0');
  const content: Record<string, unknown> = {
    version,
    status: input.status ?? 'active',
    name: input.name ?? 'Krog menjave d.o.o.',
    address: { street: 'Dunajska cesta 1', postal_code: '1000', city: 'Ljubljana', country: 'SI' },
    phone: '+386 1 234 5678',
    registration_number: '1234567000',
    tax_number: 'SI12345678',
    founded: '2020-01-15',
    director: { name: 'Ana Novak', hex: input.directorHex ?? 'd'.repeat(64) },
    owners: [{ name: 'Ana Novak', hex: input.ownerHex ?? 'e'.repeat(64), share_percent: '100' }],
    payment_methods: (input.currencies ?? ['EUR', 'GBP']).map((currency, i) => ({
      id: `acct-${i + 1}`,
      scope: 'both',
      country: currency === 'GBP' ? 'GB' : currency === 'USD' ? 'DE' : 'SI',
      scheme: 'EU.IBAN',
      currency,
      label: `${currency} account`,
      fields: { iban: TEST_IBAN[currency], account_holder: 'Krog menjave d.o.o.' },
      primary: true,
    })),
  };
  if (input.website !== null) content.website = input.website ?? `https://${host}/`;
  if (input.logo !== null) content.logo = input.logo ?? `https://${host}/uploads/logo.png`;
  const roles = input.roles === undefined ? (['sells', 'buys'] as DealerRole[]) : input.roles;
  if ((version === '1.1.0' || version === '1.2.0' || version === '1.3.0') && roles !== null) content.roles = roles;
  if (input.payoutWallet !== undefined) content.payout_wallet = input.payoutWallet;
  if (input.receiveWallet !== undefined) content.receive_wallet = input.receiveWallet;
  return { ...content, ...(input.extra ?? {}) };
}

/** The canonical tags for a content, as the writer emits them (verbatim). */
export function dealerTags(slug: string, content: Record<string, any>): string[][] {
  const tags: string[][] = [['d', slug], ['name', content.name], ['country', content.address?.country]];
  if (content.director?.hex) tags.push(['p', content.director.hex, '', 'director']);
  for (const o of content.owners ?? []) if (o.hex) tags.push(['p', o.hex, '', 'owner']);
  tags.push(['t', 'bef-dealer']);
  for (const role of (content.roles ?? []) as DealerRole[]) tags.push(['t', ROLE_T_TAGS[role]]);
  tags.push(['alt', `${ALT_PREFIX}${content.name}`]);
  return tags;
}

/** A signed KIND 30972. */
export function dealerEvent(
  key: TestKey,
  slug: string,
  content: Record<string, unknown>,
  options: { at?: number; tags?: string[][] } = {},
): NostrEvent {
  return signEvent(key, {
    kind: DEALER_KIND,
    created_at: options.at ?? NOW_S - 3600,
    tags: options.tags ?? dealerTags(slug, content),
    content: JSON.stringify(content),
  });
}

/**
 * Relays in memory: `answered` of `asked` finished their answer. They answer
 * the filter as a relay does — by author and slug — unless `liar`, which sends
 * everything it holds whatever was asked. (Verbatim.)
 */
export function fakeRelays(events: NostrEvent[], answered = 2, asked = 2, liar = false) {
  const calls: DealerFilter[] = [];
  const source = async (_relays: string[], filter: DealerFilter): Promise<DealerEventsAnswer> => {
    calls.push(filter);
    const matching = liar
      ? events
      : events.filter((e) => filter.authors.includes(e.pubkey) && (!filter.d || e.tags.some((t) => t[0] === 'd' && filter.d!.includes(t[1]))));
    return { events: answered > 0 ? matching.map((e) => ({ ...e, tags: e.tags.map((t) => [...t]) })) : [], relaysAsked: asked, relaysAnswered: answered };
  };
  return { source, calls };
}

export type SiteReply = { dealers: Record<string, { admins: string[]; name?: string }> } | { down: string };

/** Dealer sites in memory: a host answers its dealer file, or is down with a reason, or is unknown (down). (Verbatim.) */
export function fakeSites(sites: Record<string, SiteReply>) {
  const asked: string[] = [];
  const lookup = async (host: string): Promise<WellKnownAnswer> => {
    asked.push(host);
    const site = sites[host];
    if (!site) return { answered: false, reason: 'unreachable (ENOTFOUND)' };
    if ('down' in site) return { answered: false, reason: site.down };
    return { answered: true, read: parseWellKnown(site) };
  };
  return { lookup, asked, sites };
}

/** A verified KIND 38888 whose reliable people are `reliable` (the relay list is irrelevant: relays are faked). */
export function systemParams(reliable: string[]): Verified38888 {
  return { eventId: '0'.repeat(64), createdAt: NOW_S - 86_400, relays: ['wss://one.test', 'wss://two.test'], reliable: new Set(reliable) };
}

export interface ReadOptions {
  relaysAnswered?: number;
  nowMs?: number;
  liar?: boolean;
  /** Collects the hosts whose dealer file was asked for. */
  asked?: string[];
  /** Collects what the relays were asked. */
  filters?: DealerFilter[];
}

/**
 * What BEF's mirror table was, in memory: the dealers the last good read
 * listed, handed back to the next read as `held`; a read that decided nothing
 * keeps them (marked stale), minus the ones it removed.
 */
export function directory(reliable: string[]) {
  const state = { params: systemParams(reliable) as Verified38888 | null, listed: [] as ListedDealer[], stale: false };
  return {
    setReliable(hexes: string[]) { state.params = systemParams(hexes); },
    forgetParams() { state.params = null; },
    listed: () => state.listed,
    listedKeys: () => state.listed.map((d) => `${d.host}/${d.slug}`),
    isStale: () => state.stale,
    async read(events: NostrEvent[], sites: Record<string, SiteReply>, options: ReadOptions = {}): Promise<DealerRead> {
      const relays = fakeRelays(events, options.relaysAnswered ?? 2, 2, options.liar ?? false);
      const files = fakeSites(sites);
      const result = await readDealers(
        state.params,
        state.listed.map((d) => ({ host: d.host, slug: d.slug, pubkey: d.pubkey, admins: d.admins })),
        {
          fetchEvents: async (r, f) => {
            options.filters?.push(f);
            return relays.source(r, f);
          },
          fetchWellKnown: async (host) => {
            options.asked?.push(host);
            return files.lookup(host);
          },
          now: () => options.nowMs ?? NOW_MS,
        },
      );
      if (result.read === true) {
        state.listed = result.listed;
        state.stale = false;
      } else {
        const gone = new Set(result.removed.map((r) => r.dealer));
        state.listed = state.listed.filter((d) => !gone.has(`${d.host}/${d.slug}`));
        state.stale = true;
      }
      return result;
    },
  };
}
