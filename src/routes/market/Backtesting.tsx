// Market Backtesting — strategy library + past results.
// Reads market_saved_strategies and market_backtest_results.
// "Run" executes the market-backtest-run edge function and stores a result row.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "@/lib/market/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Play, Plus, Trash2 } from "lucide-react";
import { fmtNum, fmtPct } from "@/components/hud/DataTable";

type Strategy = { id: string; name: string; description: string | null; strategy: any; created_at: string };
type Result = {
  id: string; strategy_id: string | null; period_years: number | null;
  metrics: any; equity_curve: any; trades: any; ran_at: string;
};

const WINDOWS = [1, 3, 5, 10];
const RULES = [
  { v: "ema_cross_20_50", l: "EMA cross 20/50" },
  { v: "rsi_reversion", l: "RSI mean-reversion (30/70)" },
  { v: "breakout_20d", l: "20d high breakout" },
];

export default function Backtesting() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [years, setYears] = useState(3);
  const [running, setRunning] = useState(false);

  const { data: strategies = [] } = useQuery({
    queryKey: ["market", "strategies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("market_saved_strategies")
        .select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Strategy[];
    },
  });
  const { data: results = [] } = useQuery({
    queryKey: ["market", "backtests", selectedId],
    queryFn: async () => {
      let q = supabase.from("market_backtest_results").select("*").order("ran_at", { ascending: false }).limit(20);
      if (selectedId) q = q.eq("strategy_id", selectedId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Result[];
    },
  });

  const latest = results[0];
  const metrics = (latest?.metrics ?? {}) as Record<string, number | null | undefined>;
  const equity = (latest?.equity_curve ?? []) as Array<{ t?: string; v?: number }>;

  const run = async () => {
    if (!selectedId) { push("Pick a strategy first", "err"); return; }
    setRunning(true);
    try {
      await callMarketFn("market-backtest-run", { strategy_id: selectedId, period_years: years });
      push("Backtest complete", "ok");
      qc.invalidateQueries({ queryKey: ["market", "backtests"] });
    } catch (e) { push(toSafeError(e, "run failed").message, "err"); }
    finally { setRunning(false); }
  };
  const remove = async (s: Strategy) => {
    if (!confirm(`Delete strategy "${s.name}"?`)) return;
    try {
      const { error } = await supabase.from("market_saved_strategies").delete().eq("id", s.id);
      if (error) throw error;
      if (selectedId === s.id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["market", "strategies"] });
      push("Strategy deleted", "ok");
    } catch (e) { push(toSafeError(e, "delete failed").message, "err"); }
  };

  const equitySvg = useMemo(() => {
    if (!equity.length) return null;
    const vs = equity.map((p) => p.v ?? 0);
    const min = Math.min(...vs), max = Math.max(...vs);
    const w = 600, h = 120, pad = 4;
    const pts = equity.map((p, i) => {
      const x = pad + (i / Math.max(1, equity.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p.v! - min) / Math.max(0.0001, max - min)) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return { w, h, pts };
  }, [equity]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Strategies" index="MK.BT1"
        actions={<Btn size="sm" variant="primary" onClick={() => setCreating(true)}><Plus size={11} style={{ marginRight: 4 }}/> new</Btn>}>
        {strategies.length === 0 ? (
          <EmptyState hint="Create a rule-based strategy (EMA cross, RSI reversion, breakout) to backtest on historical NSE candles.">no strategies saved</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {strategies.map((s) => {
              const active = selectedId === s.id;
              return (
                <div key={s.id} onClick={() => setSelectedId(s.id)} style={{
                  display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center",
                  padding: "6px 8px", cursor: "pointer",
                  border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                  background: active ? "rgba(53,214,237,0.08)" : "transparent",
                }}>
                  <div>
                    <div style={{ color: active ? "var(--accent)" : "var(--text)", fontSize: 12 }}>{s.name}</div>
                    {s.description && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{s.description}</div>}
                  </div>
                  <Chip tone="neutral">{s.strategy?.rule ?? "custom"}</Chip>
                  <Btn size="sm" onClick={(e) => { e.stopPropagation(); remove(s); }}><Trash2 size={11}/></Btn>
                </div>
              );
            })}
          </div>
        )}
      </HudPanel>

      <HudPanel title="Run" index="MK.BT2">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Window</div>
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOWS.map((y) => (
                <Btn key={y} size="sm" variant={years === y ? "primary" : "ghost"} onClick={() => setYears(y)}>{y}y</Btn>
              ))}
            </div>
          </div>
          <Btn variant="primary" onClick={run} disabled={running || !selectedId}>
            <Play size={11} style={{ marginRight: 4 }}/> {running ? "running…" : "run backtest"}
          </Btn>
          {!selectedId && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>select a strategy above</span>}
        </div>
      </HudPanel>

      <HudPanel title="Latest Result" index="MK.BT3">
        {!latest ? (
          <EmptyState hint="Run a backtest to see equity curve, win rate, Sharpe, drawdown, and monthly returns.">no results yet</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
              <MetricTile label="Win rate" value={fmtPct(metrics.win_rate)}/>
              <MetricTile label="Profit factor" value={fmtNum(metrics.profit_factor, 2)}/>
              <MetricTile label="Sharpe" value={fmtNum(metrics.sharpe, 2)}/>
              <MetricTile label="Sortino" value={fmtNum(metrics.sortino, 2)}/>
              <MetricTile label="Max DD" value={fmtPct(metrics.max_drawdown)} tone="err"/>
              <MetricTile label="Trades" value={fmtNum(metrics.total_trades, 0)}/>
              <MetricTile label="Total return" value={fmtPct(metrics.total_return)} tone="ok"/>
              <MetricTile label="CAGR" value={fmtPct(metrics.cagr)}/>
            </div>
            {equitySvg && (
              <div>
                <div style={labelStyle}>Equity curve</div>
                <svg viewBox={`0 0 ${equitySvg.w} ${equitySvg.h}`} style={{ width: "100%", height: 120, border: "1px solid var(--edge)" }}>
                  <polyline points={equitySvg.pts} fill="none" stroke="var(--accent)" strokeWidth={1.2}/>
                </svg>
              </div>
            )}
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
              ran {new Date(latest.ran_at).toLocaleString()} · window {latest.period_years ?? "?"}y
            </div>
          </div>
        )}
      </HudPanel>

      {creating && <NewStrategyModal onClose={() => setCreating(false)} onCreated={() => {
        qc.invalidateQueries({ queryKey: ["market", "strategies"] });
        setCreating(false);
      }}/>}
    </div>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--accent)";
  return (
    <div style={{ padding: 8, border: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color }}>{value}</div>
    </div>
  );
}

function NewStrategyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const push = useUi((s) => s.push);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [rule, setRule] = useState("ema_cross_20_50");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || !symbol.trim()) { push("Name and symbol required", "err"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) throw new Error("not signed in");
      const { error } = await supabase.from("market_saved_strategies").insert({
        user_id: u.user.id,
        name: name.trim(),
        description: `${RULES.find((r) => r.v === rule)?.l} on ${symbol.toUpperCase()}`,
        strategy: { rule, symbol: symbol.trim().toUpperCase(), exchange: "NSE" },
      });
      if (error) throw error;
      push("Strategy saved", "ok");
      onCreated();
    } catch (e) { push(toSafeError(e, "save failed").message, "err"); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 420, background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 16, display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>New strategy</div>
        <div>
          <div style={labelStyle}>Name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Reliance EMA cross" style={inputStyle} autoFocus/>
        </div>
        <div>
          <div style={labelStyle}>Symbol</div>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="RELIANCE" style={inputStyle}/>
        </div>
        <div>
          <div style={labelStyle}>Rule</div>
          <select value={rule} onChange={(e) => setRule(e.target.value)} style={inputStyle}>
            {RULES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
          <Btn onClick={onClose}>cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={busy}>{busy ? "saving…" : "save"}</Btn>
        </div>
      </div>
    </div>
  );
}
