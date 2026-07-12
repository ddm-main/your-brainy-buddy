import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Btn, Chip } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { runReconciliation } from "@/lib/reconciliation";
import { useFinanceSnapshot } from "@/lib/useFinanceSnapshot";
import { useUi } from "@/store/uiStore";
import { RefreshCw } from "lucide-react";
import { utilTone, ScoreBar } from "./_shared";
import { calcGainLoss } from "@/lib/investmentCalc";
import { HudLineChart } from "@/components/hud/HudChart";

// ---------- Overview ----------
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}
function alertTone(type: string): "warn" | "err" {
  return type === "amount_mismatch" ? "err" : "warn";
}

export default function Overview() {
  const push = useUi((s) => s.push);
  const {
    state, categories, accounts, loans, subs,
    alerts, setAlerts, netWorth, utilization, health, refresh,
    trend, upcomingBills, upcomingBillsTotal, goalProjections, insights,
  } = useFinanceSnapshot();
  const [aiTake, setAiTake] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiPeriod, setAiPeriod] = useState<"day" | "week" | "month" | "brief" | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [investments, setInvestments] = useState({ totalValue: 0, totalInvested: 0, count: 0 });
  const [budgets, setBudgets] = useState<{ category: string; monthly_limit: number; spent: number }[]>([]);

  useEffect(() => {
    db.investmentHoldings.summary().then(setInvestments).catch(() => {});
    db.budgets.list().then(async (list) => {
      const withSpend = await Promise.all(list.map(async (b: any) => ({
        category: b.category, monthly_limit: Number(b.monthly_limit) || 0,
        spent: await db.budgets.spentThisMonth(b.category),
      })));
      setBudgets(withSpend);
    }).catch(() => {});
  }, []);

  const cardTiles = [
    { l: "accounts", v: state.accounts, to: "/finance/accounts" },
    { l: "credit cards", v: state.cards, to: "/finance/cards" },
    { l: "loans", v: state.loans, to: "/finance/loans" },
    { l: "investments", v: investments.count, to: "/finance/investments" },
    { l: "goals", v: state.goals, to: "/finance/goals" },
    { l: "subscriptions", v: state.subs, to: "/finance/subs" },
  ];
  const budgetsOverLimit = budgets.filter((b) => b.spent > b.monthly_limit).length;

  // Reconciliation runs after every rescan (own try/catch — a reconciliation
  // failure must never clobber the rescan's own success toast) plus on its
  // own standalone button.
  const checkForIssues = async (silent = false) => {
    setReconciling(true);
    try {
      const r = await runReconciliation();
      if (!silent) push(`Checked ${r.checked} · ${r.missing} missing · ${r.mismatched} off-amount`, r.missing || r.mismatched ? "warn" : "ok");
      setAlerts(await db.alerts.list({ status: "open" }));
    } catch (e: any) { if (!silent) push(e?.message ?? "reconciliation failed", "err"); }
    finally { setReconciling(false); }
  };
  const rescan = async () => {
    setRescanning(true);
    try {
      const j = await db.finance.extract({ since_days: 90, limit: 500 });
      push(`Extracted ${j.transactions ?? 0} txn, ${j.statements ?? 0} stmt`, "ok");
      await refresh();
      await checkForIssues(true);
    } catch (e: any) { push(e?.message ?? "extract failed", "err"); }
    finally { setRescanning(false); }
  };

  const dismissAlert = async (id: string) => {
    try { await db.alerts.dismiss(id); setAlerts((prev) => prev.filter((a) => a.id !== id)); }
    catch (e: any) { push(e?.message ?? "failed to dismiss", "err"); }
  };
  const resolveAlert = async (id: string) => {
    try { await db.alerts.resolve(id); setAlerts((prev) => prev.filter((a) => a.id !== id)); }
    catch (e: any) { push(e?.message ?? "failed to resolve", "err"); }
  };
  const alertEntityName = (a: any) => {
    if (a.entity_type === "subscription") return subs.find((s) => s.id === a.entity_id)?.name ?? "subscription";
    return loans.find((l) => l.id === a.entity_id)?.lender_name ?? "loan";
  };

  const staleBalance = accounts.some((a: any) => a.current_balance != null && (!a.current_balance_as_of || daysSince(a.current_balance_as_of) > 30));

  // period=undefined -> the original health-score "biggest lever" take;
  // period="day"|"week"|"month" -> a spend/income/merchant digest for that
  // window; period="brief" -> the Personalized Brief (portfolio, upcoming
  // obligations, budget status, health score — zero external market data,
  // entirely derived from the user's own rows per the Round 6 decision to
  // skip the Daily Market Brief this round). All share the same
  // jarvisChat() call path and aiTake display area.
  const getAiTake = async (period?: "day" | "week" | "month" | "brief") => {
    setAiLoading(true);
    setAiTake("");
    setAiPeriod(period ?? null);
    try {
      const { jarvisChat } = await import("@/lib/jarvisChat");
      const breakdown = health.components.map((c) => `${c.label} ${c.score}/${c.max} (${c.detail})`).join("; ");
      let prompt = `My financial health score is ${health.score}/100 — breakdown: ${breakdown}. Net worth ₹${Math.round(netWorth.netWorth)}.`;
      if (period === "brief") {
        const { gain, gainPct } = calcGainLoss(investments.totalValue, investments.totalInvested);
        const overBudget = budgets.filter((b) => b.spent > b.monthly_limit).map((b) => b.category).join(", ") || "none";
        const bills = upcomingBills.slice(0, 5).map((b: any) => `${b.label ?? b.name ?? "bill"} ${b.due_date ?? b.next_due_date ?? ""}`).join("; ") || "none";
        prompt += ` Investment portfolio: ₹${Math.round(investments.totalValue)} (${gainPct != null ? `${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%` : "no gain data"}, ${gain >= 0 ? "up" : "down"} ₹${Math.round(Math.abs(gain))}). Upcoming bills/EMIs: ${bills}. Budget categories over limit this month: ${overBudget}.`;
        prompt += " Write a short 'good morning' personal financial brief in 4-5 sentences: portfolio status, what needs attention (bills/budget), and one recommendation. No fluff, no external market commentary — only my own numbers.";
      } else if (period) {
        const summary = await db.transactions.periodSummary(period);
        const merchants = summary.topMerchants.map((m) => `${m.merchant} ₹${Math.round(m.amount)}`).join(", ") || "none";
        const categories = summary.topCategories.map((c) => `${c.category} ₹${Math.round(c.amount)}`).join(", ") || "none";
        prompt += ` This ${period}: spend ₹${Math.round(summary.spend)}, income ₹${Math.round(summary.income)}. Top merchants: ${merchants}. Top categories: ${categories}. Give a crisp ${period}ly financial summary in 3-4 sentences — what stands out, any advice. No fluff.`;
      } else {
        prompt += ` This month: income ₹${Math.round(state.income)}, spend ₹${Math.round(state.spend)}. In 2-3 sentences: what's the single biggest lever to improve this, and one thing that's already going well? No fluff.`;
      }
      setAiTake(await jarvisChat(prompt));
    } catch (e: any) { push(e?.message ?? "AI take failed", "err"); }
    finally { setAiLoading(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflowY: "auto" }}>
      <HudPanel title="Finance Overview" index="FIN" live="ok"
        actions={<Btn size="sm" onClick={rescan} disabled={rescanning}><RefreshCw size={11} style={{ marginRight: 4 }} />{rescanning ? "scanning…" : "re-scan email"}</Btn>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
          {cardTiles.map((c) => (
            <NavLink key={c.l} to={c.to} style={{ display: "block", padding: 14, border: "1px solid var(--edge)", textDecoration: "none", color: "inherit" }}>
              <div className="hud-label">{c.l}</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)", marginTop: 4 }}><KineticNumber value={c.v} /></div>
            </NavLink>
          ))}
        </div>
      </HudPanel>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1.3 1 360px" }}>
          <HudPanel title="Net Worth" index="NW" live="ok">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 30, color: netWorth.netWorth >= 0 ? "var(--accent-soft)" : "var(--danger)" }}>{inr(netWorth.netWorth)}</div>
              {staleBalance && <Chip tone="warn">stale balance</Chip>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
              <div><div className="hud-label">assets</div><div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--ok)" }}>{inr(netWorth.assets)}</div></div>
              <div><div className="hud-label">card debt</div><div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--warn)" }}>{inr(netWorth.cardDebt)}</div></div>
              <div><div className="hud-label">loan debt</div><div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--warn)" }}>{inr(netWorth.loanDebt)}</div></div>
              <div><div className="hud-label">tracked savings</div><div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--accent)" }}>{inr(netWorth.trackedSavings)}</div></div>
              <div><div className="hud-label">investments</div><div style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--ok)" }}>{inr(investments.totalValue)}</div></div>
            </div>
            <div className="hud-label" style={{ marginTop: 10 }}>assets &amp; card debt come from account balances (Accounts) and each card's latest statement — set a balance to track it</div>
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel title="Health Score" index="HS" live="ok"
            actions={
              <div style={{ display: "flex", gap: 4 }}>
                <Btn size="sm" onClick={() => getAiTake("brief")} disabled={aiLoading}>{aiLoading && aiPeriod === "brief" ? "…" : "brief"}</Btn>
                <Btn size="sm" onClick={() => getAiTake()} disabled={aiLoading}>{aiLoading && !aiPeriod ? "…" : "AI take"}</Btn>
                <Btn size="sm" onClick={() => getAiTake("day")} disabled={aiLoading}>{aiLoading && aiPeriod === "day" ? "…" : "day"}</Btn>
                <Btn size="sm" onClick={() => getAiTake("week")} disabled={aiLoading}>{aiLoading && aiPeriod === "week" ? "…" : "week"}</Btn>
                <Btn size="sm" onClick={() => getAiTake("month")} disabled={aiLoading}>{aiLoading && aiPeriod === "month" ? "…" : "month"}</Btn>
              </div>
            }>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 30, color: health.score >= 70 ? "var(--ok)" : health.score >= 40 ? "var(--warn)" : "var(--danger)" }}>
              {health.score}<span style={{ fontSize: 14, color: "var(--text-dim)" }}>/100</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {health.components.map((c) => (
                <div key={c.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: "var(--text-dim)", textTransform: "capitalize" }}>{c.label}</span>
                    <span style={{ color: "var(--text)" }}>{c.score}/{c.max}</span>
                  </div>
                  <ScoreBar pct={(c.score / c.max) * 100} />
                  <div className="hud-label" style={{ marginTop: 2 }}>{c.detail}</div>
                </div>
              ))}
            </div>
            {aiTake && <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--edge)", fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>{aiTake}</div>}
          </HudPanel>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <HudPanel title="This Month" index="MTD" live="ok">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
                <div className="hud-label">net</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: (state.income - state.spend) >= 0 ? "var(--accent-soft)" : "var(--danger)" }}>{inr(state.income - state.spend)}</div>
              </div>
              <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
                <div className="hud-label">income</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--ok)" }}>{inr(state.income)}</div>
              </div>
              <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
                <div className="hud-label">spend</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--warn)" }}>{inr(state.spend)}</div>
              </div>
            </div>
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <HudPanel title="Credit Utilization" index="UTL" live="ok">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: utilization.aggregatePct == null ? "var(--text-dim)" : "var(--accent)" }}>
              {utilization.aggregatePct == null ? "—" : `${utilization.aggregatePct}%`}
            </div>
            {utilization.perCard.length === 0 ? <div className="hud-label" style={{ marginTop: 8 }}>no cards yet</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
               {utilization.perCard.map((c) => (
                 <div key={c.cardId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                   <span style={{ color: "var(--text-dim)" }}>{c.cardName}</span>
                   <Chip tone={utilTone(c.utilizationPct)}>{c.utilizationPct == null ? "no data" : `${c.utilizationPct}%`}</Chip>
                 </div>
               ))}
             </div>}
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <HudPanel title="Budget Status" index="BDG" live={budgetsOverLimit ? "warn" : "ok"}>
            {budgets.length === 0 ? <NavLink to="/finance/budget" className="hud-label" style={{ textDecoration: "none" }}>set up budgets →</NavLink> :
             <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
               {budgets.slice(0, 4).map((b) => {
                 const pct = b.monthly_limit > 0 ? Math.min(100, (b.spent / b.monthly_limit) * 100) : 0;
                 return (
                   <div key={b.category}>
                     <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                       <span style={{ color: "var(--text-dim)", textTransform: "capitalize" }}>{b.category}</span>
                       <span style={{ color: b.spent > b.monthly_limit ? "var(--danger)" : "var(--text)" }}>{inr(b.spent)} / {inr(b.monthly_limit)}</span>
                     </div>
                     <ScoreBar pct={pct} />
                   </div>
                 );
               })}
             </div>}
          </HudPanel>
        </div>
        <div style={{ flex: "1.2 1 300px" }}>
          <HudPanel title="Needs Attention" index="ALT" live={alerts.length ? "warn" : "ok"}
            actions={<Btn size="sm" onClick={() => checkForIssues(false)} disabled={reconciling}>{reconciling ? "checking…" : "check for issues"}</Btn>}>
            {alerts.length === 0 ? <div className="hud-label">nothing open — you're on top of it</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
               {alerts.map((a) => (
                 <div key={a.id} style={{ padding: 8, border: "1px solid var(--edge)" }}>
                   <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                     <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                       <span style={{ fontSize: 13 }}>{alertEntityName(a)}</span>
                       <Chip tone={alertTone(a.type)}>{a.type === "amount_mismatch" ? "off-amount" : "missing"}</Chip>
                     </div>
                     <span className="hud-label">{new Date(a.expected_date).toLocaleDateString()}</span>
                   </div>
                   <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{a.message}</div>
                   <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                     <Btn size="sm" onClick={() => resolveAlert(a.id)}>resolve</Btn>
                     <Btn size="sm" onClick={() => dismissAlert(a.id)}>dismiss</Btn>
                   </div>
                 </div>
               ))}
             </div>}
          </HudPanel>
        </div>
      </div>

      {trend?.length > 1 && (
        <HudPanel title="Cash Flow Trend" index="CFT" live="ok">
          <HudLineChart data={trend.map((t: any) => ({ label: t.month, value: t.net }))} height={90} />
        </HudPanel>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel title="Spend by Category" index="CAT" live="ok">
            {categories.length === 0 ? <div className="hud-label">no categorized spend yet</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
               {categories.map((c) => (
                 <div key={c.category} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                   <span style={{ color: "var(--text-dim)", textTransform: "capitalize" }}>{c.category}</span>
                   <span style={{ color: "var(--text)", fontFamily: "var(--font-display)" }}>{inr(c.amount)}</span>
                 </div>
               ))}
             </div>}
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel
            title="Upcoming Bills (30d)"
            index="BIL"
            live={upcomingBills.length ? "warn" : "ok"}
            actions={upcomingBills.length ? <Chip tone="warn">{inr(upcomingBillsTotal)}</Chip> : undefined}
          >
            {upcomingBills.length === 0 ? <div className="hud-label">nothing due in the next 30 days</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
               {upcomingBills.slice(0, 8).map((b) => (
                 <NavLink key={b.id} to={b.to ?? "#"} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, padding: "4px 0", textDecoration: "none", color: "inherit", borderBottom: "1px dashed var(--edge)" }}>
                   <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                     <Chip tone={b.kind === "statement" ? "warn" : b.kind === "loan" ? "err" : "accent"}>{b.kind}</Chip>
                     <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.label}</span>
                   </span>
                   <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                     <span className="hud-label">{new Date(b.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                     <span style={{ color: "var(--warn)", fontFamily: "var(--font-display)" }}>{b.amount != null ? inr(b.amount) : "—"}</span>
                   </span>
                 </NavLink>
               ))}
             </div>}
          </HudPanel>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1.2 1 340px" }}>
          <HudPanel title="Cash Flow Trend (6mo)" index="CFT" live="ok">
            {trend.length === 0 ? <div className="hud-label">no transactions yet</div> : <TrendChart trend={trend} />}
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel title="Insights" index="INS" live={insights.some((i) => i.severity === "danger") ? "err" : insights.length ? "warn" : "ok"}>
            {insights.length === 0 ? <div className="hud-label">no signals — running clean</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
               {insights.map((i) => {
                 const tone: "err" | "warn" | "accent" = i.severity === "danger" ? "err" : i.severity === "warn" ? "warn" : "accent";
                 const body = (
                   <>
                     <Chip tone={tone}>{i.severity}</Chip>
                     <span style={{ color: "var(--text)" }}>{i.text}</span>
                   </>
                 );
                 return i.to ? (
                   <NavLink key={i.id} to={i.to} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "4px 0", textDecoration: "none", color: "inherit" }}>{body}</NavLink>
                 ) : (
                   <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "4px 0" }}>{body}</div>
                 );
               })}
             </div>}
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel title="Goal Projections" index="GPJ" live="ok">
            {goalProjections.length === 0 ? <div className="hud-label">no goals set</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
               {goalProjections.map((g) => (
                 <NavLink key={g.id} to="/finance/goals" style={{ padding: 8, border: "1px solid var(--edge)", textDecoration: "none", color: "inherit" }}>
                   <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                     <span style={{ fontSize: 13, color: "var(--text)" }}>{g.title}</span>
                     <Chip tone={g.status === "at-risk" ? "warn" : g.status === "no-data" ? "accent" : "ok"}>{g.status}</Chip>
                   </div>
                   <div className="hud-label" style={{ marginTop: 4 }}>
                     {inr(g.current)} / {inr(g.target)}
                     {g.monthsToReach != null && ` · ~${g.monthsToReach}mo to reach`}
                     {g.monthsLeft != null && ` · ${g.monthsLeft}mo left`}
                   </div>
                   <ScoreBar pct={g.target > 0 ? (g.current / g.target) * 100 : 0} />
                 </NavLink>
               ))}
             </div>}
          </HudPanel>
        </div>
      </div>
    </div>
  );
}

function TrendChart({ trend }: { trend: { month: string; spend: number; income: number; net: number }[] }) {
  const w = 320, h = 90, pad = 6;
  const maxV = Math.max(1, ...trend.map((t) => Math.max(t.spend, t.income)));
  const bw = (w - pad * 2) / trend.length;
  const y = (v: number) => h - pad - (v / maxV) * (h - pad * 2);
  const netLine = trend.map((t, i) => `${i === 0 ? "M" : "L"} ${pad + bw * (i + 0.5)} ${y(Math.max(0, t.net))}`).join(" ");
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
        {trend.map((t, i) => {
          const x = pad + bw * i + 2;
          const bwi = Math.max(4, bw - 6);
          return (
            <g key={t.month}>
              <rect x={x} y={y(t.income)} width={bwi / 2 - 1} height={Math.max(0, h - pad - y(t.income))} fill="var(--ok)" opacity={0.7} />
              <rect x={x + bwi / 2 + 1} y={y(t.spend)} width={bwi / 2 - 1} height={Math.max(0, h - pad - y(t.spend))} fill="var(--warn)" opacity={0.7} />
            </g>
          );
        })}
        <path d={netLine} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        {trend.map((t) => (
          <span key={t.month} className="hud-label" style={{ flex: 1, textAlign: "center" }}>{t.month.slice(5)}</span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11 }}>
        <span style={{ color: "var(--ok)" }}>■ income</span>
        <span style={{ color: "var(--warn)" }}>■ spend</span>
        <span style={{ color: "var(--accent)" }}>— net</span>
      </div>
    </div>
  );
}

