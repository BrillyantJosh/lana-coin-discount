const Navbar = () => {
  return (
    <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between h-14 sm:h-16">
        <a href="/" className="flex items-center gap-2 text-lg sm:text-xl font-display font-bold text-primary">
          <img src="/lana-logo.png" alt="Lana logo" className="h-8 w-8 dark:invert" />
          <span>Lana<span className="text-gold">.Discount</span></span>
        </a>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          <a href="/#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
          <a href="/#settlement" className="hover:text-foreground transition-colors">How we settle</a>
          <a href="/obligations" className="hover:text-foreground transition-colors">What we owe</a>
          <a href="/history" className="hover:text-foreground transition-colors">Acquisitions</a>
          <a href="/docs/api" className="hover:text-foreground transition-colors">API</a>
        </div>
        {/* Signing in is signing in — the offer itself is made on the other side,
            so this button does not pretend to be the offer. */}
        <a
          href="/login"
          className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Sign In
        </a>
      </div>
    </nav>
  );
};

export default Navbar;
