import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import RecentPayouts from '@/components/RecentPayouts';
import PendingVerification from '@/components/PendingVerification';
import { UI, LANDING } from '@/copy';

/** Public transparency record: the 100 acquisitions whose purchase price we
 * settled most recently, plus any LANA transfer still awaiting on-chain
 * verification. */
const PayoutHistory = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-10 sm:py-14 max-w-4xl">
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">{UI.history}</h1>
        <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">{LANDING.completedIntro}</p>
      </div>
      {/* Transfers still being verified on-chain — the acquisition is not complete
          and nothing is owed on them yet */}
      <div className="mb-6"><PendingVerification /></div>
      <RecentPayouts />
      <p className="text-center text-xs text-muted-foreground mt-6">
        Last 100 settlements · newest first · updates every 30s
      </p>
    </main>
    <Footer />
  </div>
);

export default PayoutHistory;
