import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { calcCreditUtilization } from "@/lib/financeMetrics";
import { useUi } from "@/store/uiStore";

/** Card detail — utilization ring, latest statement, statement history, and
 * recent transactions for a single credit card. Wired at /finance/cards/:id
 * from the Cards tab tile click. */
export default function CardDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [card, setCard] = useState<any>(null);
  const [statements, setStatements] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [all, allStatements, recentTxns] = await Promise.all([
          db.cards.list(),
          db.statements.list(500),
          // Recent transactions on this card — cap tight so the route stays snappy.
          (async () => {
            const list = await db.transactions.list(200);
            return list.filter((t: any) => t.credit_card_id === id).slice(0, 30);
          })(),
        ]);
        if (!alive) return;
        setCard(all.find((c: any) => c.id === id) ?? null);
        setStatements(allStatements.filter((s: any) => s.credit_card_id === id));
        setTxns(recentTxns);
      } catch (e: any) {
        if (alive) push(e?.message ?? "failed to load card", "err");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, push]);

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)" }}>loading…</div>;
  if (!card) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState hint="the card may have been deleted">card not found</EmptyState>
        <div style={{ marginTop: 12 }}>
          <Btn size="sm" onClick={() => nav("/finance/cards")}>← back to cards</Btn>
        </div>
      </div>
    );
  }

  const latest = statements[0] ?? null; // list is already ordered by statement_date desc
  const util = calcCreditUtilization([{
    cardId: card.id, cardName: card.card_name, limit: card.limit_amount, totalDue: latest?.total_due,
  }]).perCard[0];
  const utilPct = util?.utilizationPct ?? null;
  const utilTone = utilPct == null ? "neutral" : utilPct < 30 ? "ok" : utilPct < 70 ? "warn" : "err";

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NavLink to="/finance/cards" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← cards</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{card.card_name}</div>
        {card.banks?.name && <Chip>{card.banks.name}</Chip>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <HudPanel title="Utilization" index="UTL" live={utilTone === "err" ? "err" : utilTone === "warn" ? "warn" : "ok"}>
          <div style={{ padding: 10 }}>
            <div style={{ fontSize: 32, fontFamily: "var(--font-display)" }}>{utilPct != null ? `${utilPct}%` : "—"}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              {latest?.total_due ? inr(latest.total_due) : "—"} of {card.limit_amount ? inr(card.limit_amount) : "no limit set"}
            </div>
            <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 10 }}>
              <div style={{
                width: `${Math.max(0, Math.min(100, utilPct ?? 0))}%`, height: "100%",
                background: utilTone === "err" ? "var(--err)" : utilTone === "warn" ? "var(--warn)" : "var(--accent)",
                boxShadow: "0 0 6px currentColor",
              }} />
            </div>
          </div>
        </HudPanel>

        <HudPanel title="Latest Statement" index="STM" live={latest ? "ok" : "warn"}>
          <div style={{ padding: 10, fontSize: 12 }}>
            {latest ? (
              <>
                <div>total due: <strong>{inr(latest.total_due ?? 0)}</strong></div>
                {latest.min_due != null && <div style={{ color: "var(--text-dim)" }}>min due: {inr(latest.min_due)}</div>}
                {latest.due_date && <div style={{ color: "var(--text-dim)" }}>due: {latest.due_date}</div>}
                {latest.statement_date && <div style={{ color: "var(--text-dim)" }}>statement: {latest.statement_date}</div>}
              </>
            ) : <span style={{ color: "var(--text-dim)" }}>no statements parsed yet</span>}
          </div>
        </HudPanel>

        <HudPanel title="Card Info" index="INF" live="ok">
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
            {card.masked_number && <div>ending in {card.masked_number}</div>}
            {card.billing_day && <div>bill day: {card.billing_day}</div>}
            {card.due_day && <div>due day: {card.due_day}</div>}
            {card.autopay && <Chip tone="ok">autopay on</Chip>}
            {card.reward_type && <div>{card.reward_rate_pct}% {card.reward_type}</div>}
            {card.notes && <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{card.notes}</div>}
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
        {txns.length === 0 ? <EmptyState hint="none in the last 200 records">no transactions on this card</EmptyState> :
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
