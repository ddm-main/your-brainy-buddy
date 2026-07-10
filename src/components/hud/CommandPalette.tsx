import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useUi } from "@/store/uiStore";
import { Command as CmdIcon, Mail, Wallet, Home, ListChecks, Scan, Sparkles, SlidersHorizontal } from "lucide-react";

type Cmd = { id: string; label: string; hint?: string; icon: any; run: () => void };

export default function CommandPalette() {
  const { paletteOpen, setPalette, push } = useUi();
  const nav = useNavigate();
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useUi.getState().paletteOpen);
      } else if (e.key === "Escape") {
        setPalette(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  useEffect(() => { if (paletteOpen) setQ(""); }, [paletteOpen]);

  const commands: Cmd[] = useMemo(() => [
    { id: "home", label: "Open HUD", hint: "home", icon: Home, run: () => nav("/") },
    { id: "inbox", label: "Open Inbox Command Center", hint: "email workspace", icon: Mail, run: () => nav("/inbox") },
    { id: "finance", label: "Open Finance", hint: "accounts, transactions, statements", icon: Wallet, run: () => nav("/finance") },
    { id: "projects", label: "Open Projects", hint: "active work", icon: ListChecks, run: () => nav("/projects") },
    { id: "config", label: "Open Config", hint: "connections, entities, memory", icon: SlidersHorizontal, run: () => nav("/config") },
    { id: "scan", label: "Scan bank mail now", hint: "finance ingestion", icon: Scan, run: () => { fetch("/api/finance/scan", { method: "POST" }); push("Bank mail scan queued", "ok"); } },
    { id: "brief", label: "Brief me", hint: "read the morning briefing", icon: Sparkles, run: () => push("Briefing initiated", "ok") },
  ], [nav, push]);

  const filtered = q
    ? commands.filter((c) => (c.label + " " + (c.hint ?? "")).toLowerCase().includes(q.toLowerCase()))
    : commands;

  return (
    <AnimatePresence>
      {paletteOpen && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(3, 8, 18, 0.7)",
            backdropFilter: "blur(6px)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: "12vh",
          }}
          onClick={() => setPalette(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: -10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: -10 }}
            onClick={(e) => e.stopPropagation()}
            className="hud-panel"
            style={{ width: 560, maxWidth: "94%" }}
          >
            <span className="hud-corner tl" /><span className="hud-corner tr" />
            <span className="hud-corner bl" /><span className="hud-corner br" />
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--edge)" }}>
              <CmdIcon size={14} color="var(--accent)" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Command JARVIS…"
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 14, fontFamily: "var(--font-hud)", letterSpacing: "0.06em" }}
              />
              <span className="hud-label">esc</span>
            </div>
            <div style={{ maxHeight: 380, overflow: "auto", padding: 8 }}>
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { c.run(); setPalette(false); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 12px", borderRadius: 2, textAlign: "left",
                    color: "var(--text)", transition: "background 150ms",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53, 214, 237, 0.08)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <c.icon size={14} color="var(--accent)" />
                  <span style={{ flex: 1, fontSize: 13 }}>{c.label}</span>
                  <span className="hud-label">{c.hint}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="hud-label" style={{ padding: 20, textAlign: "center" }}>no matching command</div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
