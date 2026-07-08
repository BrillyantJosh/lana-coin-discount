import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import ObligationsBoard from '@/components/ObligationsBoard';

/**
 * Public transparency board: every UNPAID obligation to LANA sellers and the exact
 * order it will be paid (financiers first by FIFO rank, then the rest), per currency.
 */
const Obligations = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">Payout Queue</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
          Full transparency: every unpaid obligation to LANA sellers and the exact order it will be
          paid. Those who finance first are paid first — evaluated separately for each currency.
        </p>
      </div>
      <ObligationsBoard />
      <p className="text-center text-xs text-muted-foreground mt-6">
        Financiers first (by budget registration order), then the rest · per currency · updates every 30s
      </p>
    </main>
    <Footer />
  </div>
);

export default Obligations;
