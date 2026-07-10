import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type Task } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2, Star } from "lucide-react";

const FILTERS: { key: "open" | "today" | "focus" | "done"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "today", label: "Today" },
  { key: "focus", label: "Focus" },
  { key: "done", label: "Done" },
];

export default function Tasks() {
  const [tab, setTab] = useState<(typeof FILTERS)[number]["key"]>("open");
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const push = useUi((s) => s.push);

  const load = async () => {
    setLoading(true);
    try {
      let list: Task[] = [];
      if (tab === "done") list = await db.tasks.list({ status: "done", limit: 100 });
      else if (tab === "focus") list = await db.tasks.focus(100);
      else if (tab === "today") {
        const all = await db.tasks.listOpen(200);
        const end = new Date(); end.setHours(23, 59, 59, 999);
        list = all.filter((t: any) => t.due_at && new Date(t.due_at).getTime() <= end.getTime());
      } else list = await db.tasks.listOpen(200);
      setItems(list);
    } catch (e: any) {
      push(`Load failed: ${e?.message ?? e}`, "err");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [tab]);

  const toggleDone = async (t: Task) => {
    const next: Task["status"] = t.status === "done" ? "todo" : "done";
    try { await db.tasks.setStatus(t.id, next); load(); } catch (e: any) { push(e?.message, "err"); }
  };
  const toggleFocus = async (t: Task) => {
    try { await db.tasks.setFocus(t.id, !t.focus); load(); } catch (e: any) { push(e?.message, "err"); }
  };
  const remove = async (t: Task) => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    try { await db.tasks.remove(t.id); load(); } catch (e: any) { push(e?.message, "err"); }
  };

  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <HudPanel title="Tasks" index="TSK" live="ok" style={{ flexShrink: 0 }}>
        <QuickAdd onCreated={load} />
      </HudPanel>
      <HudPanel
        title="Queue"
        index="Q"
        live="ok"
        style={{ flex: 1, minHeight: 0 }}
        actions={
          <div style={{ display: "flex", gap: 4 }}>
            {FILTERS.map((f) => (
              <Btn key={f.key} size="sm" variant={tab === f.key ? "primary" : "ghost"} onClick={() => setTab(f.key)}>
                {f.label}
              </Btn>
            ))}
          </div>
        }
        bodyClass="overflow-auto"
      >
        {loading ? (
          <div className="hud-label" style={{ padding: 12 }}>loading…</div>
        ) : items.length === 0 ? (
          <EmptyState hint="use the Quick Add above">no tasks in this view</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <AnimatePresence initial={false}>
              {items.map((t) => (
                <motion.div
                  key={t.id}
                  layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  style={{
                    display: "grid", gridTemplateColumns: "auto 1fr auto auto auto",
                    gap: 10, alignItems: "center",
                    padding: "8px 10px", border: "1px solid var(--edge)",
                    background: t.status === "done" ? "rgba(107,255,176,0.03)" : "transparent",
                  }}
                >
                  <button onClick={() => toggleDone(t)} title={t.status === "done" ? "reopen" : "mark done"}
                    style={{ width: 14, height: 14, border: `1px solid ${t.status === "done" ? "var(--ok)" : "var(--edge-strong)"}`, background: t.status === "done" ? "var(--ok)" : "transparent" }} />
                  <div>
                    <div style={{ fontSize: 13, color: t.status === "done" ? "var(--text-muted)" : "var(--text)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
                    {t.description && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t.description}</div>}
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      {t.priority !== "normal" && <Chip tone={t.priority === "urgent" ? "err" : t.priority === "high" ? "warn" : "neutral"}>{t.priority}</Chip>}
                      {t.due_at && <Chip>{new Date(t.due_at).toLocaleDateString()}</Chip>}
                      {t.category && <Chip>{t.category}</Chip>}
                    </div>
                  </div>
                  <button onClick={() => toggleFocus(t)} title={t.focus ? "unfocus" : "focus"}
                    style={{ padding: 4, color: t.focus ? "var(--accent)" : "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
                    <Star size={14} fill={t.focus ? "currentColor" : "none"} />
                  </button>
                  <Chip tone={t.status === "done" ? "ok" : t.status === "doing" ? "accent" : "neutral"}>{t.status}</Chip>
                  <button onClick={() => remove(t)} title="delete" style={{ padding: 4, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
                    <Trash2 size={13} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </HudPanel>
    </div>
  );
}

function QuickAdd({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const [due, setDue] = useState("");
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const push = useUi((s) => s.push);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await db.tasks.create({
        title: title.trim(),
        priority,
        due_at: due ? new Date(due).toISOString() : null,
        focus,
        source: "hud",
      });
      await db.actions.log("task.create", `+ ${title.trim()}`, "tasks");
      setTitle(""); setDue(""); setFocus(false); setPriority("normal");
      onCreated();
    } catch (err: any) {
      push(`Create failed: ${err?.message}`, "err");
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto auto", gap: 8, alignItems: "end" }}>
      <div>
        <label style={labelStyle}>new task</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. review Axis card statement" style={{ ...inputStyle, width: "100%" }} />
      </div>
      <div>
        <label style={labelStyle}>priority</label>
        <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])} style={inputStyle}>
          <option value="low">low</option>
          <option value="normal">normal</option>
          <option value="high">high</option>
          <option value="urgent">urgent</option>
        </select>
      </div>
      <div>
        <label style={labelStyle}>due</label>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={inputStyle} />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-hud)", textTransform: "uppercase", letterSpacing: "0.14em", cursor: "pointer" }}>
        <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> focus
      </label>
      <Btn type="submit" variant="primary" disabled={busy || !title.trim()}>{busy ? "…" : "+ add"}</Btn>
    </form>
  );
}
