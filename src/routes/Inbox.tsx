import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { db, type EmailRow } from "@/lib/db";
import { gmail } from "@/lib/gmail";
import { useUi } from "@/store/uiStore";
import { RefreshCw } from "lucide-react";


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
  const [syncing, setSyncing] = useState(false);
  const push = useUi((s) => s.push);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const list = await db.emails.list(tab === "all" ? undefined : (tab as any), 100);
      setItems(list);
      if (!selected && list.length) setSelected(list[0]);
    } catch (e: any) { push(e?.message, "err"); }
    finally { setLoading(false); }
  };

  const syncAll = async (silent = false) => {
    setSyncing(true);
    try {
      const accts = await db.emailAccounts.list();
      const gmails = accts.filter((a: any) => a.provider === "gmail" && a.connected_at);
      if (gmails.length === 0) { if (!silent) push("No connected Gmail accounts", "warn" as any); return; }
      let totalNew = 0;
      for (const a of gmails) {
        try { const r = await gmail.sync(a.id); totalNew += r.inserted ?? 0; }
        catch (e: any) { if (!silent) push(`${a.email_address}: ${e?.message}`, "err"); }
      }
      if (totalNew > 0 || !silent) push(`Synced (${totalNew} new)`, "ok");
      await load();
    } finally { setSyncing(false); }
  };

  useEffect(() => { setSelected(null); load(); }, [tab]);

  // Auto-sync on mount if any account is stale (>5 min) or never synced.
  useEffect(() => {
    (async () => {
      try {
        const accts = await db.emailAccounts.list();
        const stale = accts.some((a: any) => a.provider === "gmail" && a.connected_at && (
          !a.last_synced_at || (Date.now() - new Date(a.last_synced_at).getTime()) > 5 * 60 * 1000
        ));
        if (stale) syncAll(true);
      } catch { /* noop */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load body when a message with no body is selected.
  useEffect(() => {
    if (!selected || selected.body_text || selected.body_html) return;
    if (selected.provider !== "gmail" && !selected.external_email_id) return;
    (async () => {
      try {
        const r = await gmail.message(selected.id);
        setSelected((s) => (s && s.id === selected.id ? { ...s, body_text: r.body_text, body_html: r.body_html } : s));
        setItems((list) => list.map((e) => e.id === selected.id ? { ...e, body_text: r.body_text, body_html: r.body_html } : e));
      } catch (e: any) { push(e?.message, "err"); }
    })();
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps


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
      <HudPanel title="Emails" index="LST" live="ok" bodyClass="overflow-auto" actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Btn size="sm" onClick={() => syncAll(false)} disabled={syncing}><RefreshCw size={11} style={{ marginRight: 4 }} />{syncing ? "syncing…" : "sync"}</Btn>
          <Btn size="sm" variant="primary" onClick={() => navigate("/config/email")}>+ add email account</Btn>
          <span className="hud-label" style={{ color: "var(--accent)" }}><KineticNumber value={items.length} /> loaded</span>
        </div>
      }>
        {loading ? <div className="hud-label">loading…</div> :
         items.length === 0 ? (
           <EmptyState hint="connect an inbox to start syncing mail">
             <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
               <span>no emails</span>
               <Btn size="sm" variant="primary" onClick={() => navigate("/config/email")}>+ add email account</Btn>
             </div>
           </EmptyState>
         ) :
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
