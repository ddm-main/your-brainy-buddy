import { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr } from "@/lib/db";
import { calcCreditUtilization } from "@/lib/financeMetrics";
import { useUi } from "@/store/uiStore";

/** Card detail — utilization, latest statement, statement history, recent
 * transactions, plus inline edit / delete / log-bill-payment for a single
 * credit card. Wired at /finance/cards/:id. */
export default function CardDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [card, setCard] = useState<any>(null);
  const [banks, setBanks] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [payment, setPayment] = useState({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
  const [logging, setLogging] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [all, allBanks, allAccounts, allStatements, allTxns] = await Promise.all([
      db.cards.list(),
      db.banks.list(),
      db.accounts.list(),
      db.statements.list(500),
      db.transactions.list(200),
    ]);
    setCard(all.find((c: any) => c.id === id) ?? null);
    setBanks(allBanks);
    setAccounts(allAccounts);
    setStatements(allStatements.filter((s: any) => s.credit_card_id === id));
    setTxns(allTxns.filter((t: any) => t.credit_card_id === id).slice(0, 30));
  }, [id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await load(); }
      catch (e: any) { if (alive) push(e?.message ?? "failed to load card", "err"); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [load, push]);

  const startEdit = () => {
    if (!card) return;
    setEdit({
      card_name: card.card_name ?? "", bank_id: card.bank_id ?? "",
      masked_number: card.masked_number ?? "",
      billing_day: card.billing_day ?? "", due_day: card.due_day ?? "",
      limit_amount: card.limit_amount ?? "",
      autopay: !!card.autopay, notes: card.notes ?? "",
      reward_type: card.reward_type ?? "", reward_rate_pct: card.reward_rate_pct ?? "",
    });
    setEditing(true);
  };

  const save = async () => {
    if (!id || !edit.card_name?.trim()) return;
    setSaving(true);
    try {
      await db.cards.update(id, {
        card_name: edit.card_name.trim(),
        bank_id: edit.bank_id || null,
        masked_number: edit.masked_number || null,
        billing_day: edit.billing_day ? Number(edit.billing_day) : null,
        due_day: edit.due_day ? Number(edit.due_day) : null,
        limit_amount: edit.limit_amount ? Number(edit.limit_amount) : null,
        autopay: !!edit.autopay,
        notes: edit.notes || null,
        reward_type: edit.reward_type || null,
        reward_rate_pct: edit.reward_rate_pct ? Number(edit.reward_rate_pct) : null,
      });
      push("Saved", "ok");
      setEditing(false);
      await load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!id) return;
    if (!confirm("Delete this card?")) return;
    try {
      await db.cards.remove(id);
      push("Deleted", "ok");
      nav("/finance/cards");
    } catch (e: any) { push(e?.message ?? "delete failed", "err"); }
  };

  const logPayment = async () => {
    if (!card || !payment.account_id || !payment.amount) return;
    setLogging(true);
    try {
      await db.transactions.create({
        txn_date: payment.date,
        amount: Number(payment.amount),
        txn_type: "debit",
        merchant: `${card.card_name} bill payment`,
        category: "credit card payment",
        financial_account_id: payment.account_id,
        credit_card_id: card.id,
        source: "manual",
      });
      push("Payment logged", "ok");
      setPayment({ account_id: "", amount: "", date: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (e: any) { push(e?.message ?? "failed to log payment", "err"); }
    finally { setLogging(false); }
  };

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

  const latest = statements[0] ?? null;
  const util = calcCreditUtilization([{
    cardId: card.id, cardName: card.card_name, limit: card.limit_amount, totalDue: latest?.total_due,
  }]).perCard[0];
  const utilPct = util?.utilizationPct ?? null;
  const utilTone = utilPct == null ? "neutral" : utilPct < 30 ? "ok" : utilPct < 70 ? "warn" : "err";

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <NavLink to="/finance/cards" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← cards</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{card.card_name}</div>
        {card.banks?.name && <Chip>{card.banks.name}</Chip>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {!editing && <Btn size="sm" onClick={startEdit}>edit</Btn>}
          {!editing && <Btn size="sm" variant="danger" onClick={remove}>delete</Btn>}
        </div>
      </div>

      {editing && (
        <HudPanel title="Edit Card" index="EDT" live="warn">
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div><label style={labelStyle}>card name</label><input value={edit.card_name} onChange={(e) => setEdit({ ...edit, card_name: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
              <div><label style={labelStyle}>bank</label>
                <HudSelect value={edit.bank_id} onChange={(v) => setEdit({ ...edit, bank_id: v })} placeholder="—" options={banks.map((b: any) => ({ value: b.id, label: b.name }))} />
              </div>
              <div><label style={labelStyle}>last 4</label><input value={edit.masked_number} onChange={(e) => setEdit({ ...edit, masked_number: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
              <div><label style={labelStyle}>limit</label><input type="number" value={edit.limit_amount} onChange={(e) => setEdit({ ...edit, limit_amount: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
              <div><label style={labelStyle}>bill day</label><input type="number" min={1} max={31} value={edit.billing_day} onChange={(e) => setEdit({ ...edit, billing_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
              <div><label style={labelStyle}>due day</label><input type="number" min={1} max={31} value={edit.due_day} onChange={(e) => setEdit({ ...edit, due_day: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
              <div><label style={labelStyle}>reward type</label>
                <HudSelect value={edit.reward_type} onChange={(v) => setEdit({ ...edit, reward_type: v })} placeholder="—" options={[
                  { value: "cashback", label: "cashback" }, { value: "points", label: "points" }, { value: "miles", label: "miles" },
                ]} />
              </div>
              <div><label style={labelStyle}>reward rate %</label><input type="number" step="0.01" value={edit.reward_rate_pct} onChange={(e) => setEdit({ ...edit, reward_rate_pct: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
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
              <Btn size="sm" variant="primary" disabled={saving || !edit.card_name?.trim()} onClick={save}>{saving ? "saving…" : "save"}</Btn>
              <Btn size="sm" onClick={() => setEditing(false)}>cancel</Btn>
            </div>
          </div>
        </HudPanel>
      )}

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

      <HudPanel title="Log Bill Payment" index="PAY" live="ok">
        <div style={{ padding: 10, display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 160 }}>
            <label style={labelStyle}>paid from</label>
            <HudSelect value={payment.account_id} onChange={(v) => setPayment({ ...payment, account_id: v })} placeholder="—" options={accounts.map((a: any) => ({ value: a.id, label: a.nickname }))} />
          </div>
          <div><label style={labelStyle}>amount</label><input type="number" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} style={{ ...inputStyle, width: 120 }} /></div>
          <div><label style={labelStyle}>date</label><HudDatePicker value={payment.date} onChange={(v) => setPayment({ ...payment, date: v })} /></div>
          <Btn size="sm" variant="primary" disabled={logging || !payment.account_id || !payment.amount} onClick={logPayment}>{logging ? "logging…" : "log payment"}</Btn>
        </div>
      </HudPanel>

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
