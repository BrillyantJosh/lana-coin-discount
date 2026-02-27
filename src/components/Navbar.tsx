const Navbar = () => {
  return (
    <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="container mx-auto px-6 flex items-center justify-between h-16">
        <a href="/" className="text-xl font-display font-bold text-primary">
          Lana<span className="text-gold">.discount</span>
        </a>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          <a href="#how-it-works" className="hover:text-foreground transition-colors">How It Works</a>
          <a href="#sustainability" className="hover:text-foreground transition-colors">Sustainability</a>
        </div>
        <a
          href="#how-it-works"
          className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Get Started
        </a>
      </div>
    </nav>
  );
};

export default Navbar;
