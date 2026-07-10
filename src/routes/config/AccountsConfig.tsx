import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, type Bank } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

export default function AccountsConfig() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [nick, setNick] = useState(""); const [type, setType] = useState(""); const [mask, setMask] = useState("");
  const [bankId, setBankId] = useState<string>(""); const [newBank, setNewBank] = useState("");
  const push = useUi((s) => s.push);
  const load = async () => { setBanks(await db.banks.list()); setItems(await db.accounts.list()); };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nick.trim()) return;
    try {
      let bId: string | null = bankId || null;
      if (newBank.trim()) { const b = await db.banks.create(newBank.trim()); bId = b.id; setNewBank(""); }
      await db.accounts.create({ nickname: nick.trim(), account_type: type || undefined, masked_number: mask || undefined, bank_id: bId });
      setNick(""); setType(""); setMask(""); setBankId("");
      load();
    } catch (err: any) { push(err?.message, "err"); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Account" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>nickname</label><input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="e.g. HDFC Salary" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <HudSelect value={type} onChange={setType} placeholder="—" options={[
              { value: "savings", label: "savings" }, { value: "current", label: "current" },
              { value: "salary", label: "salary" }, { value: "wallet", label: "wallet" },
              { value: "investment", label: "investment" },
            ]} />
          </div>
          <div><label style={labelStyle}>last 4</label><input value={mask} onChange={(e) => setMask(e.target.value)} placeholder="****1234" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bank</label>
            <HudSelect value={bankId} onChange={setBankId} placeholder="—" options={banks.map((b) => ({ value: b.id, label: b.name }))} />
          </div>
          <div><label style={labelStyle}>or new bank</label><input value={newBank} onChange={(e) => setNewBank(e.target.value)} placeholder="e.g. HDFC Bank" style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!nick.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Accounts" index="ACC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no accounts yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((a) => (
             <div key={a.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{a.nickname}</div>
                 {a.account_type && <Chip>{a.account_type}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.accounts.remove(a.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {a.banks?.name ?? "no bank"} {a.masked_number ? `· ${a.masked_number}` : ""}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}