import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type EmailAccount, type Bank } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

export default function Settings() {
  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minHeight: 0 }}>
      <EmailAccounts />
      <Banks />
    </div>
  );
}

function EmailAccounts() {
  const [items, setItems] = useState<EmailAccount[]>([]);
  const [addr, setAddr] = useState(""); const [purpose, setPurpose] = useState<EmailAccount["purpose"]>("other"); const [provider, setProvider] = useState("gmail");
  const push = useUi((s) => s.push);
  const load = async () => setItems(await db.emailAccounts.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addr.trim()) return;
    try {
      await db.emailAccounts.create({ email_address: addr.trim(), purpose, provider });
      setAddr(""); load();
    } catch (err: any) { push(err?.message, "err"); }
  };
  return (
    <HudPanel title="Email Accounts" index="MAIL" live="ok" bodyClass="overflow-auto">
      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 8, alignItems: "end", marginBottom: 12 }}>
        <div><label style={labelStyle}>address</label><input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="name@example.com" style={{ ...inputStyle, width: "100%" }} /></div>
        <div><label style={labelStyle}>purpose</label>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value as EmailAccount["purpose"])} style={inputStyle}>
            <option value="work">work</option><option value="finance">finance</option><option value="personal">personal</option><option value="other">other</option>
          </select>
        </div>
        <div><label style={labelStyle}>provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
            <option value="gmail">gmail</option><option value="outlook">outlook</option><option value="imap">imap</option><option value="other">other</option>
          </select>
        </div>
        <Btn type="submit" variant="primary" disabled={!addr.trim()}>+ add</Btn>
      </form>
      {items.length === 0 ? <EmptyState>no email accounts</EmptyState> :
       <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
         {items.map((a) => (
           <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--edge)" }}>
             <div style={{ fontSize: 12, color: "var(--text)", flex: 1 }}>{a.email_address}</div>
             <Chip tone={a.purpose === "finance" ? "accent" : "neutral"}>{a.purpose}</Chip>
             <Chip>{a.provider ?? "—"}</Chip>
             <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.emailAccounts.remove(a.id); load(); } }}><Trash2 size={13} /></button>
           </div>
         ))}
       </div>}
    </HudPanel>
  );
}

function Banks() {
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
