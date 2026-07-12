import { Fragment, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
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

function ConfigureCTA({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} style={{
      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
      textTransform: "uppercase", color: "var(--accent)", textDecoration: "none",
      padding: "4px 8px", border: "1px solid var(--edge)",
    }}>{label} →</NavLink>
  );
}

const TABS = [
  { to: "/finance", label: "Overview", key: "overview" },
  { to: "/finance/accounts", label: "Accounts", key: "accounts" },
  { to: "/finance/cards", label: "Cards", key: "cards" },
  { to: "/finance/loans", label: "Loans", key: "loans" },
  { to: "/finance/goals", label: "Goals", key: "goals" },
  { to: "/finance/subs", label: "Subs", key: "subs" },
  { to: "/finance/txns", label: "Transactions", key: "txns" },
  { to: "/finance/statements", label: "Statements", key: "statements" },
];

export default function Finance() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const active = t.to === "/finance" ? loc.pathname === "/finance" : loc.pathname.startsWith(t.to);
          return (
            <NavLink key={t.key} to={t.to} end={t.to === "/finance"}
              style={{
                padding: "6px 12px", border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
                textTransform: "uppercase", textDecoration: "none", borderRadius: 2,
              }}>{t.label}</NavLink>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {loc.pathname === "/finance" && <Overview />}
        {loc.pathname.startsWith("/finance/accounts") && <Accounts />}
        {loc.pathname.startsWith("/finance/cards") && <Cards />}
        {loc.pathname.startsWith("/finance/loans") && <Loans />}
        {loc.pathname.startsWith("/finance/goals") && <Goals />}
        {loc.pathname.startsWith("/finance/subs") && <Subs />}
        {loc.pathname.startsWith("/finance/txns") && <Txns />}
        {loc.pathname.startsWith("/finance/statements") && <Statements />}
      </div>
    </div>
  );
}

// ---------- Overview ----------
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}
function utilTone(pct: number | null): "neutral" | "ok" | "warn" | "err" {
  if (pct == null) return "neutral";
  if (pct < 30) return "ok";
  if (pct < 70) return "warn";
  return "err";
}
function alertTone(type: string): "warn" | "err" {
  return type === "amount_mismatch" ? "err" : "warn";
}
function ScoreBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 4 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
    </div>
  );
}

function Overview() {
  const push = useUi((s) => s.push);
  const {
    state, categories, dues, accounts, cards, loans, goals, subs,
    cardStatements, alerts, setAlerts, netWorth, utilization, health, refresh,
  } = useFinanceSnapshot();
  const [aiTake, setAiTake] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const cardTiles = [
    { l: "accounts", v: state.accounts, to: "/finance/accounts" },
    { l: "credit cards", v: state.cards, to: "/finance/cards" },
    { l: "loans", v: state.loans, to: "/finance/loans" },
    { l: "goals", v: state.goals, to: "/finance/goals" },
    { l: "subscriptions", v: state.subs, to: "/finance/subs" },
  ];

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
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract`;
      const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since_days: 90, limit: 500 }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? r.statusText);
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

  const getAiTake = async () => {
    setAiLoading(true);
    setAiTake("");
    try {
      const { jarvisChat } = await import("@/lib/jarvisChat");
      const breakdown = health.components.map((c) => `${c.label} ${c.score}/${c.max} (${c.detail})`).join("; ");
      const prompt = `My financial health score is ${health.score}/100 — breakdown: ${breakdown}. Net worth ₹${Math.round(netWorth.netWorth)}. This month: income ₹${Math.round(state.income)}, spend ₹${Math.round(state.spend)}. In 2-3 sentences: what's the single biggest lever to improve this, and one thing that's already going well? No fluff.`;
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
            </div>
            <div className="hud-label" style={{ marginTop: 10 }}>assets &amp; card debt come from account balances (Accounts) and each card's latest statement — set a balance to track it</div>
          </HudPanel>
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <HudPanel title="Health Score" index="HS" live="ok"
            actions={<Btn size="sm" onClick={getAiTake} disabled={aiLoading}>{aiLoading ? "thinking…" : "get AI take"}</Btn>}>
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
          <HudPanel title="Upcoming Dues" index="DUE" live="ok">
            {dues.length === 0 ? <div className="hud-label">no parsed statement dues yet</div> :
             <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
               {dues.map((s: any) => (
                 <div key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                   <span style={{ color: "var(--text-dim)" }}>{s.credit_cards?.card_name ?? s.financial_accounts?.nickname ?? "—"}</span>
                   <span style={{ color: "var(--warn)", fontFamily: "var(--font-display)" }}>{s.total_due != null ? inr(s.total_due) : "—"}</span>
                 </div>
               ))}
             </div>}
          </HudPanel>
        </div>
      </div>
    </div>
  );
}

// ---------- Accounts ----------
function Accounts() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [balanceTouched, setBalanceTouched] = useState(false);

  const load = async () => {
    const [a, b] = await Promise.all([db.accounts.list(), db.banks.list()]);
    setItems(a); setBanks(b);
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (a: any) => {
    if (openId === a.id) { setOpenId(null); return; }
    setOpenId(a.id);
    setEdit({
      nickname: a.nickname ?? "", account_type: a.account_type ?? "", masked_number: a.masked_number ?? "",
      bank_id: a.bank_id ?? "", notes: a.notes ?? "", source_email: a.source_email ?? "",
      statement_cycle_day: a.statement_cycle_day ?? "", current_balance: a.current_balance ?? "",
    });
    setBalanceTouched(false);
  };

  const save = async (id: string) => {
    if (!edit.nickname?.trim()) return;
    setSaving(true);
    try {
      const newBalance = edit.current_balance !== "" && edit.current_balance != null ? Number(edit.current_balance) : null;
      await db.accounts.update(id, {
        nickname: edit.nickname.trim(), account_type: edit.account_type || null,
        masked_number: edit.masked_number || null, bank_id: edit.bank_id || null,
        notes: edit.notes || null, source_email: edit.source_email || null,
        statement_cycle_day: edit.statement_cycle_day ? Number(edit.statement_cycle_day) : null,
        current_balance: newBalance,
        ...(balanceTouched ? { current_balance_as_of: newBalance != null ? new Date().toISOString().slice(0, 10) : null } : {}),
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this account?")) return;
    await db.accounts.remove(id);
    setOpenId(null);
    load();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Accounts" index="ACC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/accounts" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Accounts">no accounts yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((a) => (
             <div key={a.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(a)}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{a.nickname}</div>
                 {a.account_type && <Chip>{a.account_type}</Chip>}
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {a.banks?.name ?? "no bank"} {a.masked_number ? `· ${a.masked_number}` : ""}
                 {a.current_balance != null && <> · {inr(a.current_balance)}{a.current_balance_as_of ? ` as of ${new Date(a.current_balance_as_of).toLocaleDateString()}` : ""}</>}
               </div>
               {openId === a.id && (
                 <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>nickname</label><input value={edit.nickname} onChange={(e) => setEdit({ ...edit, nickname: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>type</label>
                       <HudSelect value={edit.account_type} onChange={(v) => setEdit({ ...edit, account_type: v })} placeholder="—" options={[
                         { value: "savings", label: "savings" }, { value: "current", label: "current" },
                         { value: "salary", label: "salary" }, { value: "wallet", label: "wallet" },
                         { value: "investment", label: "investment" },
                       ]} />
                     </div>
                     <div><label style={labelStyle}>bank</label>
                       <HudSelect value={edit.bank_id} onChange={(v) => setEdit({ ...edit, bank_id: v })} placeholder="—" options={banks.map((b: any) => ({ value: b.id, label: b.name }))} />
                     </div>
                     <div><label style={labelStyle}>last 4</label><input value={edit.masked_number} onChange={(e) => setEdit({ ...edit, masked_number: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>statement cycle day</label><input type="number" min={1} max={31} value={edit.statement_cycle_day} onChange={(e) => setEdit({ ...edit, statement_cycle_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>source email</label><input value={edit.source_email} onChange={(e) => setEdit({ ...edit, source_email: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div>
                       <label style={labelStyle}>current balance{a.current_balance_as_of ? ` (as of ${new Date(a.current_balance_as_of).toLocaleDateString()})` : ""}</label>
                       <input type="number" step="0.01" value={edit.current_balance} onChange={(e) => { setEdit({ ...edit, current_balance: e.target.value }); setBalanceTouched(true); }} style={{ ...inputStyle, width: "100%" }} />
                     </div>
                   </div>
                   <div>
                     <label style={labelStyle}>notes</label>
                     <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                   </div>
                   <div style={{ display: "flex", gap: 6 }}>
                     <Btn size="sm" variant="primary" disabled={saving || !edit.nickname?.trim()} onClick={() => save(a.id)}>{saving ? "saving…" : "save"}</Btn>
                     <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                     <Btn size="sm" variant="danger" onClick={() => remove(a.id)}>delete</Btn>
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

// ---------- Cards ----------
function Cards() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [cardStatements, setCardStatements] = useState<Map<string, any>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [payment, setPayment] = useState({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
  const [logging, setLogging] = useState(false);

  const load = async () => {
    const [c, b, a, latestByCard] = await Promise.all([db.cards.list(), db.banks.list(), db.accounts.list(), db.statements.latestByCard()]);
    setItems(c); setBanks(b); setAccounts(a); setCardStatements(latestByCard);
  };
  useEffect(() => { load(); }, []);
  const utilization = calcCreditUtilization(items.map((c: any) => ({
    cardId: c.id, cardName: c.card_name, limit: c.limit_amount, totalDue: cardStatements.get(c.id)?.total_due,
  })));
  const utilFor = (id: string) => utilization.perCard.find((u) => u.cardId === id)?.utilizationPct ?? null;

  const toggleOpen = (c: any) => {
    if (openId === c.id) { setOpenId(null); return; }
    setOpenId(c.id);
    setEdit({
      card_name: c.card_name ?? "", bank_id: c.bank_id ?? "", masked_number: c.masked_number ?? "",
      billing_day: c.billing_day ?? "", due_day: c.due_day ?? "", limit_amount: c.limit_amount ?? "",
      autopay: !!c.autopay, notes: c.notes ?? "",
    });
    setPayment({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
  };

  const save = async (id: string) => {
    if (!edit.card_name?.trim()) return;
    setSaving(true);
    try {
      await db.cards.update(id, {
        card_name: edit.card_name.trim(), bank_id: edit.bank_id || null, masked_number: edit.masked_number || null,
        billing_day: edit.billing_day ? Number(edit.billing_day) : null, due_day: edit.due_day ? Number(edit.due_day) : null,
        limit_amount: edit.limit_amount ? Number(edit.limit_amount) : null, autopay: !!edit.autopay, notes: edit.notes || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this card?")) return;
    await db.cards.remove(id);
    setOpenId(null);
    load();
  };

  const logPayment = async (card: any) => {
    if (!payment.account_id || !payment.amount) return;
    setLogging(true);
    try {
      await db.transactions.create({
        txn_date: payment.date, amount: Number(payment.amount), txn_type: "debit",
        merchant: `${card.card_name} bill payment`, category: "credit card payment",
        financial_account_id: payment.account_id, credit_card_id: card.id, source: "manual",
      });
      push("Payment logged", "ok");
      setPayment({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
    } catch (e: any) { push(e?.message ?? "failed to log payment", "err"); }
    finally { setLogging(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Credit Cards" index="CRD" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/cards" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Cards">no cards yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((c: any) => (
             <div key={c.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(c)}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{c.card_name}</div>
                 {c.banks?.name && <Chip>{c.banks.name}</Chip>}
                 {utilFor(c.id) != null && <Chip tone={utilTone(utilFor(c.id))}>{utilFor(c.id)}% used</Chip>}
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {c.masked_number ?? ""}{c.billing_day ? ` · bill ${c.billing_day}` : ""}{c.due_day ? ` · due ${c.due_day}` : ""}{c.limit_amount ? ` · limit ${inr(c.limit_amount)}` : ""}
               </div>
               {openId === c.id && (
                 <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                     <div><label style={labelStyle}>card name</label><input value={edit.card_name} onChange={(e) => setEdit({ ...edit, card_name: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>bank</label>
                       <HudSelect value={edit.bank_id} onChange={(v) => setEdit({ ...edit, bank_id: v })} placeholder="—" options={banks.map((b: any) => ({ value: b.id, label: b.name }))} />
                     </div>
                     <div><label style={labelStyle}>last 4</label><input value={edit.masked_number} onChange={(e) => setEdit({ ...edit, masked_number: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>limit</label><input type="number" value={edit.limit_amount} onChange={(e) => setEdit({ ...edit, limit_amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>bill day</label><input type="number" min={1} max={31} value={edit.billing_day} onChange={(e) => setEdit({ ...edit, billing_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     <div><label style={labelStyle}>due day</label><input type="number" min={1} max={31} value={edit.due_day} onChange={(e) => setEdit({ ...edit, due_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                   </div>
                   <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                     <input type="checkbox" checked={!!edit.autopay} onChange={(e) => setEdit({ ...edit, autopay: e.target.checked })} />
                     <label style={labelStyle}>autopay</label>
                   </div>
                   <div>
                     <label style={labelStyle}>notes</label>
                     <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                   </div>
                   <div style={{ display: "flex", gap: 6 }}>
                     <Btn size="sm" variant="primary" disabled={saving || !edit.card_name?.trim()} onClick={() => save(c.id)}>{saving ? "saving…" : "save"}</Btn>
                     <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                     <Btn size="sm" variant="danger" onClick={() => remove(c.id)}>delete</Btn>
                   </div>
                   <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
                     <div className="hud-label" style={{ marginBottom: 6 }}>log bill payment</div>
                     <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
                       <div style={{ minWidth: 160 }}>
                         <label style={labelStyle}>paid from</label>
                         <HudSelect value={payment.account_id} onChange={(v) => setPayment({ ...payment, account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
                       </div>
                       <div><label style={labelStyle}>amount</label><input type="number" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} style={{ ...inputStyle, width: 100 }} /></div>
                       <div><label style={labelStyle}>date</label><HudDatePicker value={payment.date} onChange={(v) => setPayment({ ...payment, date: v })} /></div>
                       <Btn size="sm" variant="primary" disabled={logging || !payment.account_id || !payment.amount} onClick={() => logPayment(c)}>{logging ? "logging…" : "log payment"}</Btn>
                     </div>
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

// ---------- Loans ----------
function Loans() {
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

// ---------- Goals ----------
function Goals() {
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

// ---------- Subscriptions ----------
function Subs() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [s, a, c, al] = await Promise.all([db.subscriptions.list(), db.accounts.list(), db.cards.list(), db.alerts.list({ status: "open" })]);
    setItems(s); setAccounts(a); setCards(c); setAlerts(al);
  };
  useEffect(() => { load(); }, []);
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

// ---------- Transactions ----------
function sourceTone(source: string | null | undefined): "neutral" | "ok" | "accent" | "warn" {
  if (source === "statement") return "ok";
  if (source === "email") return "accent";
  if (source === "manual") return "neutral";
  return "neutral";
}

function Txns() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [f, setF] = useState({ txn_date: new Date().toISOString().slice(0, 10), amount: "", txn_type: "debit" as Transaction["txn_type"], merchant: "", category: "", account_id: "", card_id: "" });
  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkStatementId, setLinkStatementId] = useState("");
  const [linking, setLinking] = useState(false);

  const load = async () => {
    const [t, a, c, s] = await Promise.all([db.transactions.list(200), db.accounts.list(), db.cards.list(), db.statements.list()]);
    setItems(t); setAccounts(a); setCards(c); setStatements(s);
  };
  useEffect(() => { load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.amount) return;
    const dupe = await db.transactions.findPossibleDuplicate({
      financial_account_id: f.account_id || null, credit_card_id: f.card_id || null,
      txn_date: f.txn_date, amount: Number(f.amount),
    });
    if (dupe && !confirm(`A transaction like this already exists (${dupe.merchant ?? "no merchant"}, source: ${dupe.source}) — save anyway?`)) return;
    await db.transactions.create({
      txn_date: f.txn_date, amount: Number(f.amount), txn_type: f.txn_type,
      merchant: f.merchant || undefined, category: f.category || undefined,
      financial_account_id: f.account_id || null, credit_card_id: f.card_id || null,
      source: "manual",
    });
    setF({ ...f, amount: "", merchant: "", category: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value as any });

  const toggleLink = (t: any) => {
    setLinkId(linkId === t.id ? null : t.id);
    setLinkStatementId("");
  };
  const doLink = async (t: any) => {
    if (!linkStatementId) return;
    setLinking(true);
    try {
      await db.transactions.update(t.id, { source_statement_id: linkStatementId, source: "statement" });
      push("Linked to statement", "ok");
      setLinkId(null);
      load();
    } catch (e: any) { push(e?.message ?? "link failed", "err"); }
    finally { setLinking(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Log Transaction" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>date</label><HudDatePicker value={f.txn_date} onChange={(v) => setF({ ...f, txn_date: v })} /></div>
          <div><label style={labelStyle}>amount</label><input type="number" step="0.01" value={f.amount} onChange={set("amount")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <HudSelect value={f.txn_type} onChange={(v) => setF({ ...f, txn_type: v as Transaction["txn_type"] })} options={[
              { value: "debit", label: "debit" }, { value: "credit", label: "credit" },
            ]} />
          </div>
          <div><label style={labelStyle}>merchant</label><input value={f.merchant} onChange={set("merchant")} placeholder="Amazon" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>category</label><input value={f.category} onChange={set("category")} placeholder="shopping" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>account</label>
            <HudSelect value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} placeholder="—" options={accounts.map((a) => ({ value: a.id, label: a.nickname }))} />
          </div>
          <div><label style={labelStyle}>card</label>
            <HudSelect value={f.card_id} onChange={(v) => setF({ ...f, card_id: v })} placeholder="—" options={cards.map((c) => ({ value: c.id, label: c.card_name }))} />
          </div>
          <Btn type="submit" variant="primary" disabled={!f.amount}>+ log</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Transactions" index="TXN" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState hint="log your first one above">no transactions</EmptyState> :
         <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
           <thead>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>date</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>merchant</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>category</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>account</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>source</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>amount</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }} />
             </tr>
           </thead>
           <tbody>
             {items.map((t: any) => (
               <Fragment key={t.id}>
                 <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{new Date(t.txn_date).toLocaleDateString()}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text)" }}>{t.merchant ?? "—"}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.category ?? "—"}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.financial_accounts?.nickname ?? t.credit_cards?.card_name ?? "—"}</td>
                   <td style={{ padding: "6px 8px" }}><Chip tone={sourceTone(t.source)}>{t.source ?? "manual"}</Chip></td>
                   <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "var(--font-display)", color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)" }}>
                     {t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}
                   </td>
                   <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                     {t.source === "manual" && !t.source_statement_id && (
                       <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", marginRight: 6 }} title="Link to statement" onClick={() => toggleLink(t)}>link</button>
                     )}
                     {t.source === "manual" && (
                       <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.transactions.remove(t.id); load(); } }}><Trash2 size={11} /></button>
                     )}
                   </td>
                 </tr>
                 {linkId === t.id && (
                   <tr>
                     <td colSpan={7} style={{ padding: "8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                       <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
                         <div style={{ minWidth: 220 }}>
                           <label style={labelStyle}>link to statement</label>
                           <HudSelect value={linkStatementId} onChange={setLinkStatementId} placeholder="—" options={statements.map((s: any) => ({
                             value: s.id,
                             label: `${s.credit_cards?.card_name ?? s.financial_accounts?.nickname ?? "—"} · ${s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "no date"}`,
                           }))} />
                         </div>
                         <Btn size="sm" variant="primary" disabled={linking || !linkStatementId} onClick={() => doLink(t)}>{linking ? "linking…" : "link"}</Btn>
                         <Btn size="sm" onClick={() => setLinkId(null)}>cancel</Btn>
                       </div>
                     </td>
                   </tr>
                 )}
               </Fragment>
             ))}
           </tbody>
         </table>}
      </HudPanel>
    </div>
  );
}

// ---------- Statements ----------
function statusTone(status: string | null | undefined): "neutral" | "ok" | "warn" | "err" {
  if (status === "parsed") return "ok";
  if (status === "failed") return "err";
  if (status === "pending") return "warn";
  return "neutral";
}

function Statements() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const [cards, setCards] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [retryLinkId, setRetryLinkId] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loans, setLoans] = useState<any[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadType, setUploadType] = useState<"card" | "account" | "loan">("card");
  const [uploadEntityId, setUploadEntityId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setItems(await db.statements.list()); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    db.cards.list().then(setCards).catch(() => {});
    db.accounts.list().then(setAccounts).catch(() => {});
    db.loans.list().then(setLoans).catch(() => {});
  }, []);

  const toggleOpen = async (s: any) => {
    if (openId === s.id) { setOpenId(null); return; }
    setOpenId(s.id);
    setRetryLinkId("");
    setTxnsLoading(true);
    try { setTxns(await db.statements.transactions(s.id)); }
    catch (e: any) { push(e?.message ?? "failed to load transactions", "err"); }
    finally { setTxnsLoading(false); }
  };

  const viewPdf = async (s: any) => {
    try {
      const url = await db.statements.signedPdfUrl(s.id);
      window.open(url, "_blank");
    } catch (e: any) { push(e?.message ?? "failed to open PDF", "err"); }
  };

  // For statements that never auto-resolved a card/account (so never had a
  // password to decrypt with) or that failed to parse — let the user
  // manually pick the right card/account and retry.
  const retryStatement = async (s: any) => {
    setRetrying(true);
    try {
      const linkOverride = retryLinkId
        ? cards.some((c) => c.id === retryLinkId)
          ? { credit_card_id: retryLinkId, financial_account_id: null }
          : { credit_card_id: null, financial_account_id: retryLinkId }
        : undefined;
      await db.statements.retry(s.id, linkOverride);
      push("Retry queued", "ok");
      setRetryLinkId("");
      await load();
      setTxns(await db.statements.transactions(s.id));
    } catch (e: any) { push(e?.message ?? "retry failed", "err"); }
    finally { setRetrying(false); }
  };

  // For banks that never email a statement — upload the PDF directly.
  const doUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const bytesBase64 = await fileToBase64(uploadFile);
      await db.statements.upload({
        statement_type: uploadType,
        credit_card_id: uploadType === "card" ? uploadEntityId : null,
        financial_account_id: uploadType === "account" ? uploadEntityId : null,
        loan_id: uploadType === "loan" ? uploadEntityId : null,
        filename: uploadFile.name, bytesBase64, password: uploadPassword || undefined,
      });
      push("Statement uploaded", "ok");
      setShowUpload(false); setUploadEntityId(""); setUploadFile(null); setUploadPassword("");
      load();
    } catch (e: any) { push(e?.message ?? "upload failed", "err"); }
    finally { setUploading(false); }
  };
  const entityOptions = uploadType === "card" ? cards.map((c: any) => ({ value: c.id, label: c.card_name }))
    : uploadType === "account" ? accounts.map((a: any) => ({ value: a.id, label: a.nickname }))
    : loans.map((l: any) => ({ value: l.id, label: l.lender_name }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Statements" index="STM" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<Btn size="sm" onClick={() => setShowUpload((v) => !v)}>+ upload statement</Btn>}>
        {showUpload && (
          <div style={{ padding: 10, border: "1px dashed var(--edge)", marginBottom: 10, display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <label style={labelStyle}>type</label>
              <HudSelect value={uploadType} onChange={(v) => { setUploadType(v as any); setUploadEntityId(""); }} options={[
                { value: "card", label: "card" }, { value: "account", label: "account" }, { value: "loan", label: "loan" },
              ]} />
            </div>
            <div style={{ minWidth: 160 }}>
              <label style={labelStyle}>which one</label>
              <HudSelect value={uploadEntityId} onChange={setUploadEntityId} placeholder="—" options={entityOptions} />
            </div>
            <div>
              <label style={labelStyle}>PDF file</label>
              <input type="file" accept="application/pdf" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle }} />
            </div>
            <div>
              <label style={labelStyle}>password (if any)</label>
              <input type="password" value={uploadPassword} onChange={(e) => setUploadPassword(e.target.value)} style={{ ...inputStyle, width: 140 }} />
            </div>
            <Btn size="sm" variant="primary" disabled={uploading || !uploadFile || !uploadEntityId} onClick={doUpload}>{uploading ? "uploading…" : "upload"}</Btn>
          </div>
        )}
        {loading ? <div className="hud-label">loading…</div> :
         items.length === 0 ? <EmptyState hint="statements auto-appear when banking mail with statement subjects is synced">no statements yet</EmptyState> :
         <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
           <thead>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>date</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>type</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>linked</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>period</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>status</th>
             </tr>
           </thead>
           <tbody>
             {items.map((s: any) => (
               <Fragment key={s.id}>
                 <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)", cursor: "pointer" }} onClick={() => toggleOpen(s)}>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "—"}</td>
                   <td style={{ padding: "6px 8px" }}><Chip>{s.statement_type}</Chip></td>
                   <td style={{ padding: "6px 8px", color: "var(--text)" }}>{s.credit_cards?.card_name ?? s.financial_accounts?.nickname ?? s.loans?.lender_name ?? "—"}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{s.period_start && s.period_end ? `${s.period_start} → ${s.period_end}` : "—"}</td>
                   <td style={{ padding: "6px 8px" }}><Chip tone={statusTone(s.parse_status)}>{s.parse_status ?? "manual"}</Chip></td>
                 </tr>
                 {openId === s.id && (
                   <tr>
                     <td colSpan={5} style={{ padding: "10px 8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                       <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)" }}>
                         <div><span className="hud-label">total due</span><br />{s.total_due != null ? inr(s.total_due) : "—"}</div>
                         <div><span className="hud-label">closing balance</span><br />{s.closing_balance != null ? inr(s.closing_balance) : "—"}</div>
                         <div><span className="hud-label">statement date</span><br />{s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "—"}</div>
                         <div><span className="hud-label">due date</span><br />{s.due_date ? new Date(s.due_date).toLocaleDateString() : "—"}</div>
                         {s.file_path && <Btn size="sm" onClick={() => viewPdf(s)}>view PDF →</Btn>}
                       </div>
                       {(s.parse_status === "failed" || (!s.credit_card_id && !s.financial_account_id)) && (
                         <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "end" }}>
                           <div style={{ minWidth: 200 }}>
                             <label style={labelStyle}>link to card/account and retry</label>
                             <HudSelect value={retryLinkId} onChange={setRetryLinkId} placeholder="—" options={[
                               ...cards.map((c: any) => ({ value: c.id, label: `${c.card_name} (card)` })),
                               ...accounts.map((a: any) => ({ value: a.id, label: `${a.nickname} (account)` })),
                             ]} />
                           </div>
                           <Btn size="sm" variant="primary" disabled={retrying} onClick={() => retryStatement(s)}>{retrying ? "retrying…" : "retry"}</Btn>
                         </div>
                       )}
                       <div style={{ marginTop: 10 }}>
                         <span className="hud-label">transactions from this statement</span>
                         {txnsLoading ? <div className="hud-label" style={{ marginTop: 6 }}>loading…</div> :
                          txns.length === 0 ? <div className="hud-label" style={{ marginTop: 6 }}>none extracted</div> :
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                            {txns.map((t: any) => (
                              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                <span style={{ color: "var(--text)" }}>{new Date(t.txn_date).toLocaleDateString()} · {t.merchant ?? "—"}</span>
                                <span style={{ color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)" }}>{t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}</span>
                              </div>
                            ))}
                          </div>}
                       </div>
                     </td>
                   </tr>
                 )}
               </Fragment>
             ))}
           </tbody>
         </table>}
      </HudPanel>
    </div>
  );
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
