// Trade Planner — standalone risk/position sizing workbench.
// Inputs on the left, computed sizing + R:R analysis on the right.
import { useEffect, useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { fmtNum, fmtPct } from "@/components/hud/DataTable";
import { computePlan, loadPlannerDefaults, savePlannerDefaults } from "@/lib/market/planner";
import { useQuotes } from "@/lib/market/hooks";

export default function Planner() {
  const defaults = useMemo(loadPlannerDefaults, []);
  const [symbol, setSymbol] = useState("");
  const [portfolioSize, setPortfolioSize] = useState(defaults.portfolioSize);
  const [riskPct, setRiskPct] = useState(defaults.riskPct);
  const [brokerageBps, setBrokerageBps] = useState(defaults.brokerageBps);
  const [slippageBps, setSlippageBps] = useState(defaults.slippageBps);
  const [side, setSide] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState(0);
  const [stopLoss, setStopLoss] = useState(0);
  const [t1, setT1] = useState(0);
  const [t2, setT2] = useState(0);
  const [t3, setT3] = useState(0);

  const sym = symbol.trim().toUpperCase();
  const { data: quotesData } = useQuotes(sym ? [`NSE:${sym}`] : []);
  const ltp = quotesData?.quotes?.[0]?.ltp ?? null;

  useEffect(() => {
    savePlannerDefaults({ portfolioSize, riskPct, brokerageBps, slippageBps });
  }, [portfolioSize, riskPct, brokerageBps, slippageBps]);

  const plan = useMemo(
    () => computePlan({
      portfolioSize, riskPct, entry, stopLoss,
      targets: [t1, t2, t3].filter((t) => t > 0),
      side, brokerageBps, slippageBps,
    }),
    [portfolioSize, riskPct, entry, stopLoss, t1, t2, t3, side, brokerageBps, slippageBps],
  );

  const useLtp = () => { if (ltp) setEntry(Number(ltp.toFixed(2))); };
  const suggestSL = () => {
    if (!entry) return;
    // Suggest 2% away from entry
    const pct = 0.02;
    setStopLoss(Number((side === "long" ? entry * (1 - pct) : entry * (1 + pct)).toFixed(2)));
  };
  const suggestTargets = () => {
    if (!entry || !stopLoss) return;
    const r = side === "long" ? entry - stopLoss : stopLoss - entry;
    if (r <= 0) return;
    setT1(Number((side === "long" ? entry + r * 1 : entry - r * 1).toFixed(2)));
    setT2(Number((side === "long" ? entry + r * 2 : entry - r * 2).toFixed(2)));
    setT3(Number((side === "long" ? entry + r * 3 : entry - r * 3).toFixed(2)));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 380px) 1fr", gap: 12, minHeight: 0 }}>
      <HudPanel flow title="Trade Setup" index="MK.PLN.1">
        <Field label="Symbol (optional, to pull LTP)">
          <div style={{ display: "flex", gap: 6 }}>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)}
              placeholder="RELIANCE" style={{ ...inputStyle, flex: 1 }} />
            <Btn size="sm" onClick={useLtp} disabled={!ltp}>Use LTP</Btn>
          </div>
          {ltp && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>LTP ₹{fmtNum(ltp)}</div>}
        </Field>

        <Field label="Side">
          <div style={{ display: "flex", gap: 6 }}>
            <Btn size="sm" variant={side === "long" ? "primary" : "ghost"} onClick={() => setSide("long")}>Long</Btn>
            <Btn size="sm" variant={side === "short" ? "primary" : "ghost"} onClick={() => setSide("short")}>Short</Btn>
          </div>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Portfolio (₹)">
            <input type="number" value={portfolioSize} onChange={(e) => setPortfolioSize(+e.target.value)}
              style={inputStyle} />
          </Field>
          <Field label="Risk %">
            <input type="number" step="0.1" value={riskPct} onChange={(e) => setRiskPct(+e.target.value)}
              style={inputStyle} />
          </Field>
          <Field label="Entry (₹)">
            <input type="number" step="0.05" value={entry || ""} onChange={(e) => setEntry(+e.target.value)}
              style={inputStyle} />
          </Field>
          <Field label="Stop-loss (₹)">
            <div style={{ display: "flex", gap: 4 }}>
              <input type="number" step="0.05" value={stopLoss || ""} onChange={(e) => setStopLoss(+e.target.value)}
                style={{ ...inputStyle, flex: 1 }} />
              <Btn size="sm" onClick={suggestSL}>2%</Btn>
            </div>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <Field label="Target 1"><input type="number" step="0.05" value={t1 || ""} onChange={(e) => setT1(+e.target.value)} style={inputStyle} /></Field>
          <Field label="Target 2"><input type="number" step="0.05" value={t2 || ""} onChange={(e) => setT2(+e.target.value)} style={inputStyle} /></Field>
          <Field label="Target 3"><input type="number" step="0.05" value={t3 || ""} onChange={(e) => setT3(+e.target.value)} style={inputStyle} /></Field>
          <Btn size="sm" onClick={suggestTargets}>1R/2R/3R</Btn>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Brokerage (bps)">
            <input type="number" value={brokerageBps} onChange={(e) => setBrokerageBps(+e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Slippage (bps)">
            <input type="number" value={slippageBps} onChange={(e) => setSlippageBps(+e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </HudPanel>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel flow title="Position Sizing" index="MK.PLN.2">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <Metric label="Quantity" value={plan.quantity.toLocaleString("en-IN")} accent />
            <Metric label="Position Value" value={`₹${fmtNum(plan.positionValue, 0)}`} />
            <Metric label="% of Capital" value={fmtPct(plan.positionPctOfCapital)} />
            <Metric label="Rupee Risk" value={`₹${fmtNum(plan.rupeeRisk, 0)}`} />
            <Metric label="Risk / share" value={`₹${fmtNum(plan.riskPerShare, 2)}`} />
            <Metric label="Max Loss" value={`₹${fmtNum(plan.maxLoss, 0)}`} tone="danger" />
            <Metric label="Round-trip fees" value={`₹${fmtNum(plan.totalFees, 0)}`} />
            <Metric label="Breakeven" value={`₹${fmtNum(plan.breakeven, 2)}`} />
          </div>
          {plan.warnings.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {plan.warnings.map((w) => <Chip key={w} tone="warn">{w}</Chip>)}
            </div>
          )}
        </HudPanel>

        <HudPanel flow title="Targets · Risk / Reward" index="MK.PLN.3">
          {plan.targets.length === 0 ? (
            <div className="hud-label" style={{ color: "var(--text-muted)", fontSize: 11 }}>
              add at least one target price (or click 1R/2R/3R)
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.14em" }}>
                  <th style={cell}>Target</th>
                  <th style={cell}>Price</th>
                  <th style={cell}>R:R</th>
                  <th style={cell}>Profit</th>
                  <th style={cell}>% of Capital</th>
                </tr>
              </thead>
              <tbody>
                {plan.targets.map((t, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--edge)" }}>
                    <td style={cell}>T{i + 1}</td>
                    <td style={cell}>₹{fmtNum(t.price, 2)}</td>
                    <td style={{ ...cell, color: t.rr >= 2 ? "var(--ok)" : "var(--text)" }}>{fmtNum(t.rr, 2)}R</td>
                    <td style={{ ...cell, color: "var(--ok)" }}>₹{fmtNum(t.profit, 0)}</td>
                    <td style={cell}>{fmtPct(t.profitPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </HudPanel>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "6px 8px" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  );
}

function Metric({ label, value, accent, tone }: { label: string; value: string; accent?: boolean; tone?: "danger" | "ok" }) {
  const color = tone === "danger" ? "var(--danger)" : tone === "ok" ? "var(--ok)" : accent ? "var(--accent)" : "var(--text)";
  return (
    <div>
      <div style={{ ...labelStyle, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
