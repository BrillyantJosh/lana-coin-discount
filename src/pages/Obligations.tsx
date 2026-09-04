import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import ObligationsBoard from '@/components/ObligationsBoard';
import PendingVerification from '@/components/PendingVerification';
import { LANDING, BOARD } from '@/copy';

/**
 * Public transparency board: every purchase price we have agreed and not yet
 * settled, and the order we settle them in — financing round 1, then 2, then 3,
 * then acquisitions outside a round; earliest first inside each — per currency.
 * The list is what we owe, published; it is not a register of claims on a service.
 *
 * Transfers still awaiting on-chain confirmation are shown ABOVE the board, not
 * inside it. Both halves are needed and neither can stand in for the other: an
 * unconfirmed transfer is not yet an obligation — we do not owe a purchase price
 * for coins the chain has not yet given us — but a seller who has just
 * transferred and lands here must see their own transfer, or the page reads as
 * though the sale never happened.
 */
const Obligations = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">{LANDING.settlementsTitle}</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">{LANDING.settlementsIntro}</p>
      </div>
      {/* Renders nothing at all when no transfer is awaiting confirmation. */}
      <div className="mb-6"><PendingVerification /></div>
      <ObligationsBoard />
      <p className="text-center text-xs text-muted-foreground mt-6">{BOARD.footer}</p>
    </main>
    <Footer />
  </div>
);

export default Obligations;
