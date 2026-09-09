/**
 * DISPLAY NAMES FOR A LIST OF COUNTERPARTIES.
 *
 * One request for the whole page, and one memory for the whole session. The
 * admin pages used to ask for each name separately on every load: 70 mandates
 * meant 70 requests, again on the next visit, and on 9 Sept 2026 that spent the
 * rate-limit budget of the operator's own browser — the site then answered
 * their next page load with a bare "Too many requests".
 *
 * A name that is not known comes back missing, never guessed; the caller shows
 * the hex, which is what it did before any of this existed.
 */
const memory = new Map<string, string>();
const STORE_KEY = 'lana_counterparty_names';

/** sessionStorage keeps the names across page loads, and only for this session. */
function loadStore(): void {
  if (memory.size > 0) return;
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    for (const [hex, name] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      if (typeof name === 'string') memory.set(hex, name);
    }
  } catch { /* private mode, or a shape we no longer understand */ }
}

function saveStore(): void {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(memory))); } catch { /* fine */ }
}

/** What is already known, without asking anyone. */
export function knownNames(): Record<string, string> {
  loadStore();
  return Object.fromEntries(memory);
}

/**
 * Resolve every hex not already known, in ONE request, and return the full map
 * (known + newly resolved). Failure is not fatal: the caller keeps the hexes.
 */
export async function resolveNames(hexes: string[]): Promise<Record<string, string>> {
  loadStore();
  const missing = [...new Set(hexes.map(h => String(h || '').toLowerCase()))]
    .filter(h => h && !memory.has(h));
  if (missing.length === 0) return Object.fromEntries(memory);

  try {
    const res = await fetch('/api/users/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hexes: missing }),
    });
    const data = await res.json();
    for (const [hex, name] of Object.entries((data?.names || {}) as Record<string, string>)) {
      if (typeof name === 'string' && name.trim()) memory.set(hex.toLowerCase(), name.trim());
    }
    saveStore();
  } catch {
    /* the hex is a perfectly good identifier on its own */
  }
  return Object.fromEntries(memory);
}
