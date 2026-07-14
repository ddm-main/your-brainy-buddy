// Intelligence — Morning Brief + live market strip. The brief is cached
// in public.morning_briefs (one per user per day); the market strip reads
// public.market_quotes and offers a manual "refresh" that hits
// finance-market-sync. Both sources fail-soft: an empty cache renders a
// clear call-to-action rather than an error.
import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { db } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { RefreshCw, Sparkles } from "lucide-react";
import { toSafeError } from "@/lib/errors";

type Quote = {
  symbol: string; name: string; kind: string; price: number;
  change_abs: number | null; change_pct: number | null;
  currency: string; fetched_at: string;
};

function toneFor(pct: number | null | undefined): "ok" | "warn" | "err" | "muted" {
  if (pct == null) return "muted";
  if (pct > 0) return "ok";
  if (pct < 0) return "err";
  return "muted";
}

function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

function formatPrice(q: Quote): string {
  const symbol = q.currency === "INR" ? "₹" : q.currency === "USD" ? "$" : "";
  return `${symbol}${Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export default function Intelligence() {
  const push = useUi((s) => s.push);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(true);
  const [syncingMarket, setSyncingMarket] = useState(false);
  const [brief, setBrief] = useState<string>("");
  const [briefDate, setBriefDate] = useState<string>("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefCached, setBriefCached] = useState<boolean>(false);

  const loadQuotes = async () => {
    try {
      const rows = await db.finance.quotes();
      setQuotes(rows as unknown as Quote[]);
    } catch (e: unknown) { push(toSafeError(e, "Failed to load market data").message, "err"); }
    finally { setLoadingQuotes(false); }
  };

  const loadBrief = async (force = false) => {
    setBriefLoading(true);
    try {
      const r = await db.finance.morningBrief(force);
      setBrief(r?.summary ?? "");
      setBriefDate(r?.brief_date ?? "");
      setBriefCached(Boolean(r?.cached));
    } catch (e: unknown) { push(toSafeError(e, "Morning brief failed").message, "err"); }
    finally { setBriefLoading(false); }
  };

  const syncMarket = async () => {
    setSyncingMarket(true);
    try {
      const r = await db.finance.syncMarket();
      push(`Refreshed ${r?.synced ?? 0} quotes`, "ok");
      await loadQuotes();
    } catch (e: unknown) { push(toSafeError(e, "Market refresh failed").message, "err"); }
    finally { setSyncingMarket(false); }
  };

  useEffect(() => { loadQuotes(); loadBrief(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const indian = quotes.filter((q) => q.kind === "index" && q.currency === "INR");
  const global = quotes.filter((q) => q.kind === "index" && q.currency !== "INR");
  const commodities = quotes.filter((q) => q.kind === "commodity" || q.kind === "fx" || q.kind === "crypto");
  const staleMinutes = quotes.length
    ? Math.round((Date.now() - new Date(quotes[0].fetched_at).getTime()) / 60000)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflowY: "auto" }}>
      <HudPanel
        title="Morning Brief"
        index="MB"
        live={brief ? "ok" : "warn"}
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {briefDate && <Chip tone={briefCached ? "neutral" : "accent"}>{briefCached ? "cached" : "fresh"} · {briefDate}</Chip>}
            <Btn size="sm" onClick={() => loadBrief(true)} disabled={briefLoading}>
              <Sparkles size={11} style={{ marginRight: 4 }} />
              {briefLoading ? "generating…" : "regenerate"}
            </Btn>
          </div>
        }
      >
        {brief
          ? <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text)", whiteSpace: "pre-wrap" }}>{brief}</div>
          : <div className="hud-label">No brief yet — tap regenerate to have JARVIS pull today's markets, your portfolio, and upcoming bills into a single readout.</div>}
      </HudPanel>

      <HudPanel
        title="Markets"
        index="MKT"
        live={loadingQuotes ? "warn" : quotes.length ? "ok" : "warn"}
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {staleMinutes != null && <Chip tone={staleMinutes > 30 ? "warn" : "neutral"}>{staleMinutes}m ago</Chip>}
            <Btn size="sm" onClick={syncMarket} disabled={syncingMarket}>
              <RefreshCw size={11} style={{ marginRight: 4 }} />
              {syncingMarket ? "refreshing…" : "refresh"}
            </Btn>
          </div>
        }
      >
        {quotes.length === 0 && !loadingQuotes ? (
          <div className="hud-label">No market data cached yet — tap refresh to pull Nifty, Sensex, global indices, USD/INR, gold, and crude from Yahoo Finance.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              { label: "Indian Indices", rows: indian },
              { label: "Global Indices", rows: global },
              { label: "Currency · Commodities · Crypto", rows: commodities },
            ].map((group) => group.rows.length > 0 && (
              <div key={group.label}>
                <div className="hud-label" style={{ marginBottom: 6 }}>{group.label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                  {group.rows.map((q) => {
                    const tone = toneFor(q.change_pct);
                    const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--text-dim)";
                    return (
                      <div key={q.symbol} style={{ padding: 10, border: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 4 }}>
                        <div className="hud-label" style={{ color: "var(--text-dim)" }}>{q.name}</div>
                        <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--text)" }}>{formatPrice(q)}</div>
                        <div style={{ fontSize: 11, color }}>{formatPct(q.change_pct)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </HudPanel>
    </div>
  );
}
