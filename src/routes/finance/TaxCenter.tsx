import { useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { HudDatePicker } from "@/components/hud/HudDatePicker";
import { inr } from "@/lib/db";
import { calcCapitalGains, calcRegimeComparison, TAX_RULES_FY2026_27, type CapitalGainsInput } from "@/lib/taxCalc";

const DISCLAIMER = "Estimates only — not tax or financial advice. Verify with a chartered accountant before filing.";

function Disclaimer() {
  return (
    <div style={{ padding: "8px 12px", border: "1px solid var(--warn)", background: "rgba(255,184,92,0.06)", fontSize: 11, color: "var(--warn)", marginBottom: 14 }}>
      ⚠ {DISCLAIMER} ({TAX_RULES_FY2026_27.label})
    </div>
  );
}

// ---------- Tax Center ----------
export default function TaxCenter() {
  const [cg, setCg] = useState<Partial<CapitalGainsInput>>({ assetClass: "equity" });
  const [regime, setRegime] = useState({ income: "", deductions: "" });

  const cgResult = cg.assetClass && cg.buyDate && cg.sellDate && cg.buyAmount && cg.sellAmount
    ? calcCapitalGains({
        assetClass: cg.assetClass as CapitalGainsInput["assetClass"],
        buyDate: cg.buyDate, sellDate: cg.sellDate,
        buyAmount: Number(cg.buyAmount), sellAmount: Number(cg.sellAmount),
      })
    : null;

  const regimeResult = regime.income ? calcRegimeComparison(Number(regime.income), Number(regime.deductions) || 0) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflowY: "auto" }}>
      <HudPanel title="Tax Center" index="TAX" live="ok">
        <Disclaimer />

        <div className="hud-label" style={{ marginBottom: 8 }}>capital gains estimator</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 8 }}>
          <div><label style={labelStyle}>asset class</label>
            <HudSelect value={cg.assetClass ?? "equity"} onChange={(v) => setCg({ ...cg, assetClass: v as any })} options={[
              { value: "equity", label: "equity mutual fund" }, { value: "stock", label: "stock" }, { value: "debt_fund", label: "debt fund" },
            ]} />
          </div>
          <div><label style={labelStyle}>buy date</label><HudDatePicker value={cg.buyDate ?? ""} onChange={(v) => setCg({ ...cg, buyDate: v })} /></div>
          <div><label style={labelStyle}>sell date</label><HudDatePicker value={cg.sellDate ?? ""} onChange={(v) => setCg({ ...cg, sellDate: v })} /></div>
          <div><label style={labelStyle}>buy amount</label><input type="number" value={cg.buyAmount ?? ""} onChange={(e) => setCg({ ...cg, buyAmount: Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>sell amount</label><input type="number" value={cg.sellAmount ?? ""} onChange={(e) => setCg({ ...cg, sellAmount: Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} /></div>
        </div>
        {cgResult && (
          <div style={{ padding: 10, border: "1px solid var(--edge)", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            <div>Gain: <strong>{inr(cgResult.gain)}</strong> ({cgResult.kind === "slab" ? "taxed at your income slab rate" : cgResult.kind.toUpperCase()})</div>
            {cgResult.kind !== "slab" && <div>Taxable after exemption: {inr(cgResult.taxableAfterExemption)}</div>}
            <div>Estimated tax: <strong style={{ color: "var(--warn)" }}>{inr(cgResult.estimatedTax)}</strong></div>
          </div>
        )}
      </HudPanel>

      <HudPanel title="Old vs New Regime" index="REG" live="ok">
        <Disclaimer />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 8 }}>
          <div><label style={labelStyle}>gross annual income</label><input type="number" value={regime.income} onChange={(e) => setRegime({ ...regime, income: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
          <div><label style={labelStyle}>old-regime deductions (80C/80D/HRA...)</label><input type="number" value={regime.deductions} onChange={(e) => setRegime({ ...regime, deductions: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
        </div>
        {regimeResult && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {(["new", "old"] as const).map((r) => (
              <div key={r} style={{ padding: 10, border: `1px solid ${regimeResult.better === r ? "var(--ok)" : "var(--edge)"}`, fontSize: 12 }}>
                <div className="hud-label" style={{ marginBottom: 4 }}>{r} regime {regimeResult.better === r && "· better"}</div>
                <div>Taxable income: {inr(regimeResult[r].taxableIncome)}</div>
                <div>Total tax (incl. cess): <strong>{inr(regimeResult[r].totalTax)}</strong></div>
                {regimeResult[r].rebateApplied && <div style={{ color: "var(--ok)" }}>87A rebate applied — zero tax</div>}
              </div>
            ))}
          </div>
        )}
      </HudPanel>
    </div>
  );
}
