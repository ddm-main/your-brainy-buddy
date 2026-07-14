import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, EmptyState } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/useSession";
import { inr } from "@/lib/db";
import { computeBudgetStatus, type BudgetRow, type BudgetTxn } from "@/lib/budget";

/** Overview budget widget — pulls user's budgets + last 45d debits and
 * renders per-category bars (green/warn/over). */
export default function BudgetWidget() {
  const { session } = useSession();
  const uid = session?.user.id;
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [txns, setTxns] = useState<BudgetTxn[]>([]);

  useEffect(() => {
    if (!uid) return;
    const client: any = supabase;
    let cancel = false;
    (async () => {
      const [b, t] = await Promise.all([
        client.from("budgets").select("id, category, monthly_limit, active").eq("user_id", uid),
        client.from("transactions").select("txn_date, amount, txn_type, category")
          .eq("user_id", uid)
          .gte("txn_date", new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)),
      ]);
      if (cancel) return;
      setBudgets((b.data ?? []) as BudgetRow[]);
      setTxns((t.data ?? []) as BudgetTxn[]);
    })();
    return () => { cancel = true; };
  }, [uid]);

  const rows = computeBudgetStatus(budgets, txns);
  const anyWarn = rows.some((r) => r.state !== "ok");

  return (
    <HudPanel
      title="Budgets"
      index="BGT"
      live={anyWarn ? "warn" : "ok"}
      actions={<NavLink to="/finance/budgets"><Btn size="sm">manage</Btn></NavLink>}
    >
      {rows.length === 0 ? (
        <EmptyState hint="add limits in Budgets">no budgets yet</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.slice(0, 6).map((r) => {
            const color = r.state === "over" ? "var(--err)" : r.state === "warn" ? "var(--warn)" : "var(--ok)";
            return (
              <div key={r.category}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: "var(--text)" }}>{r.category}</span>
                  <span style={{ color: "var(--text-dim)" }}>{inr(r.spent)} / {inr(r.limit)} · <b style={{ color }}>{r.pct}%</b></span>
                </div>
                <div style={{ height: 5, background: "var(--edge)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, r.pct)}%`, height: "100%", background: color, transition: "width 0.3s" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </HudPanel>
  );
}
