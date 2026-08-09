import { Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import TopBar from "@/components/hud/TopBar";
import ErrorBoundary from "@/components/hud/ErrorBoundary";

import CommandPalette from "@/components/hud/CommandPalette";
import ToastLayer from "@/components/hud/ToastLayer";
import BootScanline from "@/components/hud/BootScanline";
import AmbientLayer from "@/components/hud/AmbientLayer";
import { useNotifications } from "@/store/notificationStore";
import { startMarketAlertsPoller, formatAlertEvent } from "@/lib/market/alertsPoller";
import { useSession } from "@/lib/useSession";
import { useAccessStore } from "@/store/accessStore";
import AccessGate from "@/components/access/AccessGate";


const Config = lazy(() => import("@/routes/Config"));
const Market = lazy(() => import("@/routes/Market"));
const NotFound = lazy(() => import("@/routes/NotFound"));
const Auth = lazy(() => import("@/routes/Auth"));
const ResetPassword = lazy(() => import("@/routes/ResetPassword"));


export default function App() {
  const { session, ready } = useSession();
  const loadAccess = useAccessStore((s) => s.load);
  const resetAccess = useAccessStore((s) => s.reset);
  const accessReady = useAccessStore((s) => s.ready);
  useEffect(() => {
    if (!ready) return;
    if (session?.user?.id) loadAccess(session.user.id);
    else resetAccess();
  }, [session?.user?.id, ready, loadAccess, resetAccess]);

  useEffect(() => {
    if (!session) return;

    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch((e) => { if (import.meta.env.DEV) console.warn("[JARVIS] notification prompt:", e); });
    }

    const stopAlerts = startMarketAlertsPoller((e) => {
      const text = formatAlertEvent(e);
      useNotifications.getState().add(text);
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification("Market alert", { body: text }); } catch { /* noop */ }
      }
    });

    return () => { stopAlerts(); };
  }, [session]);


  if (!ready) return <BootFallback />;
  if (session && !accessReady) return <BootFallback />;

  const path = window.location.pathname;
  const isReset = path === "/reset-password" || window.location.hash.includes("type=recovery");
  const isAuthPath = path === "/auth" || isReset;

  // Authenticated users hitting /auth should go home; keep /reset-password accessible for recovery flow.
  if (session && path === "/auth" && !isReset) {
    return <Navigate to="/market" replace />;
  }

  // Render minimal chrome on auth surfaces (signed out, or signed-in on /reset-password).
  if (!session || isAuthPath) {
    return (
      <>
        <div className="grid-bg" />
        <div className="vignette" />
        <div style={{ position: "relative", zIndex: 2, height: "100vh" }}>
          <Suspense fallback={<BootFallback />}>
            <ErrorBoundary>
              {isReset ? <ResetPassword /> : <Auth />}
            </ErrorBoundary>
          </Suspense>
        </div>
        <ToastLayer />
      </>
    );
  }

  return (
    <>

      <AmbientLayer />
      <div className="grid-bg" />
      <div className="vignette" />
      <div style={{ position: "relative", zIndex: 2, height: "100%", display: "flex", flexDirection: "column" }}>
        <TopBar />
        <main style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <ErrorBoundary>
            <Suspense fallback={<BootFallback />}>
              <AnimatedRoutes />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette />
      <ToastLayer />
    </>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
        exit={{ opacity: 0, y: -4, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
        style={{ height: "100%", position: "relative" }}
      >
        <BootScanline triggerKey={location.pathname} />
        <Routes location={location}>

          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market/*" element={<AccessGate section="market"><Market /></AccessGate>} />
          <Route path="/config/*" element={<AccessGate section="config"><Config /></AccessGate>} />
          <Route path="/settings" element={<Navigate to="/config" replace />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

function BootFallback() {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      minHeight: "100vh", color: "var(--accent)", paddingTop: "clamp(72px, 22vh, 180px)",
      fontFamily: "var(--font-hud)", letterSpacing: "0.3em",
      fontSize: 12, textTransform: "uppercase",
    }}>
      <span className="hud-label" style={{ color: "var(--accent)" }}>· initialising kernel ·</span>
    </div>
  );
}
