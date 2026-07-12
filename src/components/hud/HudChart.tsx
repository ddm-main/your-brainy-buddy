// Lightweight custom SVG chart primitives — deliberately not recharts/d3
// (this app has no chart library and none of its other visuals pull in a
// heavy dep; ScoreBar/HudPanel set the precedent of hand-built HUD atoms).
// Each component takes plain arrays, computes its own scale, and renders
// bare <svg> — no external state, no animation library.

export interface ChartDatum {
  label: string;
  value: number;
}

const ACCENT = "var(--accent)";
const EDGE = "var(--edge)";
const TEXT_DIM = "var(--text-dim)";
const PALETTE = ["#35d6ed", "#7fe9ff", "#ffb85c", "#5cff9d", "#ff5c8a", "#b85cff", "#5c8aff", "#e9ff5c"];

export function HudBarChart({ data, height = 120 }: { data: ChartDatum[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  if (data.length === 0) return <div style={{ fontSize: 11, color: TEXT_DIM }}>no data</div>;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height, borderBottom: `1px solid ${EDGE}` }}>
      {data.map((d, i) => {
        const barHeight = Math.max(2, (Math.abs(d.value) / max) * (height - 20));
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={`${d.label}: ${d.value}`}>
            <div style={{ width: "70%", height: barHeight, background: d.value >= 0 ? ACCENT : "var(--danger)", opacity: 0.85 }} />
            <div style={{ fontSize: 9, color: TEXT_DIM, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

export function HudLineChart({ data, height = 100, width = 300 }: { data: ChartDatum[]; height?: number; width?: number }) {
  if (data.length < 2) return <div style={{ fontSize: 11, color: TEXT_DIM }}>not enough data</div>;
  const values = data.map((d) => d.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((d, i) => {
    const x = i * stepX;
    const y = height - ((d.value - min) / range) * (height - 10) - 5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={ACCENT} strokeWidth={2} />
      {data.map((d, i) => {
        const x = i * stepX;
        const y = height - ((d.value - min) / range) * (height - 10) - 5;
        return <circle key={i} cx={x} cy={y} r={2.5} fill={ACCENT}><title>{`${d.label}: ${d.value}`}</title></circle>;
      })}
    </svg>
  );
}

export function HudDonutChart({ data, size = 120 }: { data: ChartDatum[]; size?: number }) {
  const total = data.reduce((sum, d) => sum + Math.abs(d.value), 0);
  if (total <= 0) return <div style={{ fontSize: 11, color: TEXT_DIM }}>no data</div>;
  const radius = size / 2;
  const strokeWidth = size * 0.18;
  const r = radius - strokeWidth / 2;
  const circumference = 2 * Math.PI * r;
  // Precompute each slice's cumulative offset via reduce (no mutable
  // accumulator variable) — React's render-purity lint rule flags any `let`
  // reassigned during a component's render, even outside JSX.
  const slices = data.reduce<Array<ChartDatum & { dash: number; offset: number }>>((acc, d) => {
    const dash = (Math.abs(d.value) / total) * circumference;
    const offset = acc.length > 0 ? acc[acc.length - 1].offset + acc[acc.length - 1].dash : 0;
    return [...acc, { ...d, dash, offset }];
  }, []);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${radius} ${radius})`}>
          {slices.map((s, i) => (
            <circle key={i} cx={radius} cy={radius} r={r} fill="none"
              stroke={PALETTE[i % PALETTE.length]} strokeWidth={strokeWidth}
              strokeDasharray={`${s.dash} ${circumference - s.dash}`} strokeDashoffset={-s.offset}>
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          ))}
        </g>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {data.slice(0, 8).map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
            <span style={{ width: 8, height: 8, background: PALETTE[i % PALETTE.length], display: "inline-block", borderRadius: 2 }} />
            <span style={{ color: TEXT_DIM }}>{d.label}</span>
            <span>{((Math.abs(d.value) / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
