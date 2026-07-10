import { useBrain, BRAIN_PRESETS, currentBrainLabel } from "@/store/brainStore";
import { useUi } from "@/store/uiStore";

export default function BrainPicker() {
  const { provider, model, setBrain } = useBrain();
  const label = currentBrainLabel(provider, model);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>brain</span>
      <select
        value={`${provider}::${model}`}
        onChange={(e) => {
          const [p, m] = e.target.value.split("::");
          setBrain({ provider: p as any, model: m });
          if (p === "openrouter") {
            useUi.getState().push(
              "OpenRouter selected. Add OPENROUTER_API_KEY if not set.",
              "warn",
            );
          }
        }}
        style={{
          background: "var(--panel-tint-heavy)",
          color: "var(--accent)",
          border: "1px solid var(--edge-strong)",
          padding: "4px 8px",
          fontSize: 11,
          fontFamily: "var(--font-hud)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          borderRadius: 2,
        }}
        title={label}
      >
        <optgroup label="Lovable AI (Gemini)">
          {BRAIN_PRESETS.filter((b) => b.provider === "gemini").map((b) => (
            <option key={b.model} value={`gemini::${b.model}`}>{b.label}</option>
          ))}
        </optgroup>
        <optgroup label="OpenRouter (BYO key)">
          {BRAIN_PRESETS.filter((b) => b.provider === "openrouter").map((b) => (
            <option key={b.model} value={`openrouter::${b.model}`}>{b.label}</option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}