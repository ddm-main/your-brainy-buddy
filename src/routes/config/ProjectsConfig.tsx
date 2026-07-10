import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type Project, relTime } from "@/lib/db";
import { useUi } from "@/store/uiStore";

export default function ProjectsConfig() {
  const [items, setItems] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const push = useUi((s) => s.push);

  const load = async () => setItems(await db.projects.list());
  useEffect(() => { load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await db.projects.create({ name: name.trim(), description: desc.trim() || undefined, slug });
      await db.actions.log("project.create", name.trim(), "projects");
      setName(""); setDesc(""); load();
    } catch (err: any) { push(err?.message, "err"); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="New Project" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM App" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>description</label><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="one-line outcome" style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "…" : "+ create"}</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Projects" index="PRJ" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState hint="create one above">no projects yet</EmptyState> :
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
             </NavLink>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}