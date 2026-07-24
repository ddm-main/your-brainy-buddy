// PortfolioOverview — unified snapshot: funds + holdings summary + open positions
// summary. Detail-level tables continue to live on their own routes.
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { supabase } from "@/integrations/supabase/client";
import { FundsCard } from "@/components/market/FundsCard";
import { useQuotes, usePositions } from "@/lib/market/hooks";
import { holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";

type Holding = { symbol: string; exchange: string; quantity: number; avg_price: number };

const inr = (n: number | null) => n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
const pct = (n: number | null) => n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export default function PortfolioOverview() {
  const [rows, setRows] = useState<Holding[]>([]);
  useEffect(() => { (async () => {
    const { data } = await supabase.from("market_holdings").select("symbol,exchange,quantity,avg_price");
    setRows((data ?? []) as Holding[]);
  })(); }, []);

  const { data: positionsData } = usePositions();
  const positions = positionsData ?? [];

  const holdingKeys = useMemo(() => rows.map((h) => `${h.exchange}:${h.symbol}`), [rows]);
  const positionKeys = useMemo(() => positions.map((p) => `${p.exchange}:${p.symbol}`), [positions]);
  const allKeys = useMemo(() => [...new Set([...holdingKeys, ...positionKeys])], [holdingKeys, positionKeys]);
  useEffect(() => { subscribeSymbolsForTicks(allKeys); }, [allKeys]);
  const { data: quotesData } = useQuotes(allKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, import("@/lib/market/types").Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks), [restQuotes, liveTicks]);

  const hSummary = useMemo(() => {
    let invested = 0, current = 0, unresolved = 0;
    const dayPnls: (number | null)[] = [];
    for (const h of rows) {
      const c = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: quotes[quoteKey(h.exchange, h.symbol)] });
      if (c.current == null) { unresolved++; continue; }
      invested += c.invested; current += c.current; dayPnls.push(c.todayPnl);
    }
    const dayPnl = sumNullable(dayPnls);
    const pnl = rows.length === 0 || unresolved === rows.length ? null : current - invested;
    return { invested, current, pnl, pnlPct: pnl == null || !invested ? null : (pnl / invested) * 100, dayPnl, count: rows.length };
  }, [rows, quotes]);

  const pSummary = useMemo(() => {
    let unrealized = 0, exposure = 0;
    for (const p of positions) {
      const q = quotes[quoteKey(p.exchange, p.symbol)];
      const ltp = q?.ltp;
      if (ltp == null) continue;
      const sign = p.side === "long" ? 1 : -1;
      unrealized += sign * (ltp - p.entry_price) * p.quantity;
      exposure += ltp * p.quantity;
    }
    return { unrealized, exposure, count: positions.length };
  }, [positions, quotes]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
      <FundsCard />
      <HudPanel flow title="Holdings" index="MK.PO1" actions={<><PriceSourceChip compact /> <Link to="/market/holdings" className="hud-label" style={{ color: "var(--accent-soft)", marginLeft: 6 }}>view →</Link></>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
          <Stat label="Invested" value={inr(hSummary.invested)} />
          <Stat label="Current" value={inr(hSummary.current)} />
          <Stat label="Total P&L" value={inr(hSummary.pnl)} tone={hSummary.pnl == null ? undefined : hSummary.pnl >= 0 ? "ok" : "err"} />
          <Stat label="Return" value={pct(hSummary.pnlPct)} tone={hSummary.pnlPct == null ? undefined : hSummary.pnlPct >= 0 ? "ok" : "err"} />
          <Stat label="Today" value={inr(hSummary.dayPnl)} tone={hSummary.dayPnl == null ? undefined : hSummary.dayPnl >= 0 ? "ok" : "err"} />
          <Stat label="Symbols" value={String(hSummary.count)} />
        </div>
      </HudPanel>
      <HudPanel flow title="Positions" index="MK.PO2" actions={<Link to="/market/positions" className="hud-label" style={{ color: "var(--accent-soft)" }}>view →</Link>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
          <Stat label="Open" value={String(pSummary.count)} />
          <Stat label="Exposure" value={inr(pSummary.exposure)} />
          <Stat label="Unrealized" value={inr(pSummary.unrealized)} tone={pSummary.unrealized >= 0 ? "ok" : "err"} />
        </div>
      </HudPanel>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err)" : "var(--text)";
  return (
    <div style={{ padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ color, fontSize: 15, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
