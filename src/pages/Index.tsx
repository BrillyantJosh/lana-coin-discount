import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import RoundOrderExplainer from "@/components/RoundOrderExplainer";
import RoundDates from "@/components/RoundDates";
import Requirements from "@/components/Requirements";
import ObligationsBoard from "@/components/ObligationsBoard";
import RecentPayouts from "@/components/RecentPayouts";
import PendingVerification from "@/components/PendingVerification";
import PayoutStats from "@/components/PayoutStats";
import LiquidityBalance from "@/components/LiquidityBalance";
import Footer from "@/components/Footer";
import { LANDING, FRAMEWORK_COPY } from "@/copy";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />

      {/* What we are, in the framework's own sentences (§14). It sits above the
          numbers on purpose: a reader who stops after one section should have
          read this one, not inferred a service from the lists below. */}
      <section id="how-we-acquire" className="py-16 md:py-20 border-y border-border bg-card">
        <div className="container mx-auto px-6 max-w-4xl">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground">{LANDING.frameworkTitle}</h2>
          <p className="mt-5 text-lg md:text-xl leading-relaxed text-foreground/90">
            {FRAMEWORK_COPY.website}
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <div className="min-w-0 rounded-xl border border-border bg-background/60 p-6">
              <h3 className="text-lg font-semibold text-foreground mb-2 font-sans">
                {LANDING.frameworkPricingTitle}
              </h3>
              <p className="text-muted-foreground leading-relaxed text-[15px]">{FRAMEWORK_COPY.pricing}</p>
            </div>
            <div className="min-w-0 rounded-xl border border-border bg-background/60 p-6">
              <h3 className="text-lg font-semibold text-foreground mb-2 font-sans">
                {LANDING.frameworkProvenanceTitle}
              </h3>
              <p className="text-muted-foreground leading-relaxed text-[15px]">{FRAMEWORK_COPY.provenance}</p>
            </div>
          </div>
        </div>
      </section>

      {/* The round dates: when the treasury starts acquiring from each financing
          round. Dates and totals only — never a discount (P08 §4). */}
      <RoundDates />

      {/* Live board of every purchase price we owe and have not yet settled */}
      <section id="settlements" className="py-16 md:py-20 bg-muted/50">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="flex items-end justify-between gap-4 mb-8 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-3xl md:text-4xl font-bold text-foreground">{LANDING.settlementsTitle}</h2>
              <p className="mt-2 text-muted-foreground max-w-xl">{LANDING.settlementsIntro}</p>
            </div>
            <a href="/obligations" className="text-sm font-semibold text-primary hover:underline whitespace-nowrap">
              {LANDING.settlementsLink}
            </a>
          </div>
          <ObligationsBoard maxPerCurrency={10} />
        </div>
      </section>

      {/* Acquisitions we have completed and settled */}
      <section id="history" className="py-16 md:py-20">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="flex items-end justify-between gap-4 mb-8 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-3xl md:text-4xl font-bold text-foreground">{LANDING.completedTitle}</h2>
              <p className="mt-2 text-muted-foreground max-w-xl">{LANDING.completedIntro}</p>
            </div>
            <a href="/history" className="text-sm font-semibold text-primary hover:underline whitespace-nowrap">
              {LANDING.completedLink}
            </a>
          </div>
          <div className="mb-4"><PendingVerification limit={6} /></div>
          <RecentPayouts limit={12} />
        </div>
      </section>

      {/* Daily FIAT flows */}
      <section id="stats" className="py-16 md:py-20 bg-muted/50">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="mb-8">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">{LANDING.flowsTitle}</h2>
            <p className="mt-2 text-muted-foreground max-w-xl">{LANDING.flowsIntro}</p>
          </div>
          <PayoutStats />

          {/* Same two flows, accumulated: were we net positive or negative that day? */}
          <div className="mt-12 mb-8">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">{LANDING.positionTitle}</h2>
            <p className="mt-2 text-muted-foreground max-w-xl">{LANDING.positionIntro}</p>
          </div>
          <LiquidityBalance />
        </div>
      </section>

      {/* Explanations come after the live data */}
      <RoundOrderExplainer />
      <HowItWorks />
      <Requirements />
      <Footer />
    </div>
  );
};

export default Index;
