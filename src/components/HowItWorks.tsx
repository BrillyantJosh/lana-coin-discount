import { Wallet, ArrowRightLeft, MessageCircle, Banknote } from "lucide-react";

const steps = [
  {
    icon: Wallet,
    title: "Register Your Wallet",
    description: "Add your wallet address to our list. You only need to do this once.",
    step: "01",
  },
  {
    icon: ArrowRightLeft,
    title: "Transfer Your LanaCoins",
    description: "After each Split, transfer the LanaCoins you want to sell to our designated wallet.",
    step: "02",
  },
  {
    icon: MessageCircle,
    title: "Confirm via Chat",
    description: "You'll receive a chat notification to confirm the transfer of your coins.",
    step: "03",
  },
  {
    icon: Banknote,
    title: "Get Paid Instantly",
    description: "We pay out up to 79% of the determined value directly to your bank account. Done.",
    step: "04",
  },
];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="py-20 md:py-28 bg-muted/50">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            How It Works
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Four simple steps to convert your LanaCoins into cash — fast and hassle-free.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div
              key={index}
              className="relative bg-card rounded-xl p-8 shadow-sm border border-border hover:shadow-md transition-shadow group"
              style={{ animationDelay: `${index * 150}ms` }}
            >
              <span className="absolute -top-3 -left-3 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shadow">
                {step.step}
              </span>
              <div className="w-14 h-14 rounded-xl bg-accent flex items-center justify-center mb-5 group-hover:bg-primary group-hover:text-primary-foreground transition-colors text-accent-foreground">
                <step.icon className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2 font-sans">
                {step.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
