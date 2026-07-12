import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type Note, relTime } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

// "decision" intentionally excluded — decisions now have their own screen
// (/decisions, backed by the richer `decisions` table). Existing
// decision-typed notes still render fine, just no longer creatable here.
const TYPES: Note["note_type"][] = ["general", "project", "meeting", "sop", "reference", "personal", "finance"];

export default function Notes() {
  const [items, setItems] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const push = useUi((s) => s.push);

  const load = async () => {
    setLoading(true);
    try {
      const list = await db.notes.list();
      setItems(list);
      if (list.length && !selected) setSelected(list[0]);
    } catch (e: any) { push(e?.message, "err"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (n: Note) => {
    if (!confirm(`Delete note "${n.title}"?`)) return;
    await db.notes.remove(n.id);
    if (selected?.id === n.id) setSelected(null);
    load();
  };

  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "minmax(280px, 1fr) 2fr", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="New Note" index="NEW" live="ok" style={{ flexShrink: 0 }}>
          <QuickAdd onCreated={(n) => { setSelected(n); load(); }} />
        </HudPanel>
        <HudPanel title="Notes" index="MEM" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
          {loading ? <div className="hud-label">loading…</div> :
           items.length === 0 ? <EmptyState hint="capture your first thought">memory is empty</EmptyState> :
           <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
             {items.map((n) => (
               <button key={n.id} onClick={() => setSelected(n)} style={{
                 textAlign: "left", padding: "8px 10px",
                 border: `1px solid ${selected?.id === n.id ? "var(--edge-strong)" : "var(--edge)"}`,
                 background: selected?.id === n.id ? "rgba(53,214,237,0.06)" : "transparent",
                 cursor: "pointer",
               }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                   <Chip tone="accent">{n.note_type}</Chip>
                   <span className="hud-label" style={{ marginLeft: "auto" }}>{relTime(n.updated_at)}</span>
                 </div>
                 <div style={{ fontSize: 12, color: "var(--text)" }}>{n.title}</div>
                 {n.content && <div style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.content}</div>}
               </button>
             ))}
           </div>}
        </HudPanel>
      </div>

      <HudPanel
        title={selected ? selected.title : "Select a note"}
        index="VIEW" live="idle" style={{ minHeight: 0 }}
        actions={selected && <Btn size="sm" variant="danger" onClick={() => remove(selected)}><Trash2 size={11} /> delete</Btn>}
        bodyClass="overflow-auto"
      >
        {!selected ? <EmptyState>nothing selected</EmptyState> :
         <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
           <div style={{ display: "flex", gap: 6 }}>
             <Chip tone="accent">{selected.note_type}</Chip>
             <Chip>updated {relTime(selected.updated_at)}</Chip>
           </div>
           <textarea
             defaultValue={selected.content ?? ""}
             onBlur={async (e) => {
               const c = e.target.value;
               if (c !== (selected.content ?? "")) {
                 await db.notes.update(selected.id, { content: c });
                 load();
               }
             }}
             style={{ ...inputStyle, minHeight: 300, width: "100%", fontFamily: "var(--font-body)", fontSize: 13, lineHeight: 1.6, resize: "vertical" }}
             placeholder="write freely…"
           />
           <div className="hud-label" style={{ color: "var(--text-muted)" }}>auto-saves on blur</div>
         </div>}
      </HudPanel>
    </div>
  );
}

function QuickAdd({ onCreated }: { onCreated: (n: Note) => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [noteType, setNoteType] = useState<Note["note_type"]>("general");
  const [busy, setBusy] = useState(false);
  const push = useUi((s) => s.push);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const n = await db.notes.create({ title: title.trim(), content: content.trim() || undefined, note_type: noteType });
      await db.actions.log("note.create", title.trim(), "notes");
      setTitle(""); setContent(""); setNoteType("general");
      onCreated(n);
    } catch (err: any) { push(err?.message, "err"); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "end" }}>
        <div>
          <label style={labelStyle}>title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short title" style={{ ...inputStyle, width: "100%" }} />
        </div>
        <div>
          <label style={labelStyle}>type</label>
          <select value={noteType} onChange={(e) => setNoteType(e.target.value as Note["note_type"])} style={inputStyle}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <Btn type="submit" variant="primary" disabled={busy || !title.trim()}>{busy ? "…" : "+ save"}</Btn>
      </div>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="body (optional)"
        style={{ ...inputStyle, minHeight: 60, width: "100%", resize: "vertical", fontFamily: "var(--font-body)", fontSize: 13 }} />
    </form>
  );
}
