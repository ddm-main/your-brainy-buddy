import { NavLink, Link, useLocation } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { Bell, Command, LogOut, SlidersHorizontal, Wifi, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

import { useEffect, useRef, useState } from "react";
import { useUi } from "@/store/uiStore";
import { useAiStatus } from "@/store/aiStatusStore";
import { useNotifications } from "@/store/notificationStore";
import { motion, AnimatePresence } from "framer-motion";

const NAV = [
  { to: "/", label: "HUD" },
  { to: "/tasks", label: "Tasks" },
  { to: "/notes", label: "Notes" },
  { to: "/decisions", label: "Decisions" },
  { to: "/finance", label: "Finance" },
  { to: "/projects", label: "Projects" },
];

export default function TopBar() {
  const loc = useLocation();
  const navigate = useNavigate();
  const togglePalette = useUi((s) => s.togglePalette);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Real Supabase reachability check, not a decoration — cheap head-count
  // query on an interval.
  const [linkOk, setLinkOk] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { error } = await supabase.from("banks").select("id", { head: true, count: "exact" }).limit(1);
        if (!cancelled) setLinkOk(!error);
      } catch {
        if (!cancelled) setLinkOk(false);
      }
    };
    check();
    const iv = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const aiOk = useAiStatus((s) => s.ok);

  const notifItems = useNotifications((s) => s.items);
  const unreadCount = useNotifications((s) => s.unreadCount);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notifOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [notifOpen]);
  const toggleNotif = () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next) markAllRead();
  };

  const time = now.toLocaleTimeString([], { hour12: false });
  const date = now.toLocaleDateString([], { day: "2-digit", month: "short" }).toUpperCase();

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 20px",
        borderBottom: "1px solid var(--edge)",
        background: "var(--panel-tint-strong)",
        backdropFilter: "blur(20px)",
        zIndex: 10,
        gap: 20,
        position: "relative",
      }}
    >
      <Link to="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 12 }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 24, repeat: Infinity, ease: "linear" }}
          style={{
            width: 26, height: 26, borderRadius: "50%",
            border: "1px solid var(--accent)",
            position: "relative",
            boxShadow: "0 0 12px rgba(53, 214, 237, 0.5), inset 0 0 8px rgba(53, 214, 237, 0.3)",
          }}
        >
          <span style={{
            position: "absolute", inset: 6, borderRadius: "50%",
            background: "var(--accent)", boxShadow: "0 0 8px var(--accent)",
          }} />
        </motion.div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, letterSpacing: "0.28em", fontSize: 15, color: "var(--text)" }}>
            J.A.R.V.I.S
          </span>
        </div>
      </Link>

      <nav style={{ display: "flex", gap: 4 }}>
        {NAV.map((n) => {
          const active = n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to);
          return (
            <NavLink
              key={n.to}
              to={n.to}
              style={{
                padding: "6px 14px",
                fontFamily: "var(--font-hud)",
                fontSize: 11,
                letterSpacing: "0.24em",
                textTransform: "uppercase",
                textDecoration: "none",
                color: active ? "var(--accent)" : "var(--text-dim)",
                border: `1px solid ${active ? "var(--edge-strong)" : "transparent"}`,
                background: active ? "rgba(53, 214, 237, 0.08)" : "transparent",
                borderRadius: 2,
                position: "relative",
                transition: "all 200ms",
              }}
            >
              {n.label}
              {active && (
                <motion.span
                  layoutId="nav-active"
                  style={{
                    position: "absolute", left: 0, right: 0, bottom: -1, height: 1,
                    background: "var(--accent)", boxShadow: "0 0 6px var(--accent)",
                  }}
                />
              )}
            </NavLink>
          );
        })}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={togglePalette}
          className="focus-outline"
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "5px 10px", border: "1px solid var(--edge)",
            borderRadius: 2, fontSize: 10, fontFamily: "var(--font-hud)",
            letterSpacing: "0.16em", textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
          title="Command palette (⌘K)"
        >
          <Command size={12} /> ⌘K
        </button>

        <StatusChip label="link" ok={linkOk} icon={<Wifi size={11} />} />
        <StatusChip label="ai" ok={aiOk} icon={<Zap size={11} />} />

        <div style={{ fontFamily: "var(--font-display)", fontSize: 13, color: "var(--accent-soft)", letterSpacing: "0.1em" }}>
          <span style={{ color: "var(--text-dim)", fontSize: 10, marginRight: 8 }}>{date}</span>
          {time}
        </div>

        <div ref={notifRef} style={{ position: "relative" }}>
          <button className="focus-outline" title="Notifications" style={{ ...iconBtn, position: "relative" }} onClick={toggleNotif}>
            <Bell size={14} />
            {unreadCount > 0 && (
              <span style={{
                position: "absolute", top: 2, right: 2, width: 6, height: 6, borderRadius: "50%",
                background: "var(--danger)", boxShadow: "0 0 4px var(--danger)",
              }} />
            )}
          </button>
          <AnimatePresence>
            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                className="hud-panel"
                style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 300, maxHeight: 360, overflow: "auto", zIndex: 50 }}
              >
                <span className="hud-corner tl" /><span className="hud-corner tr" />
                <span className="hud-corner bl" /><span className="hud-corner br" />
                <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--edge)" }} className="hud-label">Notifications</div>
                <div style={{ padding: 8 }}>
                  {notifItems.length === 0 ? (
                    <div className="hud-label" style={{ padding: 12, textAlign: "center" }}>no notifications</div>
                  ) : (
                    notifItems.map((n) => (
                      <div key={n.id} style={{ padding: "8px 10px", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                        <div style={{ fontSize: 12, color: "var(--text)" }}>{n.text}</div>
                        <div className="hud-label" style={{ marginTop: 2, color: "var(--text-muted)" }}>{new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button
          className="focus-outline"
          title="Config"
          onClick={() => navigate("/config")}
          style={iconBtn}
        >
          <SlidersHorizontal size={13} />
        </button>
        <button
          className="focus-outline"
          title="Sign out"
          onClick={() => supabase.auth.signOut()}
          style={iconBtn}
        >
          <LogOut size={14} />
        </button>
      </div>
    </header>
  );
}


const iconBtn = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, border: "1px solid var(--edge)",
  color: "var(--text-dim)", borderRadius: 2,
  background: "transparent", cursor: "pointer",
} as const;

function StatusChip({ label, ok, icon }: { label: string; ok: boolean; icon: any }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      padding: "4px 8px", border: "1px solid var(--edge)", borderRadius: 2,
      fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.18em",
      textTransform: "uppercase", color: ok ? "var(--ok)" : "var(--danger)",
    }}>
      {icon}<span>{label}</span>
      <span className={`live-dot ${ok ? "" : "err"}`} style={{ width: 4, height: 4 }} />
    </div>
  );
}
