import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { convertWifToIds } from '@/lib/crypto';
import { SellTermsGate } from '@/components/SellTermsGate';
import { MandatePanel, proposalGate, proposableCapLana, counterBody, fill, fmtUtc, type MandateInfo, availabilityOf } from '@/components/MandatePanel';
import { signedFetch, type SigningKey } from '@/lib/signedRequest';
import { describeOfferError } from '@/lib/offerErrors';
import { BRAND, OFFER, LANDING, MANDATE } from '@/copy';
import { parseSqliteUtc, formatMoment, formatLeft, useCountdown } from '@/lib/offerClock';
import { formatLana } from '@/lib/money';
import { ESTIMATED_TRANSFER_FEE_LANA, maxProposable } from '@/lib/maxOffer';

const QrScanner = lazy(() => import('@/components/QrScanner'));

/**
 * Offering LANA to the Lana.discount treasury.
 *
 * The page this replaces did the whole thing in one request: the seller read a
 * price off a published rate, typed a private key, and the server broadcast the
 * chain transaction and booked the obligation together. There was no moment at
 * which Lana.discount decided whether it wanted the asset — which is a standing
 * service to holders, and the one shape the framework forbids.
 *
 * The order here IS the argument:
 *
 *   wallet   → which holding is being offered (all the old gates, unchanged)
 *   amount   → how much, and NO price: there is no price yet
 *   offer    → our decision comes back — a purchase offer, a review, or a no
 *   transfer → only after acceptance does a key get typed and LANA move
 *   done     → what we acquired, what we owe, and the date we owe it by
 *
 * Everything the old page knew about wallets — balances, freezes, input
 * consolidation, which Split a wallet belongs to, whether we could settle in
 * the counterparty's currency at all — is kept, because none of it was the
 * problem.
 */

interface RegisteredWallet {
  walletId: string;
  walletType: string;
  note?: string;
  amountUnregistered?: string;
  status?: string;
  freezeStatus?: string;
  /**
   * Whether that freeze actually stops a sale. Decided by the server, with the
   * same function the gate refuses by — the browser must not have its own
   * opinion about which freezes count. Absent (an older server) means it does.
   */
  freezeStops?: boolean;
  /**
   * Whether the treasury is acquiring from this wallet's CLASS at all right now.
   * Also decided by the server, with the same function the gate refuses by.
   * Absent (an older server) means it is — a page must not invent a pause.
   */
  acquiring?: boolean;
}

interface WalletBalance {
  wallet_id: string;
  balance: number;
  status: string;
}

/** Verdict from /api/sell/split-check — mirrors server/lib/buybackSplit.ts. */
interface SplitCheck {
  allowed: boolean;
  code: 'OK' | 'SPLIT_TOO_NEW' | 'SPLIT_TOO_OLD' | 'SPLIT_UNKNOWN' | 'SPLIT_UNVERIFIABLE';
  reason: string;
  walletSplit: number | null;
  currentSplit: number | null;
  allowedSplits: number[];
}

/**
 * Only the parts of /api/system-params this page is allowed to care about.
 * The reference rates are deliberately not read here: a price exists only
 * after we have decided we want the asset, and it arrives on the offer.
 */
interface SystemParams {
  split: string | null;
  activeCurrencies: string[];
  treasuryWalletId: string;
}

interface PaymentMethod {
  id: string;
  scope: string;
  country?: string;
  scheme: string;
  currency: string;
  label: string;
  fields: Record<string, any>;
  verified?: boolean;
  primary?: boolean;
}

/** The account a purchase price could be settled to, from the KIND 0 profile. */
type SettlementAccount =
  | { type: 'modern'; method: PaymentMethod }
  | { type: 'legacy'; bank: any };

/** What the server lets a counterparty see about their own offer. */
interface AcquisitionOffer {
  offerRef: string;
  status: string;
  lanaAmount: number;
  currency: string;
  purchasePrice: number | null;
  settlementDueAt: string | null;
  offerExpiresAt: string | null;
  /**
   * When what the SELLER must do next has to be done by — the server's own
   * arithmetic, not this browser's. Equal to offerExpiresAt on an open offer;
   * on an accepted, mandate-bound one it is the earlier of that window and the
   * 24-hour transfer sweep. Null when nothing is waiting on the seller.
   */
  actionDueAt?: string | null;
  decisionReason: string | null;
  senderWallet: string;
  createdAt: string;
  transactionId: number | null;
  // Round-mandate fields (null on the legacy path).
  mandateCode?: string | null;
  mandateRef?: string | null;
  round?: number | null;
  proposedLanaAmount?: number | null;
  isCounteroffer?: boolean;
}

interface TransferResult {
  success: boolean;
  offerRef: string;
  txHash: string;
  lanaAmount: number;
  currency: string;
  purchasePrice: number;
  settlementDueAt: string | null;
  fee: number;
  transactionId: number;
}

type Stage = 'wallet' | 'amount' | 'offer' | 'transfer' | 'done';

const STAGES: Stage[] = ['wallet', 'amount', 'offer', 'transfer'];

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', CZK: 'CZK',
  PLN: 'PLN', HRK: 'HRK', RSD: 'RSD', HUF: 'HUF', BAM: 'BAM',
};

const SCHEME_LABELS: Record<string, string> = {
  'EU.IBAN': 'SEPA / IBAN',
  'UK.ACCT_SORT': 'UK Account',
  'US.ACH': 'US ACH',
};

const MAX_UTXOS = 20;

const formatDay = (ts: string | null | undefined) => {
  const d = parseSqliteUtc(ts);
  return d ? d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
};

const shortAddress = (a: string) => (a && a.length > 22 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a || '—');

const SubmitOffer = () => {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>('wallet');
  const [profileLang, setProfileLang] = useState(''); // KIND 0 `language` → terms default
  const [loading, setLoading] = useState(true);

  // Open obligations of the counterparty's own — checked here as a courtesy,
  // and again by the server on every offer and every transfer.
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingChecked, setRatingChecked] = useState(false);

  // Which holding is being offered
  const [wallets, setWallets] = useState<RegisteredWallet[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('');

  // Settlement currency comes from the KIND 0 profile; it is never chosen here.
  const [systemParams, setSystemParams] = useState<SystemParams | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState('');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [legacyBank, setLegacyBank] = useState<any>(null);

  const [utxoCount, setUtxoCount] = useState<number | null>(null);
  const [utxoLoading, setUtxoLoading] = useState(false);
  const [splitCheck, setSplitCheck] = useState<SplitCheck | null>(null);
  const [splitChecking, setSplitChecking] = useState(false);
  const tooManyUtxos = utxoCount !== null && utxoCount > MAX_UTXOS;

  // The financing-round mandate for this wallet — read with a signed GET,
  // because a financer's remaining cap is theirs to see and nobody else's.
  const [mandateInfo, setMandateInfo] = useState<MandateInfo | null>(null);
  // Bumped when a sale completes: what remains under the mandate has just
  // changed, and the next proposal must be measured against the new figure.
  const [mandateRefresh, setMandateRefresh] = useState(0);
  const [mandateLoading, setMandateLoading] = useState(false);
  const [mandateError, setMandateError] = useState<string | null>(null);
  // Why an offer lapsed, when the server said more than "lapsed".
  const [lapsedReason, setLapsedReason] = useState<string | null>(null);

  // How much is being offered
  const [lanaAmount, setLanaAmount] = useState('');
  const [isEmptyWallet, setIsEmptyWallet] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Our decision
  const [offer, setOffer] = useState<AcquisitionOffer | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [refreshingDecision, setRefreshingDecision] = useState(false);
  // Withdrawing a proposal under review is terminal and frees nothing, so it
  // asks first. See OFFER.reviewWithdraw for why it is not a button any more.
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  // The server has told us the window closed, whatever this browser's clock says.
  const [serverLapsed, setServerLapsed] = useState(false);

  // The transfer
  const [privateKey, setPrivateKey] = useState('');
  const [privateKeyValid, setPrivateKeyValid] = useState<boolean | null>(null); // null = not yet checked
  const [privateKeyError, setPrivateKeyError] = useState('');
  const [validatingKey, setValidatingKey] = useState(false);
  const [transferring, setTransferring] = useState(false);
  /**
   * A refusal, AND whether pressing again could ever come out differently.
   *
   * The route answers `retryable: false` for the refusals that are arithmetic
   * — the wallet holds less than the acquisition is for, the balance is over
   * the ceiling — and `repeated: true` when it recognised an unchanged wallet
   * and did not even attempt the broadcast. The browser used to keep only
   * `{error, code}` and leave Confirm enabled, so the seller pressed a button
   * that could not work, and each press wrote another failed row. That is the
   * eight-rows complaint from the seller's side of the glass.
   */
  const [transferError, setTransferError] = useState<
    { error: string; code?: string; retryable?: boolean; repeated?: boolean } | null
  >(null);
  const [showQrScanner, setShowQrScanner] = useState(false);

  const [result, setResult] = useState<TransferResult | null>(null);

  /**
   * The deadline the SERVER will actually enforce, which on an accepted offer
   * is not the offer window.
   *
   * This counted down `offerExpiresAt` on both screens. On a mandate-bound row
   * accepted on day one of an eight-day offer that printed seven days left,
   * while expireStaleOffers voids the row at accepted_at + 24 h to give the
   * financer's cap back — so /dashboard said "3h 59m" and this page, one tap
   * away through the card's own button, said "7d 23h" about the same
   * obligation. The truthful number was on the card he was being led away
   * from, and this is the page where a private key is typed. `actionDueAt` is
   * the server's own arithmetic over both horizons; the window is the fallback
   * for a server that predates the field.
   */
  const actionDue = offer?.actionDueAt === undefined ? offer?.offerExpiresAt ?? null : offer.actionDueAt;
  const transferStage = offer?.status === 'accepted';
  const { msLeft, expired: clockExpired } = useCountdown(
    offer && (offer.status === 'offered' || offer.status === 'accepted') ? actionDue : null,
  );
  const lapsed = serverLapsed || offer?.status === 'expired' || clockExpired;

  /**
   * WHETHER ACCEPTING MOVED THE DEADLINE, ASKED RATHER THAN ASSUMED.
   *
   * "Pisalo je 8 dni, zdaj piše 19 ur." Both numbers were true. A purchase
   * offer a person made stands MANUAL_OFFER_VALIDITY_DAYS, and accepting it
   * ends that window and starts the ACCEPTED_TRANSFER_WINDOW_HOURS one for the
   * transfer — so the figure on screen collapsed the instant he pressed the
   * button, and nothing had told him it would.
   *
   * This does not compute the new deadline and does not know which sweep
   * applies: the server sends both moments — the window the offer stood for
   * (`offerExpiresAt`) and the deadline it will actually enforce now
   * (`actionDueAt`, from sellerActionDeadline) — and this only asks whether the
   * second is earlier than the first. On a legacy row nothing sweeps, the two
   * are the same timestamp, and no change is announced, which is correct:
   * there was none. It survives a reload for the same reason — both moments are
   * on the row, not in this component's memory.
   */
  const acceptedWindowMoved = (() => {
    if (offer?.status !== 'accepted' || !offer.offerExpiresAt || !actionDue) return false;
    const now = parseSqliteUtc(actionDue)?.getTime();
    const was = parseSqliteUtc(offer.offerExpiresAt)?.getTime();
    return now !== undefined && was !== undefined && now < was;
  })();

  /**
   * The server's `ACCEPTED_TRANSFER_WINDOW_HOURS`, mirrored so this page can
   * work out WHICH of the two deadlines the sentence above the button should
   * name. It is never used to draw a clock — every countdown on this page runs
   * on `actionDueAt`, which the server computed. src/copy.test.ts reads the
   * server constant and fails if this number and the sweeper drift apart.
   */
  const TRANSFER_WINDOW_HOURS = 24;

  /**
   * Whether the 24-hour sweep is the deadline that will bite once this offer
   * is accepted, or the offer's own window is.
   *
   * sellerActionDeadline takes the EARLIER of the two, and consults the sweep
   * only for a row carrying a `mandate_ref` — expireStaleOffers voids no other
   * kind. So there are two ways for 24 hours to be the wrong thing to say:
   *
   *   legacy row      no mandate, never swept → the offer window is the story
   *   automatic offer mandate-bound, but it stands OFFER_VALIDITY_MINUTES —
   *                   thirty minutes — so the sweep never gets near it
   *
   * The second is why this is not simply `Boolean(offer.mandateRef)`: that
   * would have printed "there are 24 hours" over a thirty-minute offer whose
   * deadline acceptance does not move at all. The question is not which kind
   * of row this is; it is whether the sweep lands before the window does.
   */
  const acceptStartsShortWindow = (() => {
    if (!offer?.mandateRef || !offer.offerExpiresAt) return false;
    const window = parseSqliteUtc(offer.offerExpiresAt)?.getTime();
    if (window === undefined) return false;
    return window > Date.now() + TRANSFER_WINDOW_HOURS * 3_600_000;
  })();

  useEffect(() => {
    if (!session) navigate('/login');
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    loadInitialData();
  }, [session]);

  const loadInitialData = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [ratingRes, walletsRes, paramsRes, profileRes, offersRes] = await Promise.all([
        fetch(`/api/user/${session.nostrHexId}/payment-score`),
        fetch(`/api/user/${session.nostrHexId}/wallets`),
        fetch('/api/system-params'),
        fetch(`/api/user/${session.nostrHexId}/profile`),
        fetch(`/api/acquisitions/mine/${session.nostrHexId}`),
      ]);

      const ratingData = await ratingRes.json();
      setUserRating(ratingData.score);
      setRatingChecked(true);

      const walletsData = await walletsRes.json();
      const paramsData = await paramsRes.json();
      const profileData = await profileRes.json();

      const fetchedWallets: RegisteredWallet[] = walletsData.wallets || [];
      setWallets(fetchedWallets);
      setSystemParams(paramsData);

      if (profileData.profile) {
        // KIND 0 `language` drives the language the terms open in.
        if (profileData.profile.language) setProfileLang(String(profileData.profile.language));
        if (profileData.profile.payment_methods) {
          setPaymentMethods(profileData.profile.payment_methods);
        }
        if (profileData.profile.bankName || profileData.profile.bankAccount) {
          setLegacyBank({
            bankName: profileData.profile.bankName,
            bankAddress: profileData.profile.bankAddress,
            bankSWIFT: profileData.profile.bankSWIFT,
            bankAccount: profileData.profile.bankAccount,
          });
        }
      }

      if (fetchedWallets.length > 0) {
        await readBalances(fetchedWallets.map((w: RegisteredWallet) => w.walletId));
      }

      const profileCurrency = profileData.profile?.currency;
      if (profileCurrency && paramsData.activeCurrencies?.includes(profileCurrency)) {
        setSelectedCurrency(profileCurrency);
      } else if (paramsData.activeCurrencies?.length > 0) {
        setSelectedCurrency(paramsData.activeCurrencies[0]);
      }

      // A live offer outlives this page. Someone who accepted and then closed
      // the tab must be able to come back and finish the transfer — the offer
      // is on the server, and without this they would be stranded in front of
      // a proposal that no longer exists in any browser.
      try {
        const mine = await offersRes.json();
        const mineOffers: AcquisitionOffer[] = mine.offers || [];
        const resumable = (o: AcquisitionOffer) => {
          if (o.status === 'under_review') return true;
          if (o.status !== 'offered' && o.status !== 'accepted') return false;
          const until = parseSqliteUtc(o.offerExpiresAt);
          return !until || until.getTime() > Date.now();
        };
        // WHICH offer, when there is more than one. /dashboard names the offer
        // whose card was tapped. Without that, this lookup takes whichever
        // live offer comes first in a created_at DESC list — so tapping a
        // 6,498.88 card could open a 501.20 offer, showing a different figure
        // than the one the thumb just touched.
        //
        // The ref is a hint about which of THIS seller's offers to resume and
        // nothing more: it is matched against the list the server already sent
        // for this signed-in hex, never fetched on the strength of the URL. A
        // ref that is absent, stale or somebody else's falls back to exactly
        // the behaviour that was here before.
        const wanted = new URLSearchParams(window.location.search).get('ref');
        const named = wanted ? mineOffers.find(o => o.offerRef === wanted && resumable(o)) : null;
        const open = named || mineOffers.find(resumable);
        if (open) {
          setOffer(open);
          setSelectedWallet(open.senderWallet);
          setSelectedCurrency(open.currency);
          setLanaAmount(String(open.lanaAmount));
          setStage(open.status === 'accepted' ? 'transfer' : 'offer');
        }
      } catch (e) {
        console.error('Open offer lookup failed:', e);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
      toast.error('Failed to load wallet data');
    } finally {
      setLoading(false);
    }
  };

  // Input count for the selected wallet — a transfer with too many inputs
  // cannot be signed, and the counterparty should learn that here.
  useEffect(() => {
    if (!selectedWallet) { setUtxoCount(null); return; }
    let cancelled = false;
    setUtxoLoading(true);
    fetch('/api/wallets/utxo-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: selectedWallet }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled && d.success) setUtxoCount(d.utxoCount || 0); })
      .catch(e => console.error('UTXO check failed:', e))
      .finally(() => { if (!cancelled) setUtxoLoading(false); });
    return () => { cancelled = true; };
  }, [selectedWallet]);

  // WHICH SPLIT — the Split a wallet was registered in decides whether we
  // acquire from it at all. Asked the moment a wallet is picked, so it is
  // learned here and not after a private key has been typed. The server checks
  // again on the offer and on the transfer; this is only the courtesy.
  useEffect(() => {
    if (!selectedWallet) { setSplitCheck(null); return; }
    let cancelled = false;
    setSplitChecking(true);
    fetch('/api/sell/split-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId: selectedWallet }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) setSplitCheck(d); })
      .catch(() => {
        if (!cancelled) setSplitCheck({
          allowed: false, code: 'SPLIT_UNVERIFIABLE',
          reason: 'Eligibility could not be checked right now. Please try again shortly.',
          walletSplit: null, currentSplit: null, allowedSplits: [],
        });
      })
      .finally(() => { if (!cancelled) setSplitChecking(false); });
    return () => { cancelled = true; };
  }, [selectedWallet]);

  /**
   * The key that signs mandate-path requests. AuthContext derived it from the
   * WIF at sign-in and holds it for the session; it never leaves the browser.
   */
  const signer = (): SigningKey | null =>
    session?.nostrPrivateKey && session?.nostrHexId
      ? { privateKeyHex: session.nostrPrivateKey, pubkeyHex: session.nostrHexId }
      : null;

  // WHICH ROUND — once the Split check has answered, ask what mandate the
  // treasury has published for this wallet. Refreshed after every decision,
  // because an offer made or withdrawn changes what remains.
  useEffect(() => {
    if (!session || !selectedWallet || !selectedCurrency || splitChecking) { if (!selectedWallet) setMandateInfo(null); return; }
    const key = signer();
    if (!key) { setMandateInfo(null); setMandateError('No signing key in this session.'); return; }
    let cancelled = false;
    setMandateLoading(true);
    setMandateError(null);
    const q = new URLSearchParams({ hexId: session.nostrHexId, wallet: selectedWallet, currency: selectedCurrency });
    signedFetch(`/api/acquisitions/mandate?${q.toString()}`, key)
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Mandate could not be read');
        if (!cancelled) setMandateInfo(d);
      })
      .catch(e => { if (!cancelled) { setMandateInfo(null); setMandateError(e.message || 'Mandate could not be read'); } })
      .finally(() => { if (!cancelled) setMandateLoading(false); });
    return () => { cancelled = true; };
  }, [session?.nostrHexId, selectedWallet, selectedCurrency, splitChecking, offer?.status, mandateRefresh]);

  // "Max" offers the balance less an estimated fee, and the transfer then has
  // to empty the wallet — otherwise it keeps a change output and the fee has
  // nowhere to come from. That flag lives in this page and is lost the moment
  // the tab is closed, so an offer resumed later would fail for want of a fee.
  // Recover it from the balance: the offer covering essentially the whole
  // wallet IS the emptying case.
  //
  // BOTH WAYS ROUND, since 11 Sept 2026. It only ever set the flag, never
  // cleared it, so a wallet that GREW after the page had decided kept saying
  // "empty me" about a wallet that no longer should be, and nothing on the
  // page could clear it — only a reload. The flag is a reading of the balance,
  // so it follows the balance.
  //
  // It is ADVICE, and only advice: `balances[…]` is rounded to 0.01 LANA,
  // which is ten times coarser than the 0.001008 the server's rule turns on,
  // so this can be wrong and sometimes must be. The server decides the shape
  // from the exact balance and the chain layer from the coins themselves;
  // since 11 Sept nothing here can cause a refusal.
  useEffect(() => {
    if (!offer) return;
    const balance = balances[offer.senderWallet];
    if (!balance) return;
    setIsEmptyWallet(offer.lanaAmount >= balance - ESTIMATED_TRANSFER_FEE_LANA * 3);
  }, [offer?.offerRef, offer?.lanaAmount, balances]);

  /**
   * Where a purchase price could be settled, in the counterparty's currency.
   * `payout` / `both` are KIND 0 scope values — a wire vocabulary, not ours.
   *
   * The literal `type` is what lets a reader (and the compiler) tell the two
   * shapes apart at the call site.
   */
  const getSettlementAccount = (): SettlementAccount | null => {
    if (!selectedCurrency) return null;

    const method = paymentMethods.find(
      pm => (pm.scope === 'payout' || pm.scope === 'both') && pm.currency === selectedCurrency,
    );
    if (method) return { type: 'modern', method };

    const anyMatch = paymentMethods.find(pm => pm.currency === selectedCurrency);
    if (anyMatch) return { type: 'modern', method: anyMatch };

    if (legacyBank && (legacyBank.bankName || legacyBank.bankAccount)) {
      return { type: 'legacy', bank: legacyBank };
    }
    return null;
  };

  // ── the three requests ────────────────────────────────────────────────

  const submitOffer = async () => {
    if (!session) return;
    const amount = parseFloat(lanaAmount);
    if (!selectedWallet || !selectedCurrency || !Number.isFinite(amount) || amount <= 0) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      // The body is signed by the session key (lib/signedRequest.ts): on the
      // mandate path the server requires it, on the legacy path it ignores
      // it. One request shape for every wallet class.
      const body = { hexId: session.nostrHexId, senderAddress: selectedWallet, lanaAmount: amount, currency: selectedCurrency };
      const key = signer();
      const res = key
        ? await signedFetch('/api/acquisitions/offers', key, { method: 'POST', body })
        : await fetch('/api/acquisitions/offers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
      const data = await res.json();
      if (!res.ok || !data.offer) {
        setSubmitError(describeOfferError(data, notOpenContext()));
        return;
      }
      setOffer(data.offer);
      setServerLapsed(false);
      setLapsedReason(null);
      setShowTerms(false);
      setStage('offer');
    } catch (err: any) {
      setSubmitError(err?.message?.includes('sign in') ? err.message : 'Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  /** Accepting or withdrawing a mandate-bound offer is signed; a legacy one is not. */
  const postForOffer = (path: string, bound: boolean) => {
    const body = { hexId: session!.nostrHexId };
    const key = signer();
    if (bound && key) return signedFetch(path, key, { method: 'POST', body });
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  };

  const acceptOffer = async () => {
    if (!session || !offer) return;
    setAccepting(true);
    try {
      const res = await postForOffer(`/api/acquisitions/${offer.offerRef}/accept`, !!offer.mandateRef);
      const data = await res.json();
      if (!res.ok || !data.offer) {
        // 409 is the offer lapsing under us, which is not an error to retry.
        // REFERENCE_MOVED says why: the reference changed while it stood.
        if (res.status === 409) {
          setServerLapsed(true);
          setLapsedReason(data.code === 'REFERENCE_MOVED' ? describeOfferError(data) : null);
        } else toast.error(describeOfferError(data) || 'This purchase offer could not be accepted.');
        return;
      }
      setOffer(data.offer);
      setShowTerms(false);
      setTransferError(null);
      setStage('transfer');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setAccepting(false);
    }
  };

  /** "Not now" — close our offer without transferring anything. */
  const declineOffer = async () => {
    if (!session || !offer) return;
    try {
      await postForOffer(`/api/acquisitions/${offer.offerRef}/withdraw`, !!offer.mandateRef);
    } catch { /* closing our own offer is best-effort; it lapses anyway */ }
    toast.success(OFFER.notNowNote);
    resetToAmount();
  };

  const refreshDecision = async () => {
    if (!session || !offer) return;
    setRefreshingDecision(true);
    try {
      const res = await fetch(`/api/acquisitions/${offer.offerRef}?hexId=${session.nostrHexId}`);
      const data = await res.json();
      if (res.ok && data.offer) setOffer(data.offer);
    } catch { /* the next tick tries again */ }
    finally { setRefreshingDecision(false); }
  };

  // A person decides on a reviewed proposal, and that can happen while this
  // page is open — so it asks, rather than leaving a stale screen up.
  useEffect(() => {
    if (stage !== 'offer' || offer?.status !== 'under_review') return;
    const id = setInterval(refreshDecision, 20000);
    return () => clearInterval(id);
  }, [stage, offer?.status, offer?.offerRef]);

  const transfer = async () => {
    if (!session || !offer) return;
    if (!privateKey.trim()) {
      toast.error('Enter the private key for this wallet');
      return;
    }
    setTransferring(true);
    setTransferError(null);
    try {
      const res = await fetch(`/api/acquisitions/${offer.offerRef}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hexId: session.nostrHexId,
          privateKey: privateKey.trim(),
          emptyWallet: isEmptyWallet,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (data.code === 'OFFER_EXPIRED') setServerLapsed(true);
        setTransferError({
          error: describeOfferError(data) || 'The transfer did not go through.',
          code: data.code,
          retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
          repeated: data.repeated === true,
        });
        return;
      }
      setResult(data);
      setPrivateKey('');
      setPrivateKeyValid(null);
      setStage('done');
      // The mandate and the wallet have both moved: this round has less left,
      // and the coins are gone. Read them again so the "propose the rest"
      // figure on the next screen is the one that is true now.
      setMandateRefresh(n => n + 1);
      refreshBalances();
    } catch {
      setTransferError({ error: 'Network error. Please try again.' });
    } finally {
      setTransferring(false);
    }
  };

  // Validate the key against the wallet locally, before anything is sent.
  const keyValidateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (keyValidateRef.current) clearTimeout(keyValidateRef.current);

    const trimmed = privateKey.trim();
    if (!trimmed) {
      setPrivateKeyValid(null);
      setPrivateKeyError('');
      return;
    }

    setValidatingKey(true);
    keyValidateRef.current = setTimeout(() => {
      try {
        const ids = convertWifToIds(trimmed);
        const sender = offer?.senderWallet || selectedWallet;
        if (ids.walletIdCompressed === sender || ids.walletIdUncompressed === sender) {
          setPrivateKeyValid(true);
          setPrivateKeyError('');
        } else {
          setPrivateKeyValid(false);
          setPrivateKeyError('This private key does not match the wallet you offered from');
        }
      } catch (err: any) {
        setPrivateKeyValid(false);
        setPrivateKeyError(err.message || 'Invalid private key format');
      } finally {
        setValidatingKey(false);
      }
    }, 500);

    return () => {
      if (keyValidateRef.current) clearTimeout(keyValidateRef.current);
    };
  }, [privateKey, offer?.senderWallet, selectedWallet]);

  /**
   * The round and date a MANDATE_NOT_OPEN refusal is about — the lowest round
   * with a date still ahead, from the mandate we already read.
   */
  const notOpenContext = () => {
    const m = [...(mandateInfo?.mandates || [])]
      .sort((a, b) => (a.split - b.split) || (a.round - b.round))
      .find(x => x.state === 'not_open' || x.state === 'upcoming_split');
    return { round: m?.round ?? null, opensAt: m?.opensAt ?? null };
  };

  /** On-chain balances for these addresses, into state. Used on load and after a sale. */
  const readBalances = async (addresses: string[]) => {
    if (addresses.length === 0) return;
    setBalancesLoading(true);
    try {
      const balRes = await fetch('/api/wallets/balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses }),
      });
      const balData = await balRes.json();
      const balMap: Record<string, number> = {};
      (balData.balances || []).forEach((b: WalletBalance) => { balMap[b.wallet_id] = b.balance; });
      setBalances(balMap);
    } catch (e) {
      console.error('Balance fetch failed:', e);
    } finally {
      setBalancesLoading(false);
    }
  };

  const refreshBalances = () => { void readBalances(wallets.map(w => w.walletId)); };

  /**
   * Start the next proposal on what is still open.
   *
   * Rounds carry their own discount — 22 % in round 1, 25 % in round 2 — so one
   * offer cannot cover two of them: it would be two prices on one row. With
   * both rounds open a holder therefore sells in two goes, and until now the
   * second go was unreachable: the page parks on a live offer, and once the
   * first sale completed nothing pointed at the rest. It just looked like the
   * treasury had refused to take it.
   */
  const proposeRemaining = (amountLana: number) => {
    resetToAmount();
    setLanaAmount(String(Math.max(0, Math.round(amountLana * 1e8) / 1e8)));
    refreshBalances();
  };

  const resetToAmount = () => {
    setOffer(null);
    setConfirmWithdraw(false);
    setServerLapsed(false);
    setLapsedReason(null);
    setShowTerms(false);
    setTransferError(null);
    setPrivateKey('');
    setPrivateKeyValid(null);
    setPrivateKeyError('');
    setSubmitError('');
    setStage('amount');
  };

  if (!session) return null;

  const walletBalance = selectedWallet ? (balances[selectedWallet] || 0) : 0;
  /**
   * A refusal the same press cannot cure. The route is the authority — it is
   * the side that knows whether the refusal was arithmetic (`retryable: false`)
   * or luck — so this reads its answer rather than guessing from the code.
   * Absent means unknown, and unknown leaves the button on: the safe direction
   * to be wrong in is "let them try".
   */
  const hopeless = transferError?.retryable === false;
  const settlementAccount = getSettlementAccount();
  const sym = (code: string) => CURRENCY_SYMBOLS[code] || '';
  const stageIndex = STAGES.indexOf(stage);
  const walletReady = !!selectedWallet && !tooManyUtxos && !utxoLoading && !!selectedCurrency
    && !!settlementAccount && !splitChecking && !!splitCheck?.allowed;
  const eligible = !ratingChecked || (userRating !== null && userRating === 10);
  // Before the round date the button is dead here, and the server would say
  // no anyway: a proposal then is a "not yet" with a date, nothing more.
  const gate = proposalGate(mandateInfo);
  const enteredAmount = parseFloat(lanaAmount);
  const canPropose = !submitting && enteredAmount > 0 && gate.allowed && !mandateLoading;
  // WHAT MAX MEANS. The smaller of the wallet and the round, worked out in
  // src/lib/maxOffer.ts. While the mandate is still being read the cap is not
  // known — and a cap that is not known is not a cap of zero, so the figure
  // stays the whole wallet — but the button declines to answer for that
  // moment rather than answering with a number that is about to change; the
  // propose button beside it is dead for the same reason (`!mandateLoading`).
  // A cap we could not READ is not a cap that does not EXIST. Both arrive here
  // as `mandateInfo === null`, and collapsing them put the original complaint
  // straight back: on a failed mandate fetch the cap became null, Max went live
  // and filled the whole wallet again — the exact number Dejan had to delete by
  // hand, under a banner saying the mandate could not be read. A legacy wallet
  // with genuinely no mandate answers 200 with an empty list and never sets
  // `mandateError`, so the two are distinguishable, and the unknown one declines
  // to answer rather than answering with a number it does not stand behind.
  const capUnknown = mandateLoading || mandateError !== null;
  const roundCapLana = capUnknown ? null : proposableCapLana(mandateInfo);
  const maxOffer = maxProposable(walletBalance, ESTIMATED_TRANSFER_FEE_LANA, roundCapLana);
  const maxUnavailable = capUnknown || maxOffer.amountLana <= 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between gap-3 h-16">
          {/* The wordmark is the part that gives way on a narrow phone: it may
              shrink and truncate, while the actions keep their full width. */}
          <Link to="/dashboard" className="flex min-w-0 items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 shrink-0 dark:invert" />
            <span className="truncate">Lana<span className="text-gold">.Discount</span></span>
          </Link>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Link to="/dashboard" className="hidden sm:inline text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap">
              Dashboard
            </Link>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="rounded-lg border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors whitespace-nowrap"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      <div className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-12 max-w-3xl">
        {/* Header */}
        <div className="mb-8 space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{OFFER.pageTitle}</h1>
          <p className="text-muted-foreground">{OFFER.pageIntro}</p>
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-xs text-blue-700 dark:text-blue-400">
            {OFFER.settlementTiming}
          </div>
        </div>

        {/* Stage indicator */}
        <div className="flex items-center gap-2 mb-8">
          {STAGES.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                i === stageIndex ? 'bg-primary text-white' :
                i < stageIndex || stage === 'done' ? 'bg-primary/20 text-primary' :
                'bg-muted text-muted-foreground'
              }`}>
                {i < stageIndex || stage === 'done' ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : i + 1}
              </div>
              {i < STAGES.length - 1 && (
                <div className={`w-8 h-0.5 ${i < stageIndex || stage === 'done' ? 'bg-primary/40' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {/* Open obligations of their own — the first thing that decides
                whether we will look at a proposal at all. */}
            {ratingChecked && eligible && (
              <div className="flex items-center gap-3 rounded-xl border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-4 py-3 mb-4">
                <svg className="h-5 w-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                <span className="min-w-0 text-sm text-green-700 dark:text-green-400">
                  No open obligations — <strong>{userRating}/10</strong>
                </span>
              </div>
            )}

            {ratingChecked && !eligible ? (
              <div className="rounded-2xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-6 text-center space-y-4 mb-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
                  <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </div>
                <h2 className="text-xl font-bold text-red-700 dark:text-red-400">{OFFER.blockedTitle}</h2>
                <p className="text-sm text-red-600 dark:text-red-400 max-w-md mx-auto leading-relaxed">
                  {OFFER.blockedBody}
                </p>
                {userRating !== null && (
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-100 dark:bg-red-900/40">
                    <span className="text-sm font-medium text-red-700 dark:text-red-400">
                      Your current rating: {userRating}/10
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            {eligible && (
            <>
            {/* ============ 1. WHICH WALLET ============ */}
            {stage === 'wallet' && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-4">{OFFER.selectWallet}</h2>

                  {wallets.length > 0 ? (
                    <div className="space-y-3">
                      {wallets.map(w => {
                        const isFrozen = !!w.freezeStatus;
                        // Not every freeze stops a sale. An OWN-process freeze
                        // on a LanaPays.Us wallet does not, and telling that
                        // seller to "unfreeze it first" pointed them at
                        // something they cannot undo, at a URL that does not
                        // exist either. The server decides;
                        // absent (an older server) still means blocked.
                        const frozenBlocks = isFrozen && w.freezeStops !== false;
                        // A whole class the treasury has paused. Absent means
                        // acquiring, so an older server never greys anything out.
                        const notAcquiring = w.acquiring === false;
                        const blocked = frozenBlocks || notAcquiring;
                        return (
                          <button
                            key={w.walletId}
                            // A frozen wallet cannot transfer, so it cannot be
                            // offered from. The server refuses it too; this
                            // only stops the walk into a dead end.
                            disabled={blocked}
                            title={notAcquiring ? OFFER.walletNotAcquiringBody : frozenBlocks ? OFFER.walletFrozen : undefined}
                            onClick={() => { if (!blocked) setSelectedWallet(w.walletId); }}
                            className={`w-full rounded-xl border-2 px-4 sm:px-5 py-4 text-left transition-all ${
                              selectedWallet === w.walletId
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-muted-foreground/30'
                            } ${blocked ? 'opacity-60 cursor-not-allowed hover:border-border' : ''}`}
                          >
                            <div className="flex items-start gap-3 sm:gap-4">
                              <div className="flex-1 min-w-0">
                                {/* min-w-0 has to repeat on EVERY level of the
                                    chain: without it here the inner row keeps
                                    its intrinsic width, the address refuses to
                                    shrink, and on a phone it runs underneath
                                    the balance. */}
                                <div className="flex min-w-0 items-center gap-2 mb-1">
                                  <span className="font-mono text-sm font-medium text-foreground truncate">
                                    {w.walletId.slice(0, 10)}...{w.walletId.slice(-6)}
                                  </span>
                                  {notAcquiring && (
                                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                      {OFFER.walletNotAcquiring}
                                    </span>
                                  )}
                                  {isFrozen && (
                                    <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                      frozenBlocks
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                                    }`}>
                                      {frozenBlocks ? 'Frozen' : 'Frozen · can sell'}
                                    </span>
                                  )}
                                </div>
                                {notAcquiring && (
                                  <p className="text-xs text-muted-foreground mb-1">
                                    {OFFER.walletNotAcquiringBody}
                                  </p>
                                )}
                                {isFrozen && frozenBlocks && !notAcquiring && (
                                  <p className="text-xs text-blue-700 mb-1">
                                    {OFFER.walletFrozen}
                                  </p>
                                )}
                                {isFrozen && !frozenBlocks && !notAcquiring && (
                                  <p className="text-xs text-green-700 dark:text-green-400 mb-1">
                                    {OFFER.walletFrozenSellable}
                                  </p>
                                )}
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  <span className="inline-flex items-center gap-1">
                                    <span className="font-medium text-foreground/70">Type:</span>
                                    {w.walletType}
                                  </span>
                                  {w.note && (
                                    <span className="inline-flex min-w-0 items-center gap-1">
                                      <span className="font-medium text-foreground/70">Note:</span>
                                      <span className="truncate">{w.note}</span>
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Balance — never shrinks, never wraps. */}
                              <div className="text-right flex-shrink-0 whitespace-nowrap">
                                {balancesLoading && balances[w.walletId] === undefined ? (
                                  <div className="h-4 w-20 animate-pulse bg-muted rounded" />
                                ) : balances[w.walletId] !== undefined ? (
                                  <div>
                                    <span className="font-mono text-sm font-bold text-foreground">
                                      {formatLana(balances[w.walletId])}
                                    </span>
                                    <span className="text-xs text-muted-foreground ml-1">LANA</span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 dark:border-amber-800 p-4 text-center">
                      <p className="text-sm text-amber-700 dark:text-amber-400 font-medium mb-1">No registered wallets found</p>
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        No wallets are registered for your account. Please contact support.
                      </p>
                    </div>
                  )}
                </div>

                {/* The currency we would settle in — taken from the profile,
                    and shown WITHOUT a rate: there is no price at this stage. */}
                {selectedCurrency && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{OFFER.settlementCurrencyLabel}</p>
                      <p className="text-sm font-semibold">{selectedCurrency}</p>
                    </div>
                    {settlementAccount && (
                      <div className="min-w-0 text-right">
                        <p className="text-xs text-muted-foreground">Settled to</p>
                        <p className="text-sm font-medium truncate">
                          {settlementAccount.type === 'modern'
                            ? (settlementAccount.method.label || SCHEME_LABELS[settlementAccount.method.scheme] || settlementAccount.method.scheme)
                            : (settlementAccount.bank.bankName || settlementAccount.bank.bankAccount)}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Too many inputs to sign a single transfer */}
                {selectedWallet && tooManyUtxos && (
                  <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-2">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400">{OFFER.consolidateTitle}</p>
                    <p className="text-xs text-red-600 dark:text-red-500">
                      {OFFER.consolidateBody} This wallet has <strong>{utxoCount}</strong> separate inputs; the limit is {MAX_UTXOS}.
                    </p>
                    <a href="https://youtu.be/kBi4MKcc4qM?si=bIeWS_dlgHjFproo" target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline">
                      Watch: how to consolidate your wallet
                    </a>
                  </div>
                )}

                {selectedWallet && utxoLoading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent inline-block" />
                    Checking this wallet…
                  </p>
                )}

                {/* Nothing to settle a purchase price to */}
                {selectedCurrency && !settlementAccount && (
                  <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-3">
                    <p className="text-sm font-bold text-red-700 dark:text-red-400">{OFFER.noSettlementAccountTitle}</p>
                    <p className="text-xs text-red-600 dark:text-red-500">
                      {OFFER.noSettlementAccountBody.replace('{currency}', selectedCurrency)}
                    </p>
                    {paymentMethods.filter(pm => pm.scope === 'payout' || pm.scope === 'both').length > 0 ? (
                      <div className="text-xs text-red-600 dark:text-red-500">
                        <p className="font-medium mb-1">Your profile has details for:</p>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {paymentMethods
                            .filter(pm => pm.scope === 'payout' || pm.scope === 'both')
                            .map((pm, i) => (
                              <li key={i} className="min-w-0">
                                <strong>{pm.currency}</strong> — {pm.label || pm.scheme}
                                {pm.fields?.iban && <span className="font-mono ml-1">({pm.fields.iban.slice(-4)})</span>}
                                {pm.fields?.account_number && <span className="font-mono ml-1">({pm.fields.account_number.slice(-4)})</span>}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : legacyBank ? (
                      <div className="text-xs text-red-600 dark:text-red-500">
                        <p className="font-medium mb-1">Your profile has older bank details with no currency set:</p>
                        <p className="font-mono truncate">{legacyBank.bankName} — {legacyBank.bankAccount}</p>
                      </div>
                    ) : null}
                    <p className="text-xs text-red-600 dark:text-red-500">
                      <a href="https://app.mejmosefajn.org/profile" target="_blank" rel="noopener noreferrer"
                        className="font-medium underline hover:text-red-800 dark:hover:text-red-300">
                        Update your profile
                      </a>{' '}
                      to add details in {selectedCurrency}.
                    </p>
                  </div>
                )}

                {/* Which Split this wallet belongs to */}
                {selectedWallet && splitCheck && !splitCheck.allowed && (
                  <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 space-y-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{OFFER.walletOutOfScopeTitle}</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400">{splitCheck.reason}</p>
                    {splitCheck.walletSplit !== null && splitCheck.currentSplit !== null && (
                      <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                        Wallet Split {splitCheck.walletSplit} · current Split {splitCheck.currentSplit}
                      </p>
                    )}
                  </div>
                )}

                {/* Which financing round this wallet belongs to — read after
                    the Split check, so the counterparty learns here whether
                    and when the treasury accepts proposals from it. */}
                {selectedWallet && !splitChecking && splitCheck && (
                  <MandatePanel
                    info={mandateInfo}
                    loading={mandateLoading}
                    error={mandateError}
                    lanaAmount={null}
                    currency={selectedCurrency}
                    showIndicative={false}
                  />
                )}

                <div className="flex justify-between gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Cancel
                  </Link>
                  <button
                    onClick={() => setStage('amount')}
                    disabled={!walletReady}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      walletReady ? 'bg-primary hover:bg-primary/90 shadow-lg' : 'bg-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    {splitChecking ? 'Checking…' : 'Next'}
                  </button>
                </div>
              </div>
            )}

            {/* ============ 2. HOW MUCH ============ */}
            {stage === 'amount' && (
              <div className="space-y-6">
                {/* THE ANSWER COMES BEFORE THE QUESTION. This panel used to
                    sit under the amount field, so the figure a seller needs in
                    order to answer "how much?" was below the box he answers it
                    in: «moraš dol gledat koliko lahko, potem pa gor, koliko
                    boš» — you look down to see how much you may, then back up
                    to type how much you will. It carries the indicative figure
                    for whatever is typed, which is a projection under its own
                    heading and never a price. */}
                <MandatePanel
                  info={mandateInfo}
                  loading={mandateLoading}
                  error={mandateError}
                  lanaAmount={enteredAmount > 0 ? enteredAmount : null}
                  currency={selectedCurrency}
                  showIndicative
                  compact
                />

                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-1">{OFFER.amountTitle}</h2>
                  <p className="text-sm text-muted-foreground mb-4">{OFFER.amountHint}</p>

                  <label className="block text-sm font-medium text-foreground mb-1.5">{OFFER.amountLabel}</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={lanaAmount}
                      onChange={e => { setLanaAmount(e.target.value); setIsEmptyWallet(false); setSubmitError(''); }}
                      placeholder="e.g. 100000"
                      min="1"
                      className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    />
                    {walletBalance > 0 && (
                      <button
                        onClick={() => {
                          // The smaller of the wallet and the round. Emptying
                          // the wallet is a property of the WALLET limit: when
                          // the round is what stopped it, LANA stays behind, a
                          // change output remains, and the fee comes out of it.
                          setLanaAmount(String(maxOffer.amountLana));
                          setIsEmptyWallet(maxOffer.emptiesWallet);
                          setSubmitError('');
                        }}
                        disabled={maxUnavailable}
                        title={mandateLoading ? MANDATE.loading : maxOffer.amountLana <= 0 ? gate.reason : undefined}
                        data-testid="max-button"
                        className={`shrink-0 rounded-lg border px-4 py-3 text-sm font-semibold transition-colors ${
                          maxUnavailable
                            ? 'border-border bg-muted/40 text-muted-foreground cursor-not-allowed'
                            : 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'
                        }`}
                      >
                        Max
                      </button>
                    )}
                  </div>
                  {walletBalance > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Available: {formatLana(walletBalance)} LANA
                    </p>
                  )}
                  {/* How much the open round can take; above it comes a
                      counteroffer for what remains, not a refusal. */}
                  {gate.openRound && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="cap-hint">
                      {fill(OFFER.capHint, { round: gate.openRound.round, remaining: formatLana(gate.openRound.remainingLana) })}{' '}
                      {OFFER.capHintAbove}
                    </p>
                  )}
                  {!gate.allowed && gate.reason && (
                    <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{gate.reason}</p>
                  )}

                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-xs">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">Offered from</span>
                      <span className="font-mono truncate">{shortAddress(selectedWallet)}</span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.settlementCurrencyLabel}</span>
                      <span className="font-semibold flex-shrink-0 whitespace-nowrap">{selectedCurrency}</span>
                    </div>
                  </div>

                  {submitError && (
                    <div className="mt-4 rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
                      <p className="text-sm text-red-700 dark:text-red-400">{submitError}</p>
                    </div>
                  )}
                </div>

                <div className="flex justify-between gap-3">
                  <button onClick={() => setStage('wallet')} className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    Back
                  </button>
                  <button
                    onClick={submitOffer}
                    disabled={!canPropose}
                    title={!gate.allowed ? gate.reason : undefined}
                    className={`rounded-xl px-6 py-3 font-semibold text-white transition-all ${
                      !canPropose
                        ? 'bg-muted-foreground/30 cursor-not-allowed'
                        : 'bg-primary hover:bg-primary/90 shadow-lg'
                    }`}
                  >
                    {submitting ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        {OFFER.submitting}
                      </span>
                    ) : !gate.allowed ? OFFER.proposeNotYet : OFFER.submit}
                  </button>
                </div>
              </div>
            )}

            {/* ============ 3. OUR DECISION ============ */}
            {stage === 'offer' && offer && (
              <div className="space-y-6">
                {/* It lapsed while it was being read. Nothing moved. */}
                {lapsed && offer.status !== 'declined' && offer.status !== 'under_review' ? (
                  <div className="rounded-2xl border-2 border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-6 space-y-3">
                    <h2 className="text-xl font-bold text-amber-800 dark:text-amber-300">{OFFER.lapsedTitle}</h2>
                    <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">{lapsedReason || OFFER.lapsedBody}</p>
                    <button
                      onClick={resetToAmount}
                      className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                    >
                      {OFFER.lapsedAgain}
                    </button>
                  </div>
                ) : offer.status === 'offered' ? (
                  <>
                    <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-5 sm:p-6 space-y-4">
                      {/* Above the remaining mandate the treasury counters for
                          what is left (P08 §2). Said first, in one sentence. */}
                      {offer.isCounteroffer && offer.proposedLanaAmount !== null && offer.proposedLanaAmount !== undefined && (
                        <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-200 text-amber-900">
                              {OFFER.counterTag}
                            </span>
                            {offer.round && <span className="text-[11px] text-amber-800 dark:text-amber-300">Round {offer.round}</span>}
                          </div>
                          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{OFFER.counterTitle}</p>
                          <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">
                            {counterBody(offer.proposedLanaAmount, offer.lanaAmount)}
                          </p>
                        </div>
                      )}
                      <div>
                        <h2 className="text-xl font-bold text-foreground">{OFFER.offeredTitle}</h2>
                        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{OFFER.offeredBody}</p>
                        {offer.round && !offer.isCounteroffer && (
                          <p className="mt-1 text-xs text-muted-foreground">Financing round {offer.round}</p>
                        )}
                      </div>

                      <div className="rounded-xl border border-border bg-card p-4 space-y-2.5 text-sm">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                          <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                            {formatLana(offer.lanaAmount)} LANA
                          </span>
                        </div>
                        <div className="border-t border-border pt-2.5 flex min-w-0 items-center justify-between gap-3">
                          <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                          <span className="font-mono font-bold text-lg text-primary flex-shrink-0 whitespace-nowrap">
                            {sym(offer.currency)}{(offer.purchasePrice ?? 0).toFixed(2)} {offer.currency}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                          <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(offer.settlementDueAt)}</span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.offeredExpiryLabel}</span>
                          <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatMoment(offer.offerExpiresAt)}</span>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                          <span className="font-mono text-xs text-foreground flex-shrink-0 whitespace-nowrap">{offer.offerRef}</span>
                        </div>
                      </div>

                      {msLeft !== null && (
                        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-card border border-border px-4 py-2.5">
                          <span className="text-xs text-muted-foreground">{OFFER.timeLeftLabel}</span>
                          <span className={`font-mono text-sm font-bold flex-shrink-0 whitespace-nowrap ${
                            msLeft < 120000 ? 'text-red-600' : 'text-foreground'
                          }`}>
                            {formatLeft(msLeft)}
                          </span>
                        </div>
                      )}

                      {/* WHAT THE BUTTON BELOW STARTS, SAID BEFORE IT IS
                          PRESSED. The clock above is the offer window; accepting
                          closes it and opens a shorter one for the transfer,
                          and the only place that fact is any use is here, while
                          accepting later is still an option. It sits inside the
                          offer card so it stays on screen when the terms gate
                          opens over the buttons. Informational, not amber: the
                          24 hours are real and the server keeps them, and that
                          is the whole of the claim. */}
                      <div
                        className="rounded-xl border border-border bg-muted/40 p-4 space-y-1.5"
                        data-testid="accept-starts"
                      >
                        <p className="text-sm font-semibold text-foreground">{OFFER.acceptStartsTitle}</p>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {acceptStartsShortWindow
                            ? OFFER.acceptStartsBody
                            : fill(OFFER.acceptStartsBodyWindow, { until: formatMoment(offer.offerExpiresAt) })}
                        </p>
                        {acceptStartsShortWindow && (
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {fill(OFFER.acceptStartsWhen, { until: formatMoment(offer.offerExpiresAt) })}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* The terms stand in front of acceptance, because that is
                        the contract moment — and the server records which
                        version was shown when /accept succeeds. */}
                    {showTerms ? (
                      <SellTermsGate
                        defaultLang={/^sl/i.test(profileLang) ? 'sl' : 'en'}
                        busy={accepting}
                        onAccept={acceptOffer}
                        onCancel={() => setShowTerms(false)}
                      />
                    ) : (
                      <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                        <button
                          onClick={declineOffer}
                          className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {OFFER.offeredDecline}
                        </button>
                        <button
                          onClick={() => setShowTerms(true)}
                          className="rounded-xl bg-primary px-6 py-3 font-semibold text-white hover:bg-primary/90 shadow-lg transition-all"
                        >
                          {OFFER.offeredAccept}
                        </button>
                      </div>
                    )}
                  </>
                ) : offer.status === 'under_review' ? (
                  /* THE SCREEN IS WRITTEN FOR LEAVING, NOT FOR STAYING.
                     What waits here is a person's working day, and the only
                     correct next action is to go and live yours — so the
                     acknowledgement comes first, the exit is the loudest
                     control, and nothing on the card moves. */
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-5" data-testid="submitted-card">
                    <div className="flex items-start gap-3">
                      {/* STATIC, and deliberately not green. The spinner that
                          stood here was a progress indicator on something not
                          in progress in this browser: it promised "this
                          finishes if you stay", and what finishes it is a
                          person who may decide tomorrow. A green tick over
                          "submitted" would be read as "they said yes", which
                          is the one misreading worse than the spinner — so the
                          mark is the dashboard's own under-review blue, and it
                          belongs to the act of submitting, which IS finished. */}
                      <span
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                        data-testid="submitted-mark"
                        aria-hidden="true"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                      <div className="min-w-0">
                        <h2 className="text-xl font-bold text-foreground">{OFFER.reviewTitle}</h2>
                        <span
                          className="mt-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                          data-testid="review-state"
                        >
                          {OFFER.reviewStateLabel}
                        </span>
                        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{OFFER.reviewBody}</p>
                      </div>
                    </div>

                    {/* The server's own sentence about why this one reached a
                        person — rendered only when it sent one. */}
                    {offer.decisionReason && (
                      <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-1" data-testid="review-why">
                        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{OFFER.reviewWhyLabel}</p>
                        <p className="text-sm text-foreground leading-relaxed">{offer.decisionReason}</p>
                      </div>
                    )}

                    <div className="rounded-xl bg-muted/30 border border-border p-4 space-y-2 text-sm">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                        {/* The one durable token of the whole transaction, and
                            the thing to carry away — so it is set to be read,
                            not to match the label beside it. */}
                        <span className="font-mono text-base font-bold text-foreground flex-shrink-0 whitespace-nowrap">{offer.offerRef}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{OFFER.reviewRefNote}</p>
                      <div className="flex min-w-0 items-center justify-between gap-3 pt-1 border-t border-border/60">
                        <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                        <span className="font-mono text-foreground flex-shrink-0 whitespace-nowrap">{formatLana(offer.lanaAmount)} LANA</span>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">{OFFER.settlementCurrencyLabel}</span>
                        <span className="text-foreground flex-shrink-0 whitespace-nowrap">{offer.currency}</span>
                      </div>
                    </div>

                    <div className="space-y-2" data-testid="what-happens-now">
                      <p className="text-sm font-semibold text-foreground">{OFFER.reviewNextTitle}</p>
                      <p className="text-sm text-foreground leading-relaxed">{OFFER.reviewCanClose}</p>
                      <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.reviewNoDeadline}</p>
                      <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.reviewNoMessage}</p>
                      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{OFFER.reviewAfterDecision}</p>
                      <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.reviewWhere}</p>
                    </div>

                    {/* The exit is the primary button. Telling someone they may
                        leave while the loudest control on the screen asks them
                        to press it again is advice the page contradicts with
                        its own buttons. */}
                    <div className="space-y-2">
                      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
                        <button
                          onClick={refreshDecision}
                          disabled={refreshingDecision}
                          className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          {refreshingDecision ? OFFER.reviewChecking : OFFER.reviewCheckNow}
                        </button>
                        <Link
                          to="/dashboard"
                          className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-center text-white hover:bg-primary/90 shadow-lg transition-all"
                        >
                          {OFFER.reviewBack}
                        </Link>
                      </div>
                      <p className="text-xs text-muted-foreground">{OFFER.reviewAutoCheck}</p>
                    </div>

                    {/* A proposal under review parks this page on it, so without a
                        way out the seller cannot propose anything else at all —
                        which is exactly where one stood on 9 Sept 2026. Below a
                        rule, and behind a confirmation, because on this screen
                        the try-again instinct would otherwise land on it. */}
                    <div className="border-t border-border pt-4 space-y-2">
                      <p className="text-sm font-semibold text-foreground">{OFFER.reviewChangeTitle}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">{OFFER.reviewChangeBody}</p>
                      {confirmWithdraw ? (
                        <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3" data-testid="withdraw-confirm">
                          <p className="text-sm font-semibold text-foreground">
                            {fill(OFFER.reviewWithdrawConfirm, { ref: offer.offerRef })}
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">{OFFER.reviewWithdrawConfirmBody}</p>
                          <div className="flex flex-col-reverse sm:flex-row gap-2">
                            <button
                              onClick={() => setConfirmWithdraw(false)}
                              className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {OFFER.reviewWithdrawNo}
                            </button>
                            <button
                              onClick={() => { setConfirmWithdraw(false); declineOffer(); }}
                              className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-accent transition-colors"
                            >
                              {OFFER.reviewWithdrawYes}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmWithdraw(true)}
                          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                        >
                          {OFFER.reviewWithdraw}
                        </button>
                      )}
                    </div>
                  </div>
                ) : offer.status === 'declined' && offer.mandateCode === 'MANDATE_NOT_OPEN' ? (
                  // Before the round date: a "not yet" with the date. The date
                  // opens a mandate; it is not a place in any line.
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <h2 className="text-xl font-bold text-foreground">{OFFER.notOpenTitle}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {fill(OFFER.notOpenBody, {
                        round: offer.round ?? notOpenContext().round ?? '—',
                        date: fmtUtc(notOpenContext().opensAt),
                      })}
                    </p>
                    <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                      <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                        Back to Dashboard
                      </Link>
                      <button
                        onClick={resetToAmount}
                        className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                      >
                        {OFFER.lapsedAgain}
                      </button>
                    </div>
                  </div>
                ) : offer.status === 'declined' ? (
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <h2 className="text-xl font-bold text-foreground">{OFFER.declinedTitle}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.declinedBody}</p>
                    {offer.decisionReason && (
                      <div className="rounded-xl bg-muted/30 border border-border p-4">
                        <p className="text-sm text-foreground leading-relaxed">{offer.decisionReason}</p>
                      </div>
                    )}
                    <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                      <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                        Back to Dashboard
                      </Link>
                      <button
                        onClick={resetToAmount}
                        className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                      >
                        {OFFER.lapsedAgain}
                      </button>
                    </div>
                  </div>
                ) : (
                  // withdrawn, or anything else that is no longer live
                  <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6 space-y-4">
                    <p className="text-sm text-muted-foreground leading-relaxed">{OFFER.notNowNote}</p>
                    <button
                      onClick={resetToAmount}
                      className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                    >
                      {OFFER.lapsedAgain}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ============ 4. TRANSFER ============ */}
            {stage === 'transfer' && offer && (
              lapsed ? (
                <div className="rounded-2xl border-2 border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-6 space-y-3">
                  <h2 className="text-xl font-bold text-amber-800 dark:text-amber-300">{OFFER.lapsedTitle}</h2>
                  <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">{OFFER.lapsedBody}</p>
                  <button
                    onClick={resetToAmount}
                    className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                  >
                    {OFFER.lapsedAgain}
                  </button>
                </div>
              ) : (
              <div className="space-y-6">
                {/* THE CLOCK CHANGED WHILE HE WAS PRESSING A BUTTON — SAID
                    FIRST, ABOVE THE SCREEN THAT NOW SHOWS THE NEW NUMBER.
                    The seller who accepted a purchase offer that stood eight
                    days arrived here to find nineteen hours, with both moments
                    correct and no sentence anywhere joining them. Both come off
                    the row the server just returned, so this states the change
                    only where the deadline really moved. */}
                {acceptedWindowMoved && (
                  <div
                    className="rounded-2xl border border-blue-200 bg-blue-50 p-5 space-y-1.5 dark:border-blue-500/30 dark:bg-blue-500/10"
                    data-testid="window-changed"
                  >
                    <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">{OFFER.windowChangedTitle}</p>
                    <p className="text-sm leading-relaxed text-blue-800 dark:text-blue-300">
                      {fill(OFFER.windowChangedBody, {
                        was: formatMoment(offer.offerExpiresAt),
                        now: formatMoment(actionDue),
                      })}
                    </p>
                  </div>
                )}

                <div className="rounded-2xl border-2 border-border bg-card p-5 sm:p-6">
                  <h2 className="text-lg font-semibold text-foreground mb-1">{OFFER.transferTitle}</h2>
                  <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{OFFER.transferBody}</p>

                  <div className="rounded-xl bg-muted/30 border border-border p-4 space-y-2 text-sm mb-5">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">From</span>
                      <span className="font-mono text-foreground truncate">{shortAddress(offer.senderWallet)}</span>
                    </div>
                    {systemParams?.treasuryWalletId && (
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <span className="text-muted-foreground">Treasury wallet</span>
                        <span className="font-mono text-foreground truncate">{shortAddress(systemParams.treasuryWalletId)}</span>
                      </div>
                    )}
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.amountLabel}</span>
                      <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                        {formatLana(offer.lanaAmount)} LANA
                      </span>
                    </div>
                    <div className="border-t border-border pt-2 flex min-w-0 items-center justify-between gap-3">
                      <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                      <span className="font-mono font-bold text-primary flex-shrink-0 whitespace-nowrap">
                        {sym(offer.currency)}{(offer.purchasePrice ?? 0).toFixed(2)} {offer.currency}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                      <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(offer.settlementDueAt)}</span>
                    </div>
                  </div>

                  {msLeft !== null && (
                    <div className="mb-5 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
                      {/* The offer is already accepted on this screen; what is
                          left to do is the transfer, and the clock is counting
                          down to the sweep that voids it. */}
                      <span className="text-xs text-muted-foreground">
                        {transferStage ? OFFER.timeLeftTransferLabel : OFFER.timeLeftLabel}
                      </span>
                      <span className={`font-mono text-sm font-bold flex-shrink-0 whitespace-nowrap ${
                        msLeft < 120000 ? 'text-red-600' : 'text-foreground'
                      }`}>
                        {formatLeft(msLeft)}
                      </span>
                    </div>
                  )}

                  {/* Private key */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">{OFFER.keyLabel}</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={privateKey}
                        onChange={e => setPrivateKey(e.target.value)}
                        placeholder="Enter your WIF private key"
                        className={`min-w-0 flex-1 rounded-lg border bg-background px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-colors ${
                          privateKeyValid === true
                            ? 'border-green-500 focus:ring-green-500/30 focus:border-green-500'
                            : privateKeyValid === false
                              ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                              : 'border-border focus:ring-primary/30 focus:border-primary'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowQrScanner(true)}
                        className="shrink-0 rounded-lg border border-border bg-background px-4 py-3 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                        title="Scan QR code"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75zM6.75 16.5h.75v.75h-.75v-.75zM16.5 6.75h.75v.75h-.75v-.75zM13.5 13.5h.75v.75h-.75v-.75zM13.5 19.5h.75v.75h-.75v-.75zM19.5 13.5h.75v.75h-.75v-.75zM19.5 19.5h.75v.75h-.75v-.75zM16.5 16.5h3v3h-3v-3z" />
                        </svg>
                        <span className="text-sm font-medium hidden sm:inline">Scan</span>
                      </button>
                    </div>
                    {validatingKey && (
                      <p className="mt-1.5 text-xs text-muted-foreground animate-pulse">Checking private key…</p>
                    )}
                    {!validatingKey && privateKeyValid === true && (
                      <p className="mt-1.5 text-xs text-green-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Private key matches the wallet you offered from
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === false && (
                      <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        {privateKeyError}
                      </p>
                    )}
                    {!validatingKey && privateKeyValid === null && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{OFFER.keyNote}</p>
                    )}
                  </div>

                  {showQrScanner && (
                    <Suspense fallback={
                      <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center">
                        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                      </div>
                    }>
                      <QrScanner
                        onScan={(value) => {
                          setPrivateKey(value);
                          setShowQrScanner(false);
                          toast.success('QR code scanned successfully');
                        }}
                        onClose={() => setShowQrScanner(false)}
                      />
                    </Suspense>
                  )}

                  {/* A refusal here is not a failed acquisition: the offer is
                      still ours to honour, so the key can be corrected and the
                      transfer tried again. */}
                  {transferError && (
                    <div className="mt-5 rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 space-y-2">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                        {transferError.code === 'WALLET_FROZEN' ? 'This wallet is frozen' : 'The transfer did not go through'}
                      </p>
                      <p className="text-xs text-red-600 dark:text-red-500 leading-relaxed">{transferError.error}</p>
                      {/* Said plainly, because the button below is now off. The
                          sentence above already says WHAT must change; this one
                          says that pressing again is not the way to change it. */}
                      {hopeless && (
                        <p className="text-xs font-medium text-red-700 dark:text-red-400 leading-relaxed">
                          {transferError.repeated
                            ? 'The wallet has not changed since the last attempt, so nothing was sent this time. Pressing again gives this same answer.'
                            : 'Pressing again cannot change this answer.'}{' '}
                          Put that right in the wallet, then check it again here.
                        </p>
                      )}
                      {hopeless && (
                        <button
                          type="button"
                          onClick={() => { setTransferError(null); refreshBalances(); }}
                          disabled={balancesLoading}
                          className="mt-1 rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 transition-colors"
                        >
                          {balancesLoading ? 'Checking the wallet…' : 'Check the wallet again'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                    Back to Dashboard
                  </Link>
                  <button
                    onClick={transfer}
                    disabled={transferring || !privateKey.trim() || privateKeyValid !== true || hopeless}
                    className={`rounded-xl px-8 py-3 font-semibold text-white transition-all ${
                      transferring || !privateKey.trim() || privateKeyValid !== true || hopeless
                        ? 'bg-muted-foreground/30 cursor-not-allowed'
                        : 'bg-primary hover:bg-primary/90 shadow-lg'
                    }`}
                  >
                    {transferring ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        {OFFER.transferring}
                      </span>
                    ) : OFFER.transferConfirm}
                  </button>
                </div>
              </div>
              )
            )}

            {/* ============ 5. DONE ============ */}
            {stage === 'done' && result && (
              <div className="space-y-6">
                <div className="rounded-2xl border-2 border-green-200 dark:border-green-800 bg-green-50/30 dark:bg-green-950/20 p-6 sm:p-8">
                  <div className="text-center">
                    <div className="h-16 w-16 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center mx-auto mb-4">
                      <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-foreground mb-2">{OFFER.completedTitle}</h2>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">{OFFER.completedBody}</p>
                  </div>

                  <div className="mt-6 rounded-xl border border-green-200 dark:border-green-800 bg-card p-4 space-y-2.5 text-sm max-w-md mx-auto">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.completedAcquiredLabel}</span>
                      <span className="font-mono font-bold text-foreground flex-shrink-0 whitespace-nowrap">
                        {formatLana(result.lanaAmount)} LANA
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="font-semibold text-foreground">{OFFER.offeredPriceLabel}</span>
                      <span className="font-mono font-bold text-primary flex-shrink-0 whitespace-nowrap">
                        {sym(result.currency)}{(result.purchasePrice ?? 0).toFixed(2)} {result.currency}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.offeredDueLabel}</span>
                      <span className="font-medium text-foreground flex-shrink-0 whitespace-nowrap">{formatDay(result.settlementDueAt)}</span>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{OFFER.reviewRef}</span>
                      <span className="font-mono text-xs text-foreground flex-shrink-0 whitespace-nowrap">{result.offerRef}</span>
                    </div>
                    <div className="border-t border-border pt-2.5">
                      <span className="text-xs text-muted-foreground">{OFFER.transferHashLabel}</span>
                      <div className="font-mono text-xs text-foreground break-all mt-0.5 select-all">{result.txHash}</div>
                    </div>
                  </div>

                  <p className="mt-5 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                    {OFFER.settlementTiming}
                  </p>
                </div>

                {/* One round per offer, so a holder with LANA in two open
                    rounds sells in two goes. This is the second go — without
                    it the page ends here and the rest looks refused. */}
                {(() => {
                  const left = availabilityOf(mandateInfo);
                  if (!left || left.perProposalLana <= 0) return null;
                  return (
                    <div className="rounded-2xl border-2 border-primary/40 bg-primary/5 p-5 space-y-3 text-center" data-testid="propose-remaining">
                      <p className="text-sm font-bold text-foreground">{OFFER.remainingTitle}</p>
                      <p className="text-2xl font-bold font-mono text-foreground">
                        {formatLana(left.nowLana)}{' '}
                        <span className="text-sm font-sans">LANA</span>
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed max-w-md mx-auto">
                        {fill(OFFER.remainingBody, {
                          amount: formatLana(left.perProposalLana),
                          round: left.perProposalRound,
                        })}
                      </p>
                      <button
                        onClick={() => proposeRemaining(left.perProposalLana)}
                        className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
                      >
                        {fill(OFFER.remainingCta, {
                          amount: formatLana(left.perProposalLana),
                        })}
                      </button>
                    </div>
                  );
                })()}

                <div className="flex flex-col-reverse sm:flex-row sm:justify-center gap-3">
                  <Link to="/dashboard" className="rounded-xl border border-border px-6 py-3 text-sm font-medium text-center text-muted-foreground hover:text-foreground transition-colors">
                    Back to Dashboard
                  </Link>
                  <Link
                    to="/obligations"
                    className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-center text-white hover:bg-primary/90 transition-colors"
                  >
                    {LANDING.settlementsLink}
                  </Link>
                </div>
              </div>
            )}
            </>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        {BRAND} — {LANDING.heroEyebrow}
      </footer>
    </div>
  );
};

export default SubmitOffer;
