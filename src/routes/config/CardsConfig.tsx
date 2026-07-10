import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr, type Bank } from "@/lib/db";
import { Trash2 } from "lucide-react";

export default function CardsConfig() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState(""); const [mask, setMask] = useState(""); const [bill, setBill] = useState(""); const [due, setDue] = useState(""); const [limit, setLimit] = useState(""); const [bankId, setBankId] = useState("");
  const load = async () => { setBanks(await db.banks.list()); setItems(await db.cards.list()); };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await db.cards.create({
      card_name: name.trim(), masked_number: mask || undefined,
      billing_day: bill ? Number(bill) : null, due_day: due ? Number(due) : null,
      limit_amount: limit ? Number(limit) : null, bank_id: bankId || null,
    });
    setName(""); setMask(""); setBill(""); setDue(""); setLimit(""); setBankId("");
    load();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Card" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>card name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="HDFC Millennia" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>last 4</label><input value={mask} onChange={(e) => setMask(e.target.value)} placeholder="****4421" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bill day</label><input type="number" min={1} max={31} value={bill} onChange={(e) => setBill(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>due day</label><input type="number" min={1} max={31} value={due} onChange={(e) => setDue(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>limit</label><input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bank</label>
            <HudSelect value={bankId} onChange={setBankId} placeholder="—" options={banks.map((b) => ({ value: b.id, label: b.name }))} />
          </div>
          <Btn type="submit" variant="primary" disabled={!name.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Credit Cards" index="CRD" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no cards yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((c: any) => (
             <div key={c.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{c.card_name}</div>
                 {c.banks?.name && <Chip>{c.banks.name}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.cards.remove(c.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {c.masked_number ?? ""}{c.billing_day ? ` · bill ${c.billing_day}` : ""}{c.due_day ? ` · due ${c.due_day}` : ""}{c.limit_amount ? ` · limit ${inr(c.limit_amount)}` : ""}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}