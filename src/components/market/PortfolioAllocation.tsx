// Sector allocation donut for the portfolio — groups current holding value by
// sector, same hand-built SVG chart primitive Finance → Investments already
// uses (no new chart library).
import { HudDonutChart, type ChartDatum } from "@/components/hud/HudChart";
import { quoteKey } from "@/lib/market/pnl";

export interface AllocationInput {
  symbol: string;
  exchange: string;
  currentValue: number;
}

export function PortfolioAllocation({
  holdings,
  sectorBySymbol,
}: {
  holdings: AllocationInput[];
  sectorBySymbol: Record<string, string | null>;
}) {
  const bySector = new Map<string, number>();
  for (const h of holdings) {
    const sector = sectorBySymbol[quoteKey(h.exchange, h.symbol)] || "Unclassified";
    bySector.set(sector, (bySector.get(sector) ?? 0) + h.currentValue);
  }
  const data: ChartDatum[] = [...bySector.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

  return <HudDonutChart data={data} size={140} />;
}
