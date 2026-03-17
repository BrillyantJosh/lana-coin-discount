const Footer = () => {
  return (
    <footer className="py-12 border-t border-border">
      <div className="container mx-auto px-6 text-center">
        <p className="text-2xl font-display font-bold text-primary mb-2">
          <span>Lana<span className="text-gold">.Discount</span></span>
        </p>
        <p className="text-muted-foreground text-sm mb-2">
          © {new Date().getFullYear()} Lana.Discount — Supporting sustainable commerce.
        </p>
        <a href="/docs/api" className="text-sm text-muted-foreground/70 hover:text-foreground transition-colors">
          API Documentation
        </a>
      </div>
    </footer>
  );
};

export default Footer;
