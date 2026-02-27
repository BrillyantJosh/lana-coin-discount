import { Leaf, Recycle, Heart } from "lucide-react";

const Sustainability = () => {
  return (
    <section id="sustainability" className="py-20 md:py-28 bg-muted/50">
      <div className="container mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-8">
            <Leaf className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-6">
            Your Discount Powers <span className="text-primary">Sustainable Commerce</span>
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed mb-10">
            By selling through Lana.discount, your 30% discount directly supports sustainable 
            shopping and eco-conscious merchants. Every coin you sell helps build a greener 
            economy — perhaps making a bigger impact than you realize.
          </p>

          <div className="flex flex-wrap justify-center gap-6">
            <div className="flex items-center gap-3 bg-card rounded-full px-6 py-3 shadow-sm border border-border">
              <Recycle className="w-5 h-5 text-primary" />
              <span className="text-foreground font-medium">Circular Economy</span>
            </div>
            <div className="flex items-center gap-3 bg-card rounded-full px-6 py-3 shadow-sm border border-border">
              <Heart className="w-5 h-5 text-primary" />
              <span className="text-foreground font-medium">Eco Merchants</span>
            </div>
            <div className="flex items-center gap-3 bg-card rounded-full px-6 py-3 shadow-sm border border-border">
              <Leaf className="w-5 h-5 text-primary" />
              <span className="text-foreground font-medium">Green Impact</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Sustainability;
