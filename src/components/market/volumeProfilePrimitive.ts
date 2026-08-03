// Visible-range Volume Profile (VPVR) drawn as a lightweight-charts v5 series
// primitive on the price pane. Each price row is a stacked horizontal bar:
// buying volume (bars closing up) and selling volume (bars closing down), so
// the buy/sell balance at every price level is readable at a glance.
// POC / VAH / VAL are drawn as horizontal guides.
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { volumeProfile, type VolumeProfileResult } from "@/lib/market/chartIndicators";
import type { CandleDto } from "@/lib/market/types";

export interface VolumeProfileOptions {
  rows: number;
  valueAreaPct: number;
  widthPct: number;
  rightSide: boolean;
  upColor: string;
  downColor: string;
  pocColor: string;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => p.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }
  return hex;
}

export class VolumeProfilePrimitive {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<any> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _candles: CandleDto[];
  private _opts: VolumeProfileOptions;
  private _cacheKey = "";
  private _cache: VolumeProfileResult | null = null;
  private _onRange = () => { this._cacheKey = ""; this._requestUpdate?.(); };
  private _paneViews: Array<{ renderer: () => { draw: (target: any) => void } }>;
  /** Latest computed profile — used by the legend. */
  latest: VolumeProfileResult | null = null;

  private _onProfile?: (r: VolumeProfileResult) => void;

  constructor(candles: CandleDto[], opts: VolumeProfileOptions, onProfile?: (r: VolumeProfileResult) => void) {
    this._candles = candles;
    this._opts = opts;
    this._onProfile = onProfile;
    this._paneViews = [{ renderer: () => ({ draw: (target: any) => this._draw(target) }) }];
  }

  attached(param: { chart: IChartApi; series: ISeriesApi<any>; requestUpdate: () => void }) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this._chart.timeScale().subscribeVisibleLogicalRangeChange(this._onRange);
  }

  detached() {
    try { this._chart?.timeScale().unsubscribeVisibleLogicalRangeChange(this._onRange); } catch { /* noop */ }
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews() { return this._paneViews; }
  updateAllViews() { /* recompute happens lazily in draw */ }

  private _profile(): VolumeProfileResult | null {
    const chart = this._chart;
    if (!chart || this._candles.length === 0) return null;
    const range = chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.floor(range?.from ?? 0));
    const to = Math.min(this._candles.length - 1, Math.ceil(range?.to ?? this._candles.length - 1));
    if (to < from) return null;
    const key = `${from}:${to}:${this._opts.rows}:${this._opts.valueAreaPct}:${this._candles.length}`;
    if (key === this._cacheKey && this._cache) return this._cache;
    const slice = this._candles.slice(from, to + 1);
    const res = volumeProfile(slice, { rows: this._opts.rows, valueAreaPct: this._opts.valueAreaPct });
    this._cacheKey = key;
    this._cache = res;
    this.latest = res;
    this._onProfile?.(res);
    return res;
  }

  private _draw(target: any) {
    const series = this._series;
    if (!series) return;
    target.useMediaCoordinateSpace((scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
      const profile = this._profile();
      if (!profile || profile.maxTotal <= 0) return;
      const ctx = scope.context;
      const { width, height } = scope.mediaSize;
      const maxW = Math.max(20, Math.floor((width * Math.max(5, Math.min(60, this._opts.widthPct))) / 100));
      const { rightSide } = this._opts;

      ctx.save();
      for (const row of profile.rows) {
        if (row.total <= 0) continue;
        const yHi = series.priceToCoordinate(row.priceHi);
        const yLo = series.priceToCoordinate(row.priceLo);
        if (yHi == null || yLo == null) continue;
        const top = Math.min(yHi, yLo);
        const h = Math.max(1, Math.abs(yLo - yHi) - 1);
        if (top + h < 0 || top > height) continue;
        const total = (row.total / profile.maxTotal) * maxW;
        const upW = row.total > 0 ? (row.upVol / row.total) * total : 0;
        const dnW = total - upW;
        if (rightSide) {
          let x = width;
          ctx.fillStyle = withAlpha(this._opts.upColor, 0.55);
          ctx.fillRect(x - upW, top, upW, h);
          x -= upW;
          ctx.fillStyle = withAlpha(this._opts.downColor, 0.55);
          ctx.fillRect(x - dnW, top, dnW, h);
        } else {
          ctx.fillStyle = withAlpha(this._opts.upColor, 0.55);
          ctx.fillRect(0, top, upW, h);
          ctx.fillStyle = withAlpha(this._opts.downColor, 0.55);
          ctx.fillRect(upW, top, dnW, h);
        }
      }

      // POC (solid) + value-area bounds (dashed)
      const guide = (price: number | null, color: string, dashed: boolean) => {
        if (price == null) return;
        const y = series.priceToCoordinate(price);
        if (y == null) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(dashed ? [4, 4] : []);
        ctx.moveTo(rightSide ? width - maxW : 0, y);
        ctx.lineTo(rightSide ? width : maxW, y);
        ctx.stroke();
      };
      guide(profile.vah, withAlpha(this._opts.pocColor, 0.5), true);
      guide(profile.val, withAlpha(this._opts.pocColor, 0.5), true);
      guide(profile.poc, this._opts.pocColor, false);
      ctx.setLineDash([]);
      ctx.restore();
    });
  }
}

export type { Time };
