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
import { ConfigureCTA, utilTone, sourceTone } from "./_shared";

// ---------- Loans ----------
export default function Loans() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [payment, setPayment] = useState({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
  const [logging, setLogging] = useState(false);
  const [payments, setPayments] = useState<any[]>([]);
  const [showAmort, setShowAmort] = useState(false);

  const load = async () => {
    const [l, a] = await Promise.all([db.loans.list(), db.accounts.list()]);
    setItems(l); setAccounts(a);
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (l: any) => {
    if (openId === l.id) { setOpenId(null); return; }
    setOpenId(l.id);
    setEdit({
      lender_name: l.lender_name ?? "", loan_type: l.loan_type ?? "",
      principal_amount: l.principal_amount ?? "", interest_rate: l.interest_rate ?? "",
      emi_amount: l.emi_amount ?? "", tenure_months: l.tenure_months ?? "",
      start_date: l.start_date ?? "", outstanding_amount: l.outstanding_amount ?? "",
      next_due_date: l.next_due_date ?? "", linked_account_id: l.linked_account_id ?? "",
    });
    setPayment({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
    setShowAmort(false);
    setPayments([]);
    db.loans.payments(l.id).then(setPayments).catch(() => {});
  };

  // Recalculate the other of {principal, EMI} on blur — never mid-keystroke,
  // to avoid flashing intermediate garbage into the sibling field. Rate and
  // tenure are always plain inputs, never auto-derived.
  const recalcFromPrincipal = () => {
    const emi = calcEmi(Number(edit.principal_amount), Number(edit.interest_rate), Number(edit.tenure_months));
    if (emi != null) setEdit((e: any) => ({ ...e, emi_amount: String(roundCurrency(emi)) }));
  };
  const recalcFromEmi = () => {
    const p = calcPrincipalFromEmi(Number(edit.emi_amount), Number(edit.interest_rate), Number(edit.tenure_months));
    if (p != null) setEdit((e: any) => ({ ...e, principal_amount: String(roundCurrency(p)) }));
  };
  const recalcFromRateTenure = () => {
    if (edit.principal_amount) recalcFromPrincipal();
  };

  const save = async (id: string) => {
    if (!edit.lender_name?.trim()) return;
    setSaving(true);
    try {
      await db.loans.update(id, {
        lender_name: edit.lender_name.trim(), loan_type: edit.loan_type || null,
        principal_amount: edit.principal_amount ? Number(edit.principal_amount) : null,
        interest_rate: edit.interest_rate ? Number(edit.interest_rate) : null,
        emi_amount: edit.emi_amount ? Number(edit.emi_amount) : null,
        tenure_months: edit.tenure_months ? Number(edit.tenure_months) : null,
        start_date: edit.start_date || null,
        outstanding_amount: edit.outstanding_amount ? Number(edit.outstanding_amount) : null,
        next_due_date: edit.next_due_date || null, linked_account_id: edit.linked_account_id || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this loan?")) return;
    await db.loans.remove(id);
    setOpenId(null);
    load();
  };

  const logPayment = async (loan: any) => {
    if (!payment.account_id || !payment.amount) return;
    setLogging(true);
    try {
      await db.transactions.create({
        txn_date: payment.date, amount: Number(payment.amount), txn_type: "debit",
        merchant: `${loan.lender_name} EMI payment`, category: "loan payment",
        financial_account_id: payment.account_id, loan_id: loan.id, source: "manual",
      });
      push("Payment logged", "ok");
      setPayment({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
    } catch (e: any) { push(e?.message ?? "failed to log payment", "err"); }
    finally { setLogging(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Loans" index="LN" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/loans" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Loans">no loans</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((l) => (
             <div key={l.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(l)}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{l.lender_name}</div>
                  {l.loan_type && <Chip>{l.loan_type}</Chip>}
                  <NavLink to={`/finance/loans/${l.id}`} onClick={(e) => e.stopPropagation()}
                    style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", textDecoration: "none" }}>
                    details →
                  </NavLink>
                </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.6 }}>
                 EMI {inr(l.emi_amount ?? 0)} @ {l.interest_rate ?? "—"}%<br />
                 outstanding {inr(l.outstanding_amount ?? 0)}<br />
                 {l.next_due_date && `next due ${new Date(l.next_due_date).toLocaleDateString()}`}
               </div>
               {openId === l.id && (
                 <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>lender</label><input value={edit.lender_name} onChange={(e) => setEdit({ ...edit, lender_name: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>type</label>
                       <HudSelect value={edit.loan_type} onChange={(v) => setEdit({ ...edit, loan_type: v })} placeholder="—" options={[
                         { value: "home", label: "home" }, { value: "personal", label: "personal" },
                         { value: "car", label: "car" }, { value: "device", label: "device" },
                         { value: "education", label: "education" },
                       ]} />
                     </div>
                   </div>
                   <div className="hud-label">rate + tenure are mandatory — principal and EMI auto-calculate each other on blur</div>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>rate %</label><input type="number" step="0.01" value={edit.interest_rate} onChange={(e) => setEdit({ ...edit, interest_rate: e.target.value })} onBlur={recalcFromRateTenure} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>tenure (mo)</label><input type="number" value={edit.tenure_months} onChange={(e) => setEdit({ ...edit, tenure_months: e.target.value })} onBlur={recalcFromRateTenure} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>principal</label><input type="number" value={edit.principal_amount} onChange={(e) => setEdit({ ...edit, principal_amount: e.target.value })} onBlur={recalcFromPrincipal} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>EMI</label><input type="number" value={edit.emi_amount} onChange={(e) => setEdit({ ...edit, emi_amount: e.target.value })} onBlur={recalcFromEmi} style={{ ...inputStyle, width: "100%" }} /></div>
                   </div>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>outstanding</label><input type="number" value={edit.outstanding_amount} onChange={(e) => setEdit({ ...edit, outstanding_amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>start date</label><HudDatePicker value={edit.start_date} onChange={(v) => setEdit({ ...edit, start_date: v })} /></div>
                     <div><label style={labelStyle}>next due</label><HudDatePicker value={edit.next_due_date} onChange={(v) => setEdit({ ...edit, next_due_date: v })} /></div>
                   </div>
                   <div>
                     <label style={labelStyle}>linked account</label>
                     <HudSelect value={edit.linked_account_id} onChange={(v) => setEdit({ ...edit, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                   </div>
                   <div style={{ display: "flex", gap: 6 }}>
                     <Btn size="sm" variant="primary" disabled={saving || !edit.lender_name?.trim()} onClick={() => save(l.id)}>{saving ? "saving…" : "save"}</Btn>
                     <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                     <Btn size="sm" variant="danger" onClick={() => remove(l.id)}>delete</Btn>
                   </div>
                   <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
                     <div className="hud-label" style={{ marginBottom: 6 }}>log EMI payment</div>
                     <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
                       <div style={{ minWidth: 160 }}>
                         <label style={labelStyle}>paid from</label>
                         <HudSelect value={payment.account_id} onChange={(v) => setPayment({ ...payment, account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                       </div>
                       <div><label style={labelStyle}>amount</label><input type="number" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} style={{ ...inputStyle, width: 100 }} /></div>
                       <div><label style={labelStyle}>date</label><HudDatePicker value={payment.date} onChange={(v) => setPayment({ ...payment, date: v })} /></div>
                       <Btn size="sm" variant="primary" disabled={logging || !payment.account_id || !payment.amount} onClick={() => logPayment(l)}>{logging ? "logging…" : "log payment"}</Btn>
                     </div>
                   </div>
                   <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
                     <div className="hud-label" style={{ marginBottom: 6 }}>payment history</div>
                     {payments.length === 0 ? <div className="hud-label">no logged payments yet</div> :
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflow: "auto" }}>
                        {payments.map((p: any) => (
                          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ color: "var(--text)" }}>{new Date(p.txn_date).toLocaleDateString()} · {p.merchant ?? "—"}</span>
                              <Chip tone={sourceTone(p.source)}>{p.source ?? "manual"}</Chip>
                            </div>
                            <span style={{ color: "var(--warn)", fontFamily: "var(--font-display)" }}>{inr(p.amount)}</span>
                          </div>
                        ))}
                      </div>}
                   </div>
                   <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
                     <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                       <div className="hud-label">amortization schedule</div>
                       <Btn size="sm" onClick={() => setShowAmort((v) => !v)}>{showAmort ? "hide" : "show"}</Btn>
                     </div>
                     {showAmort && (() => {
                       const schedule = generateAmortizationSchedule(Number(l.principal_amount), Number(l.interest_rate), Number(l.tenure_months));
                       if (!schedule) return <div className="hud-label" style={{ marginTop: 6 }}>insufficient data — set principal, rate and tenure</div>;
                       return (
                         <div style={{ maxHeight: 220, overflow: "auto", marginTop: 6 }}>
                           <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                             <thead>
                               <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                                 <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--edge)" }}>month</th>
                                 <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>payment</th>
                                 <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>principal</th>
                                 <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>interest</th>
                                 <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>balance</th>
                               </tr>
                             </thead>
                             <tbody>
                               {schedule.map((row) => (
                                 <tr key={row.month} style={{ borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                                   <td style={{ padding: "4px 6px", color: "var(--text-dim)" }}>{row.month}</td>
                                   <td style={{ padding: "4px 6px", textAlign: "right" }}>{inr(row.payment)}</td>
                                   <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--ok)" }}>{inr(row.principal)}</td>
                                   <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--warn)" }}>{inr(row.interest)}</td>
                                   <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--text-dim)" }}>{inr(row.balance)}</td>
                                 </tr>
                               ))}
                             </tbody>
                           </table>
                         </div>
                       );
                     })()}
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

