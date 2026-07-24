import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { supabase } from "@/integrations/supabase/client";
import { Mail, Landmark, FolderKanban, LogOut, LineChart, ShieldCheck, type LucideIcon } from "lucide-react";
import { useAccessStore } from "@/store/accessStore";

type Card = {
  to: string;
  label: string;
  desc: string;
  table: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

const CARDS: Card[] = [
  { to: "/config/email",    label: "Email",    desc: "Mailbox connections, sync rules, filters",              table: "email_accounts", icon: Mail },
  { to: "/config/finance",  label: "Finance",  desc: "Banks, accounts, cards, loans, goals, subscriptions",   table: "",               icon: Landmark },
  { to: "/config/projects", label: "Projects", desc: "Active projects and areas",                              table: "projects",       icon: FolderKanban },
  { to: "/config/market",   label: "Market",   desc: "Data pipeline health, fundamentals & technicals resync", table: "market_stocks",  icon: LineChart },
  { to: "/config/admin",    label: "Admin",    desc: "Users, roles, and section access",                       table: "",               icon: ShieldCheck, adminOnly: true },
];

export default function ConfigHome() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const role = useAccessStore((s) => s.role);
  const visibleCards = CARDS.filter((c) => (c.adminOnly ? role === "admin" : true));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        CARDS.filter((c) => c.table).map(async (c) => {
          const { count } = await supabase.from(c.table as any).select("id", { count: "exact", head: true });
          return [c.table, count ?? 0] as const;
        }),
      );
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <HudPanel title="Configuration" index="CFG" live="ok" bodyClass="overflow-auto">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
        {visibleCards.map((c) => {
          const Icon = c.icon;
          const n = counts[c.table];
          return (
            <NavLink
              key={c.to}
              to={c.to}
              style={{
                display: "flex", flexDirection: "column", gap: 8,
                padding: "14px 14px 12px",
                border: "1px solid var(--edge)",
                background: "rgba(53,214,237,0.03)",
                color: "var(--text)",
                textDecoration: "none",
                transition: "border-color 160ms, background 160ms, transform 160ms",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--edge-strong)";
                (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.07)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)";
                (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.03)";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--accent)" }}><Icon size={16} /></span>
                <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11 }}>{c.label}</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                  {!c.table ? null : n === undefined ? "…" : `${n} ${n === 1 ? "entry" : "entries"}`}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim, var(--text))", lineHeight: 1.4 }}>{c.desc}</div>
            </NavLink>
          );
        })}
      </div>

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--edge)" }}>
        <button
          onClick={() => supabase.auth.signOut()}
          className="focus-outline"
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "9px 14px", border: "1px solid var(--edge)",
            background: "transparent", color: "var(--danger)", cursor: "pointer",
            borderRadius: 2, fontFamily: "var(--font-hud)", fontSize: 11,
            letterSpacing: "0.16em", textTransform: "uppercase",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--danger)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)"; }}
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </HudPanel>
  );
}