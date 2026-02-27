const Footer = () => {
  return (
    <footer className="py-12 border-t border-border">
      <div className="container mx-auto px-6 text-center">
        <p className="text-2xl font-display font-bold text-primary mb-2">
          Lana<span className="text-gold">.discount</span>
        </p>
        <p className="text-muted-foreground text-sm">
          © {new Date().getFullYear()} Lana.discount — Supporting sustainable commerce.
        </p>
      </div>
    </footer>
  );
};

export default Footer;
