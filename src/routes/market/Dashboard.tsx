// Market Dashboard — indices, watchlist summary, holdings summary, AI insight
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase, SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { RefreshCw, Sparkles, TrendingUp } from "lucide-react";

type Quote = { symbol: string; name: string; price: number; change_pct: number | null; change_abs?: number | null };

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const [indices, setIndices] = useState<Quote[]>([]);
  const [breadth, setBreadth] = useState<{ advances?: number; declines?: number; unchanged?: number; new_highs?: number; new_lows?: number } | null>(null);
  const [holdingsCount, setHoldingsCount] = useState(0);
  const [watchlistCount, setWatchlistCount] = useState(0);
  const [insight, setInsight] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  const callFn = async (name: string, body: Record<string, unknown> = {}) => {
    const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
    const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? r.statusText);
    return j;
  };

  const load = async () => {
    try {
      const [{ data: st }, { count: hc }, { count: wc }] = await Promise.all([
        supabase.from("market_api_settings").select("active_provider,connection_status").eq("connection_status", "connected").limit(1),
        supabase.from("market_holdings").select("id", { head: true, count: "exact" }),
        supabase.from("market_watchlist_items").select("id", { head: true, count: "exact" }),
      ]);
      setConnected((st?.[0] as any)?.active_provider ?? null);
      setHoldingsCount(hc ?? 0);
      setWatchlistCount(wc ?? 0);
    } catch (e) { console.error(e); }
  };

  const loadIndices = async () => {
    setBusy("indices");
    try {
      const r = await callFn("market-indices", {});
      setIndices(r?.quotes ?? []);
      setBreadth(r?.breadth ?? null);
    } catch (e) { push(toSafeError(e, "Indices refresh failed").message, "err"); }
    finally { setBusy(null); }
  };

  const loadInsight = async () => {
    setBusy("insight");
    try {
      const r = await callFn("market-morning-insight", {});
      setInsight(r?.summary ?? "");
    } catch (e) { push(toSafeError(e, "AI insight failed").message, "err"); }
    finally { setBusy(null); }
  };

  useEffect(() => { load(); loadIndices(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Market Summary" index="MK.D1" actions={
        <Btn size="sm" onClick={loadIndices} disabled={busy !== null}>
          <RefreshCw size={11} style={{ marginRight: 4 }} /> {busy === "indices" ? "refreshing…" : "refresh"}
        </Btn>
      }>
        {!connected && (
          <div style={{ marginBottom: 12, padding: 10, border: "1px dashed var(--edge)", fontSize: 12, color: "var(--text-dim)" }}>
            Using Yahoo Finance for indices.{" "}
            <Link to="/market/settings" style={{ color: "var(--accent)" }}>Connect Kotak Neo</Link> for live NSE quotes, holdings sync and breakout scoring.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
          {indices.length === 0 && <div className="hud-label" style={{ color: "var(--text-dim)" }}>NO DATA — TAP REFRESH</div>}
          {indices.map((q) => (
            <div key={q.symbol} style={{ padding: 10, border: "1px solid var(--edge)" }}>
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>{q.name}</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>
                {Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: 11, color: (q.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                {q.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
              </div>
            </div>
          ))}
        </div>
        {breadth && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {breadth.advances != null && <Chip tone="ok">Advances {breadth.advances}</Chip>}
            {breadth.declines != null && <Chip tone="err">Declines {breadth.declines}</Chip>}
            {breadth.unchanged != null && <Chip tone="neutral">Unchanged {breadth.unchanged}</Chip>}
            {breadth.new_highs != null && <Chip tone="ok">52w highs {breadth.new_highs}</Chip>}
            {breadth.new_lows != null && <Chip tone="err">52w lows {breadth.new_lows}</Chip>}
          </div>
        )}
      </HudPanel>

      <HudPanel title="Portfolio Pulse" index="MK.D2">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          <StatTile label="Holdings" value={holdingsCount.toString()} to="/market/holdings" />
          <StatTile label="Watchlist" value={watchlistCount.toString()} to="/market/watchlist" />
          <StatTile label="Ready to buy" value="—" hint="Score engine · Phase 2" />
          <StatTile label="Near breakout" value="—" hint="Score engine · Phase 2" />
          <StatTile label="Weak stocks" value="—" hint="Score engine · Phase 2" />
        </div>
      </HudPanel>

      <HudPanel title="AI Daily Insight" index="MK.D3" actions={
        <Btn size="sm" onClick={loadInsight} disabled={busy !== null}>
          <Sparkles size={11} style={{ marginRight: 4 }} /> {busy === "insight" ? "generating…" : "generate"}
        </Btn>
      }>
        {insight
          ? <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{insight}</div>
          : <div className="hud-label" style={{ color: "var(--text-dim)" }}>Tap generate — JARVIS will read today's market breadth, your holdings and watchlist and give you an actionable brief.</div>}
      </HudPanel>

      <HudPanel title="Breakout Radar" index="MK.D4">
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          <TrendingUp size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
          Breakout probability engine (0–100 score across volume spike, RSI/MACD, EMA stack, delivery %, sector strength, market breadth) ships in Phase 2. Track candidates via your{" "}
          <Link to="/market/watchlist" style={{ color: "var(--accent)" }}>watchlist</Link>.
        </div>
      </HudPanel>
    </div>
  );
}

function StatTile({ label, value, to, hint }: { label: string; value: string; to?: string; hint?: string }) {
  const body = (
    <div style={{ padding: 10, border: "1px solid var(--edge)", height: "100%" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--accent)" }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: "none" }}>{body}</Link> : body;
}
