import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Footer, Nav } from "./components/Chrome";
import Landing from "./pages/Landing";
import "./styles.css";

// Each page is its own route and its own chunk, so nothing loads on top of the landing page.
const HowItWorks = lazy(() => import("./pages/HowItWorks"));
const Developers = lazy(() => import("./pages/Developers"));
const Security = lazy(() => import("./pages/Security"));
const Mandate = lazy(() => import("./pages/Mandate"));
const Desk = lazy(() => import("./pages/Desk"));
const NewClause = lazy(() => import("./pages/NewClause"));
const ClauseDetail = lazy(() => import("./pages/ClauseDetail"));
const Invite = lazy(() => import("./pages/Invite"));
const Receipt = lazy(() => import("./pages/Receipt"));
const Standing = lazy(() => import("./pages/Standing"));
const NotFound = lazy(() => import("./pages/NotFound"));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Nav />
      <main>
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
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
