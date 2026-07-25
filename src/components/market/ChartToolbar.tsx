import { useEffect, useState } from "react";
import { CandlestickChart, LineChart, AreaChart, BarChart3, Activity, Bell, LayoutGrid, MoreHorizontal, Maximize2, ExternalLink, Settings, Camera, Save, Search, Trash2 } from "lucide-react";
import { Menu, MenuItem, MenuGroup, MenuDivider } from "@/components/hud/Menu";
import type { ChartType } from "@/components/market/CandleChart";
import {
  OVERLAY_DEFS, OSCILLATOR_DEFS,
  type IndicatorType, type IndicatorDef,
} from "@/lib/market/indicatorRegistry";

// Trimmed to the timeframes the backend actually serves without duplicates.
// Dropped: 3m/30m (dupes of neighbours), 2h/4h (no EOD pipeline coverage for
// Indian equities), 45m/3h (no INTRADAY map entry in market-candles — the
// edge fn 400s on them and the chart went blank). TV mode still accepts
// everything via tvInterval().
export const TIMEFRAMES = [
  { key: "1m", label: "1m", intraday: true },
  { key: "5m", label: "5m", intraday: true },
  { key: "15m", label: "15m", intraday: true },
  { key: "1h", label: "1h", intraday: true },
  { key: "1D", label: "1D", intraday: false },
  { key: "1W", label: "1W", intraday: false },
  { key: "1M", label: "1M", intraday: false },
] as const;

export function isIntraday(tf: string): boolean {
  return TIMEFRAMES.find((t) => t.key === tf)?.intraday ?? false;
}

const CHART_TYPES: Array<{ key: ChartType; label: string; icon: React.ReactNode }> = [
  { key: "candles", label: "Candles", icon: <CandlestickChart size={12} /> },
  { key: "bars", label: "Bars", icon: <BarChart3 size={12} /> },
  { key: "line", label: "Line", icon: <LineChart size={12} /> },
  { key: "area", label: "Area", icon: <AreaChart size={12} /> },
];


export interface ChartSettings {
  grid: boolean;
  logScale: boolean;
  priceLine: boolean;
  sessionBreaks: boolean;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  grid: true,
  logScale: false,
  priceLine: true,
  sessionBreaks: false,
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
  /** Visible studies (drawn on chart). */
  studyCount?: number;
  /** All studies including hidden — shown as "visible/total". */
  totalStudyCount?: number;
  settings?: ChartSettings;
  onSettings?: (updater: (prev: ChartSettings) => ChartSettings) => void;
  tvMode: boolean;
  onTvMode: (v: boolean) => void;
  onFullscreen: () => void;
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
}

export function ChartToolbar({
  symbol, exchange = "NSE", tf, onTf, chartType, onChartType, onAddStudy, onResetStudies,
  studyCount = 0, totalStudyCount,
  settings, onSettings, tvMode, onTvMode, onFullscreen, onAlert, alertCount = 0, onScreenshot,
  onSaveLayout, onLoadLayout, onDeleteLayout, savedLayouts = [],
  intraday = false,
}: ChartToolbarProps) {
  const activeType = CHART_TYPES.find((c) => c.key === chartType) ?? CHART_TYPES[0];
  const total = totalStudyCount ?? studyCount;
  const countLabel = total > 0 ? (studyCount === total ? `${studyCount}` : `${studyCount}/${total}`) : "";
  const s = settings ?? DEFAULT_SETTINGS;


  return (
    <div className="mk-chart-toolbar">
      {/* Interval */}
      <Menu label={tf} width={200} active>
        {(close) => (
          <MenuGroup title="Interval">
            {TIMEFRAMES.map((t) => (
              <MenuItem key={t.key} selected={tf === t.key} onClick={() => { onTf(t.key); close(); }}>
                {t.label}
              </MenuItem>
            ))}
          </MenuGroup>
        )}
      </Menu>

      <Divider />

      {/* Chart type */}
      <Menu label={activeType.label} icon={activeType.icon} width={180} disabled={tvMode} title={tvMode ? "Switch off TradingView to change chart type" : undefined}>
        {(close) => (
          <MenuGroup title="Chart type">
            {CHART_TYPES.map((c) => (
              <MenuItem key={c.key} selected={chartType === c.key} onClick={() => { onChartType(c.key); close(); }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {c.icon}{c.label}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        )}
      </Menu>

      <Divider />

      {/* Indicators */}
      <Menu
        label={<span>Indicators{countLabel && <span className="mk-menu-count">{countLabel}</span>}</span>}
        icon={<Activity size={12} />}
        width={320}
        disabled={tvMode}
        title={tvMode ? "Indicators live in TradingView UI while TV mode is on" : undefined}
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
            </>
          )}
        </Menu>
      )}

      {/* Settings */}
      {onSettings && (
        <Menu label="Settings" icon={<Settings size={12} />} width={210} disabled={tvMode} title={tvMode ? "Chart settings apply to Native mode" : undefined}>
          <MenuGroup title="Display">
            <MenuItem checkbox selected={s.grid} onClick={() => onSettings((p) => ({ ...p, grid: !p.grid }))}>Grid lines</MenuItem>
            <MenuItem checkbox selected={s.priceLine} onClick={() => onSettings((p) => ({ ...p, priceLine: !p.priceLine }))}>Price line</MenuItem>
            <MenuItem checkbox selected={s.sessionBreaks} onClick={() => onSettings((p) => ({ ...p, sessionBreaks: !p.sessionBreaks }))}>Session breaks</MenuItem>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup title="Scale">
            <MenuItem checkbox selected={s.logScale} onClick={() => onSettings((p) => ({ ...p, logScale: !p.logScale }))}>Logarithmic</MenuItem>
          </MenuGroup>
        </Menu>
      )}

      <Menu label="More" icon={<MoreHorizontal size={12} />} width={230} align="end" showCaret={false}>
        {(close) => (
          <>
            <MenuGroup title="Actions">
              {onResetStudies && (
                <MenuItem onClick={() => { onResetStudies(); close(); }}>
                  Reset indicators
                </MenuItem>
              )}
              {onScreenshot && (
                <MenuItem onClick={() => { onScreenshot(); close(); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Camera size={11} /> Take screenshot
                  </span>
                </MenuItem>
              )}
              <MenuItem onClick={() => { onFullscreen(); close(); }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Maximize2 size={11} /> Fullscreen · F
                </span>
              </MenuItem>
            </MenuGroup>
            <MenuDivider />
            <MenuGroup title="External">
              <a
                className="mk-menu-item"
                href={`https://www.tradingview.com/chart/?symbol=${exchange}:${symbol}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
              >
                <span className="mk-menu-item-check" />
                <span style={{ flex: 1, textAlign: "left" }}>Open on tradingview.com</span>
                <ExternalLink size={11} style={{ opacity: 0.6 }} />
              </a>
            </MenuGroup>
          </>
        )}
      </Menu>

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Native / TV segmented */}
      <div className="mk-seg" role="group" aria-label="Chart engine" title="TV mode delegates chart type, indicators & settings to the TradingView embed">
        <button
          type="button"
          className={`mk-seg-btn ${!tvMode ? "is-on" : ""}`}
          onClick={() => onTvMode(false)}
          title="Native chart (client-side indicators)"
        >Native</button>
        <button
          type="button"
          className={`mk-seg-btn ${tvMode ? "is-on" : ""}`}
          onClick={() => onTvMode(true)}
          title="TradingView embed (real-time)"
        >TV</button>
      </div>
    </div>
  );
}

// Searchable, scrollable indicator type picker. Category tabs let the user
// scope to Overlays or Oscillators (industry-standard split) so the list
// stops feeling like an unfindable dump.
function IndicatorPicker({ onAddStudy, intraday = false }: { onAddStudy: (type: IndicatorType) => void; intraday?: boolean }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "overlay" | "oscillator">("all");
  const query = q.trim().toLowerCase();
  const match = (d: IndicatorDef) => !query || d.label.toLowerCase().includes(query) || d.type.toLowerCase().includes(query);
  const overlays = OVERLAY_DEFS.filter(match);
  const oscillators = OSCILLATOR_DEFS.filter(match);
  const showOverlays = tab !== "oscillator";
  const showOscillators = tab !== "overlay";

  const Item = (d: IndicatorDef) => {
    const disabled = !!d.intradayOnly && !intraday;
    return (
      <button
        key={d.type}
        type="button"
        className="mk-menu-item"
        onClick={() => { if (!disabled) onAddStudy(d.type); }}
        disabled={disabled}
        title={disabled ? `${d.label} is intraday-only — switch to an intraday timeframe.` : undefined}
        style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      >
        <span className="mk-ind-swatch" style={{ background: d.lines[0].defaultColor }} />
        <span style={{ flex: 1, textAlign: "left" }}>{d.label}{disabled && <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>intraday</span>}</span>
      </button>
    );
  };


  const Tab = ({ v, label, count }: { v: "all" | "overlay" | "oscillator"; label: string; count: number }) => (
    <button
      type="button"
      className={`mk-ind-tab ${tab === v ? "is-on" : ""}`}
      onClick={(e) => { e.stopPropagation(); setTab(v); }}
    >
      {label}<span className="mk-ind-tab-count">{count}</span>
    </button>
  );

  return (
    <div className="mk-ind-picker">
      <div className="mk-ind-tabs" onMouseDown={(e) => e.stopPropagation()}>
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
        {showOverlays && overlays.length > 0 && <MenuGroup title="Overlays">{overlays.map(Item)}</MenuGroup>}
        {showOscillators && oscillators.length > 0 && <MenuGroup title="Oscillators">{oscillators.map(Item)}</MenuGroup>}
        {((showOverlays ? overlays.length : 0) + (showOscillators ? oscillators.length : 0)) === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)" }}>No match</div>
        )}
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mk-toolbar-divider" />;
}
