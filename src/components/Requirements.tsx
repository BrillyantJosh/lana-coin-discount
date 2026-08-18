import { ShieldCheck, ListChecks, Gauge } from "lucide-react";
import { ELIGIBILITY } from "@/copy";

/**
 * These are OUR criteria for OUR treasury, not conditions a holder satisfies to
 * become entitled to something. The card this replaces published the 79/70 %
 * rates as a requirement, which read as a standing price anyone could rely on —
 * §6 says a concrete price is shown only after review, per proposal.
 */
const ICONS = [ShieldCheck, ListChecks, Gauge];

const Requirements = () => {
  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-6">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            {ELIGIBILITY.title}
          </h2>
          <p className="text-lg text-muted-foreground">
            {ELIGIBILITY.intro}
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          {ELIGIBILITY.cards.map((card, index) => {
            const Icon = ICONS[index % ICONS.length];
            return (
              <div key={card.title} className="text-center p-8 rounded-xl bg-accent/50 border border-border">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <Icon className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">{card.title}</h3>
                <p className="text-muted-foreground">{card.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Requirements;
