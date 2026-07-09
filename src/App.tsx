import { Routes, Route } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import TopBar from "@/components/hud/TopBar";
import VoiceBar from "@/components/hud/VoiceBar";
import CommandPalette from "@/components/hud/CommandPalette";
import ToastLayer from "@/components/hud/ToastLayer";
import ContentPanel from "@/components/hud/ContentPanel";
import { useContent } from "@/store/contentStore";
import { startReminderPoller } from "@/lib/reminders";
import { runMorningBriefing } from "@/lib/briefing";

const Home = lazy(() => import("@/routes/Home"));
const Inbox = lazy(() => import("@/routes/Inbox"));
const Finance = lazy(() => import("@/routes/Finance"));
const Projects = lazy(() => import("@/routes/Projects"));
const Settings = lazy(() => import("@/routes/Settings"));
const Tasks = lazy(() => import("@/routes/Tasks"));
const Notes = lazy(() => import("@/routes/Notes"));

export default function App() {
  useEffect(() => {
    const stop = startReminderPoller((r) => {
      useContent.getState().addCard({ type: "reminder", text: r.text, fireAt: r.fire_at } as any);
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
      Notification.requestPermission().catch(() => {});
    }
    // Fire morning briefing once per day, after a small delay.
    const t = window.setTimeout(() => { runMorningBriefing().catch(() => {}); }, 4000);
    return () => { stop(); window.clearTimeout(t); };
  }, []);

  return (
    <>
      <div className="grid-bg" />
      <div className="vignette" />
      <div style={{ position: "relative", zIndex: 2, height: "100%", display: "flex", flexDirection: "column" }}>
        <TopBar />
        <main style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <Suspense fallback={<BootFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/notes" element={<Notes />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/finance/*" element={<Finance />} />
              <Route path="/projects/*" element={<Projects />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
        </main>
        <VoiceBar />
      </div>
      <ContentPanel />
      <CommandPalette />
      <ToastLayer />
    </>
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
