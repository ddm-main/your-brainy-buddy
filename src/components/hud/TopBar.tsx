import { NavLink, Link, useLocation } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { Bell, SlidersHorizontal, Wifi, LogOut, Settings as SettingsIcon, User as UserIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

import { useEffect, useRef, useState } from "react";
import { useAiStatus } from "@/store/aiStatusStore";
import { useNotifications } from "@/store/notificationStore";
import { useAccessStore, type AppSection } from "@/store/accessStore";
import { motion, AnimatePresence } from "framer-motion";
import { MARKET_GROUPS } from "@/routes/market/nav";
import QuotaStatusChip from "@/components/hud/QuotaStatusChip";
import FeedStatusChip from "@/components/hud/FeedStatusChip";

const NAV: { to: string; label: string; section: AppSection }[] = [
  { to: "/", label: "HUD", section: "hud" },
  { to: "/market", label: "Market", section: "market" },
  { to: "/finance", label: "Finance", section: "finance" },
  { to: "/tasks", label: "Tasks", section: "tasks" },
  { to: "/projects", label: "Projects", section: "projects" },
];


export default function TopBar() {
  const loc = useLocation();
  const navigate = useNavigate();
  const role = useAccessStore((s) => s.role);
  const sections = useAccessStore((s) => s.sections);
  const resetAccess = useAccessStore((s) => s.reset);
  // Admins keep a safety net to /config so they can't lock themselves out of the admin panel.
  const canConfig = sections.has("config") || role === "admin";

  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // EGRESS: read the email off the cached session instead of hitting
    // /auth/v1/user on every mount.
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setEmail(data.session?.user.email ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [userOpen]);

  const signOut = async () => {
    setUserOpen(false);
    await supabase.auth.signOut();
    resetAccess();
    navigate("/auth");
  };

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
      // EGRESS: this ran every 60 s in every open tab, forever. A hidden tab
      // has nothing to indicate, so it does not need to ask.
      if (document.visibilityState !== "visible") return;
      try {
        const { error } = await supabase.from("banks").select("id", { head: true, count: "exact" }).limit(1);
        if (!cancelled) setLinkOk(!error);
      } catch {
        if (!cancelled) setLinkOk(false);
      }
    };
    check();
    const iv = setInterval(check, 5 * 60_000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
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

      <nav style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        {(() => {
          const onMarket = loc.pathname.startsWith("/market");
          const baseNav = NAV.filter((n) => sections.has(n.section));
          // On /market, replace the single "Market" chip with its group tabs
          // to reclaim vertical space from the in-page sub-nav.
          const items: { to: string; label: string; end?: boolean; key: string; isActive: (p: string) => boolean }[] = [];
          for (const n of baseNav) {
            if (onMarket && n.to === "/market") {
              // "Settings" is moved into the user (avatar) menu below to
              // declutter the top nav; skip it here.
              for (const g of MARKET_GROUPS.filter((g) => g.key !== "settings")) {
                items.push({
                  key: `mg-${g.key}`,
                  to: g.to,
                  label: g.label,
                  end: g.to === "/market",
                  isActive: (p) => g.match(p),
                });
              }
            } else {
              items.push({
                key: n.to,
                to: n.to,
                label: n.label,
                end: n.to === "/",
                isActive: (p) => (n.to === "/" ? p === "/" : p.startsWith(n.to)),
              });
            }
          }
          return items.map((it) => {
            const active = it.isActive(loc.pathname);
            return (
              <NavLink
                key={it.key}
                to={it.to}
                end={it.end}
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
                {it.label}
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
          });
        })()}
      </nav>


      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <FeedStatusChip />
        <QuotaStatusChip />
        {/* System-health chip only surfaces when something is actually down. */}
        {!(linkOk && aiOk) && (
          <StatusChip
            label="sys"
            ok={false}
            icon={<Wifi size={11} />}
            title={`Link ${linkOk ? "OK" : "DOWN"} · AI ${aiOk ? "OK" : "DOWN"}`}
          />
        )}

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
        <div ref={userRef} style={{ position: "relative" }}>
          <button
            className="focus-outline"
            title="Account"
            onClick={() => setUserOpen((v) => !v)}
            style={iconBtn}
          >
            <UserIcon size={13} />
          </button>
          <AnimatePresence>
            {userOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                className="hud-panel"
                style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 240, zIndex: 50 }}
              >
                <span className="hud-corner tl" /><span className="hud-corner tr" />
                <span className="hud-corner bl" /><span className="hud-corner br" />
                <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--edge)" }}>
                  <div className="hud-label" style={{ color: "var(--text-muted)" }}>Signed in</div>
                  <div style={{ fontSize: 12, color: "var(--text)", marginTop: 2, wordBreak: "break-all" }}>
                    {email ?? "…"}
                  </div>
                  <div className="hud-label" style={{ color: "var(--accent)", marginTop: 4 }}>{role ?? "—"}</div>
                </div>
                <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                  <button
                    className="focus-outline"
                    onClick={() => { setUserOpen(false); navigate("/market/settings"); }}
                    style={menuItem}
                  >
                    <SettingsIcon size={13} /> Market Settings
                  </button>
                  {canConfig && (
                    <button
                      className="focus-outline"
                      onClick={() => { setUserOpen(false); navigate("/config"); }}
                      style={menuItem}
                    >
                      <SlidersHorizontal size={13} /> Admin Panel
                    </button>
                  )}
                  <button
                    className="focus-outline"
                    onClick={signOut}
                    style={{ ...menuItem, color: "var(--danger)" }}
                  >
                    <LogOut size={13} /> Sign out
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
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

const menuItem = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "8px 10px", background: "transparent",
  border: "1px solid transparent", color: "var(--text)",
  cursor: "pointer", fontFamily: "var(--font-hud)", fontSize: 11,
  letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "left" as const,
} as const;

function StatusChip({ label, ok, icon, title }: { label: string; ok: boolean; icon: any; title?: string }) {
  return (
    <div title={title} style={{
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
