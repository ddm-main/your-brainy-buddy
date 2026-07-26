// PortfolioOverview — Groww/Kite-style unified snapshot: hero P&L,
// funds card, holdings summary, positions summary. Auto-syncs once per
// hour per tab session, but only when a broker is actually connected.
import { Link } from "react-router-dom";
import { useEffect, useMemo } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn } from "@/components/hud/HudControls";
import { RefreshCw } from "lucide-react";
import { FundsCard } from "@/components/market/FundsCard";
import {
  useHoldings,
  useMarketSettings,
  usePositions,
  useQuotes,
  useSyncHoldings,
  useSyncPositions,
  useTodayRealized,
} from "@/lib/market/hooks";
import { holdingPnl, positionPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";
import { useFunds } from "@/lib/market/orderHooks";

const inr = (n: number | null) => n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
const pct = (n: number | null) => n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const AUTO_SYNC_KEY = "market:portfolio:auto-sync:last";
const AUTO_SYNC_MIN_MS = 60 * 60 * 1000;

export default function PortfolioOverview() {
  const { data: holdings = [] } = useHoldings();
  const { data: positions = [] } = usePositions();
  const { data: settings = [] } = useMarketSettings();
  const { data: realizedToday = [] } = useTodayRealized();
  const funds = useFunds();
  const syncHoldings = useSyncHoldings();
  const syncPositions = useSyncPositions();
  const connected = settings.some((s) => s.active_provider === "kotak_neo" && s.connection_status === "connected");
  const sessionExpired = funds.data?.reason_code === "session_expired";

  // Auto-sync once/hr per tab session — only when broker is connected, and
  // only stamp the key on successful runs so a transient error doesn't
  // silence retries for an hour.
  useEffect(() => {
    if (!connected) return;
    const last = Number(sessionStorage.getItem(AUTO_SYNC_KEY) || 0);
    if (Date.now() - last < AUTO_SYNC_MIN_MS) return;
    Promise.allSettled([
      syncHoldings.mutateAsync(),
      syncPositions.mutateAsync(),
    ]).then((results) => {
      if (results.every((r) => r.status === "fulfilled")) {
        sessionStorage.setItem(AUTO_SYNC_KEY, String(Date.now()));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const holdingKeys = useMemo(() => holdings.map((h) => `${h.exchange}:${h.symbol}`), [holdings]);
  const positionKeys = useMemo(() => positions.filter((p) => !p.closed_at).map((p) => `${p.exchange}:${p.symbol}`), [positions]);
  const allKeys = useMemo(() => [...new Set([...holdingKeys, ...positionKeys])], [holdingKeys, positionKeys]);
  useEffect(() => { subscribeSymbolsForTicks(allKeys); }, [allKeys]);
  const { data: quotesData, dataUpdatedAt: quotesUpdatedAt } = useQuotes(allKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, import("@/lib/market/types").Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks, quotesUpdatedAt), [restQuotes, liveTicks, quotesUpdatedAt]);

  // Holdings summary — uses the same null-vs-zero contract as Holdings.tsx.
  const hSummary = useMemo(() => {
    let invested = 0, current = 0, unresolved = 0;
    const dayPnls: (number | null)[] = [];
    let anyStale = false;
    for (const h of holdings) {
      const q = quotes[quoteKey(h.exchange, h.symbol)];
      if (q?.stale) anyStale = true;
      const c = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: q });
      if (c.current == null) { unresolved++; continue; }
      invested += c.invested;
      current += c.current;
      dayPnls.push(c.todayPnl);
    }
    const allUnresolved = holdings.length > 0 && unresolved === holdings.length;
    const dayPnl = sumNullable(dayPnls);
    const pnl = allUnresolved ? null : current - invested;
    const pnlPct = pnl == null || !invested ? null : (pnl / Math.abs(invested)) * 100;
    const prevValue = dayPnl == null ? null : current - dayPnl;
    const dayPnlPct = dayPnl == null || !prevValue ? null : (dayPnl / Math.abs(prevValue)) * 100;
    return {
      invested: allUnresolved ? null : invested,
      current: allUnresolved ? null : current,
      pnl, pnlPct, dayPnl, dayPnlPct,
      count: holdings.length, anyStale,
    };
  }, [holdings, quotes]);

  // Positions summary — null when everything is unresolved (avoids "flat book"
  // illusion) and adds today's realized intraday to the day figure.
  const pSummary = useMemo(() => {
    const open = positions.filter((p) => !p.closed_at);
    let unrealized = 0, exposure = 0, unresolved = 0;
    const dayPnls: (number | null)[] = [];
    for (const p of open) {
      const q = quotes[quoteKey(p.exchange, p.symbol)];
      const calc = positionPnl({ quantity: p.quantity, entryPrice: p.entry_price, side: p.side, quote: q });
      if (calc.unrealized == null) { unresolved++; continue; }
      unrealized += calc.unrealized;
      exposure += Math.abs(p.quantity) * (calc.ltp ?? 0);
      dayPnls.push(calc.todayPnl);
    }
    const allUnresolved = open.length > 0 && unresolved === open.length;
    const dayOpen = sumNullable(dayPnls);
    const realizedDay = realizedToday.reduce((a, r) => a + (Number(r.realized) || 0), 0);
    const day = dayOpen == null && realizedDay === 0 ? null : (dayOpen ?? 0) + realizedDay;
    return {
      unrealized: allUnresolved ? null : unrealized,
      exposure: allUnresolved ? null : exposure,
      count: open.length,
      day,
      realizedToday: realizedDay,
    };
  }, [positions, quotes, realizedToday]);

  // Hero — combine holdings + open positions into a single "book" view like Groww.
  const hero = useMemo(() => {
    const investedH = hSummary.invested ?? 0;
    const currentH = hSummary.current ?? 0;
    const investedP = 0; // positions don't have "invested" the same way (margin-blocked)
    const totalInvested = investedH + investedP;
    const totalCurrent = currentH; // + open pos MTM below
    const openUnrealized = pSummary.unrealized ?? 0;
    const totalPnl = (hSummary.pnl ?? 0) + openUnrealized;
    const totalReturns = totalInvested ? (totalPnl / totalInvested) * 100 : null;
    const dayPnl = (hSummary.dayPnl ?? 0) + (pSummary.day ?? 0);
    const dayPnlPct = hSummary.dayPnlPct; // holdings-only, since positions have no meaningful "prev value"
    const anyResolved = hSummary.current != null || pSummary.unrealized != null;
    return {
      totalInvested: anyResolved ? totalInvested : null,
      totalCurrent: anyResolved ? totalCurrent + openUnrealized : null,
      totalPnl: anyResolved ? totalPnl : null,
      totalReturns,
      dayPnl: anyResolved ? dayPnl : null,
      dayPnlPct,
    };
  }, [hSummary, pSummary]);

  const holdingsSyncBtn = connected && (
    <Btn size="sm" onClick={() => syncHoldings.mutate()} disabled={syncHoldings.isPending}>
      <RefreshCw size={11} style={{ marginRight: 4 }} /> {syncHoldings.isPending ? "syncing…" : "sync"}
    </Btn>
  );
  const positionsSyncBtn = connected && (
    <Btn size="sm" onClick={() => syncPositions.mutate()} disabled={syncPositions.isPending}>
      <RefreshCw size={11} style={{ marginRight: 4 }} /> {syncPositions.isPending ? "syncing…" : "sync"}
    </Btn>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Shared session-expired banner — beats three separate messages */}
      {sessionExpired && (
        <div className="hud-label" style={{
          padding: "8px 12px", border: "1px solid var(--warn)",
          background: "color-mix(in oklab, var(--warn) 10%, transparent)",
          color: "var(--warn)", display: "flex", justifyContent: "space-between",
          alignItems: "center", gap: 12,
        }}>
          <span>Broker session expired — funds, holdings and positions may be stale.</span>
          <Link to="/market/settings" style={{ color: "var(--accent)" }}>Reconnect Kotak →</Link>
        </div>
      )}

      {/* Hero — Groww-style single-glance state */}
      <HudPanel flow title="Portfolio" index="MK.PO0" actions={<PriceSourceChip compact />}>
        <div style={{
          display: "grid", gap: 16,
          gridTemplateColumns: "1.4fr 1fr", alignItems: "start",
        }}>
          <div>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>Current value</div>
            <div style={{ fontSize: 28, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              {inr(hero.totalCurrent)}
              {hSummary.anyStale && <span className="hud-label" style={{ marginLeft: 8, color: "var(--warn)", fontSize: 10 }}>stale</span>}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
              <MiniStat label="Invested" value={inr(hero.totalInvested)} />
              <MiniStat label="Total P&L"
                value={inr(hero.totalPnl)}
                tone={hero.totalPnl == null ? undefined : hero.totalPnl >= 0 ? "ok" : "err"} />
              <MiniStat label="Returns"
                value={pct(hero.totalReturns)}
                tone={hero.totalReturns == null ? undefined : hero.totalReturns >= 0 ? "ok" : "err"} />
            </div>
          </div>
          <div style={{ borderLeft: "1px solid var(--edge)", paddingLeft: 16 }}>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>Today's P&L</div>
            <div style={{
              fontSize: 24, marginTop: 4, fontVariantNumeric: "tabular-nums",
              color: hero.dayPnl == null ? "var(--text)" : hero.dayPnl >= 0 ? "var(--ok)" : "var(--danger)",
            }}>
              {hero.dayPnl == null ? "—" : `${hero.dayPnl >= 0 ? "+" : ""}${inr(hero.dayPnl)}`}
              {hero.dayPnlPct != null && (
                <span style={{ fontSize: 13, marginLeft: 6 }}>
                  ({hero.dayPnlPct >= 0 ? "+" : ""}{hero.dayPnlPct.toFixed(2)}%)
                </span>
              )}
            </div>
            {pSummary.realizedToday !== 0 && (
              <div className="hud-label" style={{ color: "var(--text-dim)", marginTop: 6, fontSize: 10 }}>
                incl. {inr(pSummary.realizedToday)} realized intraday
              </div>
            )}
          </div>
        </div>
      </HudPanel>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        <FundsCard />
        <HudPanel flow title="Holdings" index="MK.PO1" actions={<>{holdingsSyncBtn} <Link to="/market/holdings" className="hud-label" style={{ color: "var(--accent-soft)", marginLeft: 6 }}>view →</Link></>}>
          {syncHoldings.isError && (
            <div className="hud-label" style={{ color: "var(--warn, var(--text-dim))", marginBottom: 8 }}>
              Holdings sync failed — {(syncHoldings.error as Error)?.message ?? "unknown error"}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
            <Stat label="Invested" value={inr(hSummary.invested)} />
            <Stat label="Current" value={inr(hSummary.current)} />
            <Stat label="Total P&L" value={inr(hSummary.pnl)} tone={hSummary.pnl == null ? undefined : hSummary.pnl >= 0 ? "ok" : "err"} />
            <Stat label="Return" value={pct(hSummary.pnlPct)} tone={hSummary.pnlPct == null ? undefined : hSummary.pnlPct >= 0 ? "ok" : "err"} />
            <Stat
              label="Today"
              value={hSummary.dayPnl == null ? "—" : `${inr(hSummary.dayPnl)}${hSummary.dayPnlPct != null ? ` (${hSummary.dayPnlPct >= 0 ? "+" : ""}${hSummary.dayPnlPct.toFixed(2)}%)` : ""}`}
              tone={hSummary.dayPnl == null ? undefined : hSummary.dayPnl >= 0 ? "ok" : "err"}
            />
            <Stat label="Symbols" value={String(hSummary.count)} />
          </div>
        </HudPanel>
        <HudPanel flow title="Positions" index="MK.PO2" actions={<>{positionsSyncBtn} <Link to="/market/positions" className="hud-label" style={{ color: "var(--accent-soft)", marginLeft: 6 }}>view →</Link></>}>
          {syncPositions.isError && (
            <div className="hud-label" style={{ color: "var(--warn, var(--text-dim))", marginBottom: 8 }}>
              Positions sync failed — {(syncPositions.error as Error)?.message ?? "unknown error"}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
            <Stat label="Open" value={String(pSummary.count)} />
            <Stat label="Exposure" value={inr(pSummary.exposure)} />
            <Stat label="Unrealized" value={inr(pSummary.unrealized)} tone={pSummary.unrealized == null ? undefined : pSummary.unrealized >= 0 ? "ok" : "err"} />
            <Stat label="Today realized" value={inr(pSummary.realizedToday)} tone={pSummary.realizedToday === 0 ? undefined : pSummary.realizedToday > 0 ? "ok" : "err"} />
          </div>
        </HudPanel>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger, var(--err))" : "var(--text)";
  return (
    <div style={{ padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ color, fontSize: 15, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger, var(--err))" : "var(--text)";
  return (
    <div>
      <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>{label}</div>
      <div style={{ color, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
