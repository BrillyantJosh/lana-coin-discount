import heroImage from "@/assets/hero-illustration.png";
import { LANDING } from "@/copy";
import { SellingMovedNotice } from "@/components/SellingMovedNotice";
import { SELLING_CLOSED } from "@/lib/sellingClosed";

const HeroSection = () => {
  // Since 8 Oct 2026 the first thing on the page is where selling went: the
  // old title ("We acquire selected LANA") and its "Submit an Offer" button
  // would invite a sale the server now refuses. What we already owe stays
  // below, and so does the way to it.
  if (SELLING_CLOSED) {
    return (
      <section className="relative overflow-hidden py-10 md:py-20">
        <div className="container mx-auto px-4 sm:px-6 flex flex-col lg:flex-row items-center gap-10 lg:gap-12">
          <div className="flex-1 min-w-0 w-full space-y-6">
            <SellingMovedNotice soldBefore="link" />
            <p className="text-sm md:text-base text-muted-foreground leading-relaxed">{LANDING.heroBodySecond}</p>
            <a
              href="#settlements"
              className="inline-flex items-center justify-center rounded-lg border-2 border-primary px-6 py-3 text-base font-semibold text-primary hover:bg-accent transition-colors"
            >
              {LANDING.heroSecondaryCta}
            </a>
          </div>
          <div className="hidden lg:flex flex-1 justify-center">
            <img src={heroImage} alt="" className="w-full max-w-md animate-float" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden py-20 md:py-32">
      <div className="container mx-auto px-6 flex flex-col lg:flex-row items-center gap-12">
        <div className="flex-1 min-w-0 space-y-8 text-center lg:text-left">
          <div className="inline-block rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground">
            {LANDING.heroEyebrow}
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground leading-tight">
            {LANDING.heroTitle}
            <br />
            <span className="text-primary">{LANDING.heroTitleSecond}</span>
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed">
            {LANDING.heroBody}
          </p>
          <p className="text-sm md:text-base text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed">
            {LANDING.heroBodySecond}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
            {/* Straight to the offer page. It sends anyone without a session to
                the login itself, so the button says what it does rather than
                making the visitor guess that "Sign in" is how one offers. */}
            <a
              href="/offer"
              className="inline-flex items-center justify-center rounded-lg bg-primary px-8 py-4 text-lg font-semibold text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
            >
              {LANDING.heroPrimaryCta}
            </a>
            <a
              href="#settlements"
              className="inline-flex items-center justify-center rounded-lg border-2 border-primary px-8 py-4 text-lg font-semibold text-primary hover:bg-accent transition-colors"
            >
              {LANDING.heroSecondaryCta}
            </a>
          </div>
        </div>
        <div className="flex-1 flex justify-center">
          <img
            src={heroImage}
            alt="Treasury acquisitions illustration"
            className="w-full max-w-lg animate-float"
          />
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
