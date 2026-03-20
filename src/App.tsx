import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import Index from "./pages/Index";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Wallets from "./pages/Wallets";
import AdminDashboard from "./pages/AdminDashboard";
import AdminUsers from "./pages/AdminUsers";
import AdminSettings from "./pages/AdminSettings";
import AdminPayouts from "./pages/AdminPayouts";
import AdminApiKeys from "./pages/AdminApiKeys";
import AdminVerifyTx from "./pages/AdminVerifyTx";
import SellLana from "./pages/SellLana";
import ApiDocs from "./pages/ApiDocs";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/wallets" element={<Wallets />} />
            <Route path="/sell" element={<SellLana />} />
            <Route path="/docs/api" element={<ApiDocs />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/verify-tx" element={<AdminVerifyTx />} />
            <Route path="/admin/payouts" element={<AdminPayouts />} />
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route path="/admin/api-keys" element={<AdminApiKeys />} />
            <Route path="/admin/admins" element={<AdminUsers />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
