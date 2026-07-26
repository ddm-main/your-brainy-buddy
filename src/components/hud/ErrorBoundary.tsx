import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

// React.lazy() caches a REJECTED dynamic-import promise for the life of
// that module reference — after a real chunk-load failure (stale-deploy
// hash, network blip), retrying via setState({error:null}) just re-renders
// the same lazy component and re-throws the identical cached rejection.
// The only real recovery is a hard reload, which re-fetches a fresh chunk
// manifest.
function isChunkLoadError(error: Error): boolean {
  const msg = `${error.name} ${error.message}`;
  return /dynamically imported module|loading chunk|chunkloaderror|failed to fetch/i.test(msg);
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[JARVIS] uncaught:", error, info);
  }

  reboot = () => {
    if (this.state.error && isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const chunkFailure = isChunkLoadError(this.state.error);
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", gap: 12, color: "var(--danger)",
        fontFamily: "var(--font-hud)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 11,
      }}>
        <span className="hud-label" style={{ color: "var(--danger)" }}>· subsystem fault ·</span>
        <div style={{ maxWidth: 480, textAlign: "center", color: "var(--text-dim)", letterSpacing: "0.04em", textTransform: "none" }}>
          {this.state.error.message}
        </div>
        <button
          onClick={this.reboot}
          style={{
            padding: "6px 14px", border: "1px solid var(--edge-strong)",
            background: "transparent", color: "var(--accent)",
            fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.2em",
            cursor: "pointer", textTransform: "uppercase",
          }}
        >
          {chunkFailure ? "reload app" : "reboot module"}
        </button>
      </div>
    );
  }
}
