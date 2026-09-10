/**
 * How this server identifies itself to direct.lana.fund.
 *
 * With a key of its own, never a person's Nostr hex. The fund's order ledger
 * answered anyone on the open internet until 10.9.2026, which is why nothing
 * here carried a credential; it is guarded now, and the guard admits a keyed
 * machine as well as a human administrator.
 *
 * Unset means the call goes out bare and is refused — and that is safe here.
 * The only caller is an admin page that already falls back to its cached copy
 * on any failure. NOTHING on the selling path touches Direct.Fund, so a missing
 * key cannot narrow the one door that has to stay open.
 */
export const fundPeerKey = (): string => String(process.env.FUND_PEER_KEY || '').trim();

export function fundPeerHeaders(): Record<string, string> {
  const key = fundPeerKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}
