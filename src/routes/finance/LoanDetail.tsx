import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { calcEmi, roundCurrency } from "@/lib/loanCalc";
import { generateAmortizationSchedule } from "@/lib/financeMetrics";
import { useUi } from "@/store/uiStore";

/** Loan detail — amortization schedule, EMI math, and auto-EMI-tagged
 * payments for a single loan. Wired at /finance/loans/:id from the Loans
 * tab tile click. Uses loanCalc.ts + generateAmortizationSchedule so the
 * schedule stays in sync with the same math the config screens use. */
export default function LoanDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [loan, setLoan] = useState<any>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [all, pays] = await Promise.all([db.loans.list(), db.loans.payments(id)]);
        if (!alive) return;
        setLoan(all.find((l: any) => l.id === id) ?? null);
        setPayments(pays);
      } catch (e: any) {
        if (alive) push(e?.message ?? "failed to load loan", "err");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, push]);

  // Recompute EMI from stored fields so we can flag drift between what the
  // user entered and what the math actually says.
  const computedEmi = useMemo(() => {
    if (!loan) return null;
    return calcEmi(Number(loan.principal_amount) || 0, Number(loan.interest_rate) || 0, Number(loan.tenure_months) || 0);
  }, [loan]);

  const schedule = useMemo(() => {
    if (!loan) return null;
    return generateAmortizationSchedule(
      Number(loan.principal_amount) || 0,
      Number(loan.interest_rate) || 0,
      Number(loan.tenure_months) || 0,
    );
  }, [loan]);

  // Auto-EMI: a payment counts as an EMI hit if amount is within ±1% of the
  // stored/computed EMI. Kept deterministic — no AI, no clustering.
  const emiTarget = Number(loan?.emi_amount) || computedEmi || 0;
  const emiHits = useMemo(() => {
    if (!emiTarget) return new Set<string>();
    const tol = emiTarget * 0.01;
    return new Set(payments.filter((p) => Math.abs((Number(p.amount) || 0) - emiTarget) <= tol).map((p) => p.id));
  }, [payments, emiTarget]);

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)" }}>loading…</div>;
  if (!loan) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState hint="the loan may have been deleted">loan not found</EmptyState>
        <div style={{ marginTop: 12 }}>
          <Btn size="sm" onClick={() => nav("/finance/loans")}>← back to loans</Btn>
        </div>
      </div>
    );
  }

  const outstanding = Number(loan.outstanding_amount) || 0;
  const principal = Number(loan.principal_amount) || 0;
  const paidPct = principal > 0 ? Math.max(0, Math.min(100, Math.round(((principal - outstanding) / principal) * 100))) : null;
  const emiDrift = emiTarget && loan.emi_amount && computedEmi
    ? Math.abs(Number(loan.emi_amount) - computedEmi) > Number(loan.emi_amount) * 0.02
    : false;

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NavLink to="/finance/loans" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← loans</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{loan.lender_name}</div>
        {loan.loan_type && <Chip>{loan.loan_type}</Chip>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <HudPanel title="Progress" index="PRG" live={paidPct != null && paidPct > 50 ? "ok" : "warn"}>
          <div style={{ padding: 10 }}>
            <div style={{ fontSize: 32, fontFamily: "var(--font-display)" }}>{paidPct != null ? `${paidPct}%` : "—"}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              {inr(outstanding)} outstanding of {inr(principal)}
            </div>
            <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 10 }}>
              <div style={{ width: `${paidPct ?? 0}%`, height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
            </div>
          </div>
        </HudPanel>

        <HudPanel title="EMI" index="EMI" live={emiDrift ? "warn" : "ok"}>
          <div style={{ padding: 10, fontSize: 12 }}>
            <div style={{ fontSize: 22, fontFamily: "var(--font-display)" }}>{emiTarget ? inr(roundCurrency(emiTarget)) : "—"}</div>
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
              {loan.interest_rate ? `${loan.interest_rate}% p.a.` : "—"}{loan.tenure_months ? ` · ${loan.tenure_months} mo` : ""}
            </div>
            {emiDrift && computedEmi && (
              <div style={{ marginTop: 6, color: "var(--warn)", fontSize: 11 }}>
                stored EMI ({inr(loan.emi_amount)}) differs from computed ({inr(roundCurrency(computedEmi))})
              </div>
            )}
          </div>
        </HudPanel>

        <HudPanel title="Next Due" index="DUE" live={loan.next_due_date ? "ok" : "warn"}>
          <div style={{ padding: 10, fontSize: 12 }}>
            <div style={{ fontSize: 22, fontFamily: "var(--font-display)" }}>{loan.next_due_date ?? "—"}</div>
            {loan.financial_accounts?.nickname && <div style={{ color: "var(--text-dim)", marginTop: 4 }}>from {loan.financial_accounts.nickname}</div>}
          </div>
        </HudPanel>
      </div>

      <HudPanel title="Payment History" index="PAY" live="ok" bodyClass="overflow-auto" style={{ flex: "0 0 auto", maxHeight: 260 }}
        actions={emiTarget ? <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{emiHits.size} EMI-matching</span> : null}>
        {payments.length === 0 ? <EmptyState hint="link this loan on a transaction to see it here">no payments recorded</EmptyState> :
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>date</th>
                <th style={{ padding: "6px 8px" }}>merchant</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>amount</th>
                <th style={{ padding: "6px 8px" }}>tag</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p: any) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px" }}>{p.txn_date}</td>
                  <td style={{ padding: "6px 8px" }}>{p.merchant ?? p.description ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{inr(Number(p.amount) || 0)}</td>
                  <td style={{ padding: "6px 8px" }}>{emiHits.has(p.id) ? <Chip tone="ok">EMI</Chip> : <Chip tone="neutral">extra</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>

      <HudPanel title="Amortization" index="AMR" live="ok" bodyClass="overflow-auto" style={{ flex: 1, minHeight: 0 }}>
        {!schedule ? <EmptyState hint="needs principal, rate, and tenure">can't compute schedule</EmptyState> :
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left", position: "sticky", top: 0, background: "var(--bg)" }}>
                <th style={{ padding: "6px 8px" }}>#</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>payment</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>principal</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>interest</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>balance</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((row) => (
                <tr key={row.month} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{row.month}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{inr(row.payment)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{inr(row.principal)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-dim)" }}>{inr(row.interest)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{inr(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>
    </div>
  );
}
