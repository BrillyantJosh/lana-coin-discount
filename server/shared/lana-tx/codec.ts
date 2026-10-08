/**
 * The LANA transaction wire format: decode, encode, txid.
 *
 * LanaCoin is a Peercoin-family chain. Every transaction carries a 4-byte nTime
 * straight after the version, which a Bitcoin parser would read as the input
 * count (spec Q14; lana-cards server/lib/lanaTx.ts):
 *
 *   version u32 ‖ nTime u32 ‖ varint n ‖ n × input ‖ varint m ‖ m × output ‖ locktime u32
 *   input  = prev txid (32 bytes, hash order) ‖ vout u32 ‖ varint len ‖ scriptSig ‖ sequence u32
 *   output = value u64 (lanoshis) ‖ varint len ‖ scriptPubKey
 *
 * All little-endian, no witness. Proven on mainnet transactions in
 * codec.test.ts: decode and then encode gives back the same bytes, and the txid
 * recomputed from those bytes is the id the chain knows them by.
 *
 * WHY SO STRICT. The signer and the financer decide what to sign and what was
 * paid from what this file says a transaction is. So decode refuses anything it
 * could not give back byte for byte: a non-minimal varint, a truncated field,
 * trailing bytes, an empty input or output list, a value above 2^63 − 1 (the
 * node's amounts are signed 64-bit). If two different byte strings could decode
 * to the same object, "the transaction we checked" and "the transaction that
 * was sent" could differ. They cannot here: encode(decode(raw)) === raw for
 * every raw decode accepts, and encode refuses every object it could not have
 * decoded.
 *
 * Money is integer lanoshis as bigint, read from the bytes. Never a float.
 */
import { bytesToHex, concatBytes, hexToBytes, reversed, sha256d } from './bytes.ts';

export interface TxInput {
  /** Previous transaction id in display order, as Electrum and explorers print it (64 lowercase hex). */
  prevTxid: string;
  vout: number;
  /** The unlocking script; for P2PKH, <DER signature ‖ hash type> <public key>. Empty while unsigned. */
  scriptSigHex: string;
  sequence: number;
}

export interface TxOutput {
  /** Lanoshis (1 LANA = 100,000,000). */
  value: bigint;
  scriptPubKeyHex: string;
}

export interface LanaTx {
  version: number;
  /** Seconds since 1970, UTC, set by whoever built the transaction (not the block time). */
  nTime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}

/** The only hash type KM ever signs or accepts: the signature covers every input and every output. */
export const SIGHASH_ALL = 0x01;
/** Sequence of a final input; every transaction KM builds uses it. */
export const SEQUENCE_FINAL = 0xffffffff;
/** The node's amounts are int64; anything above is not a value, it is an overflow. */
export const MAX_VALUE = (1n << 63n) - 1n;

const TXID_RE = /^[0-9a-f]{64}$/;
const SCRIPT_HEX_RE = /^(?:[0-9a-f]{2})*$/;
/** Smallest possible encodings, used to bound counts by the bytes actually present. */
const MIN_INPUT_BYTES = 32 + 4 + 1 + 4;
const MIN_OUTPUT_BYTES = 8 + 1;

class Reader {
  private o = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.o;
  }

  private need(n: number): void {
    if (n < 0 || this.o + n > this.buf.length) throw new Error('transaction is truncated');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.o++];
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }

  /** A CompactSize integer, refused unless written in its shortest form (as the node refuses it). */
  varint(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      this.need(2);
      const v = this.view.getUint16(this.o, true);
      this.o += 2;
      if (v < 0xfd) throw new Error('non-canonical varint');
      return v;
    }
    if (first === 0xfe) {
      const v = this.u32();
      if (v <= 0xffff) throw new Error('non-canonical varint');
      return v;
    }
    const v = this.u64();
    if (v <= 0xffffffffn) throw new Error('non-canonical varint');
    // No length in a transaction can be this large; the truncation check would refuse it anyway.
    throw new Error('varint out of range');
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
}

function toBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('raw transaction is not hex');
  try {
    return hexToBytes(raw);
  } catch {
    throw new Error('raw transaction is not hex');
  }
}

/** Decode one raw transaction. Throws on anything that is not exactly one well-formed transaction. */
export function decodeTx(raw: string | Uint8Array): LanaTx {
  const r = new Reader(toBytes(raw));
  const version = r.u32();
  const nTime = r.u32();

  const nIn = r.varint();
  if (nIn === 0) throw new Error('transaction has no inputs');
  if (nIn * MIN_INPUT_BYTES > r.remaining) throw new Error(`input count ${nIn} does not fit the bytes`);
  const inputs: TxInput[] = [];
  for (let i = 0; i < nIn; i++) {
    const prevTxid = bytesToHex(reversed(r.bytes(32)));
    const vout = r.u32();
    const scriptSigHex = bytesToHex(r.bytes(r.varint()));
    const sequence = r.u32();
    inputs.push({ prevTxid, vout, scriptSigHex, sequence });
  }

  const nOut = r.varint();
  if (nOut === 0) throw new Error('transaction has no outputs');
  if (nOut * MIN_OUTPUT_BYTES > r.remaining) throw new Error(`output count ${nOut} does not fit the bytes`);
  const outputs: TxOutput[] = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.u64();
    if (value > MAX_VALUE) throw new Error(`output ${i} value is out of range`);
    const scriptPubKeyHex = bytesToHex(r.bytes(r.varint()));
    outputs.push({ value, scriptPubKeyHex });
  }

  const locktime = r.u32();
  if (r.remaining !== 0) throw new Error('trailing bytes after transaction');
  return { version, nTime, inputs, outputs, locktime };
}

export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('varint must be a non-negative integer');
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return concatBytes(Uint8Array.of(0xfe), u32le(n));
  throw new Error('varint out of range');
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function assertU32(n: unknown, what: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`${what} must be a u32`);
}

function scriptBytes(hex: unknown, what: string): Uint8Array {
  if (typeof hex !== 'string' || !SCRIPT_HEX_RE.test(hex)) throw new Error(`${what} must be lowercase hex`);
  return hexToBytes(hex);
}

/** The wire bytes of a transaction. Refuses any field decodeTx could not have produced. */
export function encodeTx(tx: LanaTx): Uint8Array {
  assertU32(tx.version, 'version');
  assertU32(tx.nTime, 'nTime');
  assertU32(tx.locktime, 'locktime');
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('transaction has no inputs');
  if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) throw new Error('transaction has no outputs');

  const parts: Uint8Array[] = [u32le(tx.version), u32le(tx.nTime), encodeVarint(tx.inputs.length)];
  tx.inputs.forEach((input, i) => {
    if (typeof input.prevTxid !== 'string' || !TXID_RE.test(input.prevTxid)) throw new Error(`input ${i} prevTxid must be 64 lowercase hex`);
    assertU32(input.vout, `input ${i} vout`);
    assertU32(input.sequence, `input ${i} sequence`);
    const script = scriptBytes(input.scriptSigHex, `input ${i} scriptSig`);
    parts.push(reversed(hexToBytes(input.prevTxid)), u32le(input.vout), encodeVarint(script.length), script, u32le(input.sequence));
  });
  parts.push(encodeVarint(tx.outputs.length));
  tx.outputs.forEach((output, i) => {
    if (typeof output.value !== 'bigint' || output.value < 0n || output.value > MAX_VALUE) {
      throw new Error(`output ${i} value must be a bigint in [0, 2^63 − 1]`);
    }
    const script = scriptBytes(output.scriptPubKeyHex, `output ${i} scriptPubKey`);
    parts.push(u64le(output.value), encodeVarint(script.length), script);
  });
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}

export function encodeTxHex(tx: LanaTx): string {
  return bytesToHex(encodeTx(tx));
}

/** The txid of raw bytes, in display order. It is computed, never taken from whoever sent the bytes. */
export function txidOfRaw(raw: string | Uint8Array): string {
  return bytesToHex(reversed(sha256d(toBytes(raw))));
}

export function txidOf(tx: LanaTx): string {
  return bytesToHex(reversed(sha256d(encodeTx(tx))));
}

/** "txid:vout", the one spelling of an outpoint used as a key. */
export function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/**
 * BIP66 strict DER for an ECDSA signature WITHOUT its hash-type byte:
 * 0x30 len 0x02 lenR R 0x02 lenS S, with minimal positive integers. The same
 * test the node applies, so a signature this refuses is one the network would.
 */
export function isStrictDer(sig: Uint8Array): boolean {
  if (sig.length < 8 || sig.length > 72) return false;
  if (sig[0] !== 0x30 || sig[1] !== sig.length - 2) return false;
  const lenR = sig[3];
  if (5 + lenR >= sig.length) return false;
  const lenS = sig[5 + lenR];
  if (lenR + lenS + 6 !== sig.length) return false;
  if (sig[2] !== 0x02 || lenR === 0 || sig[4] & 0x80) return false;
  if (lenR > 1 && sig[4] === 0x00 && !(sig[5] & 0x80)) return false;
  if (sig[4 + lenR] !== 0x02 || lenS === 0 || sig[6 + lenR] & 0x80) return false;
  if (lenS > 1 && sig[6 + lenR] === 0x00 && !(sig[7 + lenR] & 0x80)) return false;
  return true;
}

export interface P2pkhScriptSig {
  /** Strict DER, without the hash-type byte. */
  signatureDer: Uint8Array;
  hashType: number;
  /** 33 bytes (02/03) or 65 bytes (04), as the input reveals it. */
  publicKey: Uint8Array;
}

/**
 * Read a P2PKH unlocking script: exactly two direct pushes, a strict-DER
 * signature with its hash-type byte, then a 33- or 65-byte public key. Anything
 * else (another script type, trailing bytes, a malformed push) is null.
 */
export function parseP2pkhScriptSig(scriptSigHex: string): P2pkhScriptSig | null {
  if (typeof scriptSigHex !== 'string' || !SCRIPT_HEX_RE.test(scriptSigHex)) return null;
  const b = hexToBytes(scriptSigHex);
  let o = 0;
  const push = (): Uint8Array | null => {
    if (o >= b.length) return null;
    const n = b[o++];
    if (n < 1 || n > 0x4b || o + n > b.length) return null;
    const out = b.subarray(o, o + n);
    o += n;
    return out;
  };
  const sig = push();
  const pub = push();
  if (!sig || !pub || o !== b.length) return null;
  const signatureDer = sig.subarray(0, sig.length - 1);
  if (!isStrictDer(signatureDer)) return null;
  const okPub = (pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03)) || (pub.length === 65 && pub[0] === 0x04);
  if (!okPub) return null;
  return { signatureDer: Uint8Array.from(signatureDer), hashType: sig[sig.length - 1], publicKey: Uint8Array.from(pub) };
}

/** <DER ‖ hash type> <public key>, as hex: what goes into a signed P2PKH input. */
export function p2pkhScriptSigHex(signatureDer: Uint8Array, publicKey: Uint8Array, hashType: number = SIGHASH_ALL): string {
  if (!isStrictDer(signatureDer)) throw new Error('signature is not strict DER');
  if (!Number.isInteger(hashType) || hashType < 0 || hashType > 0xff) throw new Error('hash type must be one byte');
  const okPub =
    (publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)) || (publicKey.length === 65 && publicKey[0] === 0x04);
  if (!okPub) throw new Error('public key must be 33 bytes (02/03) or 65 bytes (04)');
  const sig = concatBytes(signatureDer, Uint8Array.of(hashType));
  return bytesToHex(concatBytes(Uint8Array.of(sig.length), sig, Uint8Array.of(publicKey.length), publicKey));
}
