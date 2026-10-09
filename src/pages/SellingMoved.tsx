import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { SellingMovedNotice } from '@/components/SellingMovedNotice';

/**
 * /offer (and /sell) since selling LANA here closed on 8 Oct 2026.
 *
 * Other apps still send people here to sell — MejmoSeFajn, being3 — and old
 * bookmarks do too, so the address stays and answers with where selling went:
 * the firms that buy LANA now, read from the relays. There is no wallet list
 * and no field for a private key on this page: nothing here can be sold.
 */
const SellingMoved = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Navbar />
    <main className="flex-1 container mx-auto px-4 sm:px-6 py-8 sm:py-14 max-w-3xl">
      <SellingMovedNotice />
    </main>
    <Footer />
  </div>
);

export default SellingMoved;
