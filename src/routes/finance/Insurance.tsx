import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";

const POLICY_TYPES = [
  { value: "health", label: "health" }, { value: "life", label: "life" },
  { value: "term", label: "term" }, { value: "vehicle", label: "vehicle" },
  { value: "home", label: "home" }, { value: "other", label: "other" },
];

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

// ---------- Insurance ----------
export default function Insurance() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<any>({ policy_type: "health", provider: "", premium_amount: "", renewal_date: "" });

  const load = async () => {
    const [p, a] = await Promise.all([db.insurancePolicies.list(), db.accounts.list()]);
    setItems(p); setAccounts(a);
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (p: any) => {
    if (openId === p.id) { setOpenId(null); return; }
    setOpenId(p.id);
    setEdit({
      policy_type: p.policy_type ?? "health", provider: p.provider ?? "", policy_number: p.policy_number ?? "",
      sum_assured: p.sum_assured ?? "", premium_amount: p.premium_amount ?? "", premium_frequency: p.premium_frequency ?? "",
      start_date: p.start_date ?? "", renewal_date: p.renewal_date ?? "", nominee: p.nominee ?? "",
      linked_account_id: p.linked_account_id ?? "", notes: p.notes ?? "",
    });
  };

  const save = async (id: string) => {
    setSaving(true);
    try {
      await db.insurancePolicies.update(id, {
        policy_type: edit.policy_type, provider: edit.provider || null, policy_number: edit.policy_number || null,
        sum_assured: edit.sum_assured ? Number(edit.sum_assured) : null, premium_amount: edit.premium_amount ? Number(edit.premium_amount) : null,
        premium_frequency: edit.premium_frequency || null, start_date: edit.start_date || null, renewal_date: edit.renewal_date || null,
        nominee: edit.nominee || null, linked_account_id: edit.linked_account_id || null, notes: edit.notes || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this policy?")) return;
    await db.insurancePolicies.remove(id);
    setOpenId(null);
    load();
  };

  const addPolicy = async () => {
    if (!draft.provider?.trim()) return;
    setAdding(true);
    try {
      await db.insurancePolicies.create({
        policy_type: draft.policy_type, provider: draft.provider.trim(),
        premium_amount: draft.premium_amount ? Number(draft.premium_amount) : null,
        renewal_date: draft.renewal_date || null,
      });
      push("Policy added", "ok");
      setDraft({ policy_type: "health", provider: "", premium_amount: "", renewal_date: "" });
      setShowAdd(false);
      load();
    } catch (e: any) { push(e?.message ?? "failed to add policy", "err"); }
    finally { setAdding(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Insurance" index="INS" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<Btn size="sm" onClick={() => setShowAdd((v) => !v)}>{showAdd ? "cancel" : "+ add policy"}</Btn>}>
        {showAdd && (
          <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--edge)" }}>
            <div><label style={labelStyle}>type</label><HudSelect value={draft.policy_type} onChange={(v) => setDraft({ ...draft, policy_type: v })} options={POLICY_TYPES} /></div>
            <div style={{ minWidth: 160 }}><label style={labelStyle}>provider</label><input value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
            <div><label style={labelStyle}>premium</label><input type="number" value={draft.premium_amount} onChange={(e) => setDraft({ ...draft, premium_amount: e.target.value })} style={{ ...inputStyle, width: 110 }} /></div>
            <div><label style={labelStyle}>renewal date</label><HudDatePicker value={draft.renewal_date} onChange={(v) => setDraft({ ...draft, renewal_date: v })} /></div>
            <Btn size="sm" variant="primary" disabled={adding || !draft.provider?.trim()} onClick={addPolicy}>{adding ? "adding…" : "add"}</Btn>
          </div>
        )}
        {items.length === 0 ? <EmptyState hint="add a policy above">no insurance policies yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((p) => {
             const daysToRenewal = daysUntil(p.renewal_date);
             const renewalSoon = daysToRenewal != null && daysToRenewal >= 0 && daysToRenewal <= 30;
             const overdue = daysToRenewal != null && daysToRenewal < 0;
             return (
               <div key={p.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(p)}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{p.provider ?? "—"}</div>
                   <Chip>{p.policy_type}</Chip>
                   {overdue && <Chip tone="err">renewal overdue</Chip>}
                   {!overdue && renewalSoon && <Chip tone="warn">renews in {daysToRenewal}d</Chip>}
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                   {p.premium_amount ? `${inr(p.premium_amount)} / ${p.premium_frequency ?? "—"}` : "no premium set"}
                   {p.sum_assured ? ` · sum assured ${inr(p.sum_assured)}` : ""}
                   {p.renewal_date && ` · renews ${new Date(p.renewal_date).toLocaleDateString()}`}
                 </div>
                 {openId === p.id && (
                   <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                       <div><label style={labelStyle}>type</label><HudSelect value={edit.policy_type} onChange={(v) => setEdit({ ...edit, policy_type: v })} options={POLICY_TYPES} /></div>
                       <div><label style={labelStyle}>provider</label><input value={edit.provider} onChange={(e) => setEdit({ ...edit, provider: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>policy number</label><input value={edit.policy_number} onChange={(e) => setEdit({ ...edit, policy_number: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>sum assured</label><input type="number" value={edit.sum_assured} onChange={(e) => setEdit({ ...edit, sum_assured: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>premium</label><input type="number" value={edit.premium_amount} onChange={(e) => setEdit({ ...edit, premium_amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>frequency</label>
                         <HudSelect value={edit.premium_frequency} onChange={(v) => setEdit({ ...edit, premium_frequency: v })} placeholder="—" options={[
                           { value: "monthly", label: "monthly" }, { value: "quarterly", label: "quarterly" },
                           { value: "half_yearly", label: "half-yearly" }, { value: "yearly", label: "yearly" }, { value: "single", label: "single" },
                         ]} />
                       </div>
                       <div><label style={labelStyle}>start date</label><HudDatePicker value={edit.start_date} onChange={(v) => setEdit({ ...edit, start_date: v })} /></div>
                       <div><label style={labelStyle}>renewal date</label><HudDatePicker value={edit.renewal_date} onChange={(v) => setEdit({ ...edit, renewal_date: v })} /></div>
                       <div><label style={labelStyle}>nominee</label><input value={edit.nominee} onChange={(e) => setEdit({ ...edit, nominee: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>linked account</label>
                         <HudSelect value={edit.linked_account_id} onChange={(v) => setEdit({ ...edit, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                       </div>
                     </div>
                     <div>
                       <label style={labelStyle}>notes</label>
                       <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                     </div>
                     <div style={{ display: "flex", gap: 6 }}>
                       <Btn size="sm" variant="primary" disabled={saving} onClick={() => save(p.id)}>{saving ? "saving…" : "save"}</Btn>
                       <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                       <Btn size="sm" variant="danger" onClick={() => remove(p.id)}>delete</Btn>
                     </div>
                   </div>
                 )}
               </div>
             );
           })}
         </div>}
      </HudPanel>
    </div>
  );
}
