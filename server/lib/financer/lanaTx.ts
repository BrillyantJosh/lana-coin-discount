/**
 * A LANA transaction read from its own bytes, on this server — so that a payout
 * an admin enters is checked on the chain, never taken on their word.
 *
 * Brilly (6. 10. 2026): "paid orders move to payout — we transfer them the
 * LANA — showing how much LANA they must get and how much they already got."
 * The admin pays from the firm's own wallet elsewhere and enters the
 * transaction id; the server reads that transaction (server/lib/chainPayment.ts)
 * and these functions say what it pays the purchase's wallet.
 *
 * THE LAYOUT IS PEERCOIN'S. A LANA transaction carries a 4-byte nTime right
 * after the version: version u32LE | nTime u32LE | varint nIn | inputs (32-byte previous
 * id, u32 vout, varint + scriptSig, u32 sequence) | varint nOut | outputs (u64LE
 * value in lanoshis, varint + scriptPubKey) | locktime u32LE. Measured on 84 of
 * 84 real transactions of the chain on 6. 10. 2026 (version 1, no bytes left
 * over, every output P2PKH, sha256d of the bytes reversed = the transaction id
 * every time); a Bitcoin reader takes the first byte of nTime for the number of
 * inputs and goes wrong from there. Ported from lana-cards server/lib/lanaTx.ts.
 *
 * EXACT AND STRICT. Values are BigInt lanoshis (1 LANA = 100,000,000), never a
 * float. Anything but exactly one well-formed transaction throws. Only an exact
 * P2PKH output to the wallet's own key hash counts toward what it pays the
 * wallet, so nothing is ever over-counted. Pure: no network, no clock.
 *
 * IN LANA.DISCOUNT (8. 10. 2026): Krog Menjave's server/lib/lanaTx.ts
 * (origin/main a46f618), unchanged — chainPayment.ts reads with it.
 */
import { createHash } from 'node:crypto';

export interface LanaTxOutput {
  /** The value in lanoshis. */
  lanoshis: bigint;
  /** The scriptPubKey, lower-case hex. */
  script: string;
}

export interface LanaTx {
  version: number;
  /** The sender's clock when it was made (unix seconds) — Peercoin's nTime. */
  nTime: number;
  inputs: number;
  outputs: LanaTxOutput[];
  locktime: number;
}

/** A transaction id as this site writes it: 64 lower-case hex. */
export const TXID = /^[0-9a-f]{64}$/;
/** At most this many inputs or outputs: anything more is not a payout. */
const MAX_IN_OUT = 10_000;

const sha256d = (bytes: Uint8Array): Buffer => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();

/** Parse a raw transaction (hex). Throws on anything that is not exactly one well-formed transaction. */
export function parseLanaTx(rawHex: string): LanaTx {
  if (typeof rawHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(rawHex)) throw new Error('not hex');
  const b = Buffer.from(rawHex, 'hex');
  let o = 0;
  const need = (n: number) => {
    if (n < 0 || o + n > b.length) throw new Error('truncated');
  };
  const u32 = () => {
    need(4);
    const v = b.readUInt32LE(o);
    o += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = b.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const varint = () => {
    need(1);
    const first = b[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      need(2);
      const v = b.readUInt16LE(o);
      o += 2;
      return v;
    }
    if (first === 0xfe) return u32();
    throw new Error('varint too large');
  };
  const skip = (n: number) => {
    need(n);
    o += n;
  };
  const version = u32();
  const nTime = u32(); // Peercoin: nTime right after the version
  const nIn = varint();
  if (nIn < 1 || nIn > MAX_IN_OUT) throw new Error('inputs');
  for (let i = 0; i < nIn; i++) {
    skip(36); // previous transaction id and output index
    skip(varint()); // scriptSig
    u32(); // sequence
  }
  const nOut = varint();
  if (nOut < 1 || nOut > MAX_IN_OUT) throw new Error('outputs');
  const outputs: LanaTxOutput[] = [];
  for (let i = 0; i < nOut; i++) {
    const lanoshis = u64();
    const length = varint();
    need(length);
    const script = b.subarray(o, o + length).toString('hex');
    o += length;
    outputs.push({ lanoshis, script });
  }
  const locktime = u32();
  if (o !== b.length) throw new Error('trailing bytes');
  return { version, nTime, inputs: nIn, outputs, locktime };
}

/** The id of a raw transaction: sha256d of its bytes, reversed (as Electrum and explorers print it). */
export function txidOfRaw(rawHex: string): string {
  return Buffer.from(sha256d(Buffer.from(rawHex, 'hex'))).reverse().toString('hex');
}

/** The P2PKH script that pays a 20-byte key hash (hex). */
export const p2pkhScript = (hash160Hex: string) => `76a914${hash160Hex.toLowerCase()}88ac`;

/**
 * What a transaction pays one key hash, in lanoshis: the sum of its outputs
 * whose script is EXACTLY the P2PKH script of that hash. The hash comes from an
 * address that read in full (lanaAddress.ts lanaAddressHash160).
 */
export function lanoshisPaidTo(tx: LanaTx, hash160Hex: string): bigint {
  const script = p2pkhScript(hash160Hex);
  return tx.outputs.reduce((sum, out) => (out.script === script ? sum + out.lanoshis : sum), 0n);
}

/**
 * The block's merkle root (display order) a transaction reaches with its
 * branch: sha256d over the hashes in their internal byte order; at an odd
 * position the sibling is on the left. A block of one transaction: an empty
 * branch, position 0, and the root is the transaction id itself.
 */
export function merkleRootOf(txid: string, branch: readonly string[], pos: number): string {
  let hash: Buffer = Buffer.from(txid, 'hex').reverse();
  let at = pos;
  for (const sibling of branch) {
    const other = Buffer.from(sibling, 'hex').reverse();
    hash = at & 1 ? sha256d(Buffer.concat([other, hash])) : sha256d(Buffer.concat([hash, other]));
    at = Math.floor(at / 2);
  }
  return Buffer.from(hash).reverse().toString('hex');
}
