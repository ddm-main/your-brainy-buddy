// A/D drill-down dialog opened from the MarketStrip. Shows current breadth,
// sector strength ranking, and the recent FII/DII cash-segment tape.
import { HudModal } from "@/components/hud/HudModal";
import { useBreadth, useSectorStrength, useFiiDiiHistory } from "@/lib/market/hooks";

const fmtNum = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: d });

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function BreadthDetailsDialog({ open, onOpenChange }: Props) {
  const { data: breadth } = useBreadth();
  const { data: sectors = [] } = useSectorStrength();
  const { data: fii = [] } = useFiiDiiHistory(10, "CASH");

  const adv = breadth?.advances ?? 0;
  const dec = breadth?.declines ?? 0;
  const unc = breadth?.unchanged ?? 0;
  const total = adv + dec + unc;
  const pctAdv = total > 0 ? (adv / total) * 100 : null;
  const ratio = dec > 0 ? adv / dec : null;

  return (
    <HudModal
      open={open}
      onClose={() => onOpenChange(false)}
      width={760}
      title={`MARKET BREADTH${breadth?.trade_date ? ` · ${fmtDate(breadth.trade_date)}` : ""}`}
    >

        {/* Headline metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
          <Stat label="Advances" value={fmtNum(adv, 0)} tone="ok" />
          <Stat label="Declines" value={fmtNum(dec, 0)} tone="danger" />
          <Stat label="Unchanged" value={fmtNum(unc, 0)} />
          <Stat label="A/D Ratio" value={ratio == null ? "—" : ratio.toFixed(2)} />
          <Stat label="% Advancing" value={pctAdv == null ? "—" : `${pctAdv.toFixed(1)}%`} />
          <Stat label="52w Highs" value={fmtNum(breadth?.new_highs, 0)} tone="ok" />
          <Stat label="52w Lows" value={fmtNum(breadth?.new_lows, 0)} tone="danger" />
          <Stat label="Regime" value={breadth?.regime ?? "—"} />
        </div>

        {/* EMA participation */}
        <div className="grid grid-cols-3 gap-3 mt-3">
          <Stat label="% > EMA20" value={breadth?.pct_above_ema20 == null ? "—" : `${breadth.pct_above_ema20.toFixed(0)}%`} />
          <Stat label="% > EMA50" value={breadth?.pct_above_ema50 == null ? "—" : `${breadth.pct_above_ema50.toFixed(0)}%`} />
          <Stat label="% > EMA200" value={breadth?.pct_above_ema200 == null ? "—" : `${breadth.pct_above_ema200.toFixed(0)}%`} />
        </div>

        {/* Sector strength */}
        <section className="mt-5">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Sector Strength</h3>
          {sectors.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sector data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Sector</th>
                    <th className="py-1 pr-3 text-right">Strength</th>
                    <th className="py-1 pr-3 text-right">Δ%</th>
                  </tr>
                </thead>
                <tbody>
                  {sectors.slice(0, 15).map((s: any) => (
                    <tr key={s.sector} className="border-t border-border/40">
                      <td className="py-1 pr-3 text-muted-foreground">{s.strength_rank}</td>
                      <td className="py-1 pr-3">{s.sector}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtNum(s.strength_score, 1)}</td>
                      <td
                        className="py-1 pr-3 text-right tabular-nums"
                        style={{ color: (s.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}
                      >
                        {s.change_pct == null ? "—" : `${s.change_pct >= 0 ? "+" : ""}${s.change_pct.toFixed(2)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* FII/DII tape */}
        <section className="mt-5">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">FII / DII · Cash (₹ cr)</h3>
          {fii.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recent FII/DII data.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-3">Date</th>
                    <th className="py-1 pr-3 text-right">FII Net</th>
                    <th className="py-1 pr-3 text-right">DII Net</th>
                    <th className="py-1 pr-3 text-right">Net Buy</th>
                    <th className="py-1 pr-3">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {fii.map((r) => (
                    <tr key={r.activity_date} className="border-t border-border/40">
                      <td className="py-1 pr-3">{fmtDate(r.activity_date)}</td>
                      <td
                        className="py-1 pr-3 text-right tabular-nums"
                        style={{ color: (r.fii_net ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}
                      >
                        {r.fii_net == null ? "—" : `${r.fii_net >= 0 ? "+" : ""}${fmtNum(r.fii_net, 0)}`}
                      </td>
                      <td
                        className="py-1 pr-3 text-right tabular-nums"
                        style={{ color: (r.dii_net ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}
                      >
                        {r.dii_net == null ? "—" : `${r.dii_net >= 0 ? "+" : ""}${fmtNum(r.dii_net, 0)}`}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtNum(r.net_buy_inr_cr, 0)}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{r.source ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </HudModal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "danger" }) {
  const color =
    tone === "ok" ? "var(--ok)" : tone === "danger" ? "var(--danger)" : "var(--text)";
  return (
    <div
      style={{
        border: "1px solid var(--edge)",
        borderRadius: 3,
        padding: "8px 10px",
        background: "rgba(53,214,237,0.02)",
      }}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-mono tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
