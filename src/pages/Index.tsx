import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import PayoutOrderExplainer from "@/components/PayoutOrderExplainer";
import Requirements from "@/components/Requirements";
import ObligationsBoard from "@/components/ObligationsBoard";
import RecentPayouts from "@/components/RecentPayouts";
import PayoutStats from "@/components/PayoutStats";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />

      {/* Live payout queue — every unpaid obligation, in order (right after the header) */}
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

      {/* Daily payout stats */}
      <section id="stats" className="py-16 md:py-20 bg-muted/50">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="mb-8">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">Paid out per day</h2>
            <p className="mt-2 text-muted-foreground max-w-xl">
              Total FIAT paid out from Lana.Discount to LANA sellers, by day.
            </p>
          </div>
          <PayoutStats />
        </div>
      </section>

      {/* Explanations come after the live data */}
      <PayoutOrderExplainer />
      <HowItWorks />
      <Requirements />
      <Footer />
    </div>
  );
};

export default Index;
