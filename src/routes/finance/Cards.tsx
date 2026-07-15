import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Chip, EmptyState } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { calcCreditUtilization } from "@/lib/financeMetrics";
import { ConfigureCTA, utilTone } from "./_shared";

// F1: tiles route to /finance/cards/:id. Edit / delete / log payment all
// live on the detail page now.
export default function Cards() {
  const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]);
  const [cardStatements, setCardStatements] = useState<Map<string, any>>(new Map());

  useEffect(() => {
    (async () => {
      const [c, latestByCard] = await Promise.all([db.cards.list(), db.statements.latestByCard()]);
      setItems(c); setCardStatements(latestByCard);
    })();
  }, []);

  const utilization = calcCreditUtilization(items.map((c: any) => ({
    cardId: c.id, cardName: c.card_name, limit: c.limit_amount, totalDue: cardStatements.get(c.id)?.total_due,
  })));
  const utilFor = (id: string) => utilization.perCard.find((u) => u.cardId === id)?.utilizationPct ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Credit Cards" index="CRD" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<ConfigureCTA to="/config/finance/cards" label="+ add new" />}>
        {items.length === 0 ? <EmptyState hint="add one in Config → Cards">no cards yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((c: any) => (
             <button
               key={c.id}
               onClick={() => nav(`/finance/cards/${c.id}`)}
               style={{
                 padding: 12, border: "1px solid var(--edge)", cursor: "pointer",
                 background: "transparent", color: "inherit", textAlign: "left",
                 font: "inherit", transition: "background 120ms, border-color 120ms",
               }}
               onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge-strong)"; (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.04)"; }}
               onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
             >
               <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                 <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{c.card_name}</div>
                 {c.banks?.name && <Chip>{c.banks.name}</Chip>}
                 {utilFor(c.id) != null && <Chip tone={utilTone(utilFor(c.id))}>{utilFor(c.id)}% used</Chip>}
                 {c.reward_type && <Chip tone="ok">{c.reward_rate_pct}% {c.reward_type}</Chip>}
                 <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)" }}>open →</span>
               </div>
               <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                 {c.masked_number ?? ""}{c.billing_day ? ` · bill ${c.billing_day}` : ""}{c.due_day ? ` · due ${c.due_day}` : ""}{c.limit_amount ? ` · limit ${inr(c.limit_amount)}` : ""}
               </div>
             </button>
           ))}
         </div>}
      </HudPanel>
    </div>
  );
}
