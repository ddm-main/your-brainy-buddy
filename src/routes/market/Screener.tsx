// Stock Screener — AND/OR filter groups over market_stock_scores + saved screeners.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { useSavedScreeners, useScreenerMutations, useStockScores } from "@/lib/market/hooks";
import { useUi } from "@/store/uiStore";
import type { ScreenerCondition, ScreenerGroup, StockScore } from "@/lib/market/types";
import { Play, Plus, Save, Trash2, X } from "lucide-react";

// Column registry: what can be filtered and how it's displayed.
const FILTER_COLUMNS: Array<{ id: string; label: string; kind: "number" | "boolean" }> = [
  { id: "close", label: "Price", kind: "number" },
  { id: "change_pct", label: "Change %", kind: "number" },
  { id: "volume", label: "Volume", kind: "number" },
  { id: "rel_volume", label: "Rel Volume", kind: "number" },
  { id: "rsi14", label: "RSI (14)", kind: "number" },
  { id: "macd_hist", label: "MACD Hist", kind: "number" },
  { id: "adx14", label: "ADX (14)", kind: "number" },
  { id: "atr_pct", label: "ATR %", kind: "number" },
  { id: "bb_width", label: "BB Width", kind: "number" },
  { id: "pct_from_52w_high", label: "% from 52w High", kind: "number" },
  { id: "sector_strength", label: "Sector Strength (0-1)", kind: "number" },
  { id: "rel_strength_nifty", label: "Rel Strength vs NIFTY", kind: "number" },
  { id: "breakout_score", label: "Breakout Score", kind: "number" },
  { id: "prebreakout_score", label: "Pre-Breakout Score", kind: "number" },
  { id: "above_ema200", label: "Above 200 EMA", kind: "boolean" },
  { id: "bb_squeeze", label: "BB Squeeze", kind: "boolean" },
  { id: "higher_lows", label: "Higher Lows", kind: "boolean" },
  { id: "near_resistance", label: "Near Resistance", kind: "boolean" },
];

const NUM_OPS = [
  { id: "gte", label: "≥" },
  { id: "gt", label: ">" },
  { id: "lte", label: "≤" },
  { id: "lt", label: "<" },
  { id: "eq", label: "=" },
];

const PRESETS: Array<{ name: string; groups: ScreenerGroup[] }> = [
  {
    name: "Breakout candidates",
    groups: [{ conditions: [
      { column: "breakout_score", op: "gte", value: 65 },
      { column: "rel_volume", op: "gte", value: 1.5 },
      { column: "above_ema200", op: "is_true" },
    ] }],
  },
  {
    name: "Coiled springs (pre-breakout)",
    groups: [{ conditions: [
      { column: "prebreakout_score", op: "gte", value: 60 },
      { column: "bb_squeeze", op: "is_true" },
    ] }],
  },
  {
    name: "Momentum leaders",
    groups: [{ conditions: [
      { column: "rsi14", op: "gte", value: 55 },
      { column: "rsi14", op: "lte", value: 72 },
      { column: "rel_strength_nifty", op: "gte", value: 0 },
      { column: "above_ema200", op: "is_true" },
    ] }],
  },
];

const emptyCondition = (): ScreenerCondition => ({ column: "breakout_score", op: "gte", value: 60 });

export default function Screener() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const [groups, setGroups] = useState<ScreenerGroup[]>([{ conditions: [emptyCondition()] }]);
  const [applied, setApplied] = useState<ScreenerGroup[] | undefined>(undefined);
  const [name, setName] = useState("");
  const { data: rows = [], isFetching } = useStockScores({ groups: applied, limit: 300 });
  const { data: saved = [] } = useSavedScreeners();
  const { save, remove } = useScreenerMutations();

  const run = () => setApplied(groups.map((g) => ({ conditions: g.conditions.filter((c) => c.column) })));

  const updateCondition = (gi: number, ci: number, patch: Partial<ScreenerCondition>) => {
    setGroups((gs) => gs.map((g, i) => i !== gi ? g : {
      conditions: g.conditions.map((c, j) => {
        if (j !== ci) return c;
        const next = { ...c, ...patch };
        const kind = FILTER_COLUMNS.find((f) => f.id === next.column)?.kind;
        if (kind === "boolean" && next.op !== "is_true" && next.op !== "is_false") next.op = "is_true";
        if (kind === "number" && (next.op === "is_true" || next.op === "is_false")) next.op = "gte";
        return next;
      }),
    }));
  };

  const columns = useMemo<ColumnDef<StockScore, any>[]>(() => [
    {
      header: "Symbol", accessorKey: "symbol",
      cell: ({ row }) => (
        <span>
          <span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
          {row.original.sector && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.sector}</span>}
        </span>
      ),
    },
    { header: "Price", accessorKey: "close", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    { header: "Chg %", accessorKey: "change_pct", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue()} /> },
    { header: "Vol", accessorKey: "volume", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue()) },
    { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 1) },
    { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    { header: "ADX", accessorKey: "adx14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    { header: "52w Δ", accessorKey: "pct_from_52w_high", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue()} /> },
    {
      header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" />,
    },
    {
      header: "Pre-BO", accessorKey: "prebreakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.prebreakout_score} components={row.original.score_components?.prebreakout} label="pre-breakout components" />,
    },
    {
      header: "Setup", id: "setup", enableSorting: false,
      cell: ({ row }) => (
        <span style={{ display: "flex", gap: 4 }}>
          {row.original.bb_squeeze && <Chip tone="accent">squeeze</Chip>}
          {row.original.higher_lows && <Chip tone="ok">HL</Chip>}
          {row.original.near_resistance && <Chip tone="warn">@res</Chip>}
        </span>
      ),
    },
  ], []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="Filter Builder" index="MK.SC1" actions={
        <div style={{ display: "flex", gap: 6 }}>
          {PRESETS.map((p) => (
            <Btn key={p.name} size="sm" onClick={() => { setGroups(p.groups); setApplied(p.groups); }}>{p.name}</Btn>
          ))}
        </div>
      }>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ border: "1px solid var(--edge)", padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="hud-label" style={{ color: "var(--accent-soft)" }}>
                  {gi === 0 ? "MATCH ALL OF (AND)" : `OR — MATCH ALL OF`}
                </span>
                {groups.length > 1 && (
                  <button className="hud-btn" data-variant="ghost" data-size="sm" onClick={() => setGroups((gs) => gs.filter((_, i) => i !== gi))}>
                    <X size={11} />
                  </button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.conditions.map((c, ci) => {
                  const kind = FILTER_COLUMNS.find((f) => f.id === c.column)?.kind ?? "number";
                  return (
                    <div key={ci} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <select value={c.column} onChange={(e) => updateCondition(gi, ci, { column: e.target.value })}
                        style={{ ...inputStyle, padding: "4px 6px", minWidth: 180 }}>
                        {FILTER_COLUMNS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                      </select>
                      {kind === "number" ? (
                        <>
                          <select value={c.op} onChange={(e) => updateCondition(gi, ci, { op: e.target.value as any })}
                            style={{ ...inputStyle, padding: "4px 6px", width: 56 }}>
                            {NUM_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                          </select>
                          <input value={c.value ?? ""} type="number"
                            onChange={(e) => updateCondition(gi, ci, { value: e.target.value })}
                            style={{ ...inputStyle, width: 100 }} />
                        </>
                      ) : (
                        <select value={c.op} onChange={(e) => updateCondition(gi, ci, { op: e.target.value as any })}
                          style={{ ...inputStyle, padding: "4px 6px", width: 90 }}>
                          <option value="is_true">true</option>
                          <option value="is_false">false</option>
                        </select>
                      )}
                      <button className="hud-btn" data-variant="ghost" data-size="sm" title="Remove condition"
                        onClick={() => setGroups((gs) => gs.map((gg, i) => i !== gi ? gg : { conditions: gg.conditions.filter((_, j) => j !== ci) }))}>
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
                <div>
                  <Btn size="sm" onClick={() => setGroups((gs) => gs.map((gg, i) => i !== gi ? gg : { conditions: [...gg.conditions, emptyCondition()] }))}>
                    <Plus size={11} style={{ marginRight: 4 }} /> condition
                  </Btn>
                </div>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Btn size="sm" onClick={() => setGroups((gs) => [...gs, { conditions: [emptyCondition()] }])}>
              <Plus size={11} style={{ marginRight: 4 }} /> OR group
            </Btn>
            <Btn variant="primary" onClick={run}>
              <Play size={11} style={{ marginRight: 4 }} /> {isFetching ? "running…" : "Run screener"}
            </Btn>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div>
                <div style={labelStyle}>Save as</div>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="screener name" style={inputStyle} />
              </div>
              <Btn size="sm" onClick={() => {
                if (!name.trim()) { push("Name the screener first", "warn"); return; }
                save.mutate({ name: name.trim(), filters: groups }, {
                  onSuccess: () => { push("Screener saved", "ok"); setName(""); },
                  onError: (e) => push(e.message, "err"),
                });
              }}>
                <Save size={11} style={{ marginRight: 4 }} /> save
              </Btn>
            </div>
          </div>
        </div>
      </HudPanel>

      {saved.length > 0 && (
        <HudPanel flow title="Saved Screeners" index="MK.SC2">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {saved.map((s) => (
              <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--edge)", padding: "4px 8px" }}>
                <button onClick={() => { setGroups(s.filters); setApplied(s.filters); }}
                  style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.1em" }}>
                  {s.name}
                </button>
                <button className="hud-btn" data-variant="ghost" data-size="sm" title="Delete"
                  onClick={() => remove.mutate(s.id, { onError: (e) => push(e.message, "err") })}>
                  <Trash2 size={10} />
                </button>
              </span>
            ))}
          </div>
        </HudPanel>
      )}

      <HudPanel flow title={`Results ${rows.length ? `· ${rows.length}` : ""}`} index="MK.SC3" live={isFetching ? "warn" : "ok"}>
        <DataTable
          columns={columns}
          data={rows}
          onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
          initialSort={[{ id: "breakout_score", desc: true }]}
          emptyLabel={applied ? "no matches" : "build filters and run"}
          emptyHint={applied ? "loosen the filters — or the data pipeline hasn't run yet" : "results appear here"}
        />
      </HudPanel>
    </div>
  );
}
