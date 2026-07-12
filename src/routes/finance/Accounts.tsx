import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { ConfigureCTA } from "./_shared";

// ---------- Accounts ----------
export default function Accounts() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [balanceTouched, setBalanceTouched] = useState(false);

  const load = async () => {
    const [a, b] = await Promise.all([db.accounts.list(), db.banks.list()]);
    setItems(a); setBanks(b);
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (a: any) => {
    if (openId === a.id) { setOpenId(null); return; }
    setOpenId(a.id);
    setEdit({
      nickname: a.nickname ?? "", account_type: a.account_type ?? "", masked_number: a.masked_number ?? "",
      bank_id: a.bank_id ?? "", notes: a.notes ?? "", source_email: a.source_email ?? "",
      statement_cycle_day: a.statement_cycle_day ?? "", current_balance: a.current_balance ?? "",
    });
    setBalanceTouched(false);
  };

  const save = async (id: string) => {
    if (!edit.nickname?.trim()) return;
    setSaving(true);
    try {
      const newBalance = edit.current_balance !== "" && edit.current_balance != null ? Number(edit.current_balance) : null;
      await db.accounts.update(id, {
        nickname: edit.nickname.trim(), account_type: edit.account_type || null,
        masked_number: edit.masked_number || null, bank_id: edit.bank_id || null,
        notes: edit.notes || null, source_email: edit.source_email || null,
        statement_cycle_day: edit.statement_cycle_day ? Number(edit.statement_cycle_day) : null,
        current_balance: newBalance,
        ...(balanceTouched ? { current_balance_as_of: newBalance != null ? new Date().toISOString().slice(0, 10) : null } : {}),
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this account?")) return;
    await db.accounts.remove(id);
    setOpenId(null);
    load();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Accounts" index="ACC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/accounts" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Accounts">no accounts yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((a) => (
             <div key={a.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(a)}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{a.nickname}</div>
                 {a.account_type && <Chip>{a.account_type}</Chip>}
                 <NavLink to={`/finance/accounts/${a.id}`} onClick={(e) => e.stopPropagation()}
                   style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", textDecoration: "none" }}>
                   details →
                 </NavLink>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {a.banks?.name ?? "no bank"} {a.masked_number ? `· ${a.masked_number}` : ""}
                 {a.current_balance != null && <> · {inr(a.current_balance)}{a.current_balance_as_of ? ` as of ${new Date(a.current_balance_as_of).toLocaleDateString()}` : ""}</>}
               </div>
               {openId === a.id && (
                 <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>nickname</label><input value={edit.nickname} onChange={(e) => setEdit({ ...edit, nickname: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>type</label>
                       <HudSelect value={edit.account_type} onChange={(v) => setEdit({ ...edit, account_type: v })} placeholder="—" options={[
                         { value: "savings", label: "savings" }, { value: "current", label: "current" },
                         { value: "salary", label: "salary" }, { value: "wallet", label: "wallet" },
                         { value: "investment", label: "investment" },
                       ]} />
                     </div>
                     <div><label style={labelStyle}>bank</label>
                       <HudSelect value={edit.bank_id} onChange={(v) => setEdit({ ...edit, bank_id: v })} placeholder="—" options={banks.map((b: any) => ({ value: b.id, label: b.name }))} />
                     </div>
                     <div><label style={labelStyle}>last 4</label><input value={edit.masked_number} onChange={(e) => setEdit({ ...edit, masked_number: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>statement cycle day</label><input type="number" min={1} max={31} value={edit.statement_cycle_day} onChange={(e) => setEdit({ ...edit, statement_cycle_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>source email</label><input value={edit.source_email} onChange={(e) => setEdit({ ...edit, source_email: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div>
                       <label style={labelStyle}>current balance{a.current_balance_as_of ? ` (as of ${new Date(a.current_balance_as_of).toLocaleDateString()})` : ""}</label>
                       <input type="number" step="0.01" value={edit.current_balance} onChange={(e) => { setEdit({ ...edit, current_balance: e.target.value }); setBalanceTouched(true); }} style={{ ...inputStyle, width: "100%" }} />
                     </div>
                   </div>
                   <div>
                     <label style={labelStyle}>notes</label>
                     <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                   </div>
                   <div style={{ display: "flex", gap: 6 }}>
                     <Btn size="sm" variant="primary" disabled={saving || !edit.nickname?.trim()} onClick={() => save(a.id)}>{saving ? "saving…" : "save"}</Btn>
                     <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                     <Btn size="sm" variant="danger" onClick={() => remove(a.id)}>delete</Btn>
                   </div>
                 </div>
               )}
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

