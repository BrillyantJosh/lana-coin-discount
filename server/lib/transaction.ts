/**
 * LanaCoin Transaction Engine
 * Ported from MejmoseFajn server/lib/crypto.ts
 *
 * Contains:
 * - Base58 encoding/decoding
 * - secp256k1 elliptic curve operations
 * - ECDSA signing (RFC 6979, BIP-62)
 * - Address generation (LANA version byte 0x30)
 * - Transaction building with nTime field
 * - UTXO selection and fee calculation
 */

import * as crypto from 'crypto';
import { electrumCall } from './electrum.js';
import { BACKING_TOLERANCE_LANOSHIS } from './acquisitionBacking.js';

// ==============================================
// Base58 Encoding/Decoding
// ==============================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; ++j) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; ++i) {
    result += BASE58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; --i) {
    result += BASE58_ALPHABET[digits[i]];
  }

  return result;
}

export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const p = BASE58_ALPHABET.indexOf(c);
    if (p < 0) throw new Error(`Invalid Base58 character: ${c}`);

    let carry = p;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingOnes = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    leadingOnes++;
  }

  const result = new Uint8Array(leadingOnes + bytes.length);
  bytes.reverse();
  result.set(bytes, leadingOnes);
  return result;
}

export function base58CheckDecode(address: string, skipChecksum = false): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length < 5) throw new Error('Address too short');

  const payload = decoded.slice(0, -4);

  if (!skipChecksum) {
    const checksum = decoded.slice(-4);
    const hash = sha256(sha256(payload));

    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== hash[i]) {
        throw new Error(`Invalid checksum for: "${address.substring(0, 20)}..." (len=${address.length})`);
      }
    }
  }

  return payload;
}

export function base58CheckEncode(payload: Uint8Array): string {
  const hash = sha256(sha256(payload));
  const checksum = hash.slice(0, 4);

  const combined = new Uint8Array(payload.length + 4);
  combined.set(payload);
  combined.set(checksum, payload.length);

  return base58Encode(combined);
}

// ==============================================
// Hash Functions
// ==============================================

export function sha256(data: Uint8Array): Uint8Array {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return new Uint8Array(hash.digest());
}

export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function ripemd160(data: Uint8Array): Uint8Array {
  const hash = crypto.createHash('ripemd160');
  hash.update(data);
  return new Uint8Array(hash.digest());
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

// ==============================================
// Hex Utilities
// ==============================================

export function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length');
  const array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    array[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return array;
}

export function uint8ArrayToHex(array: Uint8Array): string {
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ==============================================
// secp256k1 Elliptic Curve
// ==============================================

const P = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const Gx = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
const Gy = BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8');

function mod(a: bigint, m: bigint = P): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

function modInverse(a: bigint, m: bigint = P): bigint {
  if (a === 0n) return 0n;
  let lm = 1n, hm = 0n;
  let low = mod(a, m), high = m;
  while (low > 1n) {
    const ratio = high / low;
    const nm = hm - lm * ratio;
    const nw = high - low * ratio;
    hm = lm;
    high = low;
    lm = nm;
    low = nw;
  }
  return mod(lm, m);
}

class Point {
  x: bigint | null;
  y: bigint | null;

  constructor(x: bigint | null, y: bigint | null) {
    this.x = x;
    this.y = y;
  }

  static infinity(): Point {
    return new Point(null, null);
  }

  isInfinity(): boolean {
    return this.x === null || this.y === null;
  }

  add(other: Point): Point {
    if (this.isInfinity()) return other;
    if (other.isInfinity()) return this;

    if (this.x === other.x && this.y !== other.y) {
      return Point.infinity();
    }

    let slope: bigint;
    if (this.x === other.x && this.y === other.y) {
      slope = mod((3n * this.x! * this.x! + 0n) * modInverse(2n * this.y!));
    } else {
      slope = mod((other.y! - this.y!) * modInverse(other.x! - this.x!));
    }

    const x3 = mod(slope * slope - this.x! - other.x!);
    const y3 = mod(slope * (this.x! - x3) - this.y!);

    return new Point(x3, y3);
  }

  multiply(k: bigint): Point {
    let result = Point.infinity();
    let addend: Point = this;

    while (k > 0n) {
      if (k & 1n) {
        result = result.add(addend);
      }
      addend = addend.add(addend);
      k >>= 1n;
    }

    return result;
  }
}

const G = new Point(Gx, Gy);

// ==============================================
// Key and Address Functions
// ==============================================

export function privateKeyToPublicKey(privateKeyHex: string): Uint8Array {
  const privateKey = BigInt('0x' + privateKeyHex);
  const publicPoint = G.multiply(privateKey);

  const prefix = publicPoint.y! % 2n === 0n ? 0x02 : 0x03;
  const xBytes = publicPoint.x!.toString(16).padStart(64, '0');

  const result = new Uint8Array(33);
  result[0] = prefix;
  for (let i = 0; i < 32; i++) {
    result[i + 1] = parseInt(xBytes.substring(i * 2, i * 2 + 2), 16);
  }

  return result;
}

export function privateKeyToUncompressedPublicKey(privateKeyHex: string): Uint8Array {
  const privateKey = BigInt('0x' + privateKeyHex);
  const publicPoint = G.multiply(privateKey);

  const xBytes = publicPoint.x!.toString(16).padStart(64, '0');
  const yBytes = publicPoint.y!.toString(16).padStart(64, '0');

  const result = new Uint8Array(65);
  result[0] = 0x04;
  for (let i = 0; i < 32; i++) {
    result[i + 1] = parseInt(xBytes.substring(i * 2, i * 2 + 2), 16);
    result[i + 33] = parseInt(yBytes.substring(i * 2, i * 2 + 2), 16);
  }

  return result;
}

export function publicKeyToAddress(publicKey: Uint8Array): string {
  // LANA uses version byte 0x30 (48 decimal) for mainnet addresses
  const pubKeyHash = hash160(publicKey);
  const versionedHash = new Uint8Array(21);
  versionedHash[0] = 0x30;
  versionedHash.set(pubKeyHash, 1);
  return base58CheckEncode(versionedHash);
}

export function normalizeWif(wif: string): string {
  return wif.replace(/[\s\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
}

export function normalizeAddress(address: string): string {
  return address.replace(/[\s\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
}

export function isValidLanaAddress(address: string): boolean {
  try {
    const decoded = base58CheckDecode(address, true);
    return decoded.length === 21;
  } catch {
    return false;
  }
}

// ==============================================
// ECDSA Signing
// ==============================================

function encodeDER(r: bigint, s: bigint): Uint8Array {
  const rBytes = bigintToBytes(r);
  const sBytes = bigintToBytes(s);

  const rPadded = rBytes[0] >= 0x80 ? new Uint8Array([0, ...rBytes]) : rBytes;
  const sPadded = sBytes[0] >= 0x80 ? new Uint8Array([0, ...sBytes]) : sBytes;

  const sequence = new Uint8Array([
    0x30,
    2 + rPadded.length + 2 + sPadded.length,
    0x02,
    rPadded.length,
    ...rPadded,
    0x02,
    sPadded.length,
    ...sPadded
  ]);

  return sequence;
}

function bigintToBytes(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  const bytes = hexToUint8Array(hex);

  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }

  return bytes.slice(start);
}

export function signECDSA(privateKeyHex: string, messageHash: Uint8Array): Uint8Array {
  const d = BigInt('0x' + privateKeyHex);
  const z = BigInt('0x' + uint8ArrayToHex(messageHash));

  let k = generateK(d, z);

  while (true) {
    const kPoint = G.multiply(k);
    const r = mod(kPoint.x!, N);

    if (r === 0n) {
      k = mod(k + 1n, N);
      continue;
    }

    let s = mod(modInverse(k, N) * (z + r * d), N);

    if (s === 0n) {
      k = mod(k + 1n, N);
      continue;
    }

    // Use low S value (BIP-62)
    if (s > N / 2n) {
      s = N - s;
    }

    return encodeDER(r, s);
  }
}

function generateK(privateKey: bigint, messageHash: bigint): bigint {
  const privateKeyBytes = hexToUint8Array(privateKey.toString(16).padStart(64, '0'));
  const hashBytes = hexToUint8Array(messageHash.toString(16).padStart(64, '0'));

  const combined = new Uint8Array(64);
  combined.set(privateKeyBytes);
  combined.set(hashBytes, 32);

  const kHash = sha256(combined);
  let k = BigInt('0x' + uint8ArrayToHex(kHash));

  k = mod(k, N - 1n) + 1n;
  return k;
}

// ==============================================
// Transaction Building Utilities
// ==============================================

function encodeVarint(value: number): Uint8Array {
  if (value < 0xfd) {
    return new Uint8Array([value]);
  } else if (value <= 0xffff) {
    return new Uint8Array([0xfd, value & 0xff, (value >> 8) & 0xff]);
  } else if (value <= 0xffffffff) {
    return new Uint8Array([
      0xfe,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff
    ]);
  } else {
    throw new Error('Value too large for varint');
  }
}

function pushData(data: Uint8Array): Uint8Array {
  if (data.length < 76) {
    return new Uint8Array([data.length, ...data]);
  } else if (data.length < 256) {
    return new Uint8Array([0x4c, data.length, ...data]);
  } else if (data.length < 65536) {
    return new Uint8Array([0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data]);
  } else {
    throw new Error('Data too large to push');
  }
}

function littleEndian32(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff
  ]);
}

function littleEndian64(n: bigint): Uint8Array {
  const result = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    result[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
  return result;
}

// ==============================================
// UTXO Selection
// ==============================================

export interface UTXO {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

interface Recipient {
  address: string;
  amount: number;
}

class UTXOSelector {
  static MAX_INPUTS = 20;
  static DUST_THRESHOLD = 500000; // 0.005 LANA = 500,000 lanoshis

  static selectUTXOs(utxos: UTXO[], totalNeeded: number): { selected: UTXO[]; totalValue: number } {
    if (!utxos || utxos.length === 0) {
      throw new Error('No UTXOs available for selection');
    }

    console.log(`[lana-discount] UTXO Selection: Need ${totalNeeded} lanoshis from ${utxos.length} UTXOs`);
    const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);

    if (totalAvailable < totalNeeded) {
      throw new Error(
        `Insufficient total UTXO value: ${totalAvailable} < ${totalNeeded} lanoshis. ` +
        `Available: ${(totalAvailable / 100000000).toFixed(8)} LANA, ` +
        `Needed: ${(totalNeeded / 100000000).toFixed(8)} LANA`
      );
    }

    const sortedUTXOs = [...utxos].sort((a, b) => b.value - a.value);
    const nonDustUtxos = sortedUTXOs.filter(u => u.value >= this.DUST_THRESHOLD);
    const workingSet = nonDustUtxos.length > 0 ? nonDustUtxos : sortedUTXOs;

    const selectedUTXOs: UTXO[] = [];
    let totalSelected = 0;

    for (let i = 0; i < workingSet.length && selectedUTXOs.length < this.MAX_INPUTS; i++) {
      selectedUTXOs.push(workingSet[i]);
      totalSelected += workingSet[i].value;

      if (totalSelected >= totalNeeded) {
        return { selected: selectedUTXOs, totalValue: totalSelected };
      }
    }

    // If still insufficient, try including dust
    if (nonDustUtxos.length !== sortedUTXOs.length) {
      for (const utxo of sortedUTXOs) {
        if (selectedUTXOs.some(s => s.tx_hash === utxo.tx_hash && s.tx_pos === utxo.tx_pos)) continue;
        if (selectedUTXOs.length >= this.MAX_INPUTS) break;

        selectedUTXOs.push(utxo);
        totalSelected += utxo.value;

        if (totalSelected >= totalNeeded) {
          return { selected: selectedUTXOs, totalValue: totalSelected };
        }
      }
    }

    throw new Error(
      `Cannot build transaction: Need ${(totalNeeded / 100000000).toFixed(8)} LANA but ` +
      `only ${(totalSelected / 100000000).toFixed(8)} LANA available in ${selectedUTXOs.length} UTXOs`
    );
  }
}

// ==============================================
// Transfer planning — inputs, fee, and who pays it
// ==============================================

/** The most inputs one transaction may carry. */
export const MAX_TRANSACTION_INPUTS = UTXOSelector.MAX_INPUTS;

/**
 * What this chain asks for a transaction of this shape: 180 bytes an input,
 * 34 an output, 10 of envelope, at 100 lanoshis a byte with half again on top.
 *
 * The arithmetic is unchanged; it lives in one function now so that the
 * emptying plan and the ordinary plan can never estimate it differently — the
 * bug of 10 Sept 2026 was two estimates of the same fee disagreeing.
 */
export function estimateFeeLanoshis(inputCount: number, outputCount: number): number {
  return Math.floor((inputCount * 180 + outputCount * 34 + 10) * 100 * 1.5);
}

export type TransferPlan =
  | {
      ok: true;
      /** True when the whole wallet moves in one output and the fee comes out of it. */
      emptyWallet: boolean;
      /** What the recipient actually receives — less than the balance when emptying. */
      amountLanoshis: number;
      feeLanoshis: number;
      selected: UTXO[];
      totalSelected: number;
      totalBalance: number;
    }
  | { ok: false; code: 'TOO_MANY_UTXOS'; utxoCount: number; maxInputs: number; totalBalance: number }
  | {
      ok: false;
      code: 'INSUFFICIENT_FUNDS';
      /** Amount + fee — or, when `emptying`, the amount alone. */
      requiredLanoshis: number;
      /** What the selectable UTXOs actually hold. */
      availableLanoshis: number;
      shortfallLanoshis: number;
      feeLanoshis: number;
      totalBalance: number;
      /**
       * How many pieces this plan would have spent. A top-up is a NEW piece,
       * so the sentence that asks for one has to price the extra input — see
       * describePlanFailure, and the 0.001737 that was quoted to a seller whose
       * wallet then needed 0.002007.
       */
      inputCount?: number;
      /** True when the refusal came from a sweep, where the fee is inside the amount. */
      emptying?: true;
    }
  | { ok: false; code: 'EMPTY_WALLET_EXCEEDS_CEILING'; totalBalance: number; ceilingLanoshis: number };

/**
 * WHICH COINS MOVE, AND WHERE THE FEE COMES FROM. Pure: give it the UTXOs and
 * it answers with a plan or with the reason there is none — no chain, no keys,
 * so the arithmetic that failed in production can be run in a test.
 *
 * Two shapes:
 *
 *   ordinary   one output to the recipient, one for the change. The fee is
 *              paid out of the change, so the wallet must hold amount + fee.
 *   emptying   every UTXO in, one output out, no change. The fee comes out of
 *              the amount, so a wallet holding EXACTLY the amount can still
 *              send — which is the whole point of it.
 *
 * A seller who offers their entire wallet needs the second. On 10 Sept 2026
 * eight transfers were planned as the first and every one was refused by
 * 173,700 lanoshis — the fee, with nowhere to come from.
 *
 * `sweepCeilingLanoshis` is the caller's mandate, in lanoshis: a wallet that
 * turns out to hold more than that is not swept. This is the last layer that
 * sees the EXACT balance — the UTXOs themselves — so it is where the mandate
 * is really enforced, and where the emptying decision is really made: give it
 * both `emptyWallet: true` and an `amountLanoshis`, and it sweeps when the
 * wallet fits under the ceiling and sends the named amount the ordinary way
 * when it does not. A caller that cannot read the balance at all can therefore
 * still get the right shape, by asking for both.
 */
export function planTransfer(params: {
  utxos: UTXO[];
  /** Required unless emptying. In lanoshis. */
  amountLanoshis?: number;
  emptyWallet: boolean;
  sweepCeilingLanoshis?: number;
}): TransferPlan {
  const { utxos, emptyWallet, sweepCeilingLanoshis } = params;
  const totalBalance = utxos.reduce((sum, u) => sum + u.value, 0);
  const tooMany = (): TransferPlan =>
    ({ ok: false, code: 'TOO_MANY_UTXOS', utxoCount: utxos.length, maxInputs: MAX_TRANSACTION_INPUTS, totalBalance });

  if (emptyWallet) {
    // THE CEILING IS ASKED FIRST, AND THE ORDER IS THE WHOLE POINT.
    //
    // Refusing on the input count before asking whether this is even a sweep
    // told a seller moving 100 LANA out of a 5,000 LANA wallet to consolidate
    // all 5,000 — for a transfer that needed one input. It only bit when the
    // balance could not be read, which is exactly when the route assumes a
    // sweep, so an electrum outage turned an ordinary sale into a dead end and
    // every press wrote another failed row (10 Sept 2026 review). A wallet that
    // holds more than the agreed amount is not a sweep at all, so the count of
    // its pieces is not this branch's business.
    if (sweepCeilingLanoshis !== undefined && totalBalance > sweepCeilingLanoshis) {
      // A WALLET OVER THE CEILING IS NOT A REFUSAL — IT IS AN ORDINARY TRANSFER.
      //
      // The ceiling is computed one layer up from electrum's balance reading,
      // which is a moment older than these UTXOs and — until the exact figure
      // was carried alongside it — rounded to 0.01 LANA. So "over the ceiling"
      // can mean nothing more than one small payment arriving after acceptance,
      // and refusing on it left the seller with no way through inside a 24-hour
      // window (10 Sept 2026 review).
      //
      // Holding MORE than the agreed amount is precisely the case an ordinary
      // transfer handles: the fee comes out of the change. So when the caller
      // named an amount, that amount moves and not one lanoshi more — the
      // mandate is still the ceiling on what the treasury takes.
      if (params.amountLanoshis !== undefined && params.amountLanoshis > 0) {
        return planTransfer({ utxos, amountLanoshis: params.amountLanoshis, emptyWallet: false });
      }
      // No amount to fall back to: the caller asked only for a sweep, so the
      // ceiling is the whole of its instruction and refusing it is the answer.
      return { ok: false, code: 'EMPTY_WALLET_EXCEEDS_CEILING', totalBalance, ceilingLanoshis: sweepCeilingLanoshis };
    }
    // THE FLOOR. A SWEEP HAD A CEILING AND NO FLOOR, AND THAT IS A HOLE.
    //
    // Emptying sends whatever is there, less the fee — and said ok. Nothing
    // asked whether "whatever is there" is anywhere near the amount the
    // treasury agreed to buy, because the wallet was assumed to hold it. Two
    // readings of one wallet disagree: the route asks electrum for a BALANCE,
    // which is confirmed + unconfirmed (electrum.ts), while this layer spends
    // `listunspent`, which is CONFIRMED ONLY. So an incoming payment that never
    // confirms — a low fee, a replacement — shows in the balance, backs the
    // proposal, and cannot be spent here.
    //
    // Without this line: a wallet holding 1 LANA confirmed and 3,260 LANA
    // unconfirmed against an agreed 3,261.796875 swept ONE LANA, returned
    // success, and the row and the published event both recorded 3,261.796875
    // LANA acquired at the full purchase price. The treasury would have paid
    // for LANA that never arrived.
    //
    // So a sweep is now what its name says: a wallet holding the agreed amount
    // that cannot ALSO pay the fee out of change. Below the amount it is not an
    // emptying transfer, it is a short wallet, and the honest answer is the
    // same shortfall an ordinary transfer would have given. The fee itself
    // stays the tolerance — that much is unavoidable and is the whole point of
    // the shape — so the test is on the WALLET, not on what is delivered.
    //
    // HOW FAR BELOW IS STILL "THE AGREED AMOUNT"? The repo has already answered
    // that, once, in acquisitionBacking: BACKING_TOLERANCE_LANOSHIS is what the
    // route forgives at every step that commits something. Reusing it means the
    // two layers cannot disagree — a wallet the route called backed is never
    // refused here as short, and a wallet the route would have refused is never
    // swept here. A seller who consolidates his pieces and loses the merge fee
    // stays inside it; an unconfirmed credit that never lands does not.
    const floorLanoshis = params.amountLanoshis !== undefined && params.amountLanoshis > 0
      ? params.amountLanoshis - BACKING_TOLERANCE_LANOSHIS
      : undefined;
    if (floorLanoshis !== undefined && totalBalance < floorLanoshis) {
      const feeLanoshis = estimateFeeLanoshis(Math.min(utxos.length, MAX_TRANSACTION_INPUTS), 1);
      return {
        ok: false, code: 'INSUFFICIENT_FUNDS', emptying: true,
        requiredLanoshis: params.amountLanoshis!, availableLanoshis: totalBalance,
        shortfallLanoshis: params.amountLanoshis! - totalBalance, feeLanoshis, totalBalance,
        inputCount: Math.min(utxos.length, MAX_TRANSACTION_INPUTS),
      };
    }
    // A genuine sweep DOES have to carry every piece, so here the count is the
    // real constraint and the refusal is the honest answer.
    if (utxos.length > MAX_TRANSACTION_INPUTS) return tooMany();
    // Emptying takes every UTXO and leaves no change, so the fee is known
    // exactly here — no selection loop can revise it, and nothing is left
    // behind by a subset that happened to reach the target on its own.
    const feeLanoshis = estimateFeeLanoshis(utxos.length, 1);
    const amountLanoshis = totalBalance - feeLanoshis;
    if (amountLanoshis <= 0) {
      return {
        ok: false, code: 'INSUFFICIENT_FUNDS', emptying: true,
        requiredLanoshis: feeLanoshis + 1, availableLanoshis: totalBalance,
        shortfallLanoshis: feeLanoshis + 1 - totalBalance, feeLanoshis, totalBalance,
        inputCount: utxos.length,
      };
    }
    return { ok: true, emptyWallet: true, amountLanoshis, feeLanoshis, selected: [...utxos], totalSelected: totalBalance, totalBalance };
  }

  const wanted = Math.floor(params.amountLanoshis ?? 0);
  if (!(wanted > 0)) throw new Error('planTransfer: an amount is required when the wallet is not being emptied');

  // Two outputs: the recipient and the change the fee is taken from.
  const OUTPUTS = 2;
  const short = (required: number, available: number, feeLanoshis: number, inputCount: number): TransferPlan => ({
    ok: false, code: 'INSUFFICIENT_FUNDS',
    requiredLanoshis: required, availableLanoshis: available,
    shortfallLanoshis: required - available, feeLanoshis, totalBalance, inputCount,
  });

  let selected: UTXO[];
  let totalSelected: number;
  try {
    const first = UTXOSelector.selectUTXOs(utxos, wanted);
    selected = first.selected;
    totalSelected = first.totalValue;
  } catch {
    // Not even the amount can be reached: the wallet is short, full stop.
    const inputs = Math.min(utxos.length, MAX_TRANSACTION_INPUTS);
    const feeLanoshis = estimateFeeLanoshis(inputs, OUTPUTS);
    return short(wanted + feeLanoshis, totalBalance, feeLanoshis, inputs);
  }

  let feeLanoshis = estimateFeeLanoshis(selected.length, OUTPUTS);
  for (let i = 0; i < 10 && totalSelected < wanted + feeLanoshis && selected.length < utxos.length; i++) {
    try {
      const next = UTXOSelector.selectUTXOs(utxos, wanted + feeLanoshis);
      selected = next.selected;
      totalSelected = next.totalValue;
    } catch {
      break; // the balance cannot reach amount + fee; reported below
    }
    feeLanoshis = estimateFeeLanoshis(selected.length, OUTPUTS);
  }

  if (totalSelected < wanted + feeLanoshis) {
    if (totalBalance >= wanted + feeLanoshis && utxos.length > MAX_TRANSACTION_INPUTS) return tooMany();

    // THE MIRROR OF THE CEILING ABOVE — AND THE LAST THING TRIED.
    //
    // A sweep that meets a wallet holding MORE than its ceiling is sent the
    // ordinary way. This is the other direction: an ordinary transfer whose
    // wallet turns out to hold the agreed amount and not enough on top of it
    // to pay for a change output. There is no change to take the fee from and
    // none is needed — a wallet with nothing to spare IS being emptied,
    // whatever the caller called it.
    //
    // THIS IS THE DEAD BAND, and it had nothing to do with the caller's
    // intent. One layer up, "is this a sweep?" was answered against a CONSTANT
    // dust allowance priced on a one-input transaction (100,800 lanoshis),
    // while the fee a wallet actually pays is priced on its real pieces —
    // 173,700 for six. Between those two numbers neither shape worked: too
    // much surplus to sweep, too little to pay for the change. OFF-2026-062
    // sat exactly there, 125,000 lanoshis over, 48,700 short, with nothing the
    // seller could do to either number.
    //
    // THE BAND IS STATED ON THE DELIVERY, WHICH IS THE ONLY NUMBER THAT MATTERS,
    // and it needs no constant at all:
    //
    //   utxos.length <= MAX      a sweep carries every input; when it cannot,
    //                            the honest answer is the shortfall below.
    //   totalBalance >= wanted   the agreed amount really is in the wallet. No
    //                            tolerance: the floor above forgives a rounded
    //                            balance, this does not, because here the
    //                            UTXOs are exact.
    //   delivered <= wanted      the treasury cannot receive a lanoshi more
    //                            than it agreed to buy. This is the sweep
    //                            ceiling expressed on what arrives rather than
    //                            on what the wallet holds, and it is strictly
    //                            tighter than any ceiling the caller could
    //                            hand down — so no mandate can be exceeded
    //                            through this road, whatever was passed.
    //
    // ORDER. Reached only after an ordinary plan has been attempted and has
    // failed on the balance, and that is not tidiness: the sweep fee is sized
    // on EVERY input and the ordinary fee only on the selected ones. Asked
    // first, this would sweep wallets that could comfortably have paid for
    // their own change, delivering less than agreed to do it. Asked last it
    // cannot — an ordinary plan succeeds whenever the balance allows it, which
    // puts that wallet outside this band.
    //   a ceiling was given  the caller has to have SAID that emptying this
    //                          wallet is within its mandate. This function does
    //                          not invent consent: delivering less than the
    //                          amount asked for is a decision, and a caller
    //                          that never mentioned emptying gets the honest
    //                          shortfall instead. The ceiling's own NUMBER is
    //                          not used here — the delivery bound above is
    //                          stricter in what arrives — but its presence is
    //                          the permission.
    const sweepFeeLanoshis = estimateFeeLanoshis(utxos.length, 1);
    if (
      sweepCeilingLanoshis !== undefined &&
      utxos.length <= MAX_TRANSACTION_INPUTS &&
      totalBalance >= wanted &&
      totalBalance - sweepFeeLanoshis <= wanted
    ) {
      // The ceiling is NOT forwarded: the guard above already binds what
      // arrives, and forwarding it would bounce the plan back to this branch.
      const swept = planTransfer({ utxos, amountLanoshis: wanted, emptyWallet: true });
      if (!planFailed(swept)) return swept;
    }

    return short(wanted + feeLanoshis, totalSelected, feeLanoshis, selected.length);
  }

  return { ok: true, emptyWallet: false, amountLanoshis: wanted, feeLanoshis, selected, totalSelected, totalBalance };
}

export type TransferPlanFailure = Extract<TransferPlan, { ok: false }>;

/**
 * A type guard rather than `if (!plan.ok)`: this project compiles with
 * strictNullChecks off, where narrowing a boolean discriminant does not.
 */
export function planFailed(plan: TransferPlan): plan is TransferPlanFailure {
  return plan.ok === false;
}

/**
 * TRUE WHEN PRESSING THE BUTTON AGAIN CANNOT COME OUT DIFFERENTLY.
 *
 * Not every refused plan is a dead end, and telling them apart is the whole
 * value of saying so: a caller that remembers a refusal must remember only the
 * ones whose remedy it can see happen.
 *
 *   TOO_MANY_UTXOS            NOT permanent. Its own sentence tells the seller
 *                             to consolidate, and consolidating fixes it. It is
 *                             a fact about the SHAPE of the wallet, not its
 *                             balance — a consolidation moves the balance by a
 *                             single fee, which no balance-keyed memory can
 *                             see. Calling this permanent locked sellers out of
 *                             the very fix we asked them for.
 *   EMPTY_WALLET_EXCEEDS_...  NOT permanent. The ceiling came from a reading
 *                             taken one layer up, not from the wallet.
 *   INSUFFICIENT_FUNDS        Permanent WHILE THE WALLET IS UNCHANGED: the same
 *                             coins and the same amount give the same answer.
 */
export function planFailurePermanent(plan: TransferPlanFailure): boolean {
  switch (plan.code) {
    case 'TOO_MANY_UTXOS':
    case 'EMPTY_WALLET_EXCEEDS_CEILING':
      return false;
    default:
      return true;
  }
}

/** An ordinary transfer's two outputs: the recipient, and the change. */
const OUTPUT_PAIR = 2;

/** Lanoshis as a person reads them: LANA, trailing zeros trimmed. */
function lanaText(lanoshis: number): string {
  const s = (lanoshis / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

/**
 * A refused plan in a sentence. `Insufficient funds: need 326179861200
 * lanoshis, have 326179687500` is what a seller was shown on 10 Sept 2026;
 * every number below is the same number in LANA, with the fee named as a fee.
 */
export function describePlanFailure(plan: TransferPlanFailure): { error: string; code: string } {
  switch (plan.code) {
    case 'TOO_MANY_UTXOS':
      // The code used to be the first word of the sentence, and "UTXO" the
      // fourth. This is the one refusal the seller can act on himself, so it
      // says what to do in words rather than naming its own error constant.
      return {
        code: 'TOO_MANY_UTXOS',
        error: `This wallet holds its ${lanaText(plan.totalBalance)} LANA in ${plan.utxoCount} separate pieces, and one transfer can carry at most ${plan.maxInputs}. Consolidate them with Registrar and send again. Nothing has moved.`,
      };
    case 'EMPTY_WALLET_EXCEEDS_CEILING':
      return {
        code: 'EMPTY_WALLET_EXCEEDS_CEILING',
        error: `This wallet holds ${lanaText(plan.totalBalance)} LANA, more than the ${lanaText(plan.ceilingLanoshis)} LANA this transfer may empty into. Nothing has moved.`,
      };
    default: {
      // A SWEEP IS SHORT IN A DIFFERENT WAY, so it is said differently: the fee
      // comes out of the amount there, and a sentence that adds one to the
      // other would name a figure the seller could not check against anything.
      if (plan.emptying) {
        return {
          code: 'INSUFFICIENT_FUNDS',
          error: `This wallet holds ${lanaText(plan.availableLanoshis)} LANA, less than the ${lanaText(plan.requiredLanoshis)} LANA this transfer is for — ${lanaText(plan.shortfallLanoshis)} LANA short. If LANA is on its way in, it has to be confirmed on the chain before it can be sent on. Nothing has moved.`,
        };
      }
      const amount = plan.requiredLanoshis - plan.feeLanoshis;
      // THE NUMBER WE ASK FOR HAS TO BE A NUMBER THAT WORKS.
      //
      // The shortfall is priced on the pieces this plan would have spent. A
      // top-up is a piece MORE, and every piece costs 0.00027 LANA of network
      // fee, so a seller who sent himself exactly the shortfall was refused a
      // second time — by the price of the payment he had just been asked to
      // make. 0.001737 was quoted where 0.002007 was needed.
      const perInput = estimateFeeLanoshis(1, OUTPUT_PAIR) - estimateFeeLanoshis(0, OUTPUT_PAIR);
      const topUp = plan.inputCount === undefined ? plan.shortfallLanoshis : plan.shortfallLanoshis + perInput;
      const ask = plan.inputCount === undefined
        ? ''
        : ` To send it, this wallet needs ${lanaText(topUp)} LANA more, in one payment — each payment in is another piece to spend, and costs a little network fee of its own.`;
      return {
        code: 'INSUFFICIENT_FUNDS',
        error: `There is not enough LANA in this wallet: sending ${lanaText(amount)} LANA and the ${lanaText(plan.feeLanoshis)} LANA network fee needs ${lanaText(plan.requiredLanoshis)} LANA, and the wallet holds ${lanaText(plan.availableLanoshis)} LANA — ${lanaText(plan.shortfallLanoshis)} LANA short.${ask} Nothing has moved.`,
      };
    }
  }
}

// ==============================================
// Parse Script from Raw Transaction
// ==============================================

async function parseScriptPubkeyFromRawTx(
  txHash: string,
  outputIndex: number,
  servers: Array<{ host: string; port: number }>
): Promise<Uint8Array> {
  const rawTxHex = await electrumCall('blockchain.transaction.get', [txHash, false], servers);
  const rawTx = hexToUint8Array(rawTxHex);

  let offset = 0;

  // Version (4 bytes)
  offset += 4;

  // nTime (4 bytes) - LanaCoin specific
  offset += 4;

  // Input count (varint)
  const inputCount = rawTx[offset];
  offset += inputCount < 0xfd ? 1 : (inputCount === 0xfd ? 3 : (inputCount === 0xfe ? 5 : 9));
  const actualInputCount = inputCount < 0xfd ? inputCount :
    (inputCount === 0xfd ? (rawTx[offset - 2] | (rawTx[offset - 1] << 8)) : 0);

  // Skip inputs
  for (let i = 0; i < actualInputCount; i++) {
    offset += 32; // prev txid
    offset += 4;  // prev vout
    const scriptLen = rawTx[offset];
    offset += scriptLen < 0xfd ? 1 : (scriptLen === 0xfd ? 3 : (scriptLen === 0xfe ? 5 : 9));
    const actualScriptLen = scriptLen < 0xfd ? scriptLen :
      (scriptLen === 0xfd ? (rawTx[offset - 2] | (rawTx[offset - 1] << 8)) : 0);
    offset += actualScriptLen;
    offset += 4; // sequence
  }

  // Output count (varint)
  const outputCount = rawTx[offset];
  offset += outputCount < 0xfd ? 1 : (outputCount === 0xfd ? 3 : (outputCount === 0xfe ? 5 : 9));
  const actualOutputCount = outputCount < 0xfd ? outputCount :
    (outputCount === 0xfd ? (rawTx[offset - 2] | (rawTx[offset - 1] << 8)) : 0);

  // Find the specific output
  for (let i = 0; i < actualOutputCount; i++) {
    offset += 8; // value (8 bytes)
    const scriptLen = rawTx[offset];
    offset += scriptLen < 0xfd ? 1 : (scriptLen === 0xfd ? 3 : (scriptLen === 0xfe ? 5 : 9));
    const actualScriptLen = scriptLen < 0xfd ? scriptLen :
      (scriptLen === 0xfd ? (rawTx[offset - 2] | (rawTx[offset - 1] << 8)) : 0);

    if (i === outputIndex) {
      return rawTx.slice(offset, offset + actualScriptLen);
    }

    offset += actualScriptLen;
  }

  throw new Error(`Output ${outputIndex} not found in transaction ${txHash}`);
}

// ==============================================
// Build and Sign Transaction
// ==============================================

export interface BuildTxResult {
  txHex: string;
  inputCount: number;
  outputCount: number;
  selectedUTXOs: UTXO[];
}

export async function buildSignedTx(
  selectedUTXOs: UTXO[],
  wifPrivateKey: string,
  recipients: Recipient[],
  fee: number,
  changeAddress: string,
  servers: Array<{ host: string; port: number }>,
  useCompressed?: boolean
): Promise<BuildTxResult> {
  console.log(`[lana-discount] Building transaction with ${selectedUTXOs.length} UTXOs...`);

  try {
    if (!selectedUTXOs || selectedUTXOs.length === 0) throw new Error('No UTXOs provided');
    if (recipients.length === 0) throw new Error('No recipients provided');

    const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0);
    const totalValue = selectedUTXOs.reduce((sum, utxo) => sum + utxo.value, 0);

    // Normalize and decode private key
    const normalizedKey = normalizeWif(wifPrivateKey);
    const privateKeyBytes = base58CheckDecode(normalizedKey);
    const privateKeyHex = uint8ArrayToHex(privateKeyBytes.slice(1, 33));

    const publicKey = useCompressed
      ? privateKeyToPublicKey(privateKeyHex)
      : privateKeyToUncompressedPublicKey(privateKeyHex);

    // Build recipient outputs
    const outputs: Uint8Array[] = [];
    for (const recipient of recipients) {
      const decoded = base58CheckDecode(recipient.address, true);
      if (decoded.length !== 21) {
        throw new Error(`Invalid address "${recipient.address}": decoded payload is ${decoded.length} bytes (expected 21)`);
      }
      const pubKeyHash = decoded.slice(1);

      const scriptPubKey = new Uint8Array([
        0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac
      ]);

      const valueBytes = new Uint8Array(8);
      new DataView(valueBytes.buffer).setBigUint64(0, BigInt(recipient.amount), true);

      outputs.push(new Uint8Array([
        ...valueBytes,
        ...encodeVarint(scriptPubKey.length),
        ...scriptPubKey
      ]));
    }

    // Add change output if needed
    const changeAmount = totalValue - totalAmount - fee;
    let outputCount = recipients.length;

    if (changeAmount > 1000) {
      const decoded = base58CheckDecode(changeAddress, true);
      const pubKeyHash = decoded.slice(1);

      const scriptPubKey = new Uint8Array([
        0x76, 0xa9, 0x14, ...pubKeyHash, 0x88, 0xac
      ]);

      const valueBytes = new Uint8Array(8);
      new DataView(valueBytes.buffer).setBigUint64(0, BigInt(changeAmount), true);

      outputs.push(new Uint8Array([
        ...valueBytes,
        ...encodeVarint(scriptPubKey.length),
        ...scriptPubKey
      ]));
      outputCount++;
      console.log(`[lana-discount] Change output: ${(changeAmount / 100000000).toFixed(8)} LANA`);
    }

    const allOutputs = new Uint8Array(outputs.reduce((t, o) => t + o.length, 0));
    let outOffset = 0;
    for (const output of outputs) {
      allOutputs.set(output, outOffset);
      outOffset += output.length;
    }

    // Transaction components
    const version = littleEndian32(1);
    const nTime = littleEndian32(Math.floor(Date.now() / 1000));
    const locktime = littleEndian32(0);
    const hashType = littleEndian32(1); // SIGHASH_ALL

    // Fetch all scriptPubkeys
    const scriptPubkeys: Uint8Array[] = [];
    for (let i = 0; i < selectedUTXOs.length; i++) {
      const utxo = selectedUTXOs[i];
      console.log(`[lana-discount] Fetching scriptPubKey ${i + 1}/${selectedUTXOs.length}: ${utxo.tx_hash.slice(0, 12)}...`);
      const scriptPubkey = await parseScriptPubkeyFromRawTx(utxo.tx_hash, utxo.tx_pos, servers);
      scriptPubkeys.push(scriptPubkey);
    }

    // Prepare input txid/vout data
    const inputMeta: Array<{ txid: Uint8Array; vout: Uint8Array }> = [];
    for (const utxo of selectedUTXOs) {
      const txidBytes = hexToUint8Array(utxo.tx_hash);
      const txidReversed = new Uint8Array(txidBytes.length);
      for (let i = 0; i < txidBytes.length; i++) {
        txidReversed[i] = txidBytes[txidBytes.length - 1 - i];
      }
      inputMeta.push({
        txid: txidReversed,
        vout: littleEndian32(utxo.tx_pos)
      });
    }

    // Sign each input
    const signedInputs: Uint8Array[] = [];

    for (let currentIndex = 0; currentIndex < selectedUTXOs.length; currentIndex++) {
      // Build ALL inputs for preimage (SIGHASH_ALL)
      const preimageInputs: Uint8Array[] = [];
      for (let j = 0; j < selectedUTXOs.length; j++) {
        const { txid, vout } = inputMeta[j];
        const scriptForJ = (j === currentIndex) ? scriptPubkeys[j] : new Uint8Array(0);

        preimageInputs.push(new Uint8Array([
          ...txid,
          ...vout,
          ...encodeVarint(scriptForJ.length),
          ...scriptForJ,
          0xff, 0xff, 0xff, 0xff // sequence
        ]));
      }

      const allPreimageInputs = preimageInputs.reduce((acc, cur) => {
        const out = new Uint8Array(acc.length + cur.length);
        out.set(acc);
        out.set(cur, acc.length);
        return out;
      }, new Uint8Array(0));

      // Build preimage
      const preimage = new Uint8Array([
        ...version,
        ...nTime,
        ...encodeVarint(selectedUTXOs.length),
        ...allPreimageInputs,
        ...encodeVarint(outputCount),
        ...allOutputs,
        ...locktime,
        ...hashType
      ]);

      const sighash = sha256d(preimage);
      const signature = signECDSA(privateKeyHex, sighash);
      const signatureWithHashType = new Uint8Array([...signature, 0x01]);
      const scriptSig = new Uint8Array([
        ...pushData(signatureWithHashType),
        ...pushData(publicKey)
      ]);

      const { txid, vout } = inputMeta[currentIndex];
      const signedInput = new Uint8Array([
        ...txid,
        ...vout,
        ...encodeVarint(scriptSig.length),
        ...scriptSig,
        0xff, 0xff, 0xff, 0xff
      ]);

      signedInputs.push(signedInput);
    }

    console.log(`[lana-discount] All ${selectedUTXOs.length} inputs signed`);

    // Build final transaction
    const allInputs = new Uint8Array(signedInputs.reduce((t, i) => t + i.length, 0));
    let inputOffset = 0;
    for (const input of signedInputs) {
      allInputs.set(input, inputOffset);
      inputOffset += input.length;
    }

    const finalTx = new Uint8Array([
      ...version,
      ...nTime,
      ...encodeVarint(selectedUTXOs.length),
      ...allInputs,
      ...encodeVarint(outputCount),
      ...allOutputs,
      ...locktime
    ]);

    const finalTxHex = uint8ArrayToHex(finalTx);
    console.log(`[lana-discount] Transaction built: ${finalTxHex.length / 2} bytes, ${selectedUTXOs.length} inputs, ${outputCount} outputs`);

    return {
      txHex: finalTxHex,
      inputCount: selectedUTXOs.length,
      outputCount,
      selectedUTXOs
    };
  } catch (error) {
    console.error('[lana-discount] Transaction building error:', error);
    throw error;
  }
}

// ==============================================
// Main Transaction Function
// ==============================================

export interface SendLanaParams {
  senderAddress: string;
  recipientAddress: string;
  amount?: number;               // In LANA (decimal)
  privateKey: string;            // WIF format
  emptyWallet?: boolean;         // Send all balance
  /**
   * The most this transfer may empty out of the wallet, in lanoshis. Only
   * consulted when emptying: the caller proposes the sweep from whatever
   * balance it could read, and this is where that proposal meets the exact
   * one. Pass `amount` as well and a wallet found to be over the ceiling is
   * sent the agreed amount the ordinary way instead of being refused.
   */
  sweepCeilingLanoshis?: number;
  electrumServers?: Array<{ host: string; port: number }>;
}

export interface SendLanaResult {
  success: boolean;
  txHash?: string;
  amount?: number;               // Total sent in lanoshis
  fee?: number;
  error?: string;
  /** Set on the refusals that are decided here, before anything is signed. */
  code?: string;
  /**
   * False when trying again cannot help: nothing about the wallet, the amount
   * or the fee will be different next time. Absent when unknown — a broadcast
   * that failed once may well go through on the next attempt.
   */
  retryable?: boolean;
  /** The refused plan, for the caller that wants the figures rather than the sentence. */
  detail?: TransferPlanFailure;
  /**
   * WHAT ACTUALLY HAPPENED, not what was asked for. A sweep that met a wallet
   * above its ceiling is sent as an ordinary transfer, so the caller must read
   * this rather than its own request when it records or reports the shape.
   */
  emptyWallet?: boolean;
}

export async function sendLanaTransaction(params: SendLanaParams): Promise<SendLanaResult> {
  const {
    senderAddress: rawSenderAddress,
    recipientAddress: rawRecipientAddress,
    amount,
    privateKey,
    emptyWallet = false,
    sweepCeilingLanoshis,
    electrumServers
  } = params;

  const senderAddress = normalizeAddress(rawSenderAddress || '');
  const recipientAddress = normalizeAddress(rawRecipientAddress || '');

  console.log('[lana-discount] Starting LANA transaction...');
  console.log(`[lana-discount] Sender: ${senderAddress}`);
  console.log(`[lana-discount] Recipient: ${recipientAddress}`);
  console.log(`[lana-discount] Amount: ${amount}`);

  try {
    if (!senderAddress || !recipientAddress || !privateKey) {
      throw new Error('Missing required parameters');
    }

    if (!emptyWallet && !amount) {
      throw new Error('Amount is required when not emptying wallet');
    }

    // Validate private key matches sender address
    const normalizedKey = normalizeWif(privateKey);
    const privateKeyBytes = base58CheckDecode(normalizedKey);
    const privateKeyHex = uint8ArrayToHex(privateKeyBytes.slice(1, 33));
    const generatedPubKey = privateKeyToUncompressedPublicKey(privateKeyHex);
    const expectedAddress = publicKeyToAddress(generatedPubKey);

    let useCompressed = false;

    if (expectedAddress !== senderAddress) {
      const compressedPubKey = privateKeyToPublicKey(privateKeyHex);
      const compressedAddress = publicKeyToAddress(compressedPubKey);

      if (compressedAddress !== senderAddress) {
        throw new Error(
          `Private key does not match sender address. Expected: ${expectedAddress} or ${compressedAddress}, Got: ${senderAddress}`
        );
      }
      useCompressed = true;
      console.log('[lana-discount] Using COMPRESSED public key for this transaction');
    }

    console.log('[lana-discount] Private key validation passed');

    // Use provided Electrum servers or fallback
    const servers = electrumServers && electrumServers.length > 0
      ? electrumServers
      : [
          { host: 'electrum1.lanacoin.com', port: 5097 },
          { host: 'electrum2.lanacoin.com', port: 5097 },
          { host: 'electrum3.lanacoin.com', port: 5097 }
        ];

    // Get UTXOs
    const utxos = await electrumCall('blockchain.address.listunspent', [senderAddress], servers);
    if (!utxos || utxos.length === 0) {
      throw new Error('No UTXOs available');
    }
    console.log(`[lana-discount] Found ${utxos.length} UTXOs`);

    // WHO PAYS THE FEE — planTransfer answers it, on its own, testably.
    // The amount is handed over even when emptying: it is what the plan falls
    // back to if the exact UTXO total turns out to sit above the sweep ceiling.
    const plan = planTransfer({
      utxos,
      amountLanoshis: amount === undefined || amount === null ? undefined : Math.floor(amount * 100000000),
      emptyWallet,
      sweepCeilingLanoshis,
    });

    if (planFailed(plan)) {
      const described = describePlanFailure(plan);
      console.error(`[lana-discount] No transfer plan (${described.code}): ${described.error}`);
      return {
        success: false,
        error: described.error,
        code: described.code,
        // Only where trying again genuinely cannot come out differently — see
        // planFailurePermanent. Stamping every refused plan `false` told the
        // caller to remember a TOO_MANY_UTXOS whose cure is a consolidation.
        retryable: !planFailurePermanent(plan),
        detail: plan,
      };
    }

    const amountSatoshis = plan.amountLanoshis;
    const fee = plan.feeLanoshis;
    const recipients: Recipient[] = [{ address: recipientAddress, amount: amountSatoshis }];
    const selectedUTXOs = plan.selected;

    console.log(`[lana-discount] Final: ${selectedUTXOs.length} UTXOs, total: ${plan.totalSelected}, amount: ${amountSatoshis}, fee: ${fee}, emptying: ${plan.emptyWallet}`);

    // Build and sign transaction
    const { txHex: signedTx } = await buildSignedTx(
      selectedUTXOs,
      privateKey,
      recipients,
      fee,
      senderAddress,
      servers,
      useCompressed
    );
    console.log('[lana-discount] Transaction signed successfully');

    // Broadcast
    console.log('[lana-discount] Broadcasting transaction...');
    const broadcastResult = await electrumCall(
      'blockchain.transaction.broadcast',
      [signedTx],
      servers,
      45000
    );

    if (!broadcastResult) {
      throw new Error('Transaction broadcast failed - no result');
    }

    const resultStr = typeof broadcastResult === 'string' ? broadcastResult : String(broadcastResult);

    if (
      resultStr.includes('TX rejected') ||
      resultStr.includes('error') ||
      resultStr.includes('Error') ||
      resultStr.includes('failed') ||
      resultStr.includes('Failed') ||
      resultStr.includes('-22')
    ) {
      throw new Error(`Transaction broadcast failed: ${resultStr}`);
    }

    const txHash = resultStr.trim();
    if (!/^[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new Error(`Invalid transaction ID format: ${txHash}`);
    }

    console.log('[lana-discount] Transaction broadcast successful:', txHash);

    return {
      success: true,
      txHash,
      amount: amountSatoshis,
      fee,
      emptyWallet: plan.emptyWallet,
    };
  } catch (error) {
    console.error('[lana-discount] Transaction error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
