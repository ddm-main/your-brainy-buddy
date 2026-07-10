import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr, type FinancialGoal } from "@/lib/db";
import { Trash2 } from "lucide-react";

export default function GoalsConfig() {
  const [items, setItems] = useState<FinancialGoal[]>([]);
  const [f, setF] = useState({ title: "", type: "", target: "", date: "", current: "" });
  const load = async () => setItems(await db.goals.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    await db.goals.create({
      title: f.title.trim(), goal_type: f.type || undefined,
      target_amount: f.target ? Number(f.target) : undefined,
      target_date: f.date || undefined,
      current_amount: f.current ? Number(f.current) : 0,
    });
    setF({ title: "", type: "", target: "", date: "", current: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Goal" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>title</label><input value={f.title} onChange={set("title")} placeholder="Emergency fund" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <HudSelect value={f.type} onChange={(v) => setF({ ...f, type: v })} placeholder="—" options={[
              { value: "savings", label: "savings" }, { value: "investment", label: "investment" },
              { value: "purchase", label: "purchase" }, { value: "prepayment", label: "prepayment" },
              { value: "travel", label: "travel" },
            ]} />
          </div>
          <div><label style={labelStyle}>target</label><input type="number" value={f.target} onChange={set("target")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>by</label><HudDatePicker value={f.date} onChange={(v) => setF({ ...f, date: v })} /></div>
          <div><label style={labelStyle}>current</label><input type="number" value={f.current} onChange={set("current")} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.title.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Goals" index="GL" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no goals</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((g) => {
             const pct = g.target_amount ? Math.min(100, Math.round((Number(g.current_amount) / Number(g.target_amount)) * 100)) : 0;
             return (
               <div key={g.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{g.title}</div>
                   {g.goal_type && <Chip>{g.goal_type}</Chip>}
                   <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.goals.remove(g.id); load(); } }}><Trash2 size={13} /></button>
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{inr(g.current_amount ?? 0)} of {inr(g.target_amount ?? 0)}{g.target_date && ` · by ${new Date(g.target_date).toLocaleDateString()}`}</div>
                 <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 8 }}>
                   <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
                 </div>
                 <div className="hud-label" style={{ marginTop: 4, color: "var(--accent)" }}>{pct}%</div>
               </div>
             );
           })}
         </div>}
      </HudPanel>
    </div>
  );
}