/**
 * The copies of a key that reading it leaves in memory — for the tests that a
 * reading wipes them (wif.test.ts, keyStaysInBrowser.test.ts).
 *
 * Reading a WIF (src/lib/wif.ts) decodes its base58 into a fresh buffer —
 * tryBase58Decode fills it with `out.set(body, zeros)` — and decodeWif takes the
 * private key out of that buffer with `bytes.slice(1, 33)`. Both hold the
 * private bytes. A finding of 8. 10. 2026: since the sign-in fields read what is
 * typed on every change (src/lib/keyUsername.ts), a reading that is refused (a
 * typo, a key of another network) left that buffer unwiped. So, while `run`
 * runs, every Uint8Array of the given size that is filled with `set`, and every
 * slice taken out of one, is noted; the test then asks whether each is all
 * zeros. The prototype is restored before this returns, whatever happens.
 *
 * lana.discount (8. 10. 2026): Krog Menjave's server/tests/decodedCopies.ts
 * (origin/main a46f618), unchanged, for src/lib/financer/wif.test.ts and
 * keyStaysInBrowser.test.ts. A test helper: no page imports it.
 */

/** A WIF decodes to 37 bytes (uncompressed) or 38 (with the compression flag). */
const KEY_SIZED = (length: number) => length === 37 || length === 38;

/** What `run` answered, and the copies it made: every key-sized buffer filled, and every slice taken out of one. */
export function decodedCopies<T>(run: () => T, sized: (length: number) => boolean = KEY_SIZED): { result: T; copies: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  const proto = Uint8Array.prototype;
  const { set, slice } = proto;
  Object.defineProperty(proto, 'set', {
    configurable: true,
    writable: true,
    value: function (this: Uint8Array, ...args: Parameters<Uint8Array['set']>) {
      if (sized(this.length)) seen.push(this);
      return set.apply(this, args);
    },
  });
  Object.defineProperty(proto, 'slice', {
    configurable: true,
    writable: true,
    value: function (this: Uint8Array, ...args: Parameters<Uint8Array['slice']>) {
      const out = slice.apply(this, args);
      if (sized(this.length)) seen.push(out);
      return out;
    },
  });
  try {
    return { result: run(), copies: seen };
  } finally {
    Reflect.deleteProperty(proto, 'set');
    Reflect.deleteProperty(proto, 'slice');
  }
}

/** All zeros: nothing of the key is left in it. */
export const wiped = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);
