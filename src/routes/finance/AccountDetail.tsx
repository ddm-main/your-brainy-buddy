import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

/** Account detail — balance, statement history, transaction history, and a
 * cross-entity view (linked loans + subscriptions) for a single account.
 * Wired at /finance/accounts/:id from the Accounts tab tile click. Note:
 * credit_cards has no linked_account_id in the current schema, so cards
 * can't be cross-referenced here the way loans/subs can — see db.accounts.linked. */
export default function AccountDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [account, setAccount] = useState<any>(null);
  const [statements, setStatements] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [linked, setLinked] = useState<{ loans: any[]; subs: any[] }>({ loans: [], subs: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [all, allStatements, allTxns, linkedRows] = await Promise.all([
          db.accounts.list(),
          db.statements.list(500),
          db.transactions.list(200),
          db.accounts.linked(id),
        ]);
        if (!alive) return;
        setAccount(all.find((a: any) => a.id === id) ?? null);
        setStatements(allStatements.filter((s: any) => s.financial_account_id === id));
        setTxns(allTxns.filter((t: any) => t.financial_account_id === id).slice(0, 30));
        setLinked(linkedRows);
      } catch (e: any) {
        if (alive) push(e?.message ?? "failed to load account", "err");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, push]);

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)" }}>loading…</div>;
  if (!account) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState hint="the account may have been deleted">account not found</EmptyState>
        <div style={{ marginTop: 12 }}>
          <Btn size="sm" onClick={() => nav("/finance/accounts")}>← back to accounts</Btn>
        </div>
      </div>
    );
  }

  const stale = account.current_balance != null && (!account.current_balance_as_of || daysSince(account.current_balance_as_of) > 30);

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NavLink to="/finance/accounts" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← accounts</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{account.nickname}</div>
        {account.account_type && <Chip>{account.account_type}</Chip>}
        {account.banks?.name && <Chip>{account.banks.name}</Chip>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <HudPanel title="Balance" index="BAL" live={stale ? "warn" : "ok"}>
          <div style={{ padding: 10 }}>
            <div style={{ fontSize: 32, fontFamily: "var(--font-display)" }}>{account.current_balance != null ? inr(account.current_balance) : "—"}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              {account.current_balance_as_of ? `as of ${new Date(account.current_balance_as_of).toLocaleDateString()}` : "no balance set"}
            </div>
            {stale && <Chip tone="warn">stale balance</Chip>}
          </div>
        </HudPanel>

        <HudPanel title="Account Info" index="INF" live="ok">
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
            {account.masked_number && <div>ending in {account.masked_number}</div>}
            {account.statement_cycle_day && <div>statement cycle day: {account.statement_cycle_day}</div>}
            {account.source_email && <div>source: {account.source_email}</div>}
            {account.notes && <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{account.notes}</div>}
          </div>
        </HudPanel>

        <HudPanel title="Linked" index="LNK" live="ok">
          <div style={{ padding: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {linked.loans.length === 0 && linked.subs.length === 0 ? (
              <span style={{ color: "var(--text-dim)" }}>nothing linked to this account yet</span>
            ) : (
              <>
                {linked.loans.map((l: any) => (
                  <NavLink key={l.id} to={`/finance/loans/${l.id}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{l.lender_name} (loan) →</NavLink>
                ))}
                {linked.subs.map((s: any) => (
                  <div key={s.id} style={{ color: "var(--text-dim)" }}>{s.name} (subscription)</div>
                ))}
              </>
            )}
          </div>
        </HudPanel>
      </div>

      <HudPanel title="Statements" index="HIS" live="ok" bodyClass="overflow-auto" style={{ flex: "0 0 auto", maxHeight: 260 }}>
        {statements.length === 0 ? <EmptyState hint="upload one from the Statements tab">no statements yet</EmptyState> :
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>date</th>
                <th style={{ padding: "6px 8px" }}>due</th>
                <th style={{ padding: "6px 8px" }}>amount</th>
                <th style={{ padding: "6px 8px" }}>status</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s: any) => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px" }}>{s.statement_date ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{s.due_date ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{s.total_due != null ? inr(s.total_due) : "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <Chip tone={s.parse_status === "parsed" ? "ok" : s.parse_status === "failed" ? "err" : "warn"}>{s.parse_status ?? "—"}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>

      <HudPanel title="Recent Transactions" index="TXN" live="ok" bodyClass="overflow-auto" style={{ flex: 1, minHeight: 0 }}>
        {txns.length === 0 ? <EmptyState hint="none in the last 200 records">no transactions on this account</EmptyState> :
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>date</th>
                <th style={{ padding: "6px 8px" }}>merchant</th>
                <th style={{ padding: "6px 8px" }}>category</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>amount</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t: any) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px" }}>{t.txn_date}</td>
                  <td style={{ padding: "6px 8px" }}>{t.merchant ?? t.description ?? "—"}</td>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.category ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: t.txn_type === "credit" ? "var(--ok)" : "inherit" }}>
                    {t.txn_type === "credit" ? "+" : "−"}{inr(Number(t.amount) || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>
    </div>
  );
}
