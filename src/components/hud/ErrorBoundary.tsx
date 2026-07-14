import { Component, type ErrorInfo, type ReactNode } from "react";
import { toUserError } from "@/lib/userError";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[JARVIS] uncaught:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", gap: 12, color: "var(--danger)",
        fontFamily: "var(--font-hud)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 11,
      }}>
        <span className="hud-label" style={{ color: "var(--danger)" }}>· subsystem fault ·</span>
        <div style={{ maxWidth: 480, textAlign: "center", color: "var(--text-dim)", letterSpacing: "0.04em", textTransform: "none" }}>
          {toUserError(this.state.error, "A subsystem failed to initialise.")}
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            padding: "6px 14px", border: "1px solid var(--edge-strong)",
            background: "transparent", color: "var(--accent)",
            fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.2em",
            cursor: "pointer", textTransform: "uppercase",
          }}
        >
          reboot module
        </button>
      </div>
    );
  }
}
