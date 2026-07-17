// Option Chain — NSE indices & equities. Focused rows around ATM strike.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { fmtInt, fmtNum } from "@/components/hud/DataTable";
import { useOptionChain } from "@/lib/market/hooks";

const PRESETS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "RELIANCE", "HDFCBANK", "TCS", "INFY"];

type Leg = { oi: number; oi_change: number; volume: number; iv: number | null; ltp: number; change: number; bid: number; ask: number } | null;

export default function OptionChain() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [expiry, setExpiry] = useState<string | undefined>();
  const [strikeWindow, setStrikeWindow] = useState(15);

  const sym = symbol?.toUpperCase();
  const { data, isLoading, error, refetch, isFetching } = useOptionChain(sym, expiry);

  const rowsAroundAtm = useMemo(() => {
    if (!data) return [];
    const atmIdx = data.rows.reduce((best, r, i) => {
      const cur = data.rows[best];
      return Math.abs(r.strike - data.underlying) < Math.abs(cur.strike - data.underlying) ? i : best;
    }, 0);
    const start = Math.max(0, atmIdx - strikeWindow);
    const end = Math.min(data.rows.length, atmIdx + strikeWindow + 1);
    return data.rows.slice(start, end).map((r) => ({ ...r, isAtm: r.strike === data.rows[atmIdx].strike }));
  }, [data, strikeWindow]);

  if (!sym) {
    return (
      <HudPanel flow title="Option Chain" index="MK.OPT">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 400 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Symbol</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && search.trim()) nav(`/market/options/${search.trim().toUpperCase()}`); }}
              placeholder="NIFTY" style={inputStyle} autoFocus />
          </div>
          <Btn variant="primary" onClick={() => search.trim() && nav(`/market/options/${search.trim().toUpperCase()}`)}>Load</Btn>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <Btn key={p} size="sm" variant="ghost" onClick={() => nav(`/market/options/${p}`)}>{p}</Btn>
          ))}
        </div>
      </HudPanel>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title={`${sym} Option Chain`} index="MK.OPT"
        live={isLoading || isFetching ? "warn" : "ok"}
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {data?.expiries && (
              <select value={expiry ?? data.expiry} onChange={(e) => setExpiry(e.target.value)} style={{ ...inputStyle, padding: "4px 8px" }}>
                {data.expiries.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            )}
            <select value={strikeWindow} onChange={(e) => setStrikeWindow(Number(e.target.value))} style={{ ...inputStyle, padding: "4px 8px" }}>
              {[5, 10, 15, 25, 50].map((n) => <option key={n} value={n}>±{n}</option>)}
            </select>
            <Btn size="sm" onClick={() => refetch()}>Refresh</Btn>
          </div>
        }>
        {error ? (
          <EmptyState hint={String((error as Error).message ?? "")}>option chain unavailable</EmptyState>
        ) : !data ? (
          <div className="hud-label" style={{ padding: 16 }}>loading…</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <Metric label="Underlying" value={fmtNum(data.underlying)} accent />
              <Metric label="PCR (OI)" value={data.pcr != null ? fmtNum(data.pcr, 2) : "—"}
                tone={data.pcr == null ? undefined : data.pcr > 1.3 ? "ok" : data.pcr < 0.7 ? "danger" : "warn"} />
              <Metric label="Call OI" value={fmtInt(data.total_call_oi)} />
              <Metric label="Put OI" value={fmtInt(data.total_put_oi)} />
              <Chip tone="accent">{rowsAroundAtm.length} strikes</Chip>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 11, fontVariantNumeric: "tabular-nums", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--text-dim)", textAlign: "right", borderBottom: "1px solid var(--edge)" }}>
                    <Th>OI</Th><Th>ΔOI</Th><Th>Vol</Th><Th>IV</Th><Th>LTP (CE)</Th>
                    <Th center>Strike</Th>
                    <Th>LTP (PE)</Th><Th>IV</Th><Th>Vol</Th><Th>ΔOI</Th><Th>OI</Th>
                  </tr>
                </thead>
                <tbody>
                  {rowsAroundAtm.map((r) => (
                    <tr key={r.strike} style={{
                      borderBottom: "1px solid var(--edge)",
                      background: r.isAtm ? "rgba(53,214,237,0.08)" : undefined,
                    }}>
                      <LegCells leg={r.call as Leg} side="call" />
                      <td style={{ padding: "4px 8px", textAlign: "center", fontWeight: 700, color: r.isAtm ? "var(--accent)" : "var(--text)" }}>
                        {fmtNum(r.strike, 0)}
                      </td>
                      <LegCells leg={r.put as Leg} side="put" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </HudPanel>
    </div>
  );
}

function Th({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <th style={{ padding: "6px 8px", textAlign: center ? "center" : "right", fontWeight: 400, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>{children}</th>;
}

function LegCells({ leg, side }: { leg: Leg; side: "call" | "put" }) {
  if (!leg) return <><td /><td /><td /><td /><td /></>;
  const posOi = leg.oi_change > 0;
  const cells = [
    <td key="oi" style={cell()}>{fmtInt(leg.oi)}</td>,
    <td key="doi" style={{ ...cell(), color: posOi ? "var(--ok)" : leg.oi_change < 0 ? "var(--danger)" : "var(--text-dim)" }}>{fmtInt(leg.oi_change)}</td>,
    <td key="vol" style={cell()}>{fmtInt(leg.volume)}</td>,
    <td key="iv" style={cell()}>{leg.iv != null ? fmtNum(leg.iv, 2) : "—"}</td>,
    <td key="ltp" style={{ ...cell(), color: leg.change >= 0 ? "var(--ok)" : "var(--danger)" }}>{fmtNum(leg.ltp, 2)}</td>,
  ];
  return <>{side === "call" ? cells : cells.reverse()}</>;
}

function cell(): React.CSSProperties {
  return { padding: "4px 8px", textAlign: "right" };
}

function Metric({ label, value, tone, accent }: { label: string; value: string; tone?: "ok" | "warn" | "danger"; accent?: boolean }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : accent ? "var(--accent)" : "var(--text)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="hud-label" style={{ fontSize: 9, color: "var(--text-dim)" }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
