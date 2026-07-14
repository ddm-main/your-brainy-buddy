import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, EmptyState, inputStyle } from "@/components/hud/HudControls";
import { db, type Bank } from "@/lib/db";
import { useUi } from "@/store/uiStore";

export default function BanksConfig() {
  const [items, setItems] = useState<Bank[]>([]);
  const [name, setName] = useState("");
  const push = useUi((s) => s.push);
  const load = async () => setItems(await db.banks.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try { await db.banks.create(name.trim()); setName(""); load(); } catch (err: any) { push(err?.message, "err"); }
  };
  return (
    <HudPanel title="Banks" index="BNK" live="ok" bodyClass="overflow-auto">
      <form onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="HDFC Bank" style={{ ...inputStyle, flex: 1 }} />
        <Btn type="submit" variant="primary" disabled={!name.trim()}>+ add</Btn>
      </form>
      {items.length === 0 ? <EmptyState>no banks yet</EmptyState> :
       <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
         {items.map((b) => (
           <div key={b.id} style={{ padding: "8px 10px", border: "1px solid var(--edge)", fontSize: 12 }}>{b.name}</div>
         ))}
       </div>}
    </HudPanel>
  );
}