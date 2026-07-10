import { useNavigate } from "react-router-dom";

export default function NotFound() {
  const nav = useNavigate();
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100%", gap: 16,
    }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 88, color: "var(--accent)", letterSpacing: "0.1em", lineHeight: 1 }}>
        404
      </div>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>signal not found in this sector</div>
      <button
        onClick={() => nav("/")}
        style={{
          padding: "8px 18px", border: "1px solid var(--edge-strong)",
          background: "transparent", color: "var(--accent-soft)",
          fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.22em",
          cursor: "pointer", textTransform: "uppercase",
        }}
      >
        ← return to core
      </button>
    </div>
  );
}
