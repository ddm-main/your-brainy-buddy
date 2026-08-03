import { useEffect, useState } from "react";
import { Activity, Bell, Camera, LayoutGrid, Maximize2, Minimize2, Save, Search, Star, Trash2 } from "lucide-react";
import { Menu, MenuItem, MenuGroup, MenuDivider } from "@/components/hud/Menu";
import { safeStorage } from "@/lib/safeStorage";
import type { ChartType } from "@/components/market/CandleChart";
import {
  OVERLAY_DEFS, OSCILLATOR_DEFS,
  type IndicatorType, type IndicatorDef,
} from "@/lib/market/indicatorRegistry";

// Favourite indicator types, persisted locally so the ★ tab survives reloads.
const FAV_INDICATORS_KEY = "mk.chart.favIndicators";
const ALL_TYPES = new Set<IndicatorType>([...OVERLAY_DEFS, ...OSCILLATOR_DEFS].map((d) => d.type));


// Trimmed to the timeframes the backend actually serves without duplicates.
// Dropped: 3m/30m (dupes of neighbours), 2h/4h (no EOD pipeline coverage for
// Indian equities), 45m/3h (no INTRADAY map entry in market-candles — the
// edge fn 400s on them and the chart went blank). TV mode still accepts
// everything via tvInterval(). 1W/1M are resampled from the stored daily
// series by market-candles.
export const TIMEFRAMES = [
  { key: "1m", label: "1m", intraday: true },
  { key: "5m", label: "5m", intraday: true },
  { key: "15m", label: "15m", intraday: true },
  { key: "1h", label: "1h", intraday: true },
  { key: "1D", label: "1D", intraday: false },
  { key: "1W", label: "1W", intraday: false },
  { key: "1M", label: "1M", intraday: false },
] as const;

// Viewport ranges for non-intraday charts. These only move the visible
// window — the full series stays loaded, so panning left still reveals
// everything the provider returned.
export const CHART_RANGES = [
  { key: "1Y", label: "1Y", years: 1 },
  { key: "3Y", label: "3Y", years: 3 },
  { key: "5Y", label: "5Y", years: 5 },
  { key: "ALL", label: "All", years: null },
] as const;

export type ChartRange = typeof CHART_RANGES[number]["key"];

// Approximate bars per year for each timeframe — NSE trades ~250 sessions a
// year, ~6.25 hourly bars per session.
const BARS_PER_YEAR: Record<string, number> = {
  "1m": 250 * 375,
  "5m": 250 * 75,
  "15m": 250 * 25,
  "1h": 250 * 6.25,
  "1D": 250,
  "1W": 52,
  "1M": 12,
};

// Approximate bar counts per timeframe for a given number of years.
export function rangeToBars(range: ChartRange, tf: string): number | null {
  const years = CHART_RANGES.find((r) => r.key === range)?.years ?? null;
  if (years == null) return null;
  const perYear = BARS_PER_YEAR[tf] ?? 250;
  return Math.max(20, Math.round(years * perYear));
}

export function isIntraday(tf: string): boolean {
  return TIMEFRAMES.find((t) => t.key === tf)?.intraday ?? false;
}




export interface ChartSettings {
  grid: boolean;
  logScale: boolean;
  priceLine: boolean;
  sessionBreaks: boolean;
  // Crosshair magnet. Off = free-floating crosshair (TradingView default):
  // the price label tracks the exact cursor y. On = snap to nearest OHLC.
  magnet: boolean;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  grid: true,
  logScale: false,
  priceLine: true,
  sessionBreaks: false,
  magnet: false,
};


export interface ChartToolbarProps {
  symbol: string;
  exchange?: "NSE" | "BSE";
  tf: string;
  onTf: (v: string) => void;
  chartType: ChartType;
  onChartType: (v: ChartType) => void;
  onAddStudy: (type: IndicatorType) => void;
  onResetStudies?: () => void;
  /** Clears user-dragged sub-pane heights and reapplies the auto layout. */
  onResetPanes?: () => void;
  /** Visible studies (drawn on chart). */
  studyCount?: number;
  /** All studies including hidden — shown as "visible/total". */
  totalStudyCount?: number;
  settings?: ChartSettings;
  onSettings?: (updater: (prev: ChartSettings) => ChartSettings) => void;
  onFullscreen: () => void;
  /** True when the chart is already expanded (flips the icon to collapse). */
  fullscreen?: boolean;
  onAlert: () => void;
  /** Optional badge count of active alerts (rendered on the Alert button). */
  alertCount?: number;
  onScreenshot?: () => void;
  onSaveLayout?: (name: string) => void;
  onLoadLayout?: (name: string) => void;
  onDeleteLayout?: (name: string) => void;
  savedLayouts?: string[];
  /** True for intraday timeframes (drives VWAP availability in picker). */
  intraday?: boolean;
  range?: ChartRange;
  onRange?: (v: ChartRange) => void;
}

export function ChartToolbar({
  symbol, exchange = "NSE", tf, onTf, chartType, onChartType, onAddStudy, onResetStudies,
  studyCount = 0, totalStudyCount,
  settings, onSettings, onFullscreen, fullscreen = false, onAlert, alertCount = 0, onScreenshot,
  onSaveLayout, onLoadLayout, onDeleteLayout, savedLayouts = [], onResetPanes,
  intraday = false,
  range = "ALL", onRange,
}: ChartToolbarProps) {
  void chartType; void onChartType; // chart type is fixed to candles
  const total = totalStudyCount ?? studyCount;
  const countLabel = total > 0 ? (studyCount === total ? `${studyCount}` : `${studyCount}/${total}`) : "";
  const s = settings ?? DEFAULT_SETTINGS;


  return (
    <div className="mk-chart-toolbar" role="toolbar" aria-label="Chart controls">
      {/* Interval — inline segmented buttons (TradingView / Kite pattern).
          Keyboard: press number for quick TF switch (1=1m, 2=5m, 3=15m,
          4=1h, 5=1D). See Analysis.tsx keydown handler. */}
      <div className="mk-tf-seg" role="group" aria-label="Chart timeframe">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-label={`Timeframe ${t.label}`}
            aria-pressed={tf === t.key}
            className={`mk-tf-btn ${tf === t.key ? "is-on" : ""}`}
            onClick={() => onTf(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!intraday && onRange && (
        <>
          <Divider />
          <Menu label={CHART_RANGES.find((r) => r.key === range)?.label ?? "1Y"} width={160}>
            {(close) => (
              <MenuGroup title="Range">
                {CHART_RANGES.map((r) => (
                  <MenuItem key={r.key} selected={range === r.key} onClick={() => { onRange(r.key); close(); }}>
                    {r.label}
                  </MenuItem>
                ))}
              </MenuGroup>
            )}
          </Menu>
        </>
      )}

      <Divider />


      {/* Indicators */}
      <Menu
        label={<span>Indicators{countLabel && <span className="mk-menu-count">{countLabel}</span>}</span>}
        icon={<Activity size={12} />}
        width={320}
      >
        <IndicatorPicker onAddStudy={onAddStudy} intraday={intraday} />
      </Menu>

      <Divider />

      <button type="button" className="mk-menu-trigger" onClick={onAlert} title={alertCount > 0 ? `${alertCount} active alert${alertCount === 1 ? "" : "s"} · click to create another` : "Create price alert"}>
        <span className="mk-menu-ico"><Bell size={12} /></span>
        <span>Alert{alertCount > 0 && <span className="mk-menu-count">{alertCount}</span>}</span>
      </button>


      {onSaveLayout && (
        <Menu label="Layouts" icon={<LayoutGrid size={12} />} width={240}>
          {(close) => (
            <>
              {savedLayouts.length > 0 && (
                <>
                  <MenuGroup title="Saved">
                    {savedLayouts.map((name) => (
                      <div key={name} style={{ display: "flex", alignItems: "center" }}>
                        <button
                          type="button"
                          className="mk-menu-item"
                          style={{ flex: 1 }}
                          onClick={() => { onLoadLayout?.(name); close(); }}
                          title={`Load layout: ${name}`}
                        >
                          <span className="mk-menu-item-check" />
                          <span style={{ flex: 1, textAlign: "left" }}>{name}</span>
                        </button>
                        {onDeleteLayout && (
                          <button
                            type="button"
                            className="mk-menu-item"
                            style={{ flex: "0 0 auto", padding: "6px 10px", opacity: 0.7 }}
                            title={`Delete layout: ${name}`}
                            onClick={(e) => { e.stopPropagation(); onDeleteLayout(name); }}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    ))}
                  </MenuGroup>
                  <MenuDivider />
                </>
              )}
              <MenuGroup title="Save">
                <MenuItem
                  onClick={() => {
                    const name = window.prompt("Layout name", `Layout ${savedLayouts.length + 1}`);
                    if (name && name.trim()) onSaveLayout(name.trim());
                    close();
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Save size={11} /> Save current layout
                  </span>
                </MenuItem>
              </MenuGroup>
              {onResetPanes && (
                <>
                  <MenuDivider />
                  <MenuGroup title="Panes">
                    <MenuItem onClick={() => { onResetPanes(); close(); }}>
                      Reset pane sizes
                    </MenuItem>
                  </MenuGroup>
                </>
              )}

            </>
          )}
        </Menu>
      )}


      <div style={{ flex: 1, minWidth: 8 }} />

      {onScreenshot && (
        <button type="button" className="mk-menu-trigger" onClick={onScreenshot} title="Copy chart snapshot">
          <span className="mk-menu-ico"><Camera size={12} /></span>
        </button>
      )}
      <button
        type="button"
        className="mk-menu-trigger"
        onClick={onFullscreen}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen chart"}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F) · exit with Esc"}
      >
        <span className="mk-menu-ico">{fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</span>
      </button>

    </div>
  );
}

// Searchable, scrollable indicator type picker. Category tabs let the user
// scope to Overlays or Oscillators (industry-standard split) so the list
// stops feeling like an unfindable dump.
function IndicatorPicker({ onAddStudy, intraday = false }: { onAddStudy: (type: IndicatorType) => void; intraday?: boolean }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"fav" | "all" | "overlay" | "oscillator">("all");
  const [favs, setFavs] = useState<IndicatorType[]>(() =>
    safeStorage.getJSON<IndicatorType[]>(FAV_INDICATORS_KEY, []).filter((t) => ALL_TYPES.has(t)),
  );

  const toggleFav = (type: IndicatorType) => {
    setFavs((prev) => {
      const next = prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type];
      safeStorage.setJSON(FAV_INDICATORS_KEY, next);
      return next;
    });
  };

  const query = q.trim().toLowerCase();
  const match = (d: IndicatorDef) => !query || d.label.toLowerCase().includes(query) || d.type.toLowerCase().includes(query);
  const overlays = OVERLAY_DEFS.filter(match);
  const oscillators = OSCILLATOR_DEFS.filter(match);
  const favDefs = favs
    .map((t) => [...OVERLAY_DEFS, ...OSCILLATOR_DEFS].find((d) => d.type === t))
    .filter((d): d is IndicatorDef => !!d && match(d));
  const onlyFavs = tab === "fav";
  const showOverlays = !onlyFavs && tab !== "oscillator";
  const showOscillators = !onlyFavs && tab !== "overlay";

  const Item = (d: IndicatorDef) => {
    const disabled = !!d.intradayOnly && !intraday;
    const isFav = favs.includes(d.type);
    return (
      <div key={d.type} style={{ display: "flex", alignItems: "center" }}>
        <button
          type="button"
          className="mk-menu-item"
          onClick={() => { if (!disabled) onAddStudy(d.type); }}
          disabled={disabled}
          title={disabled ? `${d.label} is intraday-only — switch to an intraday timeframe.` : undefined}
          style={{ flex: 1, ...(disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
        >
          <span className="mk-ind-swatch" style={{ background: d.lines[0].defaultColor }} />
          <span style={{ flex: 1, textAlign: "left" }}>{d.label}{disabled && <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>intraday</span>}</span>
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleFav(d.type); }}
          aria-label={isFav ? `Remove ${d.label} from favourites` : `Add ${d.label} to favourites`}
          aria-pressed={isFav}
          title={isFav ? "Remove from favourites" : "Add to favourites"}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "0 8px",
            color: isFav ? "var(--accent, #ffb84d)" : "var(--text-muted)",
            opacity: isFav ? 1 : 0.55, display: "flex", alignItems: "center",
          }}
        >
          <Star size={11} fill={isFav ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };


  const Tab = ({ v, label, count }: { v: "fav" | "all" | "overlay" | "oscillator"; label: string; count: number }) => (
    <button
      type="button"
      className={`mk-ind-tab ${tab === v ? "is-on" : ""}`}
      onClick={(e) => { e.stopPropagation(); setTab(v); }}
    >
      {label}<span className="mk-ind-tab-count">{count}</span>
    </button>
  );

  const emptyList = onlyFavs
    ? favDefs.length === 0
    : ((showOverlays ? overlays.length : 0) + (showOscillators ? oscillators.length : 0)) === 0;

  return (
    <div className="mk-ind-picker">
      <div className="mk-ind-tabs" onMouseDown={(e) => e.stopPropagation()}>
        <Tab v="fav" label="★" count={favs.length} />
        <Tab v="all" label="All" count={overlays.length + oscillators.length} />
        <Tab v="overlay" label="Overlays" count={overlays.length} />
        <Tab v="oscillator" label="Oscillators" count={oscillators.length} />
      </div>
      <div className="mk-ind-search">
        <Search size={12} style={{ opacity: 0.6, flex: "0 0 auto" }} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="Search indicators…"
          aria-label="Search indicators"
        />
      </div>
      <div className="mk-ind-list">
        {favDefs.length > 0 && (tab === "all" || onlyFavs) && (
          <MenuGroup title="Favourites">{favDefs.map(Item)}</MenuGroup>
        )}
        {showOverlays && overlays.length > 0 && <MenuGroup title="Overlays">{overlays.map(Item)}</MenuGroup>}
        {showOscillators && oscillators.length > 0 && <MenuGroup title="Oscillators">{oscillators.map(Item)}</MenuGroup>}
        {emptyList && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)" }}>
            {onlyFavs && !query ? "No favourites yet — tap the ★ next to an indicator." : "No match"}
          </div>
        )}
      </div>
    </div>
  );
}


function Divider() {
  return <span aria-hidden className="mk-toolbar-divider" />;
}
