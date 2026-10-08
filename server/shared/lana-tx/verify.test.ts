// @vitest-environment node
/**
 * verify.ts: a finished transaction is signed by the wallet's key, judged from
 * its bytes alone — the check the server runs on every payout the admin's
 * browser announces, and the browser runs on its own before it announces.
 *
 * Real mainnet signatures pass it (the five fixture cases, 38 inputs). The
 * archived km-signer's tests of it came along (each signature covers every input
 * and every output). Throwaway keys sign the rest; nothing is broadcast and
 * nothing opens a connection.
 */
import { describe, it, vi } from 'vitest';
// node:test, which these tests were written for, sets no time limit; vitest's 5 s is too short for the walks over
// thousands of cases while the whole suite runs at once.
vi.setConfig({ testTimeout: 120_000 });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as secp from '@noble/secp256k1';
import elliptic from 'elliptic';
import { bytesToHex } from './bytes.ts';
import { decodeTx, encodeTxHex, p2pkhScriptSigHex, parseP2pkhScriptSig } from './codec.ts';
import { sighash } from './sighash.ts';
import { encodeDER, signLanaSighash } from './signature.ts';
import { prevoutFromRawTx } from './shape.ts';
import { verifyTxSignatures, verifyTxSignedBy } from './verify.ts';
import { signedPayout, throwawayWallet } from './fixtures/wallets.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ec = new elliptic.ec('secp256k1');

const mainnet = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-txs.json', import.meta.url), 'utf8')) as {
  cases: { name: string; txid: string; from: string }[];
  transactions: Record<string, string>;
};
const prevoutsOf = (raw: string) => decodeTx(raw).inputs.map((i) => prevoutFromRawTx(mainnet.transactions[i.prevTxid], i.prevTxid, i.vout));

/** r and s of a strict DER signature. */
function rs(der: Uint8Array): { r: bigint; s: bigint } {
  const lenR = der[3];
  return { r: BigInt('0x' + bytesToHex(der.subarray(4, 4 + lenR))), s: BigInt('0x' + bytesToHex(der.subarray(6 + lenR))) };
}

describe('verifyTxSignatures() and verifyTxSignedBy()', () => {
  it('take the curve order from noble, and it is the published secp256k1 order', () => {
    assert.equal(secp.Point.CURVE().n, N);
    assert.equal(BigInt(`0x${ec.n!.toString(16)}`), N, 'elliptic agrees');
  });

  it('every mainnet case is signed by the wallet it spends from: 38 inputs, by noble and by elliptic', () => {
    let inputs = 0;
    for (const c of mainnet.cases) {
      const raw = mainnet.transactions[c.txid];
      assert.deepEqual(verifyTxSignedBy(raw, prevoutsOf(raw), c.from), [], c.name);
      inputs += decodeTx(raw).inputs.length;
    }
    assert.equal(inputs, 38);
  });

  it('a signed payout verifies, by the payout wallet’s address and by its public key, in both key forms', async () => {
    for (const compressed of [true, false]) {
      const p = await signedPayout({ compressed });
      assert.equal(decodeTx(p.signed.rawTx).inputs.length, 2);
      assert.deepEqual(verifyTxSignedBy(p.signed.rawTx, p.plan.coins, p.wallet.address), []);
      assert.deepEqual(verifyTxSignatures(p.signed.rawTx, p.plan.coins, bytesToHex(p.wallet.publicKey)), []);
    }
  });

  it('each signature commits to EVERY input and output: changing input 1 breaks input 0; one lanoshi more to a buyer breaks both', async () => {
    const p = await signedPayout();
    const tx = decodeTx(p.signed.rawTx);
    const changed = { ...tx, inputs: tx.inputs.map((x, i) => (i === 1 ? { ...x, sequence: 0xfffffffe } : x)) };
    const problems = verifyTxSignedBy(encodeTxHex(changed), p.plan.coins, p.wallet.address);
    assert.ok(problems.some((x) => x.startsWith('input 0:')), problems.join('; '));
    const paidMore = { ...tx, outputs: tx.outputs.map((o, i) => (i === 0 ? { ...o, value: o.value + 1n } : o)) };
    const more = verifyTxSignedBy(encodeTxHex(paidMore), p.plan.coins, p.wallet.address);
    assert.ok(more.some((x) => x.startsWith('input 0:')) && more.some((x) => x.startsWith('input 1:')), more.join('; '));
    // A change sent elsewhere, the same: the signatures cover the change output too.
    const redirected = { ...tx, outputs: tx.outputs.map((o, i) => (i === tx.outputs.length - 1 ? { ...o, scriptPubKeyHex: `76a914${bytesToHex(new Uint8Array(20).fill(7))}88ac` } : o)) };
    assert.ok(verifyTxSignedBy(encodeTxHex(redirected), p.plan.coins, p.wallet.address).length >= 2);
  });

  it('another wallet is refused at the first input, and so is the same secret in its other key form', async () => {
    const p = await signedPayout();
    const other = throwawayWallet();
    assert.deepEqual(verifyTxSignedBy(p.signed.rawTx, p.plan.coins, other.address), [`input 0: the key is not the key of ${other.address}`]);
    const sameSecretUncompressed = throwawayWallet(false, p.wallet.privateKey);
    assert.notEqual(sameSecretUncompressed.address, p.wallet.address);
    assert.equal(verifyTxSignedBy(p.signed.rawTx, p.plan.coins, sameSecretUncompressed.address).length, 1);
    assert.ok(verifyTxSignatures(p.signed.rawTx, p.plan.coins, bytesToHex(sameSecretUncompressed.publicKey)).some((x) => /not the wallet's public key/.test(x)));
  });

  it('a high-S twin of a valid signature is refused, as the network refuses it', async () => {
    const p = await signedPayout();
    const tx = decodeTx(p.signed.rawTx);
    const sig = parseP2pkhScriptSig(tx.inputs[0].scriptSigHex)!;
    const { r, s } = rs(sig.signatureDer);
    const twin = { ...tx, inputs: tx.inputs.map((x, i) => (i === 0 ? { ...x, scriptSigHex: p2pkhScriptSigHex(encodeDER(r, N - s), sig.publicKey) } : x)) };
    const problems = verifyTxSignedBy(encodeTxHex(twin), p.plan.coins, p.wallet.address);
    assert.ok(problems.includes('input 0: high S'), problems.join('; '));
    assert.ok(problems.includes('input 0: noble refuses the signature'), problems.join('; '));
    assert.ok(!problems.some((x) => x.startsWith('input 1:')), 'input 1 is untouched');
  });

  it('a signature by another key, next to the payout wallet’s public key, is refused by both libraries', async () => {
    const p = await signedPayout();
    const tx = decodeTx(p.signed.rawTx);
    const other = throwawayWallet();
    const digest = sighash(tx, 0, p.plan.coins[0].scriptPubKeyHex);
    const forged = await signLanaSighash(bytesToHex(other.privateKey), digest, other.publicKey);
    const bad = { ...tx, inputs: tx.inputs.map((x, i) => (i === 0 ? { ...x, scriptSigHex: p2pkhScriptSigHex(forged, p.wallet.publicKey) } : x)) };
    const problems = verifyTxSignedBy(encodeTxHex(bad), p.plan.coins, p.wallet.address);
    assert.deepEqual(problems, ['input 0: noble refuses the signature', 'input 0: elliptic refuses the signature']);
  });

  it('capitals, garbage, an unsigned transaction and a missing prevout are refused, never thrown', async () => {
    const p = await signedPayout();
    assert.deepEqual(verifyTxSignedBy(p.signed.rawTx.toUpperCase(), p.plan.coins, p.wallet.address), ['does not re-encode to the same bytes']);
    assert.match(verifyTxSignedBy('zz', p.plan.coins, p.wallet.address)[0], /^does not decode/);
    assert.match(verifyTxSignatures('', p.plan.coins, bytesToHex(p.wallet.publicKey))[0], /^does not decode/);
    assert.deepEqual(verifyTxSignatures(p.signed.rawTx, p.plan.coins.slice(1), bytesToHex(p.wallet.publicKey)), ['one prevout per input is required']);
    const tx = decodeTx(p.signed.rawTx);
    const unsigned = encodeTxHex({ ...tx, inputs: tx.inputs.map((x) => ({ ...x, scriptSigHex: '' })) });
    assert.deepEqual(verifyTxSignedBy(unsigned, p.plan.coins, p.wallet.address), ['input 0: not <strict DER> <public key>']);
  });
});
