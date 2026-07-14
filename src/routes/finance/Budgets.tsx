import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { useSession } from "@/lib/useSession";
import { inr } from "@/lib/db";
import { computeBudgetStatus, type BudgetRow, type BudgetTxn } from "@/lib/budget";
import { Trash2 } from "lucide-react";

export default function Budgets() {
  const push = useUi((s) => s.push);
  const { session } = useSession();
  const uid = session?.user.id;
  const [budgets, setBudgets] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [f, setF] = useState({ category: "", limit: "" });

  const load = async () => {
    if (!uid) return;
    const client: any = supabase;
    const [b, t] = await Promise.all([
      client.from("budgets").select("*").eq("user_id", uid).order("category"),
      client.from("transactions").select("txn_date, amount, txn_type, category")
        .eq("user_id", uid)
        .gte("txn_date", new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)),
    ]);
    setBudgets(b.data ?? []);
    setTxns(t.data ?? []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [uid]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.category || !f.limit || !uid) return;
    const client: any = supabase;
    const { error } = await client.from("budgets").insert({
      user_id: uid, category: f.category.trim(), monthly_limit: Number(f.limit), active: true,
    });
    if (error) return push(error.message, "err");
    setF({ category: "", limit: "" });
    load();
  };
  const remove = async (id: string) => {
    const client: any = supabase;
    await client.from("budgets").delete().eq("id", id);
    load();
  };

  const status = computeBudgetStatus(budgets as BudgetRow[], txns as BudgetTxn[]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Add Budget" index="+" live="ok">
        <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div><label style={labelStyle}>category</label><input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Food" style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>monthly limit (₹)</label><input type="number" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
          <Btn type="submit" variant="primary" disabled={!f.category || !f.limit}>+ add</Btn>
        </form>
      </HudPanel>
      <HudPanel title="Current Month" index="B" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto">
        {status.length === 0 ? <EmptyState hint="add a budget above">no budgets</EmptyState> :
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {status.map((s) => {
              const b = budgets.find((x) => x.category === s.category);
              const color = s.state === "over" ? "var(--err)" : s.state === "warn" ? "var(--warn)" : "var(--ok)";
              return (
                <div key={s.category} style={{ padding: 10, border: "1px solid var(--edge)", borderRadius: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <b style={{ color: "var(--text)" }}>{s.category}</b>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
                      <span style={{ color: "var(--text-dim)" }}>{inr(s.spent)} / {inr(s.limit)}</span>
                      <span style={{ color }}>{s.pct}%</span>
                      <button onClick={() => b && remove(b.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={11} /></button>
                    </div>
                  </div>
                  <div style={{ height: 6, background: "var(--edge)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, s.pct)}%`, height: "100%", background: color, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })}
          </div>}
      </HudPanel>
    </div>
  );
}