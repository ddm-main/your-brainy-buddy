import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, type Project, type ProjectUpdate, relTime } from "@/lib/db";
import { useUi } from "@/store/uiStore";

const STATUSES: Project["status"][] = ["active", "blocked", "paused", "done", "archived"];

export default function ProjectsRoot() {
  return (
    <Routes>
      <Route index element={<ProjectsList />} />
      <Route path=":id" element={<ProjectDetail />} />
    </Routes>
  );
}

function ProjectsList() {
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  const load = async () => { setLoading(true); try { setItems(await db.projects.list()); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <HudPanel title="Active work" index="LIST" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<Btn size="sm" variant="primary" onClick={() => nav("/config/projects")}>+ new project</Btn>}>
        {loading ? <div className="hud-label">loading…</div> :
         items.length === 0 ? <EmptyState hint="create one in Config → Projects">no projects yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((p) => (
             <NavLink key={p.id} to={`/projects/${p.id}`}
               style={{ display: "block", padding: 12, border: "1px solid var(--edge)", textDecoration: "none", color: "inherit", background: "rgba(3,8,18,0.4)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                 <Chip tone={p.status === "blocked" ? "warn" : p.status === "done" ? "ok" : p.status === "archived" ? "neutral" : "accent"}>{p.status}</Chip>
                 <Chip>{p.priority}</Chip>
                 <span className="hud-label" style={{ marginLeft: "auto" }}>{relTime(p.updated_at)}</span>
               </div>
               <div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--text)" }}>{p.name}</div>
               {p.description && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{p.description}</div>}
               {p.next_action && (
                 <div style={{ marginTop: 8, fontSize: 11 }}>
                   <span className="hud-label" style={{ color: "var(--accent)" }}>next → </span>
                   <span style={{ color: "var(--text)" }}>{p.next_action}</span>
                 </div>
               )}
             </NavLink>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [proj, setProj] = useState<Project | null>(null);
  const [updates, setUpdates] = useState<ProjectUpdate[]>([]);
  const [newUpdate, setNewUpdate] = useState("");
  const push = useUi((s) => s.push);

  const load = async () => {
    if (!id) return;
    try {
      const [p, u] = await Promise.all([db.projects.get(id), db.projects.updates(id)]);
      setProj(p); setUpdates(u);
    } catch (e: any) { push(e?.message, "err"); nav("/projects"); }
  };
  useEffect(() => { load(); }, [id]);

  const save = async (patch: Partial<Project>) => {
    if (!proj) return;
    await db.projects.update(proj.id, patch);
    setProj({ ...proj, ...patch });
  };

  const addUpd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !newUpdate.trim()) return;
    await db.projects.addUpdate(id, newUpdate.trim());
    setNewUpdate("");
    load();
  };

  if (!proj) return <div style={{ padding: 12 }} className="hud-label">loading…</div>;

  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "1fr 380px", gap: 12, minHeight: 0 }}>
      <HudPanel
        title={proj.name ?? proj.title ?? "(untitled)"} index="PRJ" live={proj.status === "blocked" ? "warn" : "ok"}
        style={{ minHeight: 0 }} bodyClass="overflow-auto"
        actions={<Btn size="sm" onClick={() => nav("/projects")}>← back</Btn>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={labelStyle}>status</label>
            <div style={{ minWidth: 140 }}>
              <HudSelect value={proj.status} onChange={(v) => save({ status: v as Project["status"] })} options={STATUSES.map((s) => ({ value: s, label: s }))} />
            </div>
            <label style={labelStyle}>priority</label>
            <div style={{ minWidth: 140 }}>
              <HudSelect value={proj.priority} onChange={(v) => save({ priority: v as Project["priority"] })} options={[
                { value: "low", label: "low" }, { value: "normal", label: "normal" },
                { value: "high", label: "high" }, { value: "urgent", label: "urgent" },
              ]} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>description</label>
            <textarea defaultValue={proj.description ?? ""} onBlur={(e) => e.target.value !== (proj.description ?? "") && save({ description: e.target.value })}
              style={{ ...inputStyle, width: "100%", minHeight: 80, resize: "vertical" }} placeholder="outcome, scope, notes…" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>next action</label>
              <input defaultValue={proj.next_action ?? ""} onBlur={(e) => e.target.value !== (proj.next_action ?? "") && save({ next_action: e.target.value })}
                placeholder="physical, specific" style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div>
              <label style={labelStyle}>blocker</label>
              <input defaultValue={proj.blocker_summary ?? ""} onBlur={(e) => e.target.value !== (proj.blocker_summary ?? "") && save({ blocker_summary: e.target.value })}
                placeholder="one line" style={{ ...inputStyle, width: "100%" }} />
            </div>
          </div>
        </div>
      </HudPanel>

      <HudPanel title="Updates" index="LOG" live="ok" style={{ minHeight: 0 }} bodyClass="overflow-auto">
        <form onSubmit={addUpd} style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <input value={newUpdate} onChange={(e) => setNewUpdate(e.target.value)} placeholder="add update…" style={{ ...inputStyle, flex: 1 }} />
          <Btn type="submit" variant="primary" size="sm" disabled={!newUpdate.trim()}>+ log</Btn>
        </form>
        {updates.length === 0 ? <EmptyState>no updates yet</EmptyState> :
         <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
           {updates.map((u) => (
             <div key={u.id} style={{ padding: "6px 8px", borderLeft: "2px solid var(--edge-strong)", fontSize: 12 }}>
               <div className="hud-label" style={{ marginBottom: 2 }}>{relTime(u.created_at)}</div>
               <div style={{ color: "var(--text)" }}>{u.update_text}</div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
