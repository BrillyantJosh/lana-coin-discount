// @vitest-environment node
/**
 * address.ts: real LANA addresses, both key forms, and every near miss refused.
 *
 * The hash functions are checked against node:crypto, an implementation that
 * shares no code with @noble/hashes, and the addresses against wallets that
 * really sent the mainnet fixture transactions.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import { hash160, sha256d } from './bytes.ts';
import {
  addressOfPublicKey,
  addressOfScript,
  addressToHash160,
  base58CheckDecode,
  base58CheckEncode,
  base58Decode,
  base58Encode,
  hash160ToAddress,
  isLanaAddress,
  LANA_ADDRESS_VERSION,
  p2pkhHash160,
  p2pkhScriptHex,
  scriptOfAddress,
} from './address.ts';
import { decodeTx, parseP2pkhScriptSig } from './codec.ts';

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};

/** The card.lanapays.us provider address, as lana-cards server/lib/lanaTx.test.ts pins it. */
const PROVIDER = 'Lb4ERRRk6pRPYHaPEFWCw1gzgMbCyapmVk';
const PROVIDER_HASH160 = 'adab57725ac3652a4aaf779c79ff2e1e1814ca76';

const nodeHash160 = (b: Uint8Array) =>
  crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(b).digest()).digest('hex');

describe('hashes', () => {
  it('sha256d and hash160 agree with node:crypto', () => {
    for (const len of [0, 1, 33, 65, 200]) {
      const b = crypto.randomBytes(len);
      const once = crypto.createHash('sha256').update(b).digest();
      assert.equal(Buffer.from(sha256d(b)).toString('hex'), crypto.createHash('sha256').update(once).digest('hex'));
      assert.equal(Buffer.from(hash160(b)).toString('hex'), nodeHash160(b));
    }
  });
});

describe('base58', () => {
  // Bitcoin Core's base58_encode_decode.json vectors.
  const vectors: [string, string][] = [
    ['', ''],
    ['61', '2g'],
    ['626262', 'a3gV'],
    ['636363', 'aPEr'],
    ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
    ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ['516b6fcd0f', 'ABnLTmg'],
    ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
    ['572e4794', '3EFU7m'],
    ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
    ['10c8511e', 'Rt5zm'],
    ['00000000000000000000', '1111111111'],
  ];
  it('encodes and decodes the reference vectors', () => {
    for (const [hex, b58] of vectors) {
      assert.equal(base58Encode(Buffer.from(hex, 'hex')), b58, hex);
      assert.equal(Buffer.from(base58Decode(b58)!).toString('hex'), hex, b58);
    }
  });

  it('refuses characters outside the alphabet (0, O, I, l, space) and absurd lengths', () => {
    for (const s of ['0', 'O', 'I', 'l', ' 2g', '2g ', '+']) assert.equal(base58Decode(s), null, JSON.stringify(s));
    assert.equal(base58Decode('2'.repeat(65)), null);
  });

  it('base58check refuses a wrong checksum', () => {
    const payload = Uint8Array.of(LANA_ADDRESS_VERSION, ...new Uint8Array(20).fill(9));
    const s = base58CheckEncode(payload);
    assert.deepEqual(base58CheckDecode(s), payload);
    const flipped = s.slice(0, -1) + (s.endsWith('2') ? '3' : '2');
    assert.equal(base58CheckDecode(flipped), null);
  });
});

describe('LANA addresses', () => {
  it('decode a real address to the hash160 the chain pays, and back', () => {
    assert.equal(addressToHash160(PROVIDER), PROVIDER_HASH160);
    assert.equal(hash160ToAddress(PROVIDER_HASH160), PROVIDER);
    assert.equal(scriptOfAddress(PROVIDER), `76a914${PROVIDER_HASH160}88ac`);
    assert.equal(addressOfScript(`76a914${PROVIDER_HASH160}88ac`), PROVIDER);
    assert.ok(isLanaAddress(PROVIDER));
  });

  it('the payment output on the chain is the script of that address', () => {
    const lc = mainnet.cases.find((c) => c.name === 'lc-card-payment')!;
    assert.equal(decodeTx(mainnet.transactions[lc.txid]).outputs[0].scriptPubKeyHex, scriptOfAddress(PROVIDER));
  });

  it('every sending wallet’s address is the hash of the key its inputs reveal, in that key’s form', () => {
    for (const c of mainnet.cases) {
      const tx = decodeTx(mainnet.transactions[c.txid]);
      const sig = parseP2pkhScriptSig(tx.inputs[0].scriptSigHex)!;
      assert.equal(addressOfPublicKey(sig.publicKey), c.from, c.name);
      assert.equal(hash160ToAddress(nodeHash160(sig.publicKey)), c.from, `${c.name}, hashed by node:crypto`);
      // and the change went back to that very wallet
      assert.equal(addressOfScript(tx.outputs[tx.outputs.length - 1].scriptPubKeyHex), c.from, c.name);
    }
  });

  it('one key gives two different addresses, compressed and uncompressed; neither is the other', () => {
    const secret = secp.utils.randomSecretKey(); // throwaway
    const compressed = addressOfPublicKey(secp.getPublicKey(secret, true));
    const uncompressed = addressOfPublicKey(secp.getPublicKey(secret, false));
    assert.ok(isLanaAddress(compressed) && isLanaAddress(uncompressed));
    assert.notEqual(compressed, uncompressed);
    assert.ok(compressed.startsWith('L') && uncompressed.startsWith('L'));
  });

  it('refuses a public key in neither form', () => {
    const pub = secp.getPublicKey(secp.utils.randomSecretKey(), true);
    assert.throws(() => addressOfPublicKey(pub.subarray(0, 32)));
    assert.throws(() => addressOfPublicKey(Uint8Array.of(0x06, ...pub.subarray(1))));
  });
});

describe('near misses are not addresses', () => {
  it('a mistyped character', () => {
    const typo = PROVIDER.slice(0, -1) + (PROVIDER.endsWith('k') ? 'm' : 'k');
    assert.equal(addressToHash160(typo), null);
    // Two neighbouring characters transposed (they must differ, or nothing changed).
    const i = 7;
    assert.notEqual(PROVIDER[i], PROVIDER[i + 1]);
    const swapped = PROVIDER.slice(0, i) + PROVIDER[i + 1] + PROVIDER[i] + PROVIDER.slice(i + 2);
    assert.equal(addressToHash160(swapped), null);
  });

  it('a valid base58check string with a foreign version byte (a Bitcoin address)', () => {
    const btc = base58CheckEncode(Uint8Array.of(0x00, ...Buffer.from(PROVIDER_HASH160, 'hex')));
    assert.ok(btc.startsWith('1'));
    assert.ok(base58CheckDecode(btc));
    assert.equal(addressToHash160(btc), null);
  });

  it('a non-canonical spelling: an extra leading 1 is an extra zero byte', () => {
    assert.equal(addressToHash160('1' + PROVIDER), null);
  });

  it('the wrong payload length, with a valid checksum', () => {
    const h = Buffer.from(PROVIDER_HASH160, 'hex');
    assert.equal(addressToHash160(base58CheckEncode(Uint8Array.of(LANA_ADDRESS_VERSION, ...h.subarray(0, 19)))), null);
    assert.equal(addressToHash160(base58CheckEncode(Uint8Array.of(LANA_ADDRESS_VERSION, ...h, 0))), null);
  });

  it('whitespace, other types, empty', () => {
    for (const bad of [` ${PROVIDER}`, `${PROVIDER}\n`, '', null, undefined, 42, {}, [PROVIDER]]) {
      assert.equal(addressToHash160(bad), null, JSON.stringify(bad));
      assert.equal(isLanaAddress(bad), false);
    }
  });
});

describe('P2PKH scripts', () => {
  it('only OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG is a P2PKH script', () => {
    assert.equal(p2pkhHash160(p2pkhScriptHex(PROVIDER_HASH160)), PROVIDER_HASH160);
    assert.equal(p2pkhHash160(`a914${PROVIDER_HASH160}87`), null, 'P2SH');
    assert.equal(p2pkhHash160(`21${'02'.repeat(33)}ac`), null, 'P2PK');
    assert.equal(p2pkhHash160(`76a914${PROVIDER_HASH160}88ac00`), null, 'trailing byte');
    assert.equal(p2pkhHash160(''), null);
    assert.equal(addressOfScript('6a'), null, 'OP_RETURN pays no address');
    assert.throws(() => p2pkhScriptHex(PROVIDER_HASH160.toUpperCase()));
    assert.throws(() => scriptOfAddress('not an address'));
  });
});
