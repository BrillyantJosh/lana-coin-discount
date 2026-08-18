import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import ObligationsBoard from '@/components/ObligationsBoard';
import { LANDING } from '@/copy';

/**
 * Public transparency board: every purchase price we have agreed and not yet
 * settled, and the order we settle them in (financiers first in financing order
 * — rounds asc, FIFO inside — then crowd-funding, then the rest), per currency.
 * The list is what we owe, published; it is not a register of claims on a service.
 */
const Obligations = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">{LANDING.settlementsTitle}</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">{LANDING.settlementsIntro}</p>
      </div>
      <ObligationsBoard />
      <p className="text-center text-xs text-muted-foreground mt-6">
        Financiers first (in financing order — rounds first, FIFO inside a round), then crowd-funding project owners, then the rest · per currency · updates every 30s · financing order refreshed every 5 min
      </p>
    </main>
    <Footer />
  </div>
);

export default Obligations;
