import * as secp from '@noble/secp256k1';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from 'bech32';

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function sha256Hex(hex: string): string {
  return bytesToHex(nobleSha256(hexToBytes(hex)));
}

function sha256d(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

function ripemd160Hex(hex: string): string {
  return bytesToHex(nobleRipemd160(hexToBytes(hex)));
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt('0x' + bytesToHex(bytes));
  let encoded = "";
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = alphabet[Number(remainder)] + encoded;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  return encoded;
}

function base58Decode(encoded: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const char of encoded) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid Base58 character');
    num = num * 58n + BigInt(index);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = hexToBytes(hex);
  for (const char of encoded) {
    if (char !== '1') break;
    bytes = new Uint8Array([0, ...bytes]);
  }
  return bytes;
}

function normalizeWif(wif: string): string {
  return wif.replace(/[\s\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
}

function wifToPrivateKey(wif: string): { privateKeyHex: string; isCompressed: boolean } {
  const normalizedWif = normalizeWif(wif);
  const decoded = base58Decode(normalizedWif);
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expectedChecksum = sha256d(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) throw new Error('Invalid WIF checksum');
  }
  if (payload[0] !== 0xb0 && payload[0] !== 0x41) throw new Error('Invalid WIF prefix');
  const isCompressed = payload.length === 34 && payload[33] === 0x01;
  const privateKey = payload.slice(1, 33);
  return { privateKeyHex: bytesToHex(privateKey), isCompressed };
}

export function generatePublicKey(privateKeyHex: string): string {
  const pubBytes = secp.getPublicKey(hexToBytes(privateKeyHex), false); // uncompressed (65 bytes)
  return bytesToHex(pubBytes);
}

export function generateCompressedPublicKey(privateKeyHex: string): string {
  const pubBytes = secp.getPublicKey(hexToBytes(privateKeyHex), true); // compressed (33 bytes)
  return bytesToHex(pubBytes);
}

export function deriveNostrPublicKey(privateKeyHex: string): string {
  const pubBytes = secp.getPublicKey(hexToBytes(privateKeyHex), true); // compressed
  return bytesToHex(pubBytes.slice(1)); // x-only (remove prefix byte)
}

export function generateLanaAddress(publicKeyHex: string): string {
  const sha256Hash = sha256Hex(publicKeyHex);
  const hash160 = ripemd160Hex(sha256Hash);
  const versionedPayload = "30" + hash160;
  const checksum = sha256Hex(sha256Hex(versionedPayload));
  const finalPayload = versionedPayload + checksum.substring(0, 8);
  return base58Encode(hexToBytes(finalPayload));
}

export function hexToNpub(hexPubKey: string): string {
  const data = hexToBytes(hexPubKey);
  const words = bech32.toWords(data);
  return bech32.encode('npub', words);
}

export function convertWifToIds(wif: string) {
  const { privateKeyHex, isCompressed } = wifToPrivateKey(wif);
  const uncompressedPublicKeyHex = generatePublicKey(privateKeyHex);
  const compressedPublicKeyHex = generateCompressedPublicKey(privateKeyHex);
  const nostrHexId = deriveNostrPublicKey(privateKeyHex);
  const walletIdCompressed = generateLanaAddress(compressedPublicKeyHex);
  const walletIdUncompressed = generateLanaAddress(uncompressedPublicKeyHex);
  const nostrNpubId = hexToNpub(nostrHexId);
  const walletId = isCompressed ? walletIdCompressed : walletIdUncompressed;

  return {
    lanaPrivateKey: wif,
    walletId,
    walletIdCompressed,
    walletIdUncompressed,
    isCompressed,
    nostrHexId,
    nostrNpubId,
    nostrPrivateKey: privateKeyHex,
  };
}
