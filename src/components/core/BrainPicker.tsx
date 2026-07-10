import { useBrain, BRAIN_PRESETS, currentBrainLabel } from "@/store/brainStore";
import { useUi } from "@/store/uiStore";
import { HudSelect } from "@/components/hud/HudSelect";

export default function BrainPicker() {
  const { provider, model, setBrain } = useBrain();
  const label = currentBrainLabel(provider, model);
  const options = [
    ...BRAIN_PRESETS.filter((b) => b.provider === "gemini").map((b) => ({ value: `gemini::${b.model}`, label: `Lovable · ${b.label}` })),
    ...BRAIN_PRESETS.filter((b) => b.provider === "openrouter").map((b) => ({ value: `openrouter::${b.model}`, label: `OpenRouter · ${b.label}` })),
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>brain</span>
      <div style={{ minWidth: 220 }} title={label}>
        <HudSelect
          value={`${provider}::${model}`}
          onChange={(v) => {
            const [p, m] = v.split("::");
            setBrain({ provider: p as any, model: m });
            if (p === "openrouter") {
              useUi.getState().push("OpenRouter selected. Add OPENROUTER_API_KEY if not set.", "warn");
            }
          }}
          options={options}
          ariaLabel="brain"
        />
      </div>
    </div>
  );
}