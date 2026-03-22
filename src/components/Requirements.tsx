import { ShieldCheck, Star, Coins } from "lucide-react";

const Requirements = () => {
  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-6">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            Requirements
          </h2>
          <p className="text-lg text-muted-foreground">
            We keep it simple. Here's what you need to get started.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          <div className="text-center p-8 rounded-xl bg-accent/50 border border-border">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Star className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">Rating 9–10</h3>
            <p className="text-muted-foreground">Your account must have a rating between 9 and 10 to qualify.</p>
          </div>

          <div className="text-center p-8 rounded-xl bg-accent/50 border border-border">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Coins className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">Any Amount</h3>
            <p className="text-muted-foreground">We buy any amount of LanaCoins — no minimum, no maximum.</p>
          </div>

          <div className="text-center p-8 rounded-xl bg-accent/50 border border-border">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <ShieldCheck className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">Up to 79% Payout</h3>
            <p className="text-muted-foreground">Receive up to 79% of the determined coin value paid directly to your account.</p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Requirements;
