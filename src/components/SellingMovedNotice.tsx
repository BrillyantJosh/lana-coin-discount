import { Fragment, useState } from 'react';
import { SELLING_MOVED } from '@/copy';
import {
  defaultNoticeLang, useBuyingDealers, BEF_DIRECTORY_URL,
  type BuyingDealer, type BuyingDealersAnswer, type NoticeLang,
} from '@/lib/sellingClosed';

/**
 * WHERE SELLING WENT.
 *
 * Shown wherever a person used to start selling LANA here — the landing page,
 * /offer, the sign-in page and the dashboard. It names each firm that buys LANA
 * now, as GET /api/buying-dealers reads them from the relays (the companies'
 * own signed KIND 30972 profiles, admitted by BEF Explorer's rule), with the
 * page at each firm where a person registers or signs in, and its page for
 * selling. When no firm can be named — the first read has not come back, or
 * the relays could not be read — it still says that selling here is closed and
 * links to the list of companies on BEF Explorer. It never offers a form.
 *
 * English is the vocabulary from src/copy.ts. Slovenian is its translation and
 * lives here beside it, as in SellTermsGate.
 */

export interface NoticeText {
  toggleLabel: string;
  eyebrow: string;
  /** For one firm, two, and more — Slovenian agrees the verb with the count. */
  titleLead: { one: string; two: string; many: string };
  and: string;
  titleNone: string;
  closed: string;
  registerOne: string;
  registerTwo: string;
  registerMany: string;
  registerNone: string;
  register: string;
  sell: string;
  directory: string;
  loading: string;
  source: string;
  soldBefore: string;
  soldBeforeLink: string;
  soldBeforeBelow: string;
  signInTitle: string;
  signInIntro: string;
  signInKeyIntro: string;
  signInKeyLabel: string;
  signInKeyPlaceholder: string;
  signInRemember: string;
  signInSubmit: string;
  signInSubmitting: string;
  signInKeyLocal: string;
}

export const NOTICE_TEXT: Record<NoticeLang, NoticeText> = {
  sl: {
    toggleLabel: 'SL',
    eyebrow: 'Prodaja LAN na Lana.discount je zaprta',
    titleLead: {
      one: 'Odkup LAN je prevzelo podjetje',
      two: 'Odkup LAN sta prevzeli podjetji',
      many: 'Odkup LAN so prevzela podjetja',
    },
    and: 'in',
    titleNone: 'Odkup LAN so prevzela druga podjetja.',
    closed: 'Na Lana.discount LAN ni več mogoče prodati.',
    registerOne: 'Če želite prodati svoje LANE, se registrirajte pri tem podjetju.',
    registerTwo: 'Če želite prodati svoje LANE, se registrirajte pri enem od obeh podjetij.',
    registerMany: 'Če želite prodati svoje LANE, se registrirajte pri enem od teh podjetij.',
    registerNone: 'Če želite prodati svoje LANE, se registrirajte pri enem od podjetij, navedenih na BEF Explorerju.',
    register: 'Registracija in prijava',
    sell: 'Prodaj LANE',
    directory: 'Podjetja na BEF Explorerju',
    loading: 'Berem podjetja z relejev Lana …',
    source: 'Prebrano iz podpisanega profila vsakega podjetja (KIND 30972) na relejih Lana.',
    soldBefore: 'Ste LANE že prodali na Lana.discount?',
    soldBeforeLink: 'Prijavite se in poglejte, kaj vam še dolgujemo.',
    soldBeforeBelow: 'Spodaj se prijavite in poglejte, kaj vam še dolgujemo.',
    signInTitle: 'Prijava',
    signInIntro:
      'Prijava je namenjena le še pregledu LAN, ki ste jih tu že prodali, in temu, kar vam še dolgujemo, ' +
      'financerjem za poravnavo njihovih nakupov (/financer) ter skrbnikom strani.',
    signInKeyIntro: 'Vnesite zasebni ključ WIF svoje denarnice LanaCoin.',
    signInKeyLabel: 'Zasebni ključ WIF',
    signInKeyPlaceholder: 'Vnesite ključ WIF ...',
    signInRemember: 'Zapomni si me za 90 dni (sicer za 30 dni)',
    signInSubmit: 'Prijava',
    signInSubmitting: 'Prijavljam ...',
    signInKeyLocal: 'Vaš zasebni ključ se obdela samo v vašem brskalniku in nikoli ne pride na naše strežnike.',
  },
  en: {
    toggleLabel: 'EN',
    eyebrow: SELLING_MOVED.eyebrow,
    titleLead: { one: SELLING_MOVED.titleLead, two: SELLING_MOVED.titleLead, many: SELLING_MOVED.titleLead },
    and: SELLING_MOVED.and,
    titleNone: SELLING_MOVED.titleNone,
    closed: SELLING_MOVED.closed,
    registerOne: SELLING_MOVED.registerOne,
    registerTwo: SELLING_MOVED.registerTwo,
    registerMany: SELLING_MOVED.registerMany,
    registerNone: SELLING_MOVED.registerNone,
    register: SELLING_MOVED.register,
    sell: SELLING_MOVED.sell,
    directory: SELLING_MOVED.directory,
    loading: SELLING_MOVED.loading,
    source: SELLING_MOVED.source,
    soldBefore: SELLING_MOVED.soldBefore,
    soldBeforeLink: SELLING_MOVED.soldBeforeLink,
    soldBeforeBelow: SELLING_MOVED.soldBeforeBelow,
    signInTitle: SELLING_MOVED.signInTitle,
    signInIntro: SELLING_MOVED.signInIntro,
    signInKeyIntro: SELLING_MOVED.signInKeyIntro,
    signInKeyLabel: SELLING_MOVED.signInKeyLabel,
    signInKeyPlaceholder: SELLING_MOVED.signInKeyPlaceholder,
    signInRemember: SELLING_MOVED.signInRemember,
    signInSubmit: SELLING_MOVED.signInSubmit,
    signInSubmitting: SELLING_MOVED.signInSubmitting,
    signInKeyLocal: SELLING_MOVED.signInKeyLocal,
  },
};

/** The page's language, defaulting from the browser; the toggle on the notice sets it. */
export function useNoticeLang(): [NoticeLang, (l: NoticeLang) => void] {
  const [lang, setLang] = useState<NoticeLang>(defaultNoticeLang);
  return [lang, setLang];
}

/** "A", "A in B", "A, B in C" — the names in bold, the joints in the reader's language. */
function Names({ buyers, and }: { buyers: BuyingDealer[]; and: string }) {
  return (
    <>
      {buyers.map((b, i) => {
        const joint = i === 0 ? null : i === buyers.length - 1 ? ` ${and} ` : ', ';
        return (
          <Fragment key={`${b.host}/${b.slug}`}>
            {joint}
            <strong className="font-bold text-foreground">{b.name}</strong>
          </Fragment>
        );
      })}
    </>
  );
}

export function LangToggle({ lang, onChange }: { lang: NoticeLang; onChange: (l: NoticeLang) => void }) {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden shrink-0" role="group" aria-label="Language">
      {(['sl', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => onChange(l)}
          className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
            lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {NOTICE_TEXT[l].toggleLabel}
        </button>
      ))}
    </div>
  );
}

export function SellingMovedNotice({
  lang: controlledLang,
  onLangChange,
  soldBefore = 'link',
  answer: givenAnswer,
  headingLevel = 'h1',
}: {
  /** Controlled language (the sign-in page shares it with its form); uncontrolled when omitted. */
  lang?: NoticeLang;
  onLangChange?: (l: NoticeLang) => void;
  /** How the line for people who already sold here ends: a link to sign in, "sign in below", or not at all. */
  soldBefore?: 'link' | 'below' | 'none';
  /** The firms, when the page already has them; otherwise the notice reads them itself. */
  answer?: BuyingDealersAnswer | null;
  headingLevel?: 'h1' | 'h2';
}) {
  const [ownLang, setOwnLang] = useNoticeLang();
  const lang = controlledLang ?? ownLang;
  const setLang = onLangChange ?? setOwnLang;
  const read = useBuyingDealers(givenAnswer === undefined);
  const answer = givenAnswer === undefined ? read : givenAnswer;
  const c = NOTICE_TEXT[lang];
  const buyers = answer?.buyers ?? [];
  const loading = answer === null;
  const lead = buyers.length === 1 ? c.titleLead.one : buyers.length === 2 ? c.titleLead.two : c.titleLead.many;
  const register = buyers.length === 0 ? c.registerNone
    : buyers.length === 1 ? c.registerOne
      : buyers.length === 2 ? c.registerTwo
        : c.registerMany;
  const Heading = headingLevel;

  return (
    <section
      data-testid="selling-moved"
      lang={lang}
      className="min-w-0 rounded-2xl border-2 border-primary/30 bg-card p-5 sm:p-7 text-left"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="min-w-0 text-xs sm:text-sm font-semibold uppercase tracking-wider text-primary">{c.eyebrow}</p>
        <LangToggle lang={lang} onChange={setLang} />
      </div>

      <Heading className="text-2xl sm:text-3xl font-bold text-foreground leading-snug break-words">
        {buyers.length > 0 ? (
          // No second full stop after a name that already ends in one ("d.o.o.").
          <>{lead} <Names buyers={buyers} and={c.and} />{buyers[buyers.length - 1].name.trim().endsWith('.') ? null : '.'}</>
        ) : c.titleNone}
      </Heading>
      <p className="mt-3 text-base text-muted-foreground leading-relaxed">
        {c.closed} {loading ? null : register}
      </p>

      {loading && (
        <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {c.loading}
        </p>
      )}

      {!loading && buyers.length > 0 && (
        <>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2" data-testid="buying-dealers">
            {buyers.map(b => (
              <li key={`${b.host}/${b.slug}`} className="min-w-0 rounded-xl border border-border bg-background/60 p-4">
                <p className="font-semibold text-foreground break-words">{b.name}</p>
                <a href={b.website} rel="noopener" className="text-xs text-muted-foreground hover:text-foreground break-all">
                  {b.host}
                </a>
                <div className="mt-3 flex flex-col gap-2">
                  <a
                    href={b.registerUrl}
                    rel="noopener"
                    className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity text-center"
                  >
                    {c.register}
                  </a>
                  <a
                    href={b.sellUrl}
                    rel="noopener"
                    className="inline-flex items-center justify-center rounded-lg border-2 border-primary px-4 py-2 text-sm font-semibold text-primary hover:bg-accent transition-colors text-center"
                  >
                    {c.sell}
                  </a>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground/80">{c.source}</p>
        </>
      )}

      {!loading && buyers.length === 0 && (
        <a
          href={answer?.directoryUrl || BEF_DIRECTORY_URL}
          rel="noopener"
          className="mt-5 inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          {c.directory}
        </a>
      )}

      {soldBefore !== 'none' && (
        <p className="mt-5 pt-4 border-t border-border text-sm text-muted-foreground leading-relaxed">
          {c.soldBefore}{' '}
          {soldBefore === 'link'
            ? <a href="/login" className="font-semibold text-primary hover:underline">{c.soldBeforeLink}</a>
            : c.soldBeforeBelow}
        </p>
      )}
    </section>
  );
}

export default SellingMovedNotice;
