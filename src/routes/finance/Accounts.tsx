import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Chip, EmptyState } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { ConfigureCTA } from "./_shared";

// F1: tiles are entirely clickable and route to /finance/accounts/:id.
// All edit/delete lives on the detail page — this list stays a clean grid.
export default function Accounts() {
  const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    (async () => { setItems(await db.accounts.list()); })();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Accounts" index="ACC" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/accounts" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Accounts">no accounts yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((a) => (
             <button
               key={a.id}
               onClick={() => nav(`/finance/accounts/${a.id}`)}
               className="finance-tile"
               style={{
                 padding: 12, border: "1px solid var(--edge)", cursor: "pointer",
                 background: "transparent", color: "inherit", textAlign: "left",
                 font: "inherit", transition: "background 120ms, border-color 120ms",
               }}
               onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge-strong)"; (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.04)"; }}
               onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
             >
               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{a.nickname}</div>
                 {a.account_type && <Chip>{a.account_type}</Chip>}
                 <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)" }}>open →</span>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {a.banks?.name ?? "no bank"} {a.masked_number ? `· ${a.masked_number}` : ""}
                 {a.current_balance != null && <> · {inr(a.current_balance)}{a.current_balance_as_of ? ` as of ${new Date(a.current_balance_as_of).toLocaleDateString()}` : ""}</>}
               </div>
             </button>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
