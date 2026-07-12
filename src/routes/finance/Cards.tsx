import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { db, inr } from "@/lib/db";
import { calcCreditUtilization } from "@/lib/financeMetrics";
import { useUi } from "@/store/uiStore";
import { ConfigureCTA, utilTone } from "./_shared";

// ---------- Cards ----------
export default function Cards() {
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
      reward_type: c.reward_type ?? "", reward_rate_pct: c.reward_rate_pct ?? "",
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
        reward_type: edit.reward_type || null, reward_rate_pct: edit.reward_rate_pct ? Number(edit.reward_rate_pct) : null,
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
                 {c.reward_type && <Chip tone="ok">{c.reward_rate_pct}% {c.reward_type}</Chip>}
                 <NavLink to={`/finance/cards/${c.id}`} onClick={(e) => e.stopPropagation()}
                   style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", textDecoration: "none" }}>
                   details →
                 </NavLink>
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

