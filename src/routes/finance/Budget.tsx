import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { ScoreBar } from "./_shared";

// ---------- Budget ----------
// No Config sub-page for this one module — the add-form lives inline here
// rather than growing the Config routing surface for a single small CRUD.
export default function Budget() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [spent, setSpent] = useState<Map<string, number>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newBudget, setNewBudget] = useState({ category: "", monthly_limit: "" });

  const load = async () => {
    const b = await db.budgets.list();
    setItems(b);
    const entries = await Promise.all(b.map(async (x: any) => [x.category, await db.budgets.spentThisMonth(x.category)] as const));
    setSpent(new Map(entries));
  };
  useEffect(() => { load(); }, []);

  const toggleOpen = (b: any) => {
    if (openId === b.id) { setOpenId(null); return; }
    setOpenId(b.id);
    setEdit({ category: b.category ?? "", monthly_limit: b.monthly_limit ?? "", rollover: !!b.rollover, notes: b.notes ?? "" });
  };

  const save = async (id: string) => {
    if (!edit.category?.trim() || !edit.monthly_limit) return;
    setSaving(true);
    try {
      await db.budgets.update(id, {
        category: edit.category.trim(), monthly_limit: Number(edit.monthly_limit),
        rollover: !!edit.rollover, notes: edit.notes || null,
      });
      push("Saved", "ok");
      setOpenId(null);
      load();
    } catch (e: any) { push(e?.message ?? "save failed", "err"); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this budget?")) return;
    await db.budgets.remove(id);
    setOpenId(null);
    load();
  };

  const addBudget = async () => {
    if (!newBudget.category.trim() || !newBudget.monthly_limit) return;
    setAdding(true);
    try {
      await db.budgets.create({ category: newBudget.category.trim(), monthly_limit: Number(newBudget.monthly_limit) });
      push("Budget added", "ok");
      setNewBudget({ category: "", monthly_limit: "" });
      load();
    } catch (e: any) { push(e?.message ?? "failed to add budget", "err"); }
    finally { setAdding(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Budget" index="BDG" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--edge)" }}>
          <div style={{ minWidth: 160 }}><label style={labelStyle}>category</label><input value={newBudget.category} onChange={(e) => setNewBudget({ ...newBudget, category: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>monthly limit</label><input type="number" value={newBudget.monthly_limit} onChange={(e) => setNewBudget({ ...newBudget, monthly_limit: e.target.value })} style={{ ...inputStyle, width: 140 }} /></div>
          <Btn size="sm" variant="primary" disabled={adding || !newBudget.category.trim() || !newBudget.monthly_limit} onClick={addBudget}>{adding ? "adding…" : "+ add budget"}</Btn>
        </div>
        {items.length === 0 ? <EmptyState hint="add a category budget above">no budgets yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((b) => {
             const spentAmt = spent.get(b.category) ?? 0;
             const limit = Number(b.monthly_limit) || 0;
             const pct = limit > 0 ? Math.min(100, (spentAmt / limit) * 100) : 0;
             const over = spentAmt > limit;
             return (
               <div key={b.id} style={{ padding: 12, border: "1px solid var(--edge)", cursor: "pointer" }} onClick={() => toggleOpen(b)}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15, textTransform: "capitalize" }}>{b.category}</div>
                   {over && <Chip tone="err">over budget</Chip>}
                   {b.rollover && <Chip>rollover</Chip>}
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{inr(spentAmt)} of {inr(limit)}</div>
                 <div style={{ marginTop: 8 }}><ScoreBar pct={pct} /></div>
                 {openId === b.id && (
                   <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
                     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                       <div><label style={labelStyle}>category</label><input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                       <div><label style={labelStyle}>monthly limit</label><input type="number" value={edit.monthly_limit} onChange={(e) => setEdit({ ...edit, monthly_limit: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
                     </div>
                     <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                       <input type="checkbox" checked={!!edit.rollover} onChange={(e) => setEdit({ ...edit, rollover: e.target.checked })} />
                       <label style={labelStyle}>rollover unused amount</label>
                     </div>
                     <div>
                       <label style={labelStyle}>notes</label>
                       <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                     </div>
                     <div style={{ display: "flex", gap: 6 }}>
                       <Btn size="sm" variant="primary" disabled={saving || !edit.category?.trim()} onClick={() => save(b.id)}>{saving ? "saving…" : "save"}</Btn>
                       <Btn size="sm" onClick={() => setOpenId(null)}>close</Btn>
                       <Btn size="sm" variant="danger" onClick={() => remove(b.id)}>delete</Btn>
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
