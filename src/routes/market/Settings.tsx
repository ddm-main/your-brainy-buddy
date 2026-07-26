// Market → Config — per-user broker connection lives here. Shared data providers
// and the pipeline stay admin-managed under Admin Panel → System Data.
import { Link } from "react-router-dom";
import { LineChart } from "lucide-react";
import BrokerConnectPanel from "@/components/market/BrokerConnectPanel";
import SystemFeedPanel from "@/components/market/SystemFeedPanel";

import { useAccessStore } from "@/store/accessStore";

export default function MarketSettings() {
  const isAdmin = useAccessStore((s) => s.role === "admin");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0, overflow: "auto" }}>
      {isAdmin && (
        <Link
          to="/config/system-data"
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start",
            padding: "6px 10px", border: "1px solid var(--edge)", borderRadius: 2,
            background: "rgba(53,214,237,0.03)", color: "var(--accent)", textDecoration: "none",
            fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase",
          }}
        >
          <LineChart size={12} /> System Data →
        </Link>
      )}
      <SystemFeedPanel />
      <BrokerConnectPanel />

    </div>
  );
}
