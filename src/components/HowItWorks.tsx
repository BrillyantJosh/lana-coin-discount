import { Wallet, ScanSearch, BadgeCheck, Banknote } from "lucide-react";
import { HOW_IT_WORKS } from "@/copy";

/**
 * The old third step, "We Sell Into Spending", said we channel the
 * counterparty's coins onward for them — selling on someone's behalf, which
 * §4 and §10 name as the red flag that turns this into a service to clients.
 * The steps now describe what actually happens: a proposal, our decision, an
 * acceptance, and only then a transfer.
 */
const ICONS = [Wallet, ScanSearch, BadgeCheck, Banknote];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="py-20 md:py-28 bg-muted/50">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            {HOW_IT_WORKS.title}
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {HOW_IT_WORKS.intro}
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {HOW_IT_WORKS.steps.map((step, index) => {
            const Icon = ICONS[index % ICONS.length];
            return (
              <div
                key={step.title}
                className="relative bg-card rounded-xl p-8 shadow-sm border border-border hover:shadow-md transition-shadow group"
                style={{ animationDelay: `${index * 150}ms` }}
              >
                <span className="absolute -top-3 -left-3 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shadow">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="w-14 h-14 rounded-xl bg-accent flex items-center justify-center mb-5 group-hover:bg-primary group-hover:text-primary-foreground transition-colors text-accent-foreground">
                  <Icon className="w-7 h-7" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">
                  {step.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {step.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
