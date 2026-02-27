import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import Requirements from "@/components/Requirements";
import Sustainability from "@/components/Sustainability";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />
      <HowItWorks />
      <Requirements />
      <Sustainability />
      <Footer />
    </div>
  );
};

export default Index;
