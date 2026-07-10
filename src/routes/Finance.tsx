import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, inr, type Bank, type FinancialAccount, type CreditCard, type Loan, type FinancialGoal, type Subscription, type Transaction } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Trash2 } from "lucide-react";

const TABS = [
  { to: "/finance", label: "Overview", key: "overview" },
  { to: "/finance/accounts", label: "Accounts", key: "accounts" },
  { to: "/finance/cards", label: "Cards", key: "cards" },
  { to: "/finance/loans", label: "Loans", key: "loans" },
  { to: "/finance/goals", label: "Goals", key: "goals" },
  { to: "/finance/subs", label: "Subs", key: "subs" },
  { to: "/finance/txns", label: "Transactions", key: "txns" },
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
      </div>
    </div>
  );
}

// ---------- Overview ----------
function Overview() {
  const [state, setState] = useState({ accounts: 0, cards: 0, loans: 0, goals: 0, subs: 0, spend: 0, income: 0 });
  useEffect(() => {
    (async () => {
      const [a, c, l, g, s, m] = await Promise.all([
        db.accounts.list(), db.cards.list(), db.loans.list(), db.goals.list(), db.subscriptions.list(), db.transactions.monthSummary(),
      ]);
      setState({ accounts: a.length, cards: c.length, loans: l.length, goals: g.length, subs: s.length, spend: m.spend, income: m.income });
    })();
  }, []);
  const cards = [
    { l: "accounts", v: state.accounts, to: "/finance/accounts" },
    { l: "credit cards", v: state.cards, to: "/finance/cards" },
    { l: "loans", v: state.loans, to: "/finance/loans" },
    { l: "goals", v: state.goals, to: "/finance/goals" },
    { l: "subscriptions", v: state.subs, to: "/finance/subs" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Finance Overview" index="FIN" live="ok" bodyClass="overflow-auto">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
          {cards.map((c) => (
            <NavLink key={c.l} to={c.to} style={{ display: "block", padding: 14, border: "1px solid var(--edge)", textDecoration: "none", color: "inherit" }}>
              <div className="hud-label">{c.l}</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)", marginTop: 4 }}><KineticNumber value={c.v} /></div>
            </NavLink>
          ))}
        </div>
      </HudPanel>
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
  );
}

// ---------- Accounts ----------
function Accounts() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [nick, setNick] = useState(""); const [type, setType] = useState(""); const [mask, setMask] = useState("");
  const [bankId, setBankId] = useState<string>(""); const [newBank, setNewBank] = useState("");
  const push = useUi((s) => s.push);
  const load = async () => { setBanks(await db.banks.list()); setItems(await db.accounts.list()); };
  useEffect(() => { load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nick.trim()) return;
    try {
      let bId: string | null = bankId || null;
      if (newBank.trim()) { const b = await db.banks.create(newBank.trim()); bId = b.id; setNewBank(""); }
      await db.accounts.create({ nickname: nick.trim(), account_type: type || undefined, masked_number: mask || undefined, bank_id: bId });
      setNick(""); setType(""); setMask(""); setBankId("");
      load();
    } catch (err: any) { push(err?.message, "err"); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Account" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>nickname</label><input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="e.g. HDFC Salary" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
              <option value="">—</option><option value="savings">savings</option><option value="current">current</option><option value="salary">salary</option><option value="wallet">wallet</option><option value="investment">investment</option>
            </select>
          </div>
          <div><label style={labelStyle}>last 4</label><input value={mask} onChange={(e) => setMask(e.target.value)} placeholder="****1234" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bank</label>
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} style={inputStyle}>
              <option value="">—</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>or new bank</label><input value={newBank} onChange={(e) => setNewBank(e.target.value)} placeholder="e.g. HDFC Bank" style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!nick.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Accounts" index="ACC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no accounts yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((a) => (
             <div key={a.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{a.nickname}</div>
                 {a.account_type && <Chip>{a.account_type}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.accounts.remove(a.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {a.banks?.name ?? "no bank"} {a.masked_number ? `· ${a.masked_number}` : ""}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

// ---------- Cards ----------
function Cards() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState(""); const [mask, setMask] = useState(""); const [bill, setBill] = useState(""); const [due, setDue] = useState(""); const [limit, setLimit] = useState(""); const [bankId, setBankId] = useState("");
  const load = async () => { setBanks(await db.banks.list()); setItems(await db.cards.list()); };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await db.cards.create({
      card_name: name.trim(), masked_number: mask || undefined,
      billing_day: bill ? Number(bill) : null, due_day: due ? Number(due) : null,
      limit_amount: limit ? Number(limit) : null, bank_id: bankId || null,
    });
    setName(""); setMask(""); setBill(""); setDue(""); setLimit(""); setBankId("");
    load();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Card" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>card name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="HDFC Millennia" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>last 4</label><input value={mask} onChange={(e) => setMask(e.target.value)} placeholder="****4421" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bill day</label><input type="number" min={1} max={31} value={bill} onChange={(e) => setBill(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>due day</label><input type="number" min={1} max={31} value={due} onChange={(e) => setDue(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>limit</label><input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>bank</label>
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} style={inputStyle}>
              <option value="">—</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <Btn type="submit" variant="primary" disabled={!name.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Credit Cards" index="CRD" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no cards yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((c: any) => (
             <div key={c.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{c.card_name}</div>
                 {c.banks?.name && <Chip>{c.banks.name}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.cards.remove(c.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {c.masked_number ?? ""}{c.billing_day ? ` · bill ${c.billing_day}` : ""}{c.due_day ? ` · due ${c.due_day}` : ""}{c.limit_amount ? ` · limit ${inr(c.limit_amount)}` : ""}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

// ---------- Loans ----------
function Loans() {
  const [items, setItems] = useState<Loan[]>([]);
  const [f, setF] = useState({ lender_name: "", loan_type: "", principal: "", rate: "", emi: "", tenure: "", start: "", outstanding: "", due: "" });
  const load = async () => setItems(await db.loans.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.lender_name.trim()) return;
    await db.loans.create({
      lender_name: f.lender_name.trim(), loan_type: f.loan_type || undefined,
      principal_amount: f.principal ? Number(f.principal) : undefined,
      interest_rate: f.rate ? Number(f.rate) : undefined,
      emi_amount: f.emi ? Number(f.emi) : undefined,
      tenure_months: f.tenure ? Number(f.tenure) : undefined,
      start_date: f.start || undefined,
      outstanding_amount: f.outstanding ? Number(f.outstanding) : undefined,
      next_due_date: f.due || undefined,
    });
    setF({ lender_name: "", loan_type: "", principal: "", rate: "", emi: "", tenure: "", start: "", outstanding: "", due: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Loan" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr) auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>lender</label><input value={f.lender_name} onChange={set("lender_name")} placeholder="HDFC" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <select value={f.loan_type} onChange={set("loan_type")} style={inputStyle}>
              <option value="">—</option><option value="home">home</option><option value="personal">personal</option><option value="car">car</option><option value="device">device</option><option value="education">education</option>
            </select>
          </div>
          <div><label style={labelStyle}>principal</label><input type="number" value={f.principal} onChange={set("principal")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>rate %</label><input type="number" step="0.01" value={f.rate} onChange={set("rate")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>EMI</label><input type="number" value={f.emi} onChange={set("emi")} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.lender_name.trim()}>+ add</Btn>
          <div><label style={labelStyle}>tenure (mo)</label><input type="number" value={f.tenure} onChange={set("tenure")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>start</label><input type="date" value={f.start} onChange={set("start")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>outstanding</label><input type="number" value={f.outstanding} onChange={set("outstanding")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>next due</label><input type="date" value={f.due} onChange={set("due")} style={{ ...inputStyle, width: "100%" }} /></div>
        </form>
      </HudPanel>
      <HudPanel title="Loans" index="LN" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no loans</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((l) => (
             <div key={l.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{l.lender_name}</div>
                 {l.loan_type && <Chip>{l.loan_type}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.loans.remove(l.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.6 }}>
                 EMI {inr(l.emi_amount ?? 0)} @ {l.interest_rate ?? "—"}%<br />
                 outstanding {inr(l.outstanding_amount ?? 0)}<br />
                 {l.next_due_date && `next due ${new Date(l.next_due_date).toLocaleDateString()}`}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

// ---------- Goals ----------
function Goals() {
  const [items, setItems] = useState<FinancialGoal[]>([]);
  const [f, setF] = useState({ title: "", type: "", target: "", date: "", current: "" });
  const load = async () => setItems(await db.goals.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    await db.goals.create({
      title: f.title.trim(), goal_type: f.type || undefined,
      target_amount: f.target ? Number(f.target) : undefined,
      target_date: f.date || undefined,
      current_amount: f.current ? Number(f.current) : 0,
    });
    setF({ title: "", type: "", target: "", date: "", current: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Goal" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>title</label><input value={f.title} onChange={set("title")} placeholder="Emergency fund" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <select value={f.type} onChange={set("type")} style={inputStyle}>
              <option value="">—</option><option value="savings">savings</option><option value="investment">investment</option><option value="purchase">purchase</option><option value="prepayment">prepayment</option><option value="travel">travel</option>
            </select>
          </div>
          <div><label style={labelStyle}>target</label><input type="number" value={f.target} onChange={set("target")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>by</label><input type="date" value={f.date} onChange={set("date")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>current</label><input type="number" value={f.current} onChange={set("current")} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.title.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Goals" index="GL" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no goals</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((g) => {
             const pct = g.target_amount ? Math.min(100, Math.round((Number(g.current_amount) / Number(g.target_amount)) * 100)) : 0;
             return (
               <div key={g.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{g.title}</div>
                   {g.goal_type && <Chip>{g.goal_type}</Chip>}
                   <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.goals.remove(g.id); load(); } }}><Trash2 size={13} /></button>
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{inr(g.current_amount ?? 0)} of {inr(g.target_amount ?? 0)}{g.target_date && ` · by ${new Date(g.target_date).toLocaleDateString()}`}</div>
                 <div style={{ height: 4, background: "rgba(53,214,237,0.1)", marginTop: 8 }}>
                   <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
                 </div>
                 <div className="hud-label" style={{ marginTop: 4, color: "var(--accent)" }}>{pct}%</div>
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
  const [items, setItems] = useState<Subscription[]>([]);
  const [f, setF] = useState({ name: "", category: "", amount: "", cycle: "monthly", due: "" });
  const load = async () => setItems(await db.subscriptions.list());
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    await db.subscriptions.create({
      name: f.name.trim(), category: f.category || undefined,
      amount: f.amount ? Number(f.amount) : undefined,
      billing_cycle: f.cycle || undefined,
      next_due_date: f.due || undefined,
    });
    setF({ name: "", category: "", amount: "", cycle: "monthly", due: "" });
    load();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Subscription" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>name</label><input value={f.name} onChange={set("name")} placeholder="Netflix" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>category</label><input value={f.category} onChange={set("category")} placeholder="OTT" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>amount</label><input type="number" value={f.amount} onChange={set("amount")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>cycle</label>
            <select value={f.cycle} onChange={set("cycle")} style={inputStyle}>
              <option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="yearly">yearly</option><option value="weekly">weekly</option>
            </select>
          </div>
          <div><label style={labelStyle}>next due</label><input type="date" value={f.due} onChange={set("due")} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.name.trim()}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Subscriptions" index="SUB" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {items.length === 0 ? <EmptyState>no subscriptions</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
           {items.map((s) => (
             <div key={s.id} style={{ padding: 12, border: "1px solid var(--edge)" }}>
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{s.name}</div>
                 {s.category && <Chip>{s.category}</Chip>}
                 <button style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.subscriptions.remove(s.id); load(); } }}><Trash2 size={13} /></button>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {inr(s.amount ?? 0)} / {s.billing_cycle ?? "—"}
                 {s.next_due_date && ` · next ${new Date(s.next_due_date).toLocaleDateString()}`}
               </div>
             </div>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}

// ---------- Transactions ----------
function Txns() {
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [f, setF] = useState({ txn_date: new Date().toISOString().slice(0, 10), amount: "", txn_type: "debit" as Transaction["txn_type"], merchant: "", category: "", account_id: "", card_id: "" });
  const load = async () => {
    const [t, a, c] = await Promise.all([db.transactions.list(200), db.accounts.list(), db.cards.list()]);
    setItems(t); setAccounts(a); setCards(c);
  };
  useEffect(() => { load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.amount) return;
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Log Transaction" index="+" live="ok" style={{ flexShrink: 0 }}>
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>date</label><input type="date" value={f.txn_date} onChange={set("txn_date")} style={inputStyle} /></div>
          <div><label style={labelStyle}>amount</label><input type="number" step="0.01" value={f.amount} onChange={set("amount")} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <select value={f.txn_type} onChange={set("txn_type")} style={inputStyle}><option value="debit">debit</option><option value="credit">credit</option></select>
          </div>
          <div><label style={labelStyle}>merchant</label><input value={f.merchant} onChange={set("merchant")} placeholder="Amazon" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>category</label><input value={f.category} onChange={set("category")} placeholder="shopping" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>account</label>
            <select value={f.account_id} onChange={set("account_id")} style={inputStyle}>
              <option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>card</label>
            <select value={f.card_id} onChange={set("card_id")} style={inputStyle}>
              <option value="">—</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.card_name}</option>)}
            </select>
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
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>amount</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }} />
             </tr>
           </thead>
           <tbody>
             {items.map((t: any) => (
               <tr key={t.id} style={{ borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                 <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{new Date(t.txn_date).toLocaleDateString()}</td>
                 <td style={{ padding: "6px 8px", color: "var(--text)" }}>{t.merchant ?? "—"}</td>
                 <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.category ?? "—"}</td>
                 <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.financial_accounts?.nickname ?? t.credit_cards?.card_name ?? "—"}</td>
                 <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "var(--font-display)", color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)" }}>
                   {t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}
                 </td>
                 <td style={{ padding: "6px 8px" }}>
                   <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={async () => { if (confirm("Delete?")) { await db.transactions.remove(t.id); load(); } }}><Trash2 size={11} /></button>
                 </td>
               </tr>
             ))}
           </tbody>
         </table>}
      </HudPanel>
    </div>
  );
}
