import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import AdminNav from '@/components/AdminNav';
import { knownNames, resolveNames } from '@/lib/counterpartyNames';
import { formatDate, formatLeftToMinute, formatMoment, useCountdown } from '@/lib/offerClock';
import { formatFiat, formatLana } from '@/lib/money';

/**
 * WHAT WE HAVE AGREED TO BUY AND HAVE NOT YET BOUGHT.
 *
 * The owner asked for it in one sentence: "Naredi seznam ponudb, ki si jih
 * sprejel in koliko denarja čakaš ter da gledaš gdaj poteče." A list of what
 * the treasury has accepted, how much money is owed on it, and when each one
 * runs out.
 *
 * TWO CLOCKS RUN ON EVERY ROW AND THEY MEAN OPPOSITE THINGS.
 *
 *   Seller transfers by   their window. Miss it and the acquisition never
 *                         happens: the offer is void and we owe nothing.
 *   We settle by          our obligation. Miss it and we are late paying for
 *                         LANA we already hold.
 *
 * A single column headed "Expires" would have to pick one of those and would
 * be read as the other — telling the person running the treasury that money is
 * safe when a deal is dying, or that a deal is dying when the money is merely
 * due. So both are drawn, side by side, each under its own name, and the one
 * that runs out first is the one in bold. Which that is comes from the server
 * (`nextDue`), because the rule behind it — a mandate-bound row is swept 24
 * hours after acceptance, a legacy row is not swept at all — lives there and
 * this page must not hold a second opinion about it.
 *
 * The visual language is AdminOffers' and AdminMandates', not a new one: the
 * same nav, the same card and table shells, the same dashed empty state, the
 * same one bottom line in mono above the detail.
 */

/** Symbols, as every other screen in this app spells them. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF',
};

const sym = (currency: string) => CURRENCY_SYMBOLS[currency] || currency;

interface AcceptedOffer {
  offerRef: string;
  userHexId: string;
  senderWallet: string;
  walletClass: string;
  currency: string;
  lanaAmount: number;
  purchasePrice: number | null;
  createdAt: string;
  acceptedAt: string | null;
  /** The SELLER's deadline to transfer. */
  transferDueAt: string | null;
  /** OUR deadline to pay. */
  settlementDueAt: string | null;
  /** Which of the two is nearer. Never merged into one "expires". */
  nextDue: 'transfer' | 'settlement' | null;
  nextDueAt: string | null;
  /** Whether the 24-hour sweep closes this row by itself. */
  sweepsItself: boolean;
  /** The seller's window has already closed: nothing can complete this. */
  transferLapsed: boolean;
  round: number | null;
  mandateRef: string | null;
}

interface AcceptedResponse {
  offers: AcceptedOffer[];
  totals: Record<string, { owed: number; lana: number; count: number; unpriced: number }>;
  lapsed: { count: number; byCurrency: Record<string, number> };
  stillWithSellers: {
    count: number;
    byCurrency: Record<string, number>;
    /** The rows, not only the sum: an offer nobody can find is an offer nobody chases. */
    offers: WaitingOnSeller[];
  };
  transferWindowHours: number;
  updated_at: string;
}

/** How long an offer still stands, ticking. A component: useCountdown is a hook. */
const Standing = ({ until }: { until: string }) => {
  const { msLeft } = useCountdown(until);
  if (msLeft === null) return null;
  return (
    <span className={`block text-[11px] ${msLeft <= 24 * 60 * 60 * 1000 ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
      {formatLeftToMinute(msLeft)} left
    </span>
  );
};

/** Priced by us and sent; standing while the seller decides. */
interface WaitingOnSeller {
  offerRef: string;
  userHexId: string;
  senderWallet: string;
  currency: string;
  lanaAmount: number | null;
  purchasePrice: number | null;
  discountPercent: number | null;
  round: number | null;
  mandateRef: string | null;
  createdAt: string;
  pricedAt: string | null;
  standsUntil: string;
}

/**
 * Under this the seller's clock turns amber, and not before.
 *
 * A quarter of the 24-hour transfer window. WaitingOffer sets its own
 * threshold at a third of the 30 minutes an automatic offer stands, for the
 * reason written there: a signal that is on for the whole life of a row says
 * nothing at all. Six hours means what it looks like — this one is nearly out
 * of time, and if it dies the mandate behind it comes back.
 */
const TRANSFER_AMBER_MS = 6 * 3_600_000;

/**
 * Under this OUR clock turns amber. Three days, because a settlement is a
 * payment somebody has to actually make — it wants notice, not a countdown.
 */
const SETTLEMENT_AMBER_MS = 3 * 86_400_000;

/**
 * One clock, drawn honestly.
 *
 * `emphasis` is not decoration: it is the answer to "which of these two runs
 * out first", and it is the only thing on the row that says so. The muted
 * twin is still perfectly readable — it is a real deadline, just not the next
 * one.
 */
const Clock = ({
  until,
  emphasis,
  amberBelowMs,
  asDate,
  lapsedText,
  voided,
}: {
  until: string | null;
  emphasis: boolean;
  amberBelowMs: number;
  /** A settlement is a calendar day; a transfer window is a moment. */
  asDate?: boolean;
  lapsedText: string;
  /**
   * THIS DEADLINE NO LONGER COSTS ANYTHING, so it is drawn as spent.
   *
   * Our settlement date on a row whose transfer window has closed is the case
   * this exists for. The date is still true — it is what we agreed — but the
   * acquisition it belonged to can no longer happen, so no payment will ever
   * be made against it. Left alone it came up amber under three days: this
   * page's "you need to act on this soon" signal, pointing at a payment that
   * is never going to be made, on the same row where the hero states in red
   * that nothing is owed. That is precisely the confusion between the two
   * clocks this page was built to prevent, so it is struck through and muted —
   * the same treatment, on the same row, that the price already gets.
   */
  voided?: boolean;
}) => {
  const { msLeft } = useCountdown(until);

  // No clock at all rather than an invented one — a row with no deadline gets
  // a dash, never a zero that reads as "out of time".
  if (!until || msLeft === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  const lapsed = msLeft <= 0;
  const amber = !lapsed && msLeft < amberBelowMs;
  // `voided` is asked first: a deadline nobody has to meet gets neither the
  // amber that asks for attention nor the red that says we are late.
  const tone = voided
    ? 'text-muted-foreground line-through'
    : lapsed
      ? 'text-red-600 dark:text-red-400'
      : amber
        ? 'text-amber-700 dark:text-amber-400'
        : emphasis
          ? 'text-foreground'
          : 'text-muted-foreground';

  return (
    <span className="block">
      <span
        className={`block whitespace-nowrap font-mono text-sm ${!voided && (emphasis || lapsed) ? 'font-bold' : ''} ${tone}`}
      >
        {lapsed ? lapsedText : formatLeftToMinute(msLeft)}
      </span>
      <span className="block whitespace-nowrap text-[11px] text-muted-foreground">
        {asDate ? formatDate(until) : formatMoment(until)}
      </span>
    </span>
  );
};

const short = (value: string | null, head = 8, tail = 6) => {
  if (!value) return '—';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

/**
 * One accepted offer. A component rather than a branch inside a `.map()`
 * because `useCountdown` is a hook and this row owns two of them.
 */
const Row = ({
  offer,
  name,
  transferWindowHours,
}: {
  offer: AcceptedOffer;
  name: string | undefined;
  /** null until the server has said how long the window is. */
  transferWindowHours: number | null;
}) => {
  const symbol = sym(offer.currency);
  return (
    <tr className={`border-b border-border/60 align-top ${offer.transferLapsed ? 'bg-red-50/50 dark:bg-red-950/20' : ''}`}>
      {/* WHOSE ROW THIS IS, KEPT ON SCREEN WHILE THE CLOCKS ARE READ.
          At 375 px this table needs about 530 px of horizontal scroll, so
          reaching the two deadline columns used to carry the offer reference
          off the left edge — on a list of several rows you could read a
          deadline without being able to say whose it was. Sticky, with the
          card's own background so the scrolling cells pass underneath it. */}
      <td className="sticky left-0 z-10 bg-card px-3 py-3">
        <span className="block font-mono text-sm font-bold text-foreground">{offer.offerRef}</span>
        <span className="block text-[11px] text-muted-foreground">
          Accepted {offer.acceptedAt ? formatMoment(offer.acceptedAt) : '—'}
        </span>
        {offer.round !== null && (
          <span
            title={offer.mandateRef || undefined}
            className="mt-1 inline-flex items-center whitespace-nowrap rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-700"
          >
            Round {offer.round}
          </span>
        )}
      </td>

      <td className="px-3 py-3 min-w-0">
        {name && <span className="block truncate text-sm font-semibold text-foreground">{name}</span>}
        <span className="block font-mono text-[11px] text-muted-foreground" title={offer.userHexId}>
          {short(offer.userHexId)}
        </span>
        <span className="block font-mono text-[11px] text-muted-foreground" title={offer.senderWallet}>
          {short(offer.senderWallet)}
        </span>
      </td>

      <td className="px-3 py-3 text-right whitespace-nowrap">
        <span className="font-mono text-sm text-foreground">{formatLana(offer.lanaAmount)}</span>
        <span className="ml-1 text-[11px] text-muted-foreground">LANA</span>
      </td>

      {/* What this row costs us. Muted when the window has closed, because
          then it costs us nothing — the money is not owed to anybody. */}
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <span
          className={`font-mono text-sm font-bold ${offer.transferLapsed ? 'text-muted-foreground line-through' : 'text-foreground'}`}
        >
          {offer.purchasePrice === null ? '—' : formatFiat(symbol, offer.purchasePrice)}
        </span>
      </td>

      {/* THEIR clock. */}
      <td className="px-3 py-3">
        <Clock
          until={offer.transferDueAt}
          emphasis={offer.nextDue === 'transfer'}
          amberBelowMs={TRANSFER_AMBER_MS}
          lapsedText="window closed"
        />
        {offer.transferLapsed && (
          <span className="mt-1 block text-[11px] text-red-700 dark:text-red-400">
            {offer.sweepsItself
              ? `Voids itself ${transferWindowHours === null ? '' : `${transferWindowHours} h `}after acceptance — the sweep has not run yet.`
              : 'Nothing sweeps this one. Void it on Offers to free what it reserves.'}
          </span>
        )}
      </td>

      {/* OUR clock — spent, on a row that can no longer become a sale. */}
      <td className="px-3 py-3">
        <Clock
          until={offer.settlementDueAt}
          emphasis={offer.nextDue === 'settlement'}
          amberBelowMs={SETTLEMENT_AMBER_MS}
          asDate
          lapsedText="overdue"
          voided={offer.transferLapsed}
        />
      </td>
    </tr>
  );
};

const AdminAcceptedOffers = () => {
  const { session, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState<AcceptedResponse | null>(null);
  const [names, setNames] = useState<Record<string, string>>(() => knownNames());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !session) navigate('/login');
    if (!authLoading && session && !isAdmin) navigate('/dashboard');
  }, [session, authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    fetchAccepted();
  }, [session, isAdmin]);

  const fetchAccepted = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/acquisitions/admin/accepted', {
        headers: { 'x-admin-hex-id': session.nostrHexId },
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body as AcceptedResponse);
      // A hex says nothing about who sold; the name does.
      const list: AcceptedOffer[] = body.offers || [];
      const waiting: WaitingOnSeller[] = body.stillWithSellers?.offers || [];
      const missing = [...new Set([...list, ...waiting].map(o => o.userHexId))]
        .filter(h => h && names[h] === undefined);
      if (missing.length) resolveNames(missing).then(found => setNames(prev => ({ ...prev, ...found })));
    } catch (err: any) {
      console.error('Failed to load accepted offers:', err);
      toast.error(err.message || 'Failed to load accepted offers');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || !session || !isAdmin) return null;

  const offers = data?.offers || [];
  const owedByCurrency = Object.entries(data?.totals || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const liveCount = owedByCurrency.reduce((n, [, cell]) => n + cell.count, 0);
  const unpricedCount = owedByCurrency.reduce((n, [, cell]) => n + cell.unpriced, 0);
  const lapsed = data?.lapsed || { count: 0, byCurrency: {} };
  const stillOut = data?.stillWithSellers || { count: 0, byCurrency: {}, offers: [] };
  const waitingOnSellers = data?.stillWithSellers?.offers || [];
  const transferWindowHours = data?.transferWindowHours ?? null;

  const listMoney = (byCurrency: Record<string, number>) =>
    Object.entries(byCurrency)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, amount]) => formatFiat(sym(currency), amount))
      .join(' · ');

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AdminNav />

      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-6xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <h1 className="text-3xl font-bold text-foreground">Accepted Offers</h1>
            <p className="text-muted-foreground">
              Purchase offers a seller has accepted and whose LANA has not arrived yet. The price on each one is
              agreed; what is still open is the transfer.
            </p>
          </div>
          <button
            onClick={fetchAccepted}
            disabled={loading}
            className="flex-shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-bold text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* THE BOTTOM LINE, FIRST. What is owed on these offers, per currency —
            adding two currencies together would be a number nobody owes. */}
        <div className="mb-4 rounded-2xl border-2 border-border bg-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Owed on accepted offers</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            {owedByCurrency.length === 0 ? (
              <span className="font-mono text-3xl font-bold text-muted-foreground">—</span>
            ) : (
              owedByCurrency.map(([currency, cell]) => (
                <span key={currency} className="font-mono text-3xl font-bold text-foreground">
                  {formatFiat(sym(currency), cell.owed)}
                </span>
              ))
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {liveCount} accepted offer{liveCount === 1 ? '' : 's'} · waiting on the seller's transfer
            {owedByCurrency.length > 0 && (
              <> · {owedByCurrency.map(([c, cell]) => `${formatLana(cell.lana)} LANA in ${c}`).join(' · ')}</>
            )}
          </p>
          {/* ONE IS THE COMMONEST COUNT ON THIS PAGE, so both of these lines
              are written for it rather than left reading "1 of them carry".
              The rest of this card already switches on the count; these two
              were the only places that did not. */}
          {unpricedCount > 0 && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              {unpricedCount === 1
                ? '1 of them carries no purchase price and is not in the figure above.'
                : `${unpricedCount} of them carry no purchase price and are not in the figure above.`}
            </p>
          )}
          {lapsed.count > 0 && (
            <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">
              {lapsed.count} more ({listMoney(lapsed.byCurrency)}){' '}
              {lapsed.count === 1
                ? 'is past its transfer window and is not listed above: it can no longer complete, so nothing is owed on it. It still reserves what it was given until the sweep voids it — or void it now on '
                : 'are past their transfer window and are not listed above: they can no longer complete, so nothing is owed on them. They still reserve what they were given until the sweep voids them — or void them now on '}
              <Link to="/admin/offers" className="underline underline-offset-2">Offers</Link>.
            </p>
          )}
        </div>

        {/* THE TRAP THIS PAGE EXISTS TO AVOID, said in the open. */}
        <div className="mb-6 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-bold text-foreground">Two clocks, and they are not the same one.</span>{' '}
          <span className="font-semibold text-foreground">Seller transfers by</span> is their window: when it runs out
          the acquisition simply does not happen and we owe nothing.{' '}
          <span className="font-semibold text-foreground">We settle by</span> is ours — the date we agreed to pay the
          purchase price — and when it runs out we are late. On every row the one that runs out first is in bold, and
          the list is ordered by it.
          {/* The length of the seller's window is the server's number, not a
              constant typed in here, so it appears once the server has said it
              and not a moment before. */}
          {transferWindowHours !== null && (
            <> The seller's window is {transferWindowHours} hours from the moment they accept — every
              accepted offer, not only those from a round mandate. Until 11 Sept 2026 it was whatever was
              left of the OFFER's own window, which on an automatic offer is thirty minutes.</>
          )}
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-muted-foreground">Loading accepted offers…</p>
            </div>
          </div>
        ) : offers.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
            <div className="flex flex-col items-center gap-3">
              <svg className="h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-lg text-muted-foreground">Nothing is waiting on a transfer</p>
              <p className="text-sm text-muted-foreground/70">
                An offer appears here the moment a seller accepts our purchase price, and leaves it the moment their
                LANA arrives.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border-2 border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="sticky left-0 z-10 bg-card px-3 py-2">Offer</th>
                  <th className="px-3 py-2">Counterparty</th>
                  <th className="px-3 py-2 text-right">LANA</th>
                  <th className="px-3 py-2 text-right">We owe</th>
                  <th className="px-3 py-2">Seller transfers by</th>
                  <th className="px-3 py-2">We settle by</th>
                </tr>
              </thead>
              <tbody>
                {/* WHAT CAN STILL BECOME A SALE, and nothing else. Owner, 11
                    Sept 2026: "primere, ki so overdue, ne rabiš sploh
                    prikazovati." A row past its transfer window owes nobody
                    anything and cannot complete; it is counted in one line
                    above, with the door to void it, rather than filling the
                    page with rows that are only in the way. */}
                {offers.filter(o => !o.transferLapsed).map(offer => (
                  <Row
                    key={offer.offerRef}
                    offer={offer}
                    name={names[offer.userHexId]}
                    transferWindowHours={transferWindowHours}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ONE STEP BEFORE THE TABLE ABOVE: priced by us, sent, and standing
            while the seller decides.
            Owner, 11 Sept 2026: he remembered an offer by name and could not
            find it on any screen. /admin/offers holds what waits on US, the
            table above holds what a seller has already accepted, and this — the
            largest money in reach on the page — was a single line of summary
            text. It is not owed, because the seller may simply let it lapse;
            it is owed the moment they say yes, and that is reason enough to be
            able to see whose it is. */}
        {waitingOnSellers.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-bold text-foreground">Waiting on the seller</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              We have priced {waitingOnSellers.length === 1 ? 'this offer' : 'these offers'} and sent{' '}
              {waitingOnSellers.length === 1 ? 'it' : 'them'}. Nothing is owed yet — the seller may accept or let the
              offer lapse, and the mandate behind it comes back if they do. It is not counted in the figure above.
            </p>

            <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[640px] text-left">
                <thead className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Offer</th>
                    <th className="px-3 py-2">Counterparty</th>
                    <th className="px-3 py-2 text-right">LANA</th>
                    <th className="px-3 py-2 text-right">If accepted</th>
                    <th className="px-3 py-2">Priced</th>
                    <th className="px-3 py-2">Stands until</th>
                  </tr>
                </thead>
                <tbody>
                  {waitingOnSellers.map(o => (
                    <tr key={o.offerRef} className="border-b border-border/60 align-top">
                      <td className="px-3 py-3">
                        <span className="block font-mono text-sm font-bold text-foreground">{o.offerRef}</span>
                        {o.round !== null && (
                          <span
                            title={o.mandateRef || undefined}
                            className="mt-1 inline-flex items-center whitespace-nowrap rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-700"
                          >
                            Round {o.round}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 min-w-0">
                        {names[o.userHexId] && (
                          <span className="block truncate text-sm font-semibold text-foreground">{names[o.userHexId]}</span>
                        )}
                        <span className="block font-mono text-[11px] text-muted-foreground" title={o.userHexId}>
                          {short(o.userHexId)}
                        </span>
                        <span className="block font-mono text-[11px] text-muted-foreground" title={o.senderWallet}>
                          {short(o.senderWallet)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <span className="font-mono text-sm text-foreground">{formatLana(o.lanaAmount)}</span>
                        <span className="ml-1 text-[11px] text-muted-foreground">LANA</span>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <span className="font-mono text-sm text-foreground">
                          {o.purchasePrice === null ? '—' : formatFiat(sym(o.currency), o.purchasePrice)}
                        </span>
                        {o.discountPercent !== null && (
                          <span className="ml-1 text-[11px] text-muted-foreground">at {o.discountPercent}%</span>
                        )}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-sm text-muted-foreground">
                        {formatMoment(o.pricedAt)}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="block font-mono text-sm text-foreground">{formatMoment(o.standsUntil)}</span>
                        <Standing until={o.standsUntil} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Where the money goes next, and where it came from — so the figure at
            the top is never mistaken for everything the treasury owes. */}
        <div className="mt-6 space-y-2 text-xs text-muted-foreground">
          <p>
            Once the LANA arrives an offer becomes a sale and leaves this page. What is owed on it from then until it
            is paid is on <Link to="/admin/payouts" className="underline underline-offset-2">Payouts</Link>.
          </p>
          {stillOut.count > 0 && (
            <p>
              Waiting on sellers: {listMoney(stillOut.byCurrency)} across {stillOut.count} offer
              {stillOut.count === 1 ? '' : 's'}, listed below and not counted above.
            </p>
          )}
        </div>
      </div>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Lana.Discount — Admin Panel
      </footer>
    </div>
  );
};

export default AdminAcceptedOffers;
