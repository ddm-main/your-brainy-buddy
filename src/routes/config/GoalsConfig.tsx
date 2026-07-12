import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, type FinancialGoal } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

function FinanceCTA({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} style={{
      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
      textTransform: "uppercase", color: "var(--accent)", textDecoration: "none",
      padding: "4px 8px", border: "1px solid var(--edge)",
    }}>{label} →</NavLink>
  );
}

export default function GoalsConfig() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<FinancialGoal[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [f, setF] = useState({ title: "", type: "", target: "", date: "", current: "", linked_account_id: "" });
  const load = async () => {
    const [g, a] = await Promise.all([db.goals.list(), db.accounts.list()]);
    setItems(g); setAccounts(a);
  };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    try {
      await db.goals.create({
        title: f.title.trim(), goal_type: f.type || undefined,
        target_amount: f.target ? Number(f.target) : undefined,
        target_date: f.date || undefined,
        current_amount: f.current ? Number(f.current) : 0,
        linked_account_id: f.linked_account_id || null,
      });
      setF({ title: "", type: "", target: "", date: "", current: "", linked_account_id: "" });
      load();
    } catch (err: any) { push(err?.message ?? "failed to add goal", "err"); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Goal" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
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
          <div><label style={labelStyle}>linked account</label>
            <HudSelect value={f.linked_account_id} onChange={(v) => setF({ ...f, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
          </div>
          <Btn type="submit" variant="primary" disabled={!f.title.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Goals" index="GL" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<FinanceCTA to="/finance/goals" label="view + edit in Finance" />}>
        {items.length === 0 ? <EmptyState>no goals</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
           {items.map((g) => (
             <div key={g.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{g.title}</div>
                 {g.goal_type && <Chip>{g.goal_type}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.goals.remove(g.id); load(); } }}><Trash2 size={13} /></button>
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
