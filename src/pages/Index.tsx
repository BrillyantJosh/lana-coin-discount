import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import PayoutOrderExplainer from "@/components/PayoutOrderExplainer";
import Requirements from "@/components/Requirements";
import ObligationsBoard from "@/components/ObligationsBoard";
import RecentPayouts from "@/components/RecentPayouts";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />
      <HowItWorks />
      <PayoutOrderExplainer />

      {/* Live payout queue — every unpaid obligation, in order */}
      <section id="queue" className="py-16 md:py-20 bg-muted/50">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="flex items-end justify-between gap-4 mb-8 flex-wrap">
            <div>
              <h2 className="text-3xl md:text-4xl font-bold text-foreground">Payout Queue</h2>
              <p className="mt-2 text-muted-foreground max-w-xl">
                Every unpaid obligation right now, in the exact order it will be paid — financiers first, per currency.
              </p>
            </div>
            <a href="/obligations" className="text-sm font-semibold text-primary hover:underline whitespace-nowrap">
              Open full queue →
            </a>
          </div>
          <ObligationsBoard maxPerCurrency={10} />
        </div>
      </section>

      {/* Recently paid */}
      <section id="history" className="py-16 md:py-20">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="flex items-end justify-between gap-4 mb-8 flex-wrap">
            <div>
              <h2 className="text-3xl md:text-4xl font-bold text-foreground">Recently paid</h2>
              <p className="mt-2 text-muted-foreground max-w-xl">
                The latest payouts to LANA sellers. Full transparency of what has already been settled.
              </p>
            </div>
            <a href="/history" className="text-sm font-semibold text-primary hover:underline whitespace-nowrap">
              View all 100 →
            </a>
          </div>
          <RecentPayouts limit={12} />
        </div>
      </section>

      <Requirements />
      <Footer />
    </div>
  );
};

export default Index;
