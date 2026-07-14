import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, type Decision, relTime } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

export default function Decisions() {
  const [items, setItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const push = useUi((s) => s.push);

  const load = async () => {
    setLoading(true);
    try {
      const list = await db.decisions.list();
      setItems(list);
      if (selected) {
        const fresh = list.find((d: any) => d.id === selected.id);
        setSelected(fresh ?? null);
      } else if (list.length) {
        setSelected(list[0]);
      }
    } catch (e: any) { push(e?.message, "err"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (d: any) => {
    if (!confirm(`Delete decision "${d.title}"?`)) return;
    await db.decisions.remove(d.id);
    if (selected?.id === d.id) setSelected(null);
    load();
  };

  const saveField = async (patch: Partial<Decision>) => {
    if (!selected) return;
    await db.decisions.update(selected.id, patch);
    setSelected({ ...selected, ...patch });
  };

  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "minmax(300px, 1fr) 2fr", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="New Decision" index="NEW" live="ok" style={{ flexShrink: 0 }}>
          <QuickAdd onCreated={(d) => { setSelected(d); load(); }} />
        </HudPanel>
        <HudPanel title="Decisions" index="DEC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
          {loading ? <div className="hud-label">loading…</div> :
           items.length === 0 ? <EmptyState hint="record why, not just what">no decisions yet</EmptyState> :
           <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
             {items.map((d: any) => (
               <button key={d.id} onClick={() => setSelected(d)} style={{
                 textAlign: "left", padding: "8px 10px",
                 border: `1px solid ${selected?.id === d.id ? "var(--edge-strong)" : "var(--edge)"}`,
                 background: selected?.id === d.id ? "rgba(53,214,237,0.06)" : "transparent",
                 cursor: "pointer",
               }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                   {d.projects?.name && <Chip tone="accent">{d.projects.name}</Chip>}
                   <span className="hud-label" style={{ marginLeft: "auto" }}>{d.decided_on ? new Date(d.decided_on).toLocaleDateString() : relTime(d.created_at)}</span>
                 </div>
                 <div style={{ fontSize: 12, color: "var(--text)" }}>{d.title}</div>
                 {d.decision_text && <div style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.decision_text}</div>}
               </button>
             ))}
           </div>}
        </HudPanel>
      </div>

      <HudPanel
        title={selected ? selected.title : "Select a decision"}
        index="VIEW" live="idle" style={{ minHeight: 0 }}
        actions={selected && <Btn size="sm" variant="danger" onClick={() => remove(selected)}><Trash2 size={11} /> delete</Btn>}
        bodyClass="overflow-auto"
      >
        {!selected ? <EmptyState>nothing selected</EmptyState> :
         <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
           <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
             <label style={labelStyle}>decided on</label>
             <div style={{ minWidth: 140 }}>
               <HudDatePicker value={selected.decided_on ?? ""} onChange={(v) => saveField({ decided_on: v })} />
             </div>
           </div>
           <div>
             <label style={labelStyle}>decision</label>
             <textarea
               defaultValue={selected.decision_text ?? ""}
               onBlur={(e) => e.target.value !== (selected.decision_text ?? "") && saveField({ decision_text: e.target.value })}
               style={{ ...inputStyle, minHeight: 80, width: "100%", resize: "vertical" }}
               placeholder="what was decided"
             />
           </div>
           <div>
             <label style={labelStyle}>context</label>
             <textarea
               defaultValue={selected.context ?? ""}
               onBlur={(e) => e.target.value !== (selected.context ?? "") && saveField({ context: e.target.value })}
               style={{ ...inputStyle, minHeight: 60, width: "100%", resize: "vertical" }}
               placeholder="what prompted this decision"
             />
           </div>
           <div>
             <label style={labelStyle}>options considered</label>
             <textarea
               defaultValue={selected.options_considered ?? ""}
               onBlur={(e) => e.target.value !== (selected.options_considered ?? "") && saveField({ options_considered: e.target.value })}
               style={{ ...inputStyle, minHeight: 60, width: "100%", resize: "vertical" }}
               placeholder="alternatives weighed"
             />
           </div>
           <div>
             <label style={labelStyle}>rationale</label>
             <textarea
               defaultValue={selected.rationale ?? ""}
               onBlur={(e) => e.target.value !== (selected.rationale ?? "") && saveField({ rationale: e.target.value })}
               style={{ ...inputStyle, minHeight: 60, width: "100%", resize: "vertical" }}
               placeholder="why this option, over the others"
             />
           </div>
           <div className="hud-label" style={{ color: "var(--text-muted)" }}>auto-saves on blur</div>
         </div>}
      </HudPanel>
    </div>
  );
}

function QuickAdd({ onCreated }: { onCreated: (d: any) => void }) {
  const [title, setTitle] = useState("");
  const [decisionText, setDecisionText] = useState("");
  const [decidedOn, setDecidedOn] = useState(new Date().toISOString().slice(0, 10));
  const [linkedProjectId, setLinkedProjectId] = useState("");
  const [projects, setProjects] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const push = useUi((s) => s.push);

  useEffect(() => { db.projects.list().then(setProjects).catch(() => {}); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !decisionText.trim()) return;
    setBusy(true);
    try {
      const d = await db.decisions.create({
        title: title.trim(), decision_text: decisionText.trim(),
        decided_on: decidedOn || undefined, linked_project_id: linkedProjectId || null,
      });
      setTitle(""); setDecisionText(""); setDecidedOn(new Date().toISOString().slice(0, 10)); setLinkedProjectId("");
      onCreated(d);
    } catch (err: any) { push(err?.message, "err"); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div><label style={labelStyle}>title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short title" style={{ ...inputStyle, width: "100%" }} /></div>
      <div><label style={labelStyle}>decision</label>
        <textarea value={decisionText} onChange={(e) => setDecisionText(e.target.value)} placeholder="what was decided"
          style={{ ...inputStyle, minHeight: 50, width: "100%", resize: "vertical" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end" }}>
        <div><label style={labelStyle}>decided on</label><HudDatePicker value={decidedOn} onChange={setDecidedOn} /></div>
        <div><label style={labelStyle}>linked project</label>
          <HudSelect value={linkedProjectId} onChange={setLinkedProjectId} placeholder="—" options={projects.map((p: any) => ({ value: p.id, label: p.name }))} />
        </div>
      </div>
      <Btn type="submit" variant="primary" disabled={busy || !title.trim() || !decisionText.trim()}>{busy ? "…" : "+ save"}</Btn>
    </form>
  );
}
