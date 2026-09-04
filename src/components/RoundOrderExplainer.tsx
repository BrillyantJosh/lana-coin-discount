import { ListOrdered, Users, Layers, Landmark, Eye } from "lucide-react";
import { SETTLEMENT_ORDER } from "@/copy";

/**
 * HOW WE SETTLE WHAT WE OWE — by financing round.
 *
 * The one order the owner set on 4 Sep 2026: round 1, then 2, then 3, each
 * opened on a published date; per financer up to the LANA their budget
 * received; per currency; from our own funds by the date on the offer. This
 * block replaces the old explainer, which described ranks and bands that no
 * longer exist. The words live in src/copy.ts, where they are reviewed in one
 * place and checked by src/copy.test.ts.
 */
const ICONS = [ListOrdered, Users, Layers, Landmark, Eye];

const RoundOrderExplainer = () => {
  return (
    <section id="settlement" className="py-20 md:py-28">
      <div className="container mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-4">
            {SETTLEMENT_ORDER.title}
          </h2>
          <p className="text-lg text-muted-foreground">{SETTLEMENT_ORDER.intro}</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {SETTLEMENT_ORDER.points.map((p, i) => {
            const Icon = ICONS[i % ICONS.length];
            return (
              <div key={p.title} className="flex gap-4 rounded-xl bg-card border border-border p-6 shadow-sm">
                <div className="w-12 h-12 shrink-0 rounded-xl bg-accent flex items-center justify-center text-accent-foreground">
                  <Icon className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-foreground mb-1 font-sans">{p.title}</h3>
                  <p className="text-muted-foreground leading-relaxed text-[15px]">{p.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default RoundOrderExplainer;
