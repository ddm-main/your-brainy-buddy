import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";

export default function Scaffold({ title, index, blurb, children }: { title: string; index: string; blurb: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <HudPanel title={title} index={index}>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {blurb}
        </div>
        <div style={{ marginTop: 12, padding: 12, border: "1px dashed var(--edge)", background: "rgba(53,214,237,0.03)" }}>
          <div className="hud-label" style={{ color: "var(--accent-soft)" }}>Phase 2</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
            This module is scaffolded. Connect your Kotak Neo account in{" "}
            <Link to="/market/settings" style={{ color: "var(--accent)" }}>Settings → API Configuration</Link>{" "}
            to unlock live data across the Market suite.
          </div>
        </div>
        {children}
      </HudPanel>
    </div>
  );
}
