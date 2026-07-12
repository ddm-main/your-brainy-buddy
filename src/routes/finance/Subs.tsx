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
import { detectRecurringSuggestions, type RecurringSuggestion } from "@/lib/recurringDetector";

// ---------- Subscriptions ----------
export default function Subs() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = async () => {
    const [s, a, c, al] = await Promise.all([db.subscriptions.list(), db.accounts.list(), db.cards.list(), db.alerts.list({ status: "open" })]);
    setItems(s); setAccounts(a); setCards(c); setAlerts(al);
  };
  useEffect(() => { load(); scan(); }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const out = await detectRecurringSuggestions();
      setSuggestions(out);
    } catch (e: any) { push(e?.message ?? "scan failed", "err"); }
    finally { setScanning(false); }
  };

  const addFromSuggestion = async (s: RecurringSuggestion) => {
    setAdding(s.merchantKey);
    try {
      await db.subscriptions.create({
        name: s.displayName,
        category: s.category ?? undefined,
        amount: s.amount,
        billing_cycle: s.cadence,
        next_due_date: s.nextDueDate,
        linked_account_id: s.financial_account_id ?? null,
        linked_card_id: s.credit_card_id ?? null,
      });
      push(`Added ${s.displayName}`, "ok");
      setSuggestions((cur) => cur.filter((x) => x.merchantKey !== s.merchantKey));
      load();
    } catch (e: any) { push(e?.message ?? "failed to add", "err"); }
    finally { setAdding(null); }
  };

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.merchantKey));
  const hasIssue = (id: string) => alerts.some((a) => a.entity_type === "subscription" && a.entity_id === id);

  const toggleOpen = (s: any) => {
    if (openId === s.id) { setOpenId(null); return; }
    setOpenId(s.id);
    setEdit({
      name: s.name ?? "", category: s.category ?? "", amount: s.amount ?? "",
      billing_cycle: s.billing_cycle ?? "", next_due_date: s.next_due_date ?? "",
      linked_account_id: s.linked_account_id ?? "", linked_card_id: s.linked_card_id ?? "",
    });
  };

  const save = async (id: string) => {
    if (!edit.name?.trim()) return;
    setSaving(true);
    try {
      await db.subscriptions.update(id, {
        name: edit.name.trim(), category: edit.category || null,
        amount: edit.amount ? Number(edit.amount) : null, billing_cycle: edit.billing_cycle || null,
        next_due_date: edit.next_due_date || null, linked_account_id: edit.linked_account_id || null,
        linked_card_id: edit.linked_card_id || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this subscription?")) return;
    await db.subscriptions.remove(id);
    setOpenId(null);
    load();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Detected Recurring Charges" index="DET" live={visibleSuggestions.length ? "warn" : "ok"} style={{ flexShrink: 0 }}
        actions={<Btn size="sm" onClick={scan} disabled={scanning}><RefreshCw size={12} style={{ marginRight: 4, verticalAlign: -1 }} />{scanning ? "scanning…" : "re-scan"}</Btn>}>
        {visibleSuggestions.length === 0
          ? <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{scanning ? "scanning transactions…" : "no unrecognized recurring charges in the last 180 days"}</div>
          : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
              {visibleSuggestions.slice(0, 8).map((s) => (
                <div key={s.merchantKey} style={{ padding: 10, border: "1px dashed var(--edge)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.displayName}</div>
                    <Chip tone="warn">{s.cadence}</Chip>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    ~{inr(s.amount)} · {s.occurrences}× · last {s.lastDate}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <Btn size="sm" variant="primary" disabled={adding === s.merchantKey} onClick={() => addFromSuggestion(s)}>{adding === s.merchantKey ? "adding…" : "+ subscription"}</Btn>
                    <Btn size="sm" onClick={() => setDismissed((d) => new Set(d).add(s.merchantKey))}>dismiss</Btn>
                  </div>
                </div>
              ))}
            </div>}
      </HudPanel>
      <HudPanel title="Subscriptions" index="SUB" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/subscriptions" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Subscriptions">no subscriptions</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
           {items.map((s) => (
             <div key={s.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(s)}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{s.name}</div>
                 {s.category && <Chip>{s.category}</Chip>}
                 {hasIssue(s.id) && <Chip tone="warn">issue</Chip>}
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {inr(s.amount ?? 0)} / {s.billing_cycle ?? "—"}
                 {s.next_due_date && ` · next ${new Date(s.next_due_date).toLocaleDateString()}`}
               </div>
               {openId === s.id && (
                 <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>name</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>category</label><input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>amount</label><input type="number" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>billing cycle</label>
                       <HudSelect value={edit.billing_cycle} onChange={(v) => setEdit({ ...edit, billing_cycle: v })} placeholder="—" options={[
                         { value: "weekly", label: "weekly" }, { value: "monthly", label: "monthly" },
                         { value: "quarterly", label: "quarterly" }, { value: "yearly", label: "yearly" },
                       ]} />
                     </div>
                     <div><label style={labelStyle}>next due</label><HudDatePicker value={edit.next_due_date} onChange={(v) => setEdit({ ...edit, next_due_date: v })} /></div>
                   </div>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>linked account</label>
                       <HudSelect value={edit.linked_account_id} onChange={(v) => setEdit({ ...edit, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                     </div>
                     <div><label style={labelStyle}>linked card</label>
                       <HudSelect value={edit.linked_card_id} onChange={(v) => setEdit({ ...edit, linked_card_id: v })} placeholder="—" options={cards.map((c: any) => ({ value: c.id, label: c.card_name }))} />
                     </div>
                   </div>
                   <div style={{ display: "flex", gap: 6 }}>
                     <Btn size="sm" variant="primary" disabled={saving || !edit.name?.trim()} onClick={() => save(s.id)}>{saving ? "saving…" : "save"}</Btn>
                     <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                     <Btn size="sm" variant="danger" onClick={() => remove(s.id)}>delete</Btn>
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

