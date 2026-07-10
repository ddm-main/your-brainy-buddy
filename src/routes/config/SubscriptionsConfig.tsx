import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr, type Subscription } from "@/lib/db";
import { Trash2 } from "lucide-react";

export default function SubscriptionsConfig() {
  const [items, setItems] = useState<Subscription[]>([]);
  const [f, setF] = useState({ name: "", category: "", amount: "", cycle: "monthly", due: "" });
  const load = async () => setItems(await db.subscriptions.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    await db.subscriptions.create({
      name: f.name.trim(), category: f.category || undefined,
      amount: f.amount ? Number(f.amount) : undefined,
      billing_cycle: f.cycle || undefined,
      next_due_date: f.due || undefined,
    });
    setF({ name: "", category: "", amount: "", cycle: "monthly", due: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Subscription" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>name</label><input value={f.name} onChange={set("name")} placeholder="Netflix" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>category</label><input value={f.category} onChange={set("category")} placeholder="OTT" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>amount</label><input type="number" value={f.amount} onChange={set("amount")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>cycle</label>
            <HudSelect value={f.cycle} onChange={(v) => setF({ ...f, cycle: v })} options={[
              { value: "monthly", label: "monthly" }, { value: "quarterly", label: "quarterly" },
              { value: "yearly", label: "yearly" }, { value: "weekly", label: "weekly" },
            ]} />
          </div>
          <div><label style={labelStyle}>next due</label><HudDatePicker value={f.due} onChange={(v) => setF({ ...f, due: v })} /></div>
          <Btn type="submit" variant="primary" disabled={!f.name.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Subscriptions" index="SUB" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no subscriptions</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
           {items.map((s) => (
             <div key={s.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{s.name}</div>
                 {s.category && <Chip>{s.category}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.subscriptions.remove(s.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {inr(s.amount ?? 0)} / {s.billing_cycle ?? "—"}
                 {s.next_due_date && ` · next ${new Date(s.next_due_date).toLocaleDateString()}`}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}