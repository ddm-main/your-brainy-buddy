import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type EmailRow } from "@/lib/db";
import { useUi } from "@/store/uiStore";

const CATS: { key: EmailRow["category"] | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "important", label: "Important" },
  { key: "needs_reply", label: "Needs Reply" },
  { key: "follow_up", label: "Follow-up" },
  { key: "finance", label: "Finance" },
  { key: "work", label: "Work" },
  { key: "personal", label: "Personal" },
];

export default function Inbox() {
  const [tab, setTab] = useState<(typeof CATS)[number]["key"]>("all");
  const [items, setItems] = useState<EmailRow[]>([]);
  const [selected, setSelected] = useState<EmailRow | null>(null);
  const [loading, setLoading] = useState(true);
  const push = useUi((s) => s.push);

  const load = async () => {
    setLoading(true);
    try {
      const list = await db.emails.list(tab === "all" ? undefined : (tab as any), 100);
      setItems(list);
      if (!selected && list.length) setSelected(list[0]);
    } catch (e: any) { push(e?.message, "err"); }
    finally { setLoading(false); }
  };
  useEffect(() => { setSelected(null); load(); }, [tab]);

  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "220px 1fr 1.4fr", gap: 12, minHeight: 0 }}>
      <HudPanel title="Lanes" index="IN" live="ok" bodyClass="overflow-auto">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {CATS.map((c) => (
            <button key={c.key} onClick={() => setTab(c.key)}
              style={{
                padding: "8px 10px", textAlign: "left", border: `1px solid ${tab === c.key ? "var(--edge-strong)" : "var(--edge)"}`,
                background: tab === c.key ? "rgba(53,214,237,0.08)" : "transparent",
                color: tab === c.key ? "var(--accent)" : "var(--text-dim)", fontSize: 12, cursor: "pointer",
              }}>{c.label}</button>
          ))}
        </div>
      </HudPanel>
      <HudPanel title="Emails" index="LST" live="ok" bodyClass="overflow-auto">
        {loading ? <div className="hud-label">loading…</div> :
         items.length === 0 ? <EmptyState hint="import a Gmail account or add rows to the emails table">no emails</EmptyState> :
         <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
           {items.map((e) => (
             <button key={e.id} onClick={() => setSelected(e)}
               style={{ textAlign: "left", padding: "8px 10px", border: `1px solid ${selected?.id === e.id ? "var(--edge-strong)" : "var(--edge)"}`, background: selected?.id === e.id ? "rgba(53,214,237,0.06)" : "transparent", cursor: "pointer" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                 {e.category && <Chip tone={e.category === "important" ? "warn" : e.category === "finance" ? "accent" : "neutral"}>{e.category}</Chip>}
                 {e.finance_related && <Chip tone="accent">$</Chip>}
                 <span className="hud-label" style={{ marginLeft: "auto" }}>{e.received_at ? new Date(e.received_at).toLocaleDateString() : ""}</span>
               </div>
               <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-hud)", letterSpacing: "0.06em" }}>{e.from_name ?? e.from_email ?? "—"}</div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.subject ?? "(no subject)"}</div>
             </button>
           ))}
         </div>}
      </HudPanel>
      <HudPanel title={selected ? (selected.subject ?? "(no subject)") : "Preview"} index="MSG" live="idle" bodyClass="overflow-auto">
        {!selected ? <EmptyState>nothing selected</EmptyState> :
         <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
           <div style={{ borderBottom: "1px solid var(--edge)", paddingBottom: 8, fontSize: 12 }}>
             <div style={{ color: "var(--accent-soft)", fontFamily: "var(--font-hud)", letterSpacing: "0.06em" }}>{selected.from_name ?? selected.from_email ?? "—"}</div>
             <div className="hud-label">{selected.received_at ? new Date(selected.received_at).toLocaleString() : ""}</div>
           </div>
           {selected.ai_summary && (
             <div style={{ padding: 10, border: "1px solid var(--edge)", background: "rgba(53,214,237,0.04)" }}>
               <div className="hud-label" style={{ color: "var(--accent)", marginBottom: 4 }}>ai summary</div>
               <div style={{ fontSize: 12, color: "var(--text)" }}>{selected.ai_summary}</div>
             </div>
           )}
           <div style={{ fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
             {selected.body_text ?? "— no body captured —"}
           </div>
           <NewEmailFormOnce email={selected} />
         </div>}
      </HudPanel>
    </div>
  );
}

function NewEmailFormOnce({ email }: { email: EmailRow }) {
  // Utility: convert to task
  const [busy, setBusy] = useState(false);
  const push = useUi((s) => s.push);
  const toTask = async () => {
    setBusy(true);
    try {
      await db.tasks.create({
        title: `Reply: ${email.subject ?? email.from_email ?? "email"}`,
        source: "inbox",
        linked_email_id: email.id,
        priority: email.category === "important" ? "high" : "normal",
      });
      await db.actions.log("email.to_task", email.subject ?? "", "inbox");
      push("Task created from email", "ok");
    } catch (e: any) { push(e?.message, "err"); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <Btn size="sm" variant="primary" onClick={toTask} disabled={busy}>+ create task</Btn>
    </div>
  );
}
