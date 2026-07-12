import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, type Subscription } from "@/lib/db";
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

export default function SubscriptionsConfig() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<Subscription[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [f, setF] = useState({ name: "", category: "", amount: "", cycle: "monthly", due: "", linked_account_id: "", linked_card_id: "" });
  const load = async () => {
    const [s, a, c] = await Promise.all([db.subscriptions.list(), db.accounts.list(), db.cards.list()]);
    setItems(s); setAccounts(a); setCards(c);
  };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    try {
      await db.subscriptions.create({
        name: f.name.trim(), category: f.category || undefined,
        amount: f.amount ? Number(f.amount) : undefined,
        billing_cycle: f.cycle || undefined,
        next_due_date: f.due || undefined,
        linked_account_id: f.linked_account_id || null,
        linked_card_id: f.linked_card_id || null,
      });
      setF({ name: "", category: "", amount: "", cycle: "monthly", due: "", linked_account_id: "", linked_card_id: "" });
      load();
    } catch (err: any) { push(err?.message ?? "failed to add subscription", "err"); }
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
          <div><label style={labelStyle}>linked account</label>
            <HudSelect value={f.linked_account_id} onChange={(v) => setF({ ...f, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
          </div>
          <div><label style={labelStyle}>linked card</label>
            <HudSelect value={f.linked_card_id} onChange={(v) => setF({ ...f, linked_card_id: v })} placeholder="—" options={cards.map((c: any) => ({ value: c.id, label: c.card_name }))} />
          </div>
        </form>
      </HudPanel>
      <HudPanel title="Subscriptions" index="SUB" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<FinanceCTA to="/finance/subs" label="view + edit in Finance" />}>
        {items.length === 0 ? <EmptyState>no subscriptions</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
           {items.map((s) => (
             <div key={s.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{s.name}</div>
                 {s.category && <Chip>{s.category}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.subscriptions.remove(s.id); load(); } }}><Trash2 size={13} /></button>
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
