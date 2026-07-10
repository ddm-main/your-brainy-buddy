import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Chip, EmptyState } from "@/components/hud/HudControls";
import { db, type EmailAccount } from "@/lib/db";

function relTime(iso?: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function RecentActivity() {
  const [items, setItems] = useState<EmailAccount[]>([]);
  useEffect(() => { db.emailAccounts.list().then(setItems as any); }, []);

  if (items.length === 0) return <EmptyState>no accounts to report on</EmptyState>;

  return (
    <HudPanel title="Recent Activity" index="LOG" live="ok" bodyClass="overflow-auto">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((a) => (
          <div key={a.id} style={{ padding: "8px 10px", border: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, color: "var(--text)", flex: 1, minWidth: 200 }}>{a.email_address}</div>
              {a.paused_at
                ? <Chip tone="warn">paused</Chip>
                : a.sync_status === "error"
                  ? <Chip tone="warn">error</Chip>
                  : a.sync_status === "syncing"
                    ? <Chip tone="accent">syncing…</Chip>
                    : <Chip tone="accent">last sync {relTime(a.last_synced_at)}</Chip>}
              <Chip>{(a as any).sync_frequency ?? "manual"}</Chip>
            </div>
            {a.last_error && (
              <div style={{ fontSize: 11, color: "var(--warn, #e0a458)", fontFamily: "var(--font-mono, monospace)", wordBreak: "break-word" }}>
                {a.last_error}
              </div>
            )}
          </div>
        ))}
      </div>
    </HudPanel>
  );
}