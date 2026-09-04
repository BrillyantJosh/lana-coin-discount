import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import Index from "./pages/Index";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import AdminDashboard from "./pages/AdminDashboard";
import AdminUsers from "./pages/AdminUsers";
import AdminSettings from "./pages/AdminSettings";
import AdminPayouts from "./pages/AdminPayouts";
import AdminApiKeys from "./pages/AdminApiKeys";
import AdminVerifyTx from "./pages/AdminVerifyTx";
import AdminIncomingPayments from "./pages/AdminIncomingPayments";
import AdminAnalytics from "./pages/AdminAnalytics";
import AdminOverview from "./pages/AdminOverview";
import AdminMandates from "./pages/AdminMandates";
import AdminTreasuryRounds from "./pages/AdminTreasuryRounds";
import SubmitOffer from "./pages/SubmitOffer";
import AdminOffers from "./pages/AdminOffers";
import ApiDocs from "./pages/ApiDocs";
import Obligations from "./pages/Obligations";
import PayoutHistory from "./pages/PayoutHistory";
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
            <Route path="/obligations" element={<Obligations />} />
            <Route path="/history" element={<PayoutHistory />} />
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/offer" element={<SubmitOffer />} />
            {/* Kept so old links and bookmarks land somewhere true rather than
                on a 404 — the page they point at no longer exists. */}
            <Route path="/sell" element={<Navigate to="/offer" replace />} />
            <Route path="/docs/api" element={<ApiDocs />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/offers" element={<AdminOffers />} />
            <Route path="/admin/verify-tx" element={<AdminVerifyTx />} />
            <Route path="/admin/payouts" element={<AdminPayouts />} />
            <Route path="/admin/mandates" element={<AdminMandates />} />
            <Route path="/admin/treasury-rounds" element={<AdminTreasuryRounds />} />
            {/* The expecting-cashout report became the mandate worklist. The
                old page file stays until Phase B removes it. */}
            <Route path="/admin/expecting-cashout" element={<Navigate to="/admin/mandates" replace />} />
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route path="/admin/api-keys" element={<AdminApiKeys />} />
            <Route path="/admin/admins" element={<AdminUsers />} />
            <Route path="/admin/incoming-payments" element={<AdminIncomingPayments />} />
            <Route path="/admin/analytics" element={<AdminAnalytics />} />
            <Route path="/admin/overview" element={<AdminOverview />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
