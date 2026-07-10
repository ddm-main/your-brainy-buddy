import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { db } from "@/lib/db";
import { Plus, ListChecks, SlidersHorizontal, Filter, Activity } from "lucide-react";

export default function EmailHome() {
  const nav = useNavigate();
  const [stats, setStats] = useState<{ total: number; connected: number; errors: number } | null>(null);
  useEffect(() => { db.emailAccounts.counts().then(setStats).catch(() => {}); }, []);

  const cards = [
    { view: "list?add=1",   label: "Connect new mailbox", desc: "Add and authorize a new Gmail account",       icon: Plus },
    { view: "list",         label: "Manage mailboxes",    desc: "Connections, sync now, reconnect, delete",     icon: ListChecks },
    { view: "list",         label: "Sync rules",          desc: "Frequency, period, cap, pause — per account",  icon: SlidersHorizontal },
    { view: "list",         label: "Sender filters",      desc: "Finance-only, extra domains",                  icon: Filter },
    { view: "activity",     label: "Recent activity",     desc: "Last sync, errors, history per account",       icon: Activity },
  ] as const;

  return (
    <HudPanel
      title="Email"
      index="MAIL"
      live="ok"
      bodyClass="overflow-auto"
      actions={
        <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
          {stats ? `${stats.connected}/${stats.total} connected · ${stats.errors} error${stats.errors === 1 ? "" : "s"}` : ""}
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.label}
              onClick={() => nav(`/config/email/${c.view}`)}
              style={{
                textAlign: "left", padding: "14px", display: "flex", flexDirection: "column", gap: 8,
                border: "1px solid var(--edge)", background: "rgba(53,214,237,0.03)",
                color: "var(--text)", cursor: "pointer",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge-strong)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)" }}>
                <Icon size={16} />
                <div className="hud-label" style={{ fontSize: 11 }}>{c.label}</div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim, var(--text))", lineHeight: 1.4 }}>{c.desc}</div>
            </button>
          );
        })}
      </div>
    </HudPanel>
  );
}