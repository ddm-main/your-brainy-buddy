import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import BankPicker from "@/components/finance/BankPicker";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2, KeyRound } from "lucide-react";

function FinanceCTA({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} style={{
      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
      textTransform: "uppercase", color: "var(--accent)", textDecoration: "none",
      padding: "4px 8px", border: "1px solid var(--edge)",
    }}>{label} →</NavLink>
  );
}

export default function CardsConfig() {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState(""); const [mask, setMask] = useState(""); const [bill, setBill] = useState(""); const [due, setDue] = useState(""); const [limit, setLimit] = useState(""); const [bankId, setBankId] = useState(""); const [autopay, setAutopay] = useState(false);
  const [pwEditId, setPwEditId] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const push = useUi((s) => s.push);
  const load = async () => { setItems(await db.cards.list()); };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await db.cards.create({
        card_name: name.trim(), masked_number: mask || undefined,
        billing_day: bill ? Number(bill) : null, due_day: due ? Number(due) : null,
        limit_amount: limit ? Number(limit) : null, bank_id: bankId || null,
        autopay,
      });
      setName(""); setMask(""); setBill(""); setDue(""); setLimit(""); setBankId(""); setAutopay(false);
      load();
    } catch (err: any) { push(err?.message ?? "failed to add card", "err"); }
  };
  const savePassword = async (id: string) => {
    if (!pwValue) return;
    setPwSaving(true);
    try {
      await db.cards.setStatementPassword(id, pwValue);
      push("Statement password saved", "ok");
      setPwEditId(null); setPwValue("");
      load();
    } catch (err: any) { push(err?.message ?? "failed to save password", "err"); }
    finally { setPwSaving(false); }
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
            <BankPicker value={bankId} onChange={(id) => setBankId(id)} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} />
            <label style={labelStyle}>autopay</label>
          </div>
          <Btn type="submit" variant="primary" disabled={!name.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Credit Cards" index="CRD" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<FinanceCTA to="/finance/cards" label="view + edit in Finance" />}>
        {items.length === 0 ? <EmptyState>no cards yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((c: any) => (
             <div key={c.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{c.card_name}</div>
                 {c.banks?.name && <Chip>{c.banks.name}</Chip>}
                 {c.statement_password_rule && <Chip tone="ok">has password</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} title="Set statement password" onClick={() => { setPwEditId(pwEditId === c.id ? null : c.id); setPwValue(""); }}><KeyRound size={13} /></button>
                 <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.cards.remove(c.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {c.masked_number ?? ""}{c.billing_day ? ` · bill ${c.billing_day}` : ""}{c.due_day ? ` · due ${c.due_day}` : ""}{c.limit_amount ? ` · limit ${inr(c.limit_amount)}` : ""}
               </div>
               {pwEditId === c.id && (
                 <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "end" }}>
                   <div style={{ flex: 1 }}>
                     <label style={labelStyle}>statement password</label>
                     <input type="password" autoFocus value={pwValue} onChange={(e) => setPwValue(e.target.value)} placeholder="PDF password" style={{ ...inputStyle, width: "100%" }} />
                   </div>
                   <Btn size="sm" variant="primary" disabled={!pwValue || pwSaving} onClick={() => savePassword(c.id)}>{pwSaving ? "saving…" : "save"}</Btn>
                   <Btn size="sm" onClick={() => { setPwEditId(null); setPwValue(""); }}>cancel</Btn>
                 </div>
               )}
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}