import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import {
  deriveHoldingFromTransactions, calcGainLoss, calcCagr, calcXirr, xirrCashflowsFromTransactions,
} from "@/lib/investmentCalc";

const TXN_TYPES = [
  { value: "buy", label: "buy" }, { value: "sip", label: "SIP" }, { value: "sell", label: "sell" },
  { value: "dividend", label: "dividend" }, { value: "bonus", label: "bonus" }, { value: "split", label: "split" },
];

/** Investment holding detail — transaction ledger, XIRR/CAGR, and goal
 * mapping for a single holding. Wired at /finance/investments/:id. */
export default function InvestmentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [holding, setHolding] = useState<any>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [goals, setGoals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ txn_type: "buy", txn_date: new Date().toISOString().slice(0, 10), units: "", price: "", amount: "" });
  const [logging, setLogging] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);

  const load = async () => {
    if (!id) return;
    try {
      const [h, t, g] = await Promise.all([db.investmentHoldings.get(id), db.investmentTransactions.list(id), db.goals.list()]);
      setHolding(h);
      setTxns(t);
      setGoals(g);
    } catch (e: any) {
      push(e?.message ?? "failed to load holding", "err");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [id]);

  const logTxn = async () => {
    if (!id || !draft.amount) return;
    setLogging(true);
    try {
      await db.investmentTransactions.create({
        holding_id: id, txn_type: draft.txn_type, txn_date: draft.txn_date,
        units: draft.units ? Number(draft.units) : null, price: draft.price ? Number(draft.price) : null,
        amount: Number(draft.amount), source: "manual",
      });
      push("Transaction logged", "ok");
      setDraft({ txn_type: "buy", txn_date: new Date().toISOString().slice(0, 10), units: "", price: "", amount: "" });
      load();
    } catch (e: any) { push(e?.message ?? "failed to log transaction", "err"); }
    finally { setLogging(false); }
  };

  const removeTxn = async (txnId: string) => {
    await db.investmentTransactions.remove(txnId);
    load();
  };

  const setGoalMapping = async (goalId: string) => {
    if (!id) return;
    setSavingGoal(true);
    try { await db.investmentHoldings.update(id, { goal_id: goalId || null }); load(); }
    catch (e: any) { push(e?.message ?? "failed to update goal mapping", "err"); }
    finally { setSavingGoal(false); }
  };

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)" }}>loading…</div>;
  if (!holding) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState hint="the holding may have been deleted">investment not found</EmptyState>
        <div style={{ marginTop: 12 }}><Btn size="sm" onClick={() => nav("/finance/investments")}>← back to investments</Btn></div>
      </div>
    );
  }

  // Where a transaction ledger exists, it's the source of truth (weighted
  // average cost) — otherwise fall back to the holding's manually-entered
  // units/invested_amount. See the investment_transactions migration comment.
  const derived = txns.length > 0 ? deriveHoldingFromTransactions(txns) : null;
  const units = derived ? derived.units : (Number(holding.units) || 0);
  const investedAmount = derived ? derived.investedAmount : (Number(holding.invested_amount) || 0);
  const currentPrice = Number(holding.current_price) || 0;
  const currentValue = (units * currentPrice) || (Number(holding.current_value) || 0);
  const { gain, gainPct } = calcGainLoss(currentValue, investedAmount);
  const firstTxnDate = txns.length > 0 ? [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date))[0].txn_date : null;
  const cagr = firstTxnDate ? calcCagr(investedAmount, currentValue, firstTxnDate) : null;
  const xirr = txns.length > 0 ? calcXirr(xirrCashflowsFromTransactions(txns, currentValue)) : null;

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NavLink to="/finance/investments" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← investments</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{holding.name}</div>
        <Chip>{holding.asset_type.replace("_", " ")}</Chip>
      </div>

      <HudPanel title="Position" index="POS" live={gain >= 0 ? "ok" : "warn"}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, padding: 4 }}>
          <div><div className="hud-label">current value</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{inr(currentValue)}</div></div>
          <div><div className="hud-label">invested</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{inr(investedAmount)}</div></div>
          <div><div className="hud-label">gain/loss</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20, color: gain >= 0 ? "var(--ok)" : "var(--err)" }}>{inr(gain)}{gainPct != null && ` (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%)`}</div></div>
          <div><div className="hud-label">units</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{units || "—"}</div></div>
          <div><div className="hud-label">CAGR</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{cagr != null ? `${cagr.toFixed(1)}%` : "—"}</div></div>
          <div><div className="hud-label">XIRR</div><div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{xirr != null ? `${xirr.toFixed(1)}%` : "—"}</div></div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          price {currentPrice ? inr(currentPrice) : "—"}{holding.current_price_source && ` (${holding.current_price_source})`}
          {holding.current_price_updated_at && ` · updated ${new Date(holding.current_price_updated_at).toLocaleDateString()}`}
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
          <label style={labelStyle}>map to goal</label>
          <HudSelect value={holding.goal_id ?? ""} onChange={setGoalMapping} placeholder="none" options={goals.map((g: any) => ({ value: g.id, label: g.title }))} />
          {savingGoal && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 8 }}>saving…</span>}
        </div>
      </HudPanel>

      <HudPanel title="Transaction Ledger" index="TXN" live="ok" bodyClass="overflow-auto" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap", marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--edge)" }}>
          <div><label style={labelStyle}>type</label><HudSelect value={draft.txn_type} onChange={(v) => setDraft({ ...draft, txn_type: v })} options={TXN_TYPES} /></div>
          <div><label style={labelStyle}>date</label><HudDatePicker value={draft.txn_date} onChange={(v) => setDraft({ ...draft, txn_date: v })} /></div>
          <div><label style={labelStyle}>units</label><input type="number" value={draft.units} onChange={(e) => setDraft({ ...draft, units: e.target.value })} style={{ ...inputStyle, width: 90 }} /></div>
          <div><label style={labelStyle}>price</label><input type="number" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} style={{ ...inputStyle, width: 90 }} /></div>
          <div><label style={labelStyle}>amount</label><input type="number" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} style={{ ...inputStyle, width: 110 }} /></div>
          <Btn size="sm" variant="primary" disabled={logging || !draft.amount} onClick={logTxn}>{logging ? "logging…" : "log transaction"}</Btn>
        </div>
        {txns.length === 0 ? <EmptyState hint="log a buy/SIP/sell above, or import via Groww">no transactions yet — showing manually-entered position</EmptyState> :
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>date</th>
                <th style={{ padding: "6px 8px" }}>type</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>units</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>price</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>amount</th>
                <th style={{ padding: "6px 8px" }}>source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {txns.map((t: any) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px" }}>{t.txn_date}</td>
                  <td style={{ padding: "6px 8px" }}><Chip>{t.txn_type}</Chip></td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{t.units ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{t.price ? inr(t.price) : "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{inr(t.amount)}</td>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.source ?? "manual"}</td>
                  <td style={{ padding: "6px 8px" }}><button onClick={() => removeTxn(t.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>
    </div>
  );
}
