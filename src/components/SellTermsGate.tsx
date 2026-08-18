import { useState, useEffect, useRef } from 'react';
import { TERMS, OFFER } from '@/copy';

/**
 * The terms a counterparty agrees to, shown at the moment they accept a
 * purchase offer.
 *
 * It used to open the whole sell flow — read once, before there was anything
 * to agree to, and its acceptance lived only in React state, so no evidence
 * ever existed that anyone had agreed to anything. Now it stands in front of
 * the one action that forms a contract, and the server records the terms
 * version when `/accept` succeeds.
 *
 * English is the vocabulary from src/copy.ts, word for word. Slovenian is its
 * translation and lives here beside it, as it always has — copy.ts holds the
 * compliance wording, and a second language in that file would blur what a
 * reviewer is reading.
 */

interface TermsContent {
  toggleLabel: string;
  title: string;
  points: readonly string[];
  agree: string;
  accept: string;
  cancel: string;
}

const CONTENT: Record<'sl' | 'en', TermsContent> = {
  sl: {
    toggleLabel: 'SL',
    title: 'Preden sprejmete',
    points: [
      'Lana.discount kupuje te LANA za svojo zakladnico, kot glavni pogodbenik in z lastnim kapitalom. Ne prodaja jih v vašem imenu in ne nastopa kot vaš posrednik.',
      'Prikazana odkupna cena je znesek, ki ga bo Lana.discount plačal. To je naša ponudba za ta predlog, ne tržna cena in ne cena, na katero bi se lahko zanašali v prihodnje.',
      'Ko izvedete prenos, so LANA naše, skupaj z vsakim poznejšim dobičkom ali izgubo na njih.',
      'Odkupno ceno vam dolgujemo do datuma, navedenega na ponudbi. Poravnave potekajo po objavljenem vrstnem redu.',
      'Lana.discount ne hrani vaših ključev, ne vodi stanj za vas in za vas ne izvršuje naročil.',
    ],
    agree: 'To sem prebral in sprejemam odkupno ponudbo.',
    accept: 'Sprejmi',
    cancel: 'Ne zdaj',
  },
  en: {
    toggleLabel: 'EN',
    title: TERMS.title,
    points: TERMS.points,
    agree: TERMS.agree,
    accept: TERMS.continue,
    cancel: OFFER.offeredDecline,
  },
};

export function SellTermsGate({
  onAccept,
  onCancel,
  defaultLang = 'en',
  busy = false,
}: {
  onAccept: () => void;
  onCancel?: () => void;
  defaultLang?: 'sl' | 'en';
  busy?: boolean;
}) {
  const [lang, setLang] = useState<'sl' | 'en'>(defaultLang);
  // Adopt the profile-derived default when it arrives (the KIND 0 language may
  // load a moment after mount) — but never override a manual toggle.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setLang(defaultLang); }, [defaultLang]);
  const [checked, setChecked] = useState(false);
  const c = CONTENT[lang];

  return (
    <div className="rounded-2xl border-2 border-primary/30 bg-card p-5 sm:p-7">
      {/* Title + language toggle */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="h-6 w-6 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <h2 className="text-xl sm:text-2xl font-bold text-foreground truncate">{c.title}</h2>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          {(['sl', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => { touched.current = true; setLang(l); }}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {CONTENT[l].toggleLabel}
            </button>
          ))}
        </div>
      </div>

      {/* What accepting means. Numbered, because each point is a separate
          statement about who owns what and who owes what. */}
      <ol className="space-y-2.5">
        {c.points.map((p, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {i + 1}
            </span>
            <span className="min-w-0 text-sm text-foreground leading-relaxed">{p}</span>
          </li>
        ))}
      </ol>

      {/* Agreement + accept */}
      <label className="mt-5 flex items-start gap-3 cursor-pointer select-none rounded-lg bg-muted/40 border border-border px-3 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-primary focus:ring-2 focus:ring-primary cursor-pointer"
        />
        <span className="min-w-0 text-sm font-medium text-foreground leading-relaxed">{c.agree}</span>
      </label>

      <div className="mt-4 flex flex-col-reverse sm:flex-row sm:items-center gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {c.cancel}
          </button>
        )}
        <button
          type="button"
          disabled={!checked || busy}
          onClick={onAccept}
          className="flex-1 rounded-xl bg-primary px-6 py-3.5 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              {c.accept}
            </span>
          ) : c.accept}
        </button>
      </div>
    </div>
  );
}
