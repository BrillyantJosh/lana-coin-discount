import heroImage from "@/assets/hero-illustration.png";

const HeroSection = () => {
  return (
    <section className="relative overflow-hidden py-20 md:py-32">
      <div className="container mx-auto px-6 flex flex-col lg:flex-row items-center gap-12">
        <div className="flex-1 space-y-8 text-center lg:text-left">
          <div className="inline-block rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground">
            Instant LanaCoin Buyback
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground leading-tight">
            Sell Your <span className="text-primary">LanaCoins</span> Instantly.
            <br />
            Get <span className="text-gold">70% Cash</span> Today.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed">
            Stop selling your coins piece by piece. We buy any amount in one go — 
            you get paid immediately. No hassle, no waiting.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
            <a
              href="/login"
              className="inline-flex items-center justify-center rounded-lg bg-primary px-8 py-4 text-lg font-semibold text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
            >
              Start Selling
            </a>
            <a
              href="#sustainability"
              className="inline-flex items-center justify-center rounded-lg border-2 border-primary px-8 py-4 text-lg font-semibold text-primary hover:bg-accent transition-colors"
            >
              Learn More
            </a>
          </div>
        </div>
        <div className="flex-1 flex justify-center">
          <img
            src={heroImage}
            alt="Sustainable crypto trading illustration"
            className="w-full max-w-lg animate-float"
          />
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
