import { ListOrdered, Coins, Layers, Eye } from "lucide-react";

const points = [
  {
    icon: ListOrdered,
    title: "A fair, public queue",
    body: "When you sell, you join the payout queue. There is no fixed “next day” — you are paid as real spending generates revenue, strictly in queue order.",
  },
  {
    icon: Coins,
    title: "Financiers first, then everyone else",
    body: "Those who finance the Lana economy — who fund the budgets that drive spending — are paid first, in the order they committed. Then all other sellers.",
  },
  {
    icon: Layers,
    title: "Separate for each currency",
    body: "EUR, GBP and every other currency have their own independent queue. An unpaid recipient in one currency never delays a payout in another.",
  },
  {
    icon: Eye,
    title: "Fully transparent",
    body: "See exactly where you stand in the Payout Queue and every payout already made in the History. Around 20–30% of each sale fuels shopper cashback that grows the network — a bigger network means faster payouts for everyone.",
  },
];

const PayoutOrderExplainer = () => {
  return (
    <section id="payouts" className="py-20 md:py-28">
      <div className="container mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            How payouts work <span className="text-primary">now</span>
          </h2>
          <p className="text-lg text-muted-foreground">
            We no longer promise a fixed next-day payout. Instead, everyone is paid in a clear,
            public order — so you always know exactly when and why.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {points.map((p, i) => (
            <div key={i} className="flex gap-4 rounded-xl bg-card border border-border p-6 shadow-sm">
              <div className="w-12 h-12 shrink-0 rounded-xl bg-accent flex items-center justify-center text-accent-foreground">
                <p.icon className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-1 font-sans">{p.title}</h3>
                <p className="text-muted-foreground leading-relaxed text-[15px]">{p.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default PayoutOrderExplainer;
