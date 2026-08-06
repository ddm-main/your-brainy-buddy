// 0–100 score chip with component-breakdown tooltip.
import { useEffect, useState } from "react";
import { BAND_COLOR, bandOf } from "@/lib/market/scoreBands";
import { useScoreBandCuts } from "@/lib/market/scoreHistory";
import { supabase } from "@/integrations/supabase/client";

// The score_components blob is ~600 B a row. Shipping it for all 2 800
// screener rows to serve a tooltip that opens on one row at a time was one of
// the biggest egress items in the app, so the badge now fetches the breakdown
// for a single symbol on first hover and caches it for the session.
type ComponentKind = "breakout" | "prebreakout" | "swing" | "intraday" | "breakout_v4";
const componentCache = new Map<string, Record<string, number> | null>();

async function loadComponents(
  symbol: string, exchange: string, kind: ComponentKind,
): Promise<Record<string, number> | null> {
  const cacheKey = `${exchange}:${symbol}:${kind}`;
  if (componentCache.has(cacheKey)) return componentCache.get(cacheKey) ?? null;
  const column = kind === "swing" ? "swing_components"
    : kind === "intraday" ? "intraday_components"
    // v4 keeps its buckets in their own blob; it used to ride along with every
    // screener row (~10 MB/day) purely to serve this hover tooltip.
    : kind === "breakout_v4" ? "breakout_v4_components"
    : "score_components";
  const { data } = await (supabase as any)
    .from("market_stock_scores")
    .select(`v:${column}`)
    .eq("symbol", symbol).eq("exchange", exchange)
    .maybeSingle();
  const blob = data?.v ?? null;
  const out = kind === "breakout_v4" ? (blob?.buckets ?? null)
    : (kind === "breakout" || kind === "prebreakout") ? (blob?.[kind] ?? null)
    : blob;
  componentCache.set(cacheKey, out);
  return out;
}


export function ScoreBadge({
  score,
  components,
  symbol,
  exchange,
  kind,
  label,
  provisional,
  onClick,
}: {
  score: number | null | undefined;
  components?: Record<string, number> | null;
  // When `components` is not supplied, the badge lazy-loads the breakdown for
  // this symbol on hover instead of the caller pre-fetching it for every row.
  symbol?: string;
  exchange?: string | null;
  kind?: ComponentKind;
  label?: string;
  // True while only the neutral-context EOD pass has written this score —
  // sector strength / relative strength / regime are not in it yet.
  provisional?: boolean;
  // Default is hover-tooltip only (unchanged). When provided, the badge also
  // becomes clickable — stopPropagation so a badge nested in a clickable
  // table row navigates to ITS target, not the row's.
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [lazy, setLazy] = useState<Record<string, number> | null>(null);
  // Cached query — every badge on a table shares the one distribution row.
  const { data: cuts } = useScoreBandCuts();

  const wantsLazy = open && !components && !!symbol && !!kind;
  useEffect(() => {
    if (!wantsLazy) return;
    let alive = true;
    loadComponents(symbol!, exchange || "NSE", kind!)
      .then((c) => { if (alive) setLazy(c); })
      .catch(() => { /* tooltip simply stays empty */ });
    return () => { alive = false; };
  }, [wantsLazy, symbol, exchange, kind]);

  const shown = components ?? lazy;

  if (score == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;

  const band = bandOf(score, cuts);
  const color = BAND_COLOR[band];
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    >
      <span
        style={{
          display: "inline-block",
          minWidth: 34,
          textAlign: "center",
          padding: "1px 6px",
          borderRadius: 2,
          border: `1px solid ${color}`,
          color,
          fontFamily: "var(--font-hud)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          background: "rgba(0,0,0,0.25)",
          cursor: onClick ? "pointer" : undefined,
        }}
        title={provisional
          ? "Provisional — computed before market context (sector/RS/regime) was applied"
          : onClick ? `Open score breakdown — ${band.toUpperCase()}` : undefined}
      >
        {score}{provisional ? "*" : ""}
      </span>
      {open && (provisional || (shown && Object.keys(shown).length > 0) || wantsLazy) && (
        <span
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 190,
            padding: "8px 10px",
            background: "var(--bg-deep, #071019)",
            border: "1px solid var(--edge-strong)",
            borderRadius: 2,
            boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            fontSize: 10,
            fontFamily: "var(--font-hud)",
            color: "var(--text-dim)",
            textAlign: "left",
          }}
        >
          {label && (
            <span style={{ display: "block", color: "var(--accent-soft)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
              {label}
            </span>
          )}
          {provisional && (
            <span style={{ display: "block", color: "var(--warn)", marginBottom: 6 }}>
              Provisional — market context not applied yet
            </span>
          )}
          {wantsLazy && !shown && (
            <span style={{ display: "block", color: "var(--text-muted)" }}>loading breakdown…</span>
          )}

          {Object.entries(shown ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <span key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "1px 0" }}>
                <span>{k.replace(/_/g, " ")}</span>
                <span style={{ color: v > 0 ? "var(--accent)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {v > 0 ? `+${v}` : v}
                </span>
              </span>
            ))}
        </span>
      )}
    </span>
  );
}
