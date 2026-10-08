// @vitest-environment node
/**
 * lanaAddress.ts (Krog Menjave's, copied 8. 10. 2026) reads an address exactly as
 * server/shared/lana-tx/address.ts does — the module the signer and the checker
 * use — so the wallet chainPayment.ts asks Electrum about is the one the send
 * pays. Two implementations that share no code, held against each other on
 * fresh keys in both forms and on every one-character typo.
 */
import { describe, it, expect } from 'vitest';
import { addressesForSigner, lanaAddressHash160, lanaAddressOf, readLanaAddress } from './lanaAddress.ts';
import { addressOfPublicKey, addressToHash160, isLanaAddress } from '../../shared/lana-tx/address.ts';
import { throwawayWallet } from '../../shared/lana-tx/fixtures/wallets.ts';
import { bytesToHex } from '../../shared/lana-tx/bytes.ts';

describe('lanaAddress.ts and shared/lana-tx/address.ts agree', () => {
  it('on the address of a key, in both forms, and its hash160', () => {
    for (let i = 0; i < 20; i++) {
      for (const compressed of [true, false]) {
        const w = throwawayWallet(compressed);
        expect(lanaAddressOf(w.publicKey)).toBe(addressOfPublicKey(w.publicKey));
        expect(readLanaAddress(w.address)).toBe(w.address);
        expect(lanaAddressHash160(w.address)).toBe(addressToHash160(w.address));
      }
    }
  });

  it('on every one-character change of an address: both refuse it, or both read the same new address', () => {
    const address = throwawayWallet().address;
    for (let i = 0; i < address.length; i++) {
      for (const ch of ['1', 'z', 'L', 'o']) {
        const changed = address.slice(0, i) + ch + address.slice(i + 1);
        if (changed === address) continue;
        expect(readLanaAddress(changed) !== null).toBe(isLanaAddress(changed));
      }
    }
    for (const bad of ['', ' ' + address, address + ' ', address.toLowerCase(), '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', null, 42]) {
      expect(readLanaAddress(bad)).toBeNull();
      expect(isLanaAddress(bad)).toBe(false);
    }
  });

  it('addressesForSigner: both addresses of the signer’s own key, nothing for another', () => {
    const w = throwawayWallet(true);
    const hex = bytesToHex(w.publicKey);
    const both = addressesForSigner(hex, hex.slice(2));
    expect(both?.compressed).toBe(w.address);
    expect(both?.uncompressed).toBe(throwawayWallet(false, w.privateKey).address);
    expect(addressesForSigner(hex, bytesToHex(throwawayWallet().publicKey).slice(2))).toBeNull();
    expect(addressesForSigner('04' + hex.slice(2), hex.slice(2))).toBeNull();
  });
});
