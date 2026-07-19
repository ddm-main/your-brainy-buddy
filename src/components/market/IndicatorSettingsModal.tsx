// Per-study settings modal — Inputs (numeric params + price source) and Style
// (colour per drawn line, line width, visibility). All edits are live: they call
// onChange with the patched study so the chart updates immediately.
import { HudModal } from "@/components/hud/HudModal";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { defByType, type Study } from "@/lib/market/indicatorRegistry";
import type { Source } from "@/lib/market/chartIndicators";

const SOURCES: Source[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

export function IndicatorSettingsModal({
  study, onChange, onRemove, onClose,
}: {
  study: Study | null;
  onChange: (s: Study) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const def = study ? defByType(study.type) : null;

  const patch = (partial: Partial<Study>) => { if (study) onChange({ ...study, ...partial }); };
  const setParam = (key: string, v: number) => { if (study) patch({ params: { ...study.params, [key]: v } }); };
  const setColor = (i: number, v: string) => {
    if (!study) return;
    const colors = [...study.colors]; colors[i] = v; patch({ colors });
  };
  const reset = () => {
    if (!study || !def) return;
    patch({ params: { ...def.defaultParams }, source: def.hasSource ? "close" : undefined, colors: def.lines.map((l) => l.defaultColor), lineWidth: def.defaultWidth, visible: true });
  };

  return (
    <HudModal
      open={!!study}
      onClose={onClose}
      width={380}
      title={def?.label ?? ""}
      footer={
        <>
          <Btn variant="ghost" size="sm" onClick={reset}>Reset</Btn>
          <Btn variant="ghost" size="sm" onClick={() => { if (study) { onRemove(study.id); onClose(); } }}>Delete</Btn>
          <Btn variant="primary" size="sm" onClick={onClose}>Done</Btn>
        </>
      }
    >
      {study && def && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Inputs */}
          {(def.params.length > 0 || def.hasSource) && (
            <div>
              <div style={labelStyle}>Inputs</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {def.params.map((p) => (
                  <label key={p.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em" }}>{p.label}</span>
                    <input
                      type="number"
                      style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}
                      value={study.params[p.key]}
                      min={p.min} max={p.max} step={p.step}
                      onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setParam(p.key, v); }}
                    />
                  </label>
                ))}
                {def.hasSource && (
                  <label style={{ display: "flex", flexDirection: "column", gap: 3, gridColumn: "1 / -1" }}>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em" }}>Source</span>
                    <select
                      style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}
                      value={study.source ?? "close"}
                      onChange={(e) => patch({ source: e.target.value as Source })}
                    >
                      {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Style */}
          <div>
            <div style={labelStyle}>Style</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {def.lines.map((ln, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text)" }}>{ln.label}</span>
                  <input
                    type="color"
                    className="mk-color-input"
                    value={study.colors[i] ?? ln.defaultColor}
                    onChange={(e) => setColor(i, e.target.value)}
                    aria-label={`${ln.label} colour`}
                  />
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12, color: "var(--text)" }}>Line width</span>
                <input
                  type="number"
                  style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: 70 }}
                  value={study.lineWidth} min={1} max={5} step={1}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) patch({ lineWidth: Math.max(1, Math.min(5, v)) }); }}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}>
                <span style={{ fontSize: 12, color: "var(--text)" }}>Visible</span>
                <input type="checkbox" checked={study.visible} onChange={(e) => patch({ visible: e.target.checked })} />
              </label>
            </div>
          </div>
        </div>
      )}
    </HudModal>
  );
}
