// TradingView-style study legend — one row per active indicator, overlaid top-left
// on the chart under the OHLC line. Shows a colour swatch, label, live value (at the
// crosshair, else last bar), and hover controls: toggle visibility / settings / remove.
import { Eye, EyeOff, Settings2, X } from "lucide-react";

export interface LegendRow {
  id: string;
  label: string;
  color: string;
  value: string;
  visible: boolean;
}

export function ChartLegend({
  rows, onToggle, onEdit, onRemove, top = 22,
}: {
  rows: LegendRow[];
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  top?: number;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mk-legend" style={{ top }}>
      {rows.map((r) => (
        <div key={r.id} className="mk-legend-row" data-off={r.visible ? undefined : "true"}>
          <span className="mk-legend-swatch" style={{ background: r.color }} />
          <span className="mk-legend-label">{r.label}</span>
          <span className="mk-legend-value">{r.value}</span>
          <span className="mk-legend-actions">
            <button type="button" title={r.visible ? "Hide" : "Show"} onClick={() => onToggle(r.id)}>
              {r.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button type="button" title="Settings" onClick={() => onEdit(r.id)}><Settings2 size={12} /></button>
            <button type="button" title="Remove" onClick={() => onRemove(r.id)}><X size={12} /></button>
          </span>
        </div>
      ))}
    </div>
  );
}
