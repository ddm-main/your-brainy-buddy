import { Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import TopBar from "@/components/hud/TopBar";
import ErrorBoundary from "@/components/hud/ErrorBoundary";

import CommandPalette from "@/components/hud/CommandPalette";
import ToastLayer from "@/components/hud/ToastLayer";
import ContentPanel from "@/components/hud/ContentPanel";
import BootScanline from "@/components/hud/BootScanline";
import AmbientLayer from "@/components/hud/AmbientLayer";
import { useContent } from "@/store/contentStore";
import { useUi } from "@/store/uiStore";
import { useNotifications } from "@/store/notificationStore";
import { startReminderPoller } from "@/lib/reminders";
import { runMorningBriefing } from "@/lib/briefing";
import { useSession } from "@/lib/useSession";


const Home = lazy(() => import("@/routes/Home"));
const Inbox = lazy(() => import("@/routes/Inbox"));
const Finance = lazy(() => import("@/routes/Finance"));
const Projects = lazy(() => import("@/routes/Projects"));
const Config = lazy(() => import("@/routes/Config"));
const Tasks = lazy(() => import("@/routes/Tasks"));
const Notes = lazy(() => import("@/routes/Notes"));
const Decisions = lazy(() => import("@/routes/Decisions"));
const NotFound = lazy(() => import("@/routes/NotFound"));
const Auth = lazy(() => import("@/routes/Auth"));
const ResetPassword = lazy(() => import("@/routes/ResetPassword"));


export default function App() {
  const { session, ready } = useSession();
  useEffect(() => {
    if (!session) return;

    const stop = startReminderPoller((r) => {
      useContent.getState().addCard({ type: "reminder", text: r.text, fireAt: r.fire_at } as any);
      useNotifications.getState().add(r.text);
      try {
        const u = new SpeechSynthesisUtterance(`Reminder, sir: ${r.text}`);
        window.speechSynthesis?.speak(u);
      } catch { /* noop */ }
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification("JARVIS reminder", { body: r.text }); } catch { /* noop */ }
      }
    });
    // Ask for notification permission once, non-blocking.
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch((e) => { if (import.meta.env.DEV) console.warn("[JARVIS] notification prompt:", e); });
    }
    // Fire morning briefing once per day, after a small delay.
    const t = window.setTimeout(() => {
      runMorningBriefing().catch((e) => { if (import.meta.env.DEV) console.warn("[JARVIS] morning briefing:", e); });
    }, 4000);

    // Global hotkey: ⌘/Ctrl+J → open conversation overlay.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "j") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      useUi.getState().openConversation();
    };
    window.addEventListener("keydown", onKey);

    return () => { stop(); window.clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [session]);


  if (!ready) return <BootFallback />;
  if (!session) {
    const isReset = window.location.pathname === "/reset-password"
      || window.location.hash.includes("type=recovery");
    return (
      <>
        <div className="grid-bg" />
        <div className="vignette" />
        <div style={{ position: "relative", zIndex: 2, height: "100vh" }}>
          <Suspense fallback={<BootFallback />}>
            {isReset ? <ResetPassword /> : <Auth />}
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

      <ContentPanel />
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

          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/finance/*" element={<Finance />} />
          <Route path="/projects/*" element={<Projects />} />
          <Route path="/config/*" element={<Config />} />
          <Route path="/settings" element={<Navigate to="/config" replace />} />
          <Route path="/auth" element={<Navigate to="/" replace />} />
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
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100%", color: "var(--accent)",
      fontFamily: "var(--font-hud)", letterSpacing: "0.3em",
      fontSize: 12, textTransform: "uppercase",
    }}>
      <span className="hud-label" style={{ color: "var(--accent)" }}>· initialising kernel ·</span>
    </div>
  );
}
