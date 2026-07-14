import { useEffect, useMemo, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { EmptyState } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/useSession";
import { inr } from "@/lib/db";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, LineChart, Line, CartesianGrid, Legend,
} from "recharts";

const COLORS = ["#35d6ed", "#7fe9ff", "#ffb74d", "#ff6b6b", "#a78bfa", "#4ade80", "#fbbf24", "#f472b6", "#60a5fa", "#34d399"];

export default function Analytics() {
  const { session } = useSession();
  const uid = session?.user.id;
  const [txns, setTxns] = useState<any[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [months, setMonths] = useState<3 | 6 | 12>(6);

  useEffect(() => {
    if (!uid) return;
    const client: any = supabase;
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    (async () => {
      const [t, s] = await Promise.all([
        client.from("transactions").select("txn_date, amount, txn_type, merchant, category, credit_card_id")
          .eq("user_id", uid).gte("txn_date", from.toISOString().slice(0, 10)).limit(5000),
        client.from("statements").select("statement_date, total_due, credit_card_id, credit_cards(card_name, credit_limit)")
          .eq("user_id", uid).order("statement_date", { ascending: true }),
      ]);
      setTxns(t.data ?? []);
      setStatements(s.data ?? []);
    })();
  }, [uid, months]);

  const spendByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of txns) {
      if (t.txn_type !== "debit") continue;
      const c = t.category ?? "Uncategorized";
      m.set(c, (m.get(c) ?? 0) + Number(t.amount));
    }
    return [...m.entries()].map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value).slice(0, 10);
  }, [txns]);

  const momSeries = useMemo(() => {
    const map = new Map<string, { month: string; income: number; spend: number }>();
    for (const t of txns) {
      const k = (t.txn_date ?? "").slice(0, 7);
      if (!k) continue;
      const row = map.get(k) ?? { month: k, income: 0, spend: 0 };
      if (t.txn_type === "credit") row.income += Number(t.amount);
      else row.spend += Number(t.amount);
      map.set(k, row);
    }
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map((r) => ({ ...r, income: Math.round(r.income), spend: Math.round(r.spend) }));
  }, [txns]);

  const topMerchants = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of txns) {
      if (t.txn_type !== "debit") continue;
      const k = (t.merchant ?? "—").slice(0, 40);
      m.set(k, (m.get(k) ?? 0) + Number(t.amount));
    }
    return [...m.entries()].map(([merchant, total]) => ({ merchant, total: Math.round(total) }))
      .sort((a, b) => b.total - a.total).slice(0, 10);
  }, [txns]);

  const utilTrend = useMemo(() => {
    const map = new Map<string, { date: string; pct: number }>();
    for (const s of statements) {
      const limit = Number(s.credit_cards?.credit_limit ?? 0);
      if (!limit) continue;
      const key = (s.statement_date ?? "").slice(0, 7);
      if (!key) continue;
      const pct = (Number(s.total_due) / limit) * 100;
      const cur = map.get(key);
      if (!cur || pct > cur.pct) map.set(key, { date: key, pct: Math.round(pct * 10) / 10 });
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [statements]);

  const incomeBySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of txns) {
      if (t.txn_type !== "credit") continue;
      const k = (t.merchant ?? "unknown").slice(0, 40);
      m.set(k, (m.get(k) ?? 0) + Number(t.amount));
    }
    return [...m.entries()].map(([name, value]) => ({ name, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value).slice(0, 8);
  }, [txns]);

  if (!uid) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--text-dim)", textTransform: "uppercase" }}>period</span>
        <HudSelect value={String(months)} onChange={(v) => setMonths(Number(v) as 3 | 6 | 12)} options={[
          { value: "3", label: "3 months" }, { value: "6", label: "6 months" }, { value: "12", label: "12 months" },
        ]} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <HudPanel title="Spend by Category" index="C" live="ok">
          {spendByCategory.length === 0 ? <EmptyState>no data</EmptyState> :
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={spendByCategory} dataKey="value" nameKey="name" outerRadius={90} innerRadius={40}>
                    {spendByCategory.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => inr(v)} contentStyle={{ background: "#000", border: "1px solid var(--edge)" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>}
        </HudPanel>

        <HudPanel title="Income vs Spend (MoM)" index="M" live="ok">
          {momSeries.length === 0 ? <EmptyState>no data</EmptyState> :
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={momSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <Tooltip formatter={(v: any) => inr(v)} contentStyle={{ background: "#000", border: "1px solid var(--edge)" }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="income" fill="#4ade80" />
                  <Bar dataKey="spend" fill="#ff6b6b" />
                </BarChart>
              </ResponsiveContainer>
            </div>}
        </HudPanel>

        <HudPanel title="Top Merchants" index="TM" live="ok">
          {topMerchants.length === 0 ? <EmptyState>no data</EmptyState> :
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={topMerchants} layout="vertical" margin={{ left: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <YAxis dataKey="merchant" type="category" width={110} tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <Tooltip formatter={(v: any) => inr(v)} contentStyle={{ background: "#000", border: "1px solid var(--edge)" }} />
                  <Bar dataKey="total" fill="#35d6ed" />
                </BarChart>
              </ResponsiveContainer>
            </div>}
        </HudPanel>

        <HudPanel title="Utilization Trend" index="U" live="ok">
          {utilTrend.length === 0 ? <EmptyState>no statements</EmptyState> :
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={utilTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
                  <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ background: "#000", border: "1px solid var(--edge)" }} />
                  <Line dataKey="pct" stroke="#ffb74d" dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>}
        </HudPanel>

        <HudPanel title="Income by Source" index="I" live="ok">
          {incomeBySource.length === 0 ? <EmptyState>no income data</EmptyState> :
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={incomeBySource} dataKey="value" nameKey="name" outerRadius={90}>
                    {incomeBySource.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => inr(v)} contentStyle={{ background: "#000", border: "1px solid var(--edge)" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>}
        </HudPanel>
      </div>
    </div>
  );
}