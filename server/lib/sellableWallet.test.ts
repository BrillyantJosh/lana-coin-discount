// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isSellableWalletType } from './sellableWallet.js';

describe('which wallet types may be offered', () => {
  it('admits the three the owner named', () => {
    expect(isSellableWalletType('Main Wallet')).toBe(true);
    expect(isSellableWalletType('Wallet')).toBe(true);
    expect(isSellableWalletType('LanaPays.Us')).toBe(true);
  });
  it('admits LanaPays sub-types by prefix', () => {
    expect(isSellableWalletType('LanaPays.Us Investors')).toBe(true);
    expect(isSellableWalletType('lanapays.us admin')).toBe(true);
  });
  it('refuses Retail — the type that reached the offer page', () => {
    expect(isSellableWalletType('Retail')).toBe(false);
  });
  it('refuses the types the old blocklist named, and the ones it never knew about', () => {
    for (const t of ['Lana8Wonder', 'Knights', 'Savings', 'Spending', 'Something New']) {
      expect(isSellableWalletType(t), t).toBe(false);
    }
  });
  it('refuses an absent or blank type rather than admitting it', () => {
    expect(isSellableWalletType(null)).toBe(false);
    expect(isSellableWalletType(undefined)).toBe(false);
    expect(isSellableWalletType('   ')).toBe(false);
  });
  it('ignores casing and stray spacing, as relay tags carry both', () => {
    expect(isSellableWalletType('  MAIN WALLET ')).toBe(true);
    expect(isSellableWalletType('wallet')).toBe(true);
  });
});
