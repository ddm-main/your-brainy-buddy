import { Fragment, useEffect, useMemo, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr, type FinancialAccount, type CreditCard, type Transaction } from "@/lib/db";
import { runReconciliation } from "@/lib/reconciliation";
import { useUi } from "@/store/uiStore";
import { Trash2, Check, Pencil, X } from "lucide-react";
import { sourceTone } from "./_shared";
import { toCsv, downloadCsv } from "@/lib/csv";
import { learnFromCorrection } from "@/lib/categorize";
import { useSession } from "@/lib/useSession";

const SUSPICIOUS_AMOUNT = 50000; // rupees — flag any single txn over this

// ---------- Transactions ----------
export default function Txns() {
  const push = useUi((s) => s.push);
  const { session } = useSession();
  const uid = session?.user.id;
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const [f, setF] = useState({ txn_date: new Date().toISOString().slice(0, 10), amount: "", txn_type: "debit" as Transaction["txn_type"], merchant: "", category: "", account_id: "", card_id: "" });
  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkStatementId, setLinkStatementId] = useState("");
  const [linking, setLinking] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ merchant: string; category: string }>({ merchant: "", category: "" });
  // filters
  const [ff, setFF] = useState({ q: "", type: "", source: "", account: "", from: "", to: "", unreconciled: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCat, setBulkCat] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    const [t, a, c, s, al] = await Promise.all([
      db.transactions.list(500), db.accounts.list(), db.cards.list(), db.statements.list(),
      db.alerts.list({ status: "open" }),
    ]);
    setItems(t); setAccounts(a); setCards(c); setStatements(s); setAlerts(al);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = ff.q.trim().toLowerCase();
    return items.filter((t: any) => {
      if (q && !(t.merchant ?? "").toLowerCase().includes(q) && !(t.category ?? "").toLowerCase().includes(q) && !(t.description ?? "").toLowerCase().includes(q)) return false;
      if (ff.type && t.txn_type !== ff.type) return false;
      if (ff.source && (t.source ?? "manual") !== ff.source) return false;
      if (ff.account) {
        const acc = t.financial_account_id ?? t.credit_card_id;
        if (acc !== ff.account) return false;
      }
      if (ff.from && t.txn_date < ff.from) return false;
      if (ff.to && t.txn_date > ff.to) return false;
      if (ff.unreconciled && t.is_reconciled) return false;
      return true;
    });
  }, [items, ff]);

  const totals = useMemo(() => {
    let spend = 0, income = 0, unrec = 0;
    for (const t of filtered) {
      const amt = Number(t.amount) || 0;
      if (t.txn_type === "debit") spend += amt; else income += amt;
      if (!t.is_reconciled && t.txn_type === "debit") unrec++;
    }
    return { spend, income, unrec, count: filtered.length };
  }, [filtered]);

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

  const startEdit = (t: any) => {
    setEditId(t.id);
    setEditForm({ merchant: t.merchant ?? "", category: t.category ?? "" });
  };
  const saveEdit = async (t: any) => {
    try {
      const catChanged = (editForm.category || null) !== (t.category ?? null);
      await db.transactions.update(t.id, { merchant: editForm.merchant || null, category: editForm.category || null } as any);
      if (catChanged && editForm.category && uid) {
        learnFromCorrection({ merchant: editForm.merchant || t.merchant, description: t.description }, editForm.category, uid)
          .catch(() => { /* non-blocking */ });
      }
      push("saved", "ok");
      setEditId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
  };
  const exportCsv = () => {
    const rows = filtered.map((t: any) => ({
      date: t.txn_date,
      merchant: t.merchant ?? "",
      category: t.category ?? "",
      amount: t.amount,
      type: t.txn_type,
      source: t.source ?? "manual",
      account: t.financial_accounts?.nickname ?? t.credit_cards?.card_name ?? "",
      reconciled: t.is_reconciled ? "yes" : "no",
    }));
    downloadCsv(`txns-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  };
  const toggleReconciled = async (t: any) => {
    try {
      await db.transactions.update(t.id, { is_reconciled: !t.is_reconciled } as any);
      load();
    } catch (e: any) { push(e?.message ?? "update failed", "err"); }
  };
  const runRecon = async () => {
    setReconciling(true);
    try {
      const r = await runReconciliation();
      push(`recon: ${r.matched} matched · ${r.mismatched} mismatched · ${r.missing} missing`, "ok");
      load();
    } catch (e: any) { push(e?.message ?? "recon failed", "err"); }
    finally { setReconciling(false); }
  };

  const toggleSel = (id: string) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAllSel = () => setSelected((prev) => {
    if (prev.size === filtered.length) return new Set();
    return new Set(filtered.map((t: any) => t.id));
  });
  const bulkCategorize = async () => {
    if (!bulkCat.trim() || selected.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selected];
      await Promise.all(ids.map((id) => db.transactions.update(id, { category: bulkCat.trim() } as any)));
      if (uid) {
        // create/bump one merchant rule per unique merchant in selection
        const touched = items.filter((t: any) => selected.has(t.id));
        const uniqueMerchants = new Map<string, any>();
        for (const t of touched) {
          const key = (t.merchant ?? t.description ?? "").toLowerCase().trim();
          if (key && !uniqueMerchants.has(key)) uniqueMerchants.set(key, t);
        }
        await Promise.all([...uniqueMerchants.values()].map((t) =>
          learnFromCorrection({ merchant: t.merchant, description: t.description }, bulkCat.trim(), uid).catch(() => {}),
        ));
      }
      push(`categorized ${ids.length} txns`, "ok");
      setSelected(new Set());
      setBulkCat("");
      load();
    } catch (e: any) { push(e?.message ?? "bulk failed", "err"); }
    finally { setBulkBusy(false); }
  };
  const bulkDelete = async () => {
    if (selected.size === 0 || !confirm(`Delete ${selected.size} txns?`)) return;
    setBulkBusy(true);
    try {
      await Promise.all([...selected].map((id) => db.transactions.remove(id)));
      push(`deleted ${selected.size}`, "ok");
      setSelected(new Set()); load();
    } catch (e: any) { push(e?.message ?? "bulk delete failed", "err"); }
    finally { setBulkBusy(false); }
  };
  const bulkReconcile = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all([...selected].map((id) => db.transactions.update(id, { is_reconciled: true } as any)));
      push(`marked ${selected.size} reconciled`, "ok");
      setSelected(new Set()); load();
    } catch (e: any) { push(e?.message ?? "bulk reconcile failed", "err"); }
    finally { setBulkBusy(false); }
  };

  const accountOptions = [
    ...accounts.map((a) => ({ value: a.id, label: `A: ${a.nickname}` })),
    ...cards.map((c) => ({ value: c.id, label: `C: ${c.card_name}` })),
  ];

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
      <HudPanel title="Filters" index="F" live="ok" style={{ flexShrink: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1.5fr 1fr 1fr auto auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>search</label><input value={ff.q} onChange={(e) => setFF({ ...ff, q: e.target.value })} placeholder="merchant / category" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>type</label>
            <HudSelect value={ff.type} onChange={(v) => setFF({ ...ff, type: v })} placeholder="all" options={[{ value: "debit", label: "debit" }, { value: "credit", label: "credit" }]} />
          </div>
          <div><label style={labelStyle}>source</label>
            <HudSelect value={ff.source} onChange={(v) => setFF({ ...ff, source: v })} placeholder="all" options={[
              { value: "manual", label: "manual" }, { value: "statement", label: "statement" }, { value: "email", label: "email" }, { value: "sms", label: "sms" },
            ]} />
          </div>
          <div><label style={labelStyle}>account/card</label>
            <HudSelect value={ff.account} onChange={(v) => setFF({ ...ff, account: v })} placeholder="all" options={accountOptions} />
          </div>
          <div><label style={labelStyle}>from</label><HudDatePicker value={ff.from} onChange={(v) => setFF({ ...ff, from: v })} /></div>
          <div><label style={labelStyle}>to</label><HudDatePicker value={ff.to} onChange={(v) => setFF({ ...ff, to: v })} /></div>
          <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
            <input type="checkbox" checked={ff.unreconciled} onChange={(e) => setFF({ ...ff, unreconciled: e.target.checked })} /> unreconciled only
          </label>
          <Btn size="sm" onClick={() => setFF({ q: "", type: "", source: "", account: "", from: "", to: "", unreconciled: false })}>clear</Btn>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 10, alignItems: "center", flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)" }}>
          <span>{totals.count} txns</span>
          <span>spend: <b style={{ color: "var(--warn)" }}>{inr(totals.spend)}</b></span>
          <span>income: <b style={{ color: "var(--ok)" }}>{inr(totals.income)}</b></span>
          <span>net: <b style={{ color: totals.income - totals.spend >= 0 ? "var(--ok)" : "var(--warn)" }}>{inr(totals.income - totals.spend)}</b></span>
          <span>unreconciled debits: <b>{totals.unrec}</b></span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {alerts.length > 0 && <Chip tone="warn">{alerts.length} open alerts</Chip>}
            <Btn size="sm" onClick={exportCsv} disabled={filtered.length === 0}>export CSV</Btn>
            <Btn size="sm" variant="primary" onClick={runRecon} disabled={reconciling}>{reconciling ? "scanning…" : "run reconciliation"}</Btn>
          </span>
        </div>
        {selected.size > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, padding: 8, border: "1px solid var(--edge-strong)", background: "rgba(53,214,237,0.05)", borderRadius: 3 }}>
            <span style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>{selected.size} selected</span>
            <input value={bulkCat} onChange={(e) => setBulkCat(e.target.value)} placeholder="new category…" style={{ ...inputStyle, width: 160 }} />
            <Btn size="sm" variant="primary" disabled={bulkBusy || !bulkCat.trim()} onClick={bulkCategorize}>categorize</Btn>
            <Btn size="sm" disabled={bulkBusy} onClick={bulkReconcile}>mark reconciled</Btn>
            <Btn size="sm" disabled={bulkBusy} onClick={bulkDelete}>delete</Btn>
            <Btn size="sm" onClick={() => setSelected(new Set())}>clear</Btn>
          </div>
        )}
      </HudPanel>

      <HudPanel title="Transactions" index="TXN" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {filtered.length === 0 ? <EmptyState hint={items.length ? "adjust filters above" : "log your first one above"}>no transactions</EmptyState> :
         <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
           <thead>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", width: 24 }}>
                 <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleAllSel} />
               </th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>date</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>merchant</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>category</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>account</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>source</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>rec</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>amount</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }} />
             </tr>
           </thead>
           <tbody>
             {filtered.map((t: any) => {
               const isEditing = editId === t.id;
               const suspicious = Number(t.amount) >= SUSPICIOUS_AMOUNT && t.txn_type === "debit";
               return (
               <Fragment key={t.id}>
                  <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)", background: selected.has(t.id) ? "rgba(53,214,237,0.08)" : (suspicious ? "rgba(255,183,77,0.05)" : undefined) }}>
                   <td style={{ padding: "6px 8px" }}>
                     <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} />
                   </td>

                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{new Date(t.txn_date).toLocaleDateString()}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text)" }}>
                     {isEditing
                       ? <input value={editForm.merchant} onChange={(e) => setEditForm({ ...editForm, merchant: e.target.value })} style={{ ...inputStyle, width: "100%", fontSize: 12 }} />
                       : (t.merchant ?? "—")}
                     {suspicious && !isEditing && <span style={{ marginLeft: 6 }}><Chip tone="warn">large</Chip></span>}
                   </td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>
                     {isEditing
                       ? <input value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} style={{ ...inputStyle, width: "100%", fontSize: 12 }} />
                       : (t.category ?? "—")}
                   </td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{t.financial_accounts?.nickname ?? t.credit_cards?.card_name ?? "—"}</td>
                   <td style={{ padding: "6px 8px" }}><Chip tone={sourceTone(t.source)}>{t.source ?? "manual"}</Chip></td>
                   <td style={{ padding: "6px 8px" }}>
                     <button title={t.is_reconciled ? "reconciled — click to unmark" : "mark reconciled"} onClick={() => toggleReconciled(t)}
                       style={{ background: "none", border: "1px solid var(--edge)", cursor: "pointer", padding: "2px 4px", borderRadius: 3,
                                color: t.is_reconciled ? "var(--ok)" : "var(--text-muted)" }}>
                       {t.is_reconciled ? <Check size={11} /> : "—"}
                     </button>
                   </td>
                   <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "var(--font-display)", color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)" }}>
                     {t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}
                   </td>
                   <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                     {isEditing ? (
                       <>
                         <button style={{ color: "var(--ok)", background: "none", border: "none", cursor: "pointer", marginRight: 4 }} onClick={() => saveEdit(t)}><Check size={12} /></button>
                         <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }} onClick={() => setEditId(null)}><X size={12} /></button>
                       </>
                     ) : (
                       <button style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", marginRight: 6 }} title="Edit merchant/category" onClick={() => startEdit(t)}><Pencil size={11} /></button>
                     )}
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
                     <td colSpan={9} style={{ padding: "8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
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
             );
             })}
           </tbody>
         </table>}
      </HudPanel>
    </div>
  );
}

