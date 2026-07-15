import { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

/** Account detail — balance, statement history, transaction history, linked
 * loans/subs, and inline edit/delete for a single account. Wired at
 * /finance/accounts/:id. */
export default function AccountDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [account, setAccount] = useState<any>(null);
  const [banks, setBanks] = useState<any[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [linked, setLinked] = useState<{ loans: any[]; subs: any[] }>({ loans: [], subs: [] });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<any>({});
  const [balanceTouched, setBalanceTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [all, allBanks, allStatements, allTxns, linkedRows] = await Promise.all([
      db.accounts.list(),
      db.banks.list(),
      db.statements.list(500),
      db.transactions.list(200),
      db.accounts.linked(id),
    ]);
    setAccount(all.find((a: any) => a.id === id) ?? null);
    setBanks(allBanks);
    setStatements(allStatements.filter((s: any) => s.financial_account_id === id));
    setTxns(allTxns.filter((t: any) => t.financial_account_id === id).slice(0, 30));
    setLinked(linkedRows);
  }, [id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await load(); }
      catch (e: any) { if (alive) push(e?.message ?? "failed to load account", "err"); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [load, push]);

  const startEdit = () => {
    if (!account) return;
    setEdit({
      nickname: account.nickname ?? "", account_type: account.account_type ?? "",
      masked_number: account.masked_number ?? "", bank_id: account.bank_id ?? "",
      notes: account.notes ?? "", source_email: account.source_email ?? "",
      statement_cycle_day: account.statement_cycle_day ?? "",
      current_balance: account.current_balance ?? "",
    });
    setBalanceTouched(false);
    setEditing(true);
  };

  const save = async () => {
    if (!id || !edit.nickname?.trim()) return;
    setSaving(true);
    try {
      const newBalance = edit.current_balance !== "" && edit.current_balance != null ? Number(edit.current_balance) : null;
      await db.accounts.update(id, {
        nickname: edit.nickname.trim(),
        account_type: edit.account_type || null,
        masked_number: edit.masked_number || null,
        bank_id: edit.bank_id || null,
        notes: edit.notes || null,
        source_email: edit.source_email || null,
        statement_cycle_day: edit.statement_cycle_day ? Number(edit.statement_cycle_day) : null,
        current_balance: newBalance,
        ...(balanceTouched ? { current_balance_as_of: newBalance != null ? new Date().toISOString().slice(0, 10) : null } : {}),
      });
      push("Saved", "ok");
      setEditing(false);
      await load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!id) return;
    if (!confirm("Delete this account?")) return;
    try {
      await db.accounts.remove(id);
      push("Deleted", "ok");
      nav("/finance/accounts");
    } catch (e: any) { push(e?.message ?? "delete failed", "err"); }
  };

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <NavLink to="/finance/accounts" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← accounts</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{account.nickname}</div>
        {account.account_type && <Chip>{account.account_type}</Chip>}
        {account.banks?.name && <Chip>{account.banks.name}</Chip>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {!editing && <Btn size="sm" onClick={startEdit}>edit</Btn>}
          {!editing && <Btn size="sm" variant="danger" onClick={remove}>delete</Btn>}
        </div>
      </div>

      {editing && (
        <HudPanel title="Edit Account" index="EDT" live="warn">
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
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
                <label style={labelStyle}>current balance{account.current_balance_as_of ? ` (as of ${new Date(account.current_balance_as_of).toLocaleDateString()})` : ""}</label>
                <input type="number" step="0.01" value={edit.current_balance} onChange={(e) => { setEdit({ ...edit, current_balance: e.target.value }); setBalanceTouched(true); }} style={{ ...inputStyle, width: "100%" }} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>notes</label>
              <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="primary" disabled={saving || !edit.nickname?.trim()} onClick={save}>{saving ? "saving…" : "save"}</Btn>
              <Btn size="sm" onClick={() => setEditing(false)}>cancel</Btn>
            </div>
          </div>
        </HudPanel>
      )}

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
