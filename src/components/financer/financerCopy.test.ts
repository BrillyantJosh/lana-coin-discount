// @vitest-environment node
/**
 * /financer SPEAKS BOTH LANGUAGES, THE SAME THINGS.
 *
 * The page's words are src/copy.ts FINANCER (English) and FINANCER_SL. The
 * type makes the Slovenian carry every key; this holds what the type cannot:
 *   - every {placeholder} of a sentence is in its translation too — a lost
 *     {amount} would show a financer how much is missing in one language and
 *     not in the other;
 *   - nothing was left untranslated (copied English);
 *   - the codes the server answers are all worded (a code the page does not
 *     know is shown raw, which is a sentence nobody wrote).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINANCER, FINANCER_SL, FINANCER_TEXT } from '@/copy';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Tree = { [k: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** The same word in both languages, on purpose. */
const SAME_IN_BOTH = new Set(['navLink']);

describe('the financer page in Slovenian and English', () => {
  const en = leaves(FINANCER as unknown as Tree);
  const sl = leaves(FINANCER_SL as unknown as Tree);

  it('has every sentence in both, and the toggle reaches both', () => {
    expect([...sl.keys()].sort()).toEqual([...en.keys()].sort());
    expect(FINANCER_TEXT.en).toBe(FINANCER);
    expect(FINANCER_TEXT.sl).toBe(FINANCER_SL);
    expect(en.size).toBeGreaterThan(100);
  });

  it('keeps every placeholder in the translation', () => {
    const lost: string[] = [];
    for (const [key, text] of en) {
      if (placeholders(text).join() !== placeholders(sl.get(key) ?? '').join()) lost.push(key);
    }
    expect(lost).toEqual([]);
  });

  it('leaves nothing in English on the Slovenian page', () => {
    const untranslated = [...en].filter(([key, text]) => !SAME_IN_BOTH.has(key) && sl.get(key) === text).map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('words every refusal the confirm and the send routes answer — read from the server, so a new code fails here', () => {
    const server = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
    const confirm = server('server/lib/financer/confirm.ts');
    const union = confirm.slice(confirm.indexOf('export type ConfirmCode'), confirm.indexOf(';', confirm.indexOf('export type ConfirmCode')));
    const confirmCodes = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const sendsCodes = [...server('server/lib/financer/sends.ts').matchAll(/refusal\(\s*[^,]+,\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    const routeCodes = [...server('server/routes/financer.ts').matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(confirmCodes.length).toBeGreaterThan(10);
    expect(sendsCodes.length + routeCodes.length).toBeGreaterThan(15);
    // The treasury's own refusals (recordTreasurySend) never reach a financer; a 500 on announce is "in doubt", worded as such.
    const notTheirs = new Set(['NO_LEGS', 'COIN_IN_FLIGHT', 'ANNOUNCE_FAILED', 'EMPTY_BATCH_REFS', 'TOO_MANY_BATCHES']);
    // A send's refusal is worded from sendCodes ONLY (src/pages/Financer.tsx sendRefusal): a send code worded only
    // among the confirm codes was shown as "Refused (OWNER_MISMATCH)." The routes answer both kinds.
    const unworded = [
      ...confirmCodes.filter((c) => !(c in FINANCER.confirmCodes)),
      ...sendsCodes.filter((c) => !notTheirs.has(c) && !(c in FINANCER.sendCodes)),
      ...routeCodes.filter((c) => !notTheirs.has(c) && !(c in FINANCER.sendCodes) && !(c in FINANCER.confirmCodes)),
    ];
    expect([...new Set(unworded)]).toEqual([]);
  });

  it('the page fills every placeholder of a refusal: a send refusal names only what the page knows', () => {
    // src/pages/Financer.tsx sendRefusal fills {wallet} (from the refusal), {max} (limits.maxLegs), {button} and
    // {currency} (the refusal's — NO_WALLET names the currency without a wallet — or the part's own).
    const filled = new Set(['wallet', 'max', 'button', 'code', 'currency']);
    for (const tree of [FINANCER, FINANCER_SL]) {
      const unknown = Object.entries(tree.sendCodes).filter(([, text]) => placeholders(text).some((p) => !filled.has(p)));
      expect(unknown.map(([code]) => code)).toEqual([]);
      expect(Object.values(tree.confirmCodes).filter((text) => placeholders(text).some((p) => p !== 'code'))).toEqual([]);
    }
  });

  it('the Slovenian administrator is never "skrbnik" — that word is the caretaker, paid by these very sends', () => {
    const wrong = [...en].filter(([key, text]) => /administrator/i.test(text) && /skrbnik/i.test(sl.get(key) ?? '')).map(([key]) => key);
    expect(wrong).toEqual([]);
    for (const [key, text] of en) if (/administrator/i.test(text)) expect(sl.get(key), key).toMatch(/administrator/i);
    expect(FINANCER_SL.legTypes.caretaker_commission).toBe('Skrbnik');
  });

  it('a payment waiting for a block never reads as LANA that go by themselves: the button turns on while the page is open, the financer prepares and signs (review N14)', () => {
    for (const tt of [FINANCER, FINANCER_SL]) expect(tt.sendCodes.WALLET_UNCONFIRMED).toContain(`»${tt.prepare}«`);
    expect(FINANCER.sendCodes.WALLET_UNCONFIRMED).toMatch(/turns on by itself \(this page checks every half minute while it is open\); you then prepare and sign the send/);
    expect(FINANCER.sendCodes.WALLET_UNCONFIRMED).not.toMatch(/sending opens by itself/);
    expect(FINANCER_SL.sendCodes.WALLET_UNCONFIRMED).toMatch(/vklopi sam \(stran preveri vsake pol minute, dokler je odprta\); pošiljanje nato pripravite in podpišete vi/);
    expect(FINANCER_SL.sendCodes.WALLET_UNCONFIRMED).not.toMatch(/pošiljanje mogoče samo od sebe/);
  });

  it('»Confirm again« says why in one sentence, naming the button as it is written (review N7/N9)', () => {
    for (const tt of [FINANCER, FINANCER_SL]) {
      for (const key of ['againUnclaimed', 'againResend'] as const) expect(placeholders(tt[key])).toEqual(['button']);
      expect(placeholders(tt.unclaimed)).toEqual(['count', 'refs']);
    }
    expect(FINANCER.confirmAgain).toBe('Confirm again');
    expect(FINANCER_SL.confirmAgain).toBe('Potrdi znova');
  });

  it('the words stay a business reader’s: no outpoint, UTXO or must-spend in either language', () => {
    for (const [key, text] of en) expect(text, key).not.toMatch(/utxo|outpoint|must-spend/i);
    for (const [key, text] of sl) expect(text, key).not.toMatch(/utxo|outpoint|must[- ]?spend|mempool/i);
  });

  it('no sentence tells the financer to send their wallet’s LANA to its own address or to merge it themselves (review M6)', () => {
    // A desktop wallet holding other addresses spends from any of them and sends its change elsewhere: a self-send could
    // pay the Lana.Discount wallet from an unregistered one (which freezes it) and lose LANA to a change address.
    for (const [key, text] of en) expect(text, key).not.toMatch(/own address|wallet app|merge (your|the|this) wallet|merge it/i);
    for (const [key, text] of sl) expect(text, key).not.toMatch(/lastni naslov|denarnišk\w* aplikacij|združ/i);
    expect(FINANCER.mergeHow).toMatch(/one or a few larger payments, not in many small ones.*administrator/);
    expect(FINANCER_SL.mergeHow).toMatch(/v enem ali nekaj večjih plačilih, ne v veliko majhnih.*administratorja Lana\.Discount/);
  });

  it('a coin is said in plain words wherever it is named: the separate payments the wallet received (review M10)', () => {
    for (const [key, text] of sl) if (/kovan/i.test(text)) expect(text, key).toMatch(/plačil/);
    for (const [key, text] of en) if (/\bcoins?\b/i.test(text)) expect(text, key).toMatch(/payments?\b/);
    // What to move in, said as a business reader acts on it.
    expect(FINANCER_SL.shortfallHint).toContain('v enem ali nekaj večjih plačilih (ne v veliko majhnih)');
    expect(FINANCER.shortfallHint).toContain('in one or a few larger payments (not in many small ones)');
    expect(FINANCER_SL.planProblem.INSUFFICIENT_MERGE).toContain('(ločenih plačilih, ki jih je denarnica prejela)');
    expect(FINANCER.planProblem.INSUFFICIENT_MERGE).toContain('(separate payments the wallet received)');
  });

  it('approval is said to wait for every part of a purchase paid on Direct.Fund, bank payouts to merchants too — not a flat ten minutes after confirming (review C19)', () => {
    for (const key of ['batchState.awaitingApproval', 'approvalNote', 'confirmDone']) {
      expect(en.get(key), key).toMatch(/every part/);
      expect(en.get(key), key).toMatch(/bank payouts to merchants/);
      expect(en.get(key), key).not.toMatch(/after (you )?confirm/);
      expect(sl.get(key), key).toMatch(/vsi (njegovi )?deli/);
      expect(sl.get(key), key).toMatch(/bančna izplačila trgovcem/);
      expect(sl.get(key), key).not.toMatch(/po potrditvi/);
    }
  });
});
