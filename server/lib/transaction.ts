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

interface UTXO {
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
  electrumServers?: Array<{ host: string; port: number }>;
}

export interface SendLanaResult {
  success: boolean;
  txHash?: string;
  amount?: number;               // Total sent in lanoshis
  fee?: number;
  error?: string;
}

export async function sendLanaTransaction(params: SendLanaParams): Promise<SendLanaResult> {
  const {
    senderAddress: rawSenderAddress,
    recipientAddress: rawRecipientAddress,
    amount,
    privateKey,
    emptyWallet = false,
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

    let amountSatoshis: number;
    let recipients: Recipient[];
    let fee: number;

    if (emptyWallet) {
      const totalBalance = utxos.reduce((sum: number, utxo: UTXO) => sum + utxo.value, 0);

      if (utxos.length > UTXOSelector.MAX_INPUTS) {
        return {
          success: false,
          error: `TOO_MANY_UTXOS: Your wallet has ${utxos.length} UTXOs but the maximum per transaction is ${UTXOSelector.MAX_INPUTS}. Please consolidate your wallet using Registrar before sending.`
        };
      }

      const estimatedInputCount = Math.min(utxos.length, UTXOSelector.MAX_INPUTS);
      const outputCount = 1;
      fee = Math.floor((estimatedInputCount * 180 + outputCount * 34 + 10) * 100 * 1.5);

      amountSatoshis = totalBalance - fee;
      if (amountSatoshis <= 0) {
        throw new Error(`Insufficient funds. Balance: ${totalBalance}, Fee: ${fee}`);
      }

      recipients = [{ address: recipientAddress, amount: amountSatoshis }];
    } else {
      amountSatoshis = Math.floor(amount! * 100000000);
      recipients = [{ address: recipientAddress, amount: amountSatoshis }];
    }

    // UTXO selection with iterative fee recalculation
    const totalAmountSatoshis = recipients.reduce((sum, r) => sum + r.amount, 0);
    const actualOutputCount = emptyWallet ? recipients.length : recipients.length + 1;

    let selection = UTXOSelector.selectUTXOs(utxos, totalAmountSatoshis);
    let selectedUTXOs = selection.selected;
    let totalSelected = selection.totalValue;

    let baseFee = (selectedUTXOs.length * 180 + actualOutputCount * 34 + 10) * 100;
    fee = Math.floor(baseFee * 1.5);

    let iterations = 0;
    while (totalSelected < totalAmountSatoshis + fee && selectedUTXOs.length < utxos.length && iterations < 10) {
      iterations++;
      selection = UTXOSelector.selectUTXOs(utxos, totalAmountSatoshis + fee);
      selectedUTXOs = selection.selected;
      totalSelected = selection.totalValue;
      baseFee = (selectedUTXOs.length * 180 + actualOutputCount * 34 + 10) * 100;
      fee = Math.floor(baseFee * 1.5);
    }

    if (totalSelected < totalAmountSatoshis + fee) {
      const totalBalance = utxos.reduce((sum: number, utxo: UTXO) => sum + utxo.value, 0);
      if (totalBalance >= totalAmountSatoshis + fee && utxos.length > UTXOSelector.MAX_INPUTS) {
        return {
          success: false,
          error: `TOO_MANY_UTXOS: Your wallet has ${utxos.length} UTXOs but the maximum per transaction is ${UTXOSelector.MAX_INPUTS}. Please consolidate your wallet using Registrar before sending.`
        };
      }
      throw new Error(`Insufficient funds: need ${totalAmountSatoshis + fee} lanoshis, have ${totalSelected}`);
    }

    console.log(`[lana-discount] Final: ${selectedUTXOs.length} UTXOs, total: ${totalSelected}, amount: ${totalAmountSatoshis}, fee: ${fee}`);

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
      fee
    };
  } catch (error) {
    console.error('[lana-discount] Transaction error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
