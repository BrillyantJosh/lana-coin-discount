const Footer = () => {
  return (
    <footer className="py-12 border-t border-border">
      <div className="container mx-auto px-6 text-center">
        <p className="text-2xl font-display font-bold text-primary mb-2">
          <span>Lana<span className="text-gold">.Discount</span></span>
        </p>
        <p className="text-muted-foreground text-sm">
          © {new Date().getFullYear()} Lana.Discount — Supporting sustainable commerce.
        </p>
      </div>
    </footer>
  );
};

export default Footer;
