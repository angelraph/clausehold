import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Footer, Nav } from "./components/Chrome";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import Landing from "./pages/Landing";
import { NetworkProvider, useNetwork } from "./lib/network";
import { WalletProvider } from "./lib/wallet";
import "./styles.css";

// Each page is its own route and its own chunk, so nothing loads on top of the landing page.
// Once the first page is on screen, the rest are fetched quietly, so every click opens at once.
const loadHowItWorks = () => import("./pages/HowItWorks");
const loadDevelopers = () => import("./pages/Developers");
const loadSecurity = () => import("./pages/Security");
const loadMandate = () => import("./pages/Mandate");
const loadDesk = () => import("./pages/Desk");
const loadNewClause = () => import("./pages/NewClause");
const loadClauseDetail = () => import("./pages/ClauseDetail");
const loadInvite = () => import("./pages/Invite");
const loadReceipt = () => import("./pages/Receipt");
const loadStanding = () => import("./pages/Standing");
const loadFaucet = () => import("./pages/Faucet");
const loadNotFound = () => import("./pages/NotFound");
const HowItWorks = lazy(loadHowItWorks);
const Developers = lazy(loadDevelopers);
const Security = lazy(loadSecurity);
const Mandate = lazy(loadMandate);
const Desk = lazy(loadDesk);
const NewClause = lazy(loadNewClause);
const ClauseDetail = lazy(loadClauseDetail);
const Invite = lazy(loadInvite);
const Receipt = lazy(loadReceipt);
const Standing = lazy(loadStanding);
const Faucet = lazy(loadFaucet);
const NotFound = lazy(loadNotFound);

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function usePrefetchPages() {
  useEffect(() => {
    const all = [loadHowItWorks, loadDevelopers, loadSecurity, loadMandate, loadDesk, loadNewClause, loadClauseDetail, loadInvite, loadReceipt, loadStanding, loadFaucet, loadNotFound];
    const run = () => all.forEach((load) => load().catch(() => undefined));
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const id = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1200);
    return () => {
      if (!w.requestIdleCallback) window.clearTimeout(id);
    };
  }, []);
}

function Pages() {
  usePrefetchPages();
  const { pathname } = useLocation();
  return (
    <PageErrorBoundary key={pathname}>
      <Suspense fallback={<div className="wrap page-head faint">Loading</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/security" element={<Security />} />
          <Route path="/mandate" element={<Mandate />} />
          <Route path="/desk" element={<Desk />} />
          <Route path="/desk/new" element={<NewClause />} />
          <Route path="/clause/:id" element={<ClauseDetail />} />
          <Route path="/w/:invite" element={<Invite />} />
          <Route path="/r/:clause" element={<Receipt />} />
          <Route path="/s/:account" element={<Standing />} />
          <Route path="/faucet" element={<Faucet />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </PageErrorBoundary>
  );
}

function App() {
  const { network } = useNetwork();
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Nav />
      {/* Keyed by network, so every page reloads its data when the switch flips. */}
      <main key={network.id}>
        <Pages />
      </main>
      <Footer />
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NetworkProvider>
      <WalletProvider>
        <App />
      </WalletProvider>
    </NetworkProvider>
  </StrictMode>
);
