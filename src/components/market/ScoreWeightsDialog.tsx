// "How the 100 points split" reference dialog — pure presentation over the
// v4 scoring catalog in scoreExplain.ts.
import { HudModal } from "@/components/hud/HudModal";
import { V4_BUCKETS, BUCKET_COLORS } from "@/lib/market/scoreExplain";

export function ScoreWeightsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const total = V4_BUCKETS.reduce((s, b) => s + b.weight, 0);

  return (
    <HudModal open={open} onClose={() => onOpenChange(false)} width={720} title="HOW THE 100 POINTS ARE DISTRIBUTED">
      <div style={{ display: "flex", height: 10, marginTop: 4, border: "1px solid var(--edge)" }}>
        {V4_BUCKETS.map((b) => (
          <div key={b.key} title={`${b.label} — ${b.weight} pts`}
               style={{ width: `${(b.weight / total) * 100}%`, background: BUCKET_COLORS[b.key] ?? "var(--accent)" }} />
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--text-muted)", margin: "4px 0 10px", letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {V4_BUCKETS.length} sections · {total} points total
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "60vh", overflowY: "auto" }}>
        {V4_BUCKETS.map((b) => (
          <section key={b.key} style={{ border: "1px solid var(--edge)", padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, background: BUCKET_COLORS[b.key] ?? "var(--accent)" }} />
              <span style={{ fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text)" }}>
                {b.label}
              </span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
                {b.weight} pts
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>{b.blurb}</div>
            <div style={{ marginTop: 6 }}>
              {b.factors.map((f) => (
                <div key={f.key} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 10, padding: "1px 0" }}>
                  <span style={{ color: "var(--text-dim)", flex: "0 0 150px" }}>{f.label}</span>
                  <span style={{ flex: 1, height: 3, background: "var(--edge)" }}>
                    <span style={{ display: "block", height: "100%", width: `${f.w * 100}%`, background: BUCKET_COLORS[b.key] ?? "var(--accent)" }} />
                  </span>
                  <span style={{ flex: "0 0 72px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
                    {(b.weight * f.w).toFixed(1)} pts
                  </span>
                  <span style={{ flex: "0 0 40px", textAlign: "right", color: "var(--text-muted)" }}>
                    {Math.round(f.w * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.5 }}>
        When a section lacks data, its weight is renormalised across the sections that do have data, then penalties are deducted — so a live score rarely uses these raw ceilings exactly.
      </div>
    </HudModal>
  );
}

export default ScoreWeightsDialog;