import { useState } from 'react';

/**
 * Payment-order notice + terms agreement shown as the first step of the sell
 * flow. The seller must read the payout-order rules and tick the agreement box
 * before they can continue. Bilingual (Slovenian / English) via a small toggle.
 */

interface NoticeContent {
  toggleLabel: string;
  orderTitle: string;
  intro: string;
  steps: string[];
  afterSteps: string;
  doNotExpect: string;
  spendFirst: string;
  transparencyTitle: string;
  transparencyBody: string;
  agree: string;
  continue: string;
}

const CONTENT: Record<'sl' | 'en', NoticeContent> = {
  sl: {
    toggleLabel: 'SL',
    orderTitle: 'Vrstni red izplačil',
    intro:
      'Izplačila v sistemu potekajo po vnaprej določenem vrstnem redu, ki zagotavlja stabilnost in naravno ravnovesje celotnega ekosistema. Zaporedje izplačil je naslednje:',
    steps: [
      'Investitorji',
      'Crowdfunding projekti',
      'Projekti brezpogojnih posojil (Unconditional Loan)',
      'Lana8Wonder Spliti in premije iz potrošnje',
    ],
    afterSteps: 'Ko so vse obveznosti poravnane, sledi naslednji Split.',
    doNotExpect:
      'Prosimo, da ne pričakujete izplačil mimo tega vrstnega reda — to je naravni ritem sistema, ki omogoča, da deluje predvidljivo, transparentno in dolgoročno stabilno.',
    spendFirst:
      'Če ste prejeli Lane, jih najprej porabite pri nakupih v trgovinah in pri ponudnikih, vključenih v sistem — Lana je potrošniški ekosistem in njena največja vrednost je v kroženju. Če svojih Lan pred naslednjim Splitom ne uspete porabiti, jih lahko prodate na trgu in se tako izognete morebitni zamrznitvi sredstev ob izvedbi Splita.',
    transparencyTitle: 'Transparentnost izplačil',
    transparencyBody:
      'Vsa izplačila so popolnoma transparentna. Trenutni vrstni red in status vašega zahtevka lahko kadarkoli spremljate na portalu lana.discount, kjer je jasno prikazano, na katerem mestu v čakalni vrsti je vaše izplačilo.',
    agree: 'Strinjam se s pogoji in razumem vrstni red izplačil.',
    continue: 'Nadaljuj',
  },
  en: {
    toggleLabel: 'EN',
    orderTitle: 'Payment Order',
    intro:
      'Payments within the system follow a predefined order designed to ensure the stability and natural balance of the entire ecosystem. The payment sequence is as follows:',
    steps: [
      'Investors',
      'Crowdfunding projects',
      'Unconditional Loan projects',
      'Lana8Wonder Splits and retail incentives',
    ],
    afterSteps: 'Once all obligations have been fulfilled, the next Split takes place.',
    doNotExpect:
      'Please do not expect payments outside of this sequence. Following this order allows the system to operate predictably, transparently, and sustainably over the long term.',
    spendFirst:
      'If you have received LANA, we encourage you to spend it first at participating merchants and service providers. LANA is designed as a consumer-driven ecosystem, and its greatest value comes from circulating throughout the economy. If you are unable to spend your LANA before the next Split, you may sell it on the market to avoid the possibility of your funds being temporarily frozen during the Split process.',
    transparencyTitle: 'Payment Transparency',
    transparencyBody:
      'All payments are fully transparent. You can monitor the current payment queue and the status of your payment at any time on lana.discount, where you can clearly see your current position in the payment queue.',
    agree: 'I agree to the terms and understand the payment order.',
    continue: 'Continue',
  },
};

export function SellTermsGate({ onAccept }: { onAccept: () => void }) {
  const [lang, setLang] = useState<'sl' | 'en'>('sl');
  const [checked, setChecked] = useState(false);
  const c = CONTENT[lang];

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-7">
      {/* Title + language toggle */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="h-6 w-6 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <h2 className="text-xl sm:text-2xl font-bold text-foreground truncate">{c.orderTitle}</h2>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          {(['sl', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {CONTENT[l].toggleLabel}
            </button>
          ))}
        </div>
      </div>

      {/* Intro */}
      <p className="text-sm text-muted-foreground leading-relaxed">{c.intro}</p>

      {/* Ordered payout sequence */}
      <ol className="mt-3 space-y-2">
        {c.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {i + 1}
            </span>
            <span className="text-sm text-foreground leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>

      {/* After steps → next Split */}
      <p className="mt-3 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm font-medium text-foreground">
        {c.afterSteps}
      </p>

      {/* Do not expect out-of-order */}
      <p className="mt-4 text-sm text-muted-foreground leading-relaxed">{c.doNotExpect}</p>

      {/* Spend-first guidance */}
      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{c.spendFirst}</p>

      {/* Transparency */}
      <div className="mt-5 pt-4 border-t border-border">
        <h3 className="text-base font-bold text-foreground">{c.transparencyTitle}</h3>
        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{c.transparencyBody}</p>
      </div>

      {/* Agreement + continue */}
      <label className="mt-5 flex items-start gap-3 cursor-pointer select-none rounded-lg bg-muted/40 border border-border px-3 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-primary focus:ring-2 focus:ring-primary cursor-pointer"
        />
        <span className="text-sm font-medium text-foreground leading-relaxed">{c.agree}</span>
      </label>

      <button
        type="button"
        disabled={!checked}
        onClick={onAccept}
        className="mt-4 w-full rounded-xl bg-primary px-6 py-3.5 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {c.continue}
      </button>
    </div>
  );
}
