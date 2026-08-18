import heroImage from "@/assets/hero-illustration.png";
import { LANDING } from "@/copy";

const HeroSection = () => {
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
