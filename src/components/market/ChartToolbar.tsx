import { CandlestickChart, LineChart, BarChart3, AreaChart, Activity, Bell, LayoutGrid, MoreHorizontal, Maximize2, ExternalLink } from "lucide-react";
import { Menu, MenuItem, MenuGroup, MenuDivider } from "@/components/hud/Menu";
import type { ChartType, IndicatorFlags } from "@/components/market/CandleChart";

const TIMEFRAMES = [
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "1h", label: "1h" },
  { key: "1D", label: "1D" },
];

const CHART_TYPES: Array<{ key: ChartType; label: string; icon: React.ReactNode }> = [
  { key: "candles", label: "Candles", icon: <CandlestickChart size={12} /> },
  { key: "bars", label: "Bars", icon: <BarChart3 size={12} /> },
  { key: "line", label: "Line", icon: <LineChart size={12} /> },
  { key: "area", label: "Area", icon: <AreaChart size={12} /> },
];

const OVERLAYS: Array<{ key: keyof IndicatorFlags; label: string }> = [
  { key: "ema20", label: "EMA 20" },
  { key: "ema50", label: "EMA 50" },
  { key: "ema200", label: "EMA 200" },
  { key: "sma20", label: "SMA 20" },
  { key: "bb", label: "Bollinger Bands" },
  { key: "vwap", label: "VWAP" },
];
const OSCILLATORS: Array<{ key: keyof IndicatorFlags; label: string }> = [
  { key: "rsi", label: "RSI (14)" },
  { key: "macd", label: "MACD (12,26,9)" },
];

const DEFAULT_FLAGS: IndicatorFlags = { ema20: true, ema50: true, volume: true };

export interface ChartToolbarProps {
  symbol: string;
  tf: string;
  onTf: (v: string) => void;
  chartType: ChartType;
  onChartType: (v: ChartType) => void;
  flags: IndicatorFlags;
  onFlags: (updater: (prev: IndicatorFlags) => IndicatorFlags) => void;
  tvMode: boolean;
  onTvMode: (v: boolean) => void;
  onFullscreen: () => void;
  onAlert: () => void;
}

export function ChartToolbar({
  symbol, tf, onTf, chartType, onChartType, flags, onFlags, tvMode, onTvMode, onFullscreen, onAlert,
}: ChartToolbarProps) {
  const activeType = CHART_TYPES.find((c) => c.key === chartType) ?? CHART_TYPES[0];
  const activeCount = Object.values(flags).filter(Boolean).length;

  return (
    <div className="mk-chart-toolbar">
      {/* Interval */}
      <Menu label={tf} width={160} active>
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
        label={<span>Indicators{activeCount > 0 && <span className="mk-menu-count">{activeCount}</span>}</span>}
        icon={<Activity size={12} />}
        width={230}
        disabled={tvMode}
        title={tvMode ? "Indicators live in TradingView UI while TV mode is on" : undefined}
      >
        <MenuGroup title="Overlays">
          {OVERLAYS.map((o) => (
            <MenuItem
              key={o.key}
              checkbox
              selected={!!flags[o.key]}
              onClick={() => onFlags((p) => ({ ...p, [o.key]: !p[o.key] }))}
            >{o.label}</MenuItem>
          ))}
        </MenuGroup>
        <MenuDivider />
        <MenuGroup title="Oscillators">
          {OSCILLATORS.map((o) => (
            <MenuItem
              key={o.key}
              checkbox
              selected={!!flags[o.key]}
              onClick={() => onFlags((p) => ({ ...p, [o.key]: !p[o.key] }))}
            >{o.label}</MenuItem>
          ))}
        </MenuGroup>
        <MenuDivider />
        <MenuGroup title="Volume">
          <MenuItem
            checkbox
            selected={flags.volume !== false}
            onClick={() => onFlags((p) => ({ ...p, volume: !p.volume }))}
          >Volume</MenuItem>
        </MenuGroup>
      </Menu>

      <Divider />

      <button type="button" className="mk-menu-trigger" onClick={onAlert} title="Create price alert">
        <span className="mk-menu-ico"><Bell size={12} /></span>
        <span>Alert</span>
      </button>

      <Menu label="Layout" icon={<LayoutGrid size={12} />} width={180}>
        <MenuGroup title="Layout">
          <MenuItem selected>Single</MenuItem>
          <MenuItem disabled hint="soon">2 charts</MenuItem>
          <MenuItem disabled hint="soon">2 × 2 grid</MenuItem>
        </MenuGroup>
      </Menu>

      <Menu label="More" icon={<MoreHorizontal size={12} />} width={220} align="end" showCaret={false}>
        {(close) => (
          <>
            <MenuGroup title="Actions">
              <MenuItem onClick={() => { onFlags(() => DEFAULT_FLAGS); close(); }}>
                Reset indicators
              </MenuItem>
              <MenuItem onClick={() => { onFullscreen(); close(); }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Maximize2 size={11} /> Fullscreen
                </span>
              </MenuItem>
            </MenuGroup>
            <MenuDivider />
            <MenuGroup title="External">
              <a
                className="mk-menu-item"
                href={`https://www.tradingview.com/chart/?symbol=NSE:${symbol}`}
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

      <div style={{ flex: 1 }} />

      {/* Native / TV segmented */}
      <div className="mk-seg" role="group" aria-label="Chart engine">
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

      <button
        type="button"
        className="mk-menu-trigger"
        onClick={onFullscreen}
        title="Fullscreen"
        aria-label="Fullscreen"
        style={{ padding: "4px 6px" }}
      >
        <Maximize2 size={12} />
      </button>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mk-toolbar-divider" />;
}
