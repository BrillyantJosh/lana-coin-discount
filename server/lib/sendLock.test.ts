// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { tryAcquireSendLock, releaseSendLock, sendLockHolder } from './sendLock.js';

beforeEach(() => { releaseSendLock('auto-send'); releaseSendLock('manual-batch'); });

describe('one LANA broadcast at a time', () => {
  it('the second sender is refused while the first holds the lock', () => {
    expect(tryAcquireSendLock('auto-send')).toBe(true);
    expect(tryAcquireSendLock('manual-batch')).toBe(false);
    expect(sendLockHolder()?.who).toBe('auto-send');
  });
  it('release by the holder frees it; release by anyone else is a no-op', () => {
    tryAcquireSendLock('auto-send');
    releaseSendLock('manual-batch');
    expect(sendLockHolder()?.who).toBe('auto-send');
    releaseSendLock('auto-send');
    expect(sendLockHolder()).toBeNull();
    expect(tryAcquireSendLock('manual-batch')).toBe(true);
  });
});
