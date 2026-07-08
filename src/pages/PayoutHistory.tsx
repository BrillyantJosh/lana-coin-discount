import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import RecentPayouts from '@/components/RecentPayouts';

/** Public transparency history: the 100 most recent payouts to LANA sellers. */
const PayoutHistory = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">Payout History</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
          The 100 most recent payouts to LANA sellers — newest first. Full transparency of what has already been paid.
        </p>
      </div>
      <RecentPayouts />
      <p className="text-center text-xs text-muted-foreground mt-6">
        Last 100 payouts · newest first · updates every 30s
      </p>
    </main>
    <Footer />
  </div>
);

export default PayoutHistory;
