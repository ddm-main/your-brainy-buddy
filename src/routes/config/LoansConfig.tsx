import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, type Loan } from "@/lib/db";
import { calcEmi, calcPrincipalFromEmi, roundCurrency } from "@/lib/loanCalc";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

function FinanceCTA({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} style={{
      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
      textTransform: "uppercase", color: "var(--accent)", textDecoration: "none",
      padding: "4px 8px", border: "1px solid var(--edge)",
    }}>{label} →</NavLink>
  );
}

export default function LoansConfig() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<Loan[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [f, setF] = useState({ lender_name: "", loan_type: "", principal: "", rate: "", emi: "", tenure: "", start: "", outstanding: "", due: "", linked_account_id: "" });
  const load = async () => {
    const [l, a] = await Promise.all([db.loans.list(), db.accounts.list()]);
    setItems(l); setAccounts(a);
  };
  useEffect(() => { load(); }, []);

  const recalcFromPrincipal = () => {
    const emi = calcEmi(Number(f.principal), Number(f.rate), Number(f.tenure));
    if (emi != null) setF((s) => ({ ...s, emi: String(roundCurrency(emi)) }));
  };
  const recalcFromEmi = () => {
    const p = calcPrincipalFromEmi(Number(f.emi), Number(f.rate), Number(f.tenure));
    if (p != null) setF((s) => ({ ...s, principal: String(roundCurrency(p)) }));
  };
  const recalcFromRateTenure = () => {
    if (f.principal) recalcFromPrincipal();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.lender_name.trim()) return;
    try {
      await db.loans.create({
        lender_name: f.lender_name.trim(), loan_type: f.loan_type || undefined,
        principal_amount: f.principal ? Number(f.principal) : undefined,
        interest_rate: f.rate ? Number(f.rate) : undefined,
        emi_amount: f.emi ? Number(f.emi) : undefined,
        tenure_months: f.tenure ? Number(f.tenure) : undefined,
        start_date: f.start || undefined,
        outstanding_amount: f.outstanding ? Number(f.outstanding) : undefined,
        next_due_date: f.due || undefined,
        linked_account_id: f.linked_account_id || null,
      });
      setF({ lender_name: "", loan_type: "", principal: "", rate: "", emi: "", tenure: "", start: "", outstanding: "", due: "", linked_account_id: "" });
      load();
    } catch (err: any) { push(err?.message ?? "failed to add loan", "err"); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Loan" index="+" live="ok" style={{ flexShrink: 0 }}>
        <div className="hud-label" style={{ marginBottom: 6 }}>rate + tenure are mandatory — principal and EMI auto-calculate each other on blur</div>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr) auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>lender</label><input value={f.lender_name} onChange={set("lender_name")} placeholder="HDFC" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <HudSelect value={f.loan_type} onChange={(v) => setF({ ...f, loan_type: v })} placeholder="—" options={[
              { value: "home", label: "home" }, { value: "personal", label: "personal" },
              { value: "car", label: "car" }, { value: "device", label: "device" },
              { value: "education", label: "education" },
            ]} />
          </div>
          <div><label style={labelStyle}>rate %</label><input type="number" step="0.01" value={f.rate} onChange={set("rate")} onBlur={recalcFromRateTenure} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>tenure (mo)</label><input type="number" value={f.tenure} onChange={set("tenure")} onBlur={recalcFromRateTenure} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>principal</label><input type="number" value={f.principal} onChange={set("principal")} onBlur={recalcFromPrincipal} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.lender_name.trim()}>+ add</Btn>
          <div><label style={labelStyle}>EMI</label><input type="number" value={f.emi} onChange={set("emi")} onBlur={recalcFromEmi} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>start</label><HudDatePicker value={f.start} onChange={(v) => setF({ ...f, start: v })} /></div>
          <div><label style={labelStyle}>outstanding</label><input type="number" value={f.outstanding} onChange={set("outstanding")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>next due</label><HudDatePicker value={f.due} onChange={(v) => setF({ ...f, due: v })} /></div>
          <div><label style={labelStyle}>linked account</label>
            <HudSelect value={f.linked_account_id} onChange={(v) => setF({ ...f, linked_account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
          </div>
        </form>
      </HudPanel>
      <HudPanel title="Loans" index="LN" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<FinanceCTA to="/finance/loans" label="view + edit in Finance" />}>
        {items.length === 0 ? <EmptyState>no loans</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
           {items.map((l) => (
             <div key={l.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{l.lender_name}</div>
                 {l.loan_type && <Chip>{l.loan_type}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.loans.remove(l.id); load(); } }}><Trash2 size={13} /></button>
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
