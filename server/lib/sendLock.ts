/**
 * One LANA broadcast at a time, across the two senders.
 *
 * The auto-sender and the admin's manual batch both read status='pending',
 * both wait on Electrum for seconds, both broadcast, and both then write
 * status='sent'. Without a shared lock the same orders can be paid twice: the
 * second broadcast only fails when both happen to pick the same input, and
 * the auto-sender's blacklist makes it pick different inputs precisely after a
 * rejection. Both senders run in this one process, so a process-local lock is
 * the whole story.
 */
let holder: string | null = null;
let since = 0;

export function tryAcquireSendLock(who: string): boolean {
  if (holder) return false;
  holder = who; since = Date.now();
  return true;
}

export function releaseSendLock(who: string): void {
  if (holder === who) { holder = null; since = 0; }
}

export function sendLockHolder(): { who: string; heldForMs: number } | null {
  return holder ? { who: holder, heldForMs: Date.now() - since } : null;
}
