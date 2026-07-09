import { NavLink, Link, useLocation } from "react-router-dom";
import { Bell, Command, Settings as SettingsIcon, Wifi, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useUi } from "@/store/uiStore";
import { motion } from "framer-motion";

const NAV = [
  { to: "/", label: "HUD" },
  { to: "/tasks", label: "Tasks" },
  { to: "/notes", label: "Notes" },
  { to: "/inbox", label: "Inbox" },
  { to: "/finance", label: "Finance" },
  { to: "/projects", label: "Projects" },
];

export default function TopBar() {
  const loc = useLocation();
  const togglePalette = useUi((s) => s.togglePalette);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

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
        background: "rgba(5, 10, 20, 0.7)",
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
          <span className="hud-label" style={{ fontSize: 8, letterSpacing: "0.24em" }}>
            personal ai operating system
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

        <StatusChip label="link" ok icon={<Wifi size={11} />} />
        <StatusChip label="ai" ok icon={<Zap size={11} />} />

        <div style={{ fontFamily: "var(--font-display)", fontSize: 13, color: "var(--accent-soft)", letterSpacing: "0.1em" }}>
          <span style={{ color: "var(--text-dim)", fontSize: 10, marginRight: 8 }}>{date}</span>
          {time}
        </div>

        <button className="focus-outline" title="Notifications" style={iconBtn}>
          <Bell size={14} />
        </button>
        <NavLink to="/settings" className="focus-outline" title="Settings" style={iconBtn as any}>
          <SettingsIcon size={14} />
        </NavLink>
      </div>
    </header>
  );
}

const iconBtn = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, border: "1px solid var(--edge)",
  color: "var(--text-dim)", borderRadius: 2,
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
