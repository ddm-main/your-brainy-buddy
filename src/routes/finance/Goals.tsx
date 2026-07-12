import { Fragment, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr, type FinancialAccount, type CreditCard, type Transaction } from "@/lib/db";
import { authFetch } from "@/lib/authFetch";
import { calcEmi, calcPrincipalFromEmi, roundCurrency } from "@/lib/loanCalc";
import { calcCreditUtilization, generateAmortizationSchedule } from "@/lib/financeMetrics";
import { runReconciliation } from "@/lib/reconciliation";
import { useFinanceSnapshot } from "@/lib/useFinanceSnapshot";
import { useUi } from "@/store/uiStore";
import { Trash2, RefreshCw } from "lucide-react";
import { ConfigureCTA, utilTone } from "./_shared";

// ---------- Goals ----------
export default function Goals() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [contribution, setContribution] = useState("");
  const [contributing, setContributing] = useState(false);

  const load = async () => {
    const [g, a] = await Promise.all([db.goals.list(), db.accounts.list()]);
    setItems(g); setAccounts(a);
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (g: any) => {
    if (openId === g.id) { setOpenId(null); return; }
    setOpenId(g.id);
    setEdit({
      title: g.title ?? "", goal_type: g.goal_type ?? "", target_amount: g.target_amount ?? "",
      target_date: g.target_date ?? "", linked_account_id: g.linked_account_id ?? "",
    });
    setContribution("");
  };

  const save = async (id: string) => {
    if (!edit.title?.trim()) return;
    setSaving(true);
    try {
      await db.goals.update(id, {
        title: edit.title.trim(), goal_type: edit.goal_type || null,
        target_amount: edit.target_amount ? Number(edit.target_amount) : null,
        target_date: edit.target_date || null, linked_account_id: edit.linked_account_id || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this goal?")) return;
    await db.goals.remove(id);
    setOpenId(null);
    load();
  };

  const addContribution = async (g: any) => {
    if (!contribution) return;
    setContributing(true);
    try {
      const next = Number(g.current_amount ?? 0) + Number(contribution);
      await db.goals.update(g.id, { current_amount: next });
      push(`Added ${inr(Number(contribution))}`, "ok");
      setContribution("");
      load();
    } catch (e: any) { push(e?.message ?? "failed to add", "err"); }
    finally { setContributing(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Goals" index="GL" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/goals" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Goals">no goals</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((g) => {
             const pct = g.target_amount ? Math.min(100, Math.round((Number(g.current_amount) / Number(g.target_amount)) * 100)) : 0;
             return (
               <div key={g.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(g)}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{g.title}</div>
                   {g.goal_type && <Chip>{g.goal_type}</Chip>}
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{inr(g.current_amount ?? 0)} of {inr(g.target_amount ?? 0)}{g.target_date && ` · by ${new Date(g.target_date).toLocaleDateString()}`}</div>
                 <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 8 }}>
                   <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
                 </div>
                 <div className="hud-label" style={{ marginTop: 4, color: "var(--accent)" }}>{pct}%</div>
                 {openId === g.id && (
                   <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                       <div><label style={labelStyle}>title</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>type</label>
                         <HudSelect value={edit.goal_type} onChange={(v) => setEdit({ ...edit, goal_type: v })} placeholder="—" options={[
                           { value: "savings", label: "savings" }, { value: "investment", label: "investment" },
                           { value: "purchase", label: "purchase" }, { value: "prepayment", label: "prepayment" },
                           { value: "travel", label: "travel" },
                         ]} />
                       </div>
                       <div><label style={labelStyle}>target amount</label><input type="number" value={edit.target_amount} onChange={(e) => setEdit({ ...edit, target_amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>target date</label><HudDatePicker value={edit.target_date} onChange={(v) => setEdit({ ...edit, target_date: v })} /></div>
                     </div>
                     <div>
                       <label style={labelStyle}>linked account</label>
                       <HudSelect value={edit.linked_account_id} onChange={(v) => setEdit({ ...edit, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                     </div>
                     <div style={{ display: "flex", gap: 6 }}>
                       <Btn size="sm" variant="primary" disabled={saving || !edit.title?.trim()} onClick={() => save(g.id)}>{saving ? "saving…" : "save"}</Btn>
                       <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                       <Btn size="sm" variant="danger" onClick={() => remove(g.id)}>delete</Btn>
                     </div>
                     <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
                       <div className="hud-label" style={{ marginBottom: 6 }}>log a contribution</div>
                       <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
                         <div><label style={labelStyle}>+ amount</label><input type="number" value={contribution} onChange={(e) => setContribution(e.target.value)} style={{ ...inputStyle, width: 120 }} /></div>
                         <Btn size="sm" variant="primary" disabled={contributing || !contribution} onClick={() => addContribution(g)}>{contributing ? "adding…" : "add"}</Btn>
                       </div>
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

