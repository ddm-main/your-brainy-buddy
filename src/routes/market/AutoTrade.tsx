// AutoTrade — user-defined entry/exit rules executed automatically against
// the connected Kotak Neo account. Real orders, real money: the kill switch
// defaults off, every rule needs an explicit "Arm" action separate from
// "Save", and risk caps are enforced server-side in market-autotrade-eval
// (this UI mirrors them so they're visible, not so they're the only guard).
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtNum } from "@/components/hud/DataTable";
import { relTime } from "@/lib/db";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useMarketSettings } from "@/lib/market/hooks";
import { FILTERS, FILTER_BY_ID, type FilterDef } from "@/lib/market/screenerCatalog";
import type { ScreenerCondition, ScreenerGroup } from "@/lib/market/types";
import {
  useAutoTradeAction,
  useAutoTradeLog,
  useAutoTradeOrders,
  useAutoTradeRuleMutations,
  useAutoTradeRules,
  useAutoTradeSettings,
  useAutoTradeSettingsMutation,
  type AutoTradeOrder,
  type AutoTradeRule,
} from "@/lib/market/autotradeHooks";
import { Plus, Power, Trash2, X } from "lucide-react";

const RULE_FILTER_IDS = [
  "ltp", "pct_from_52w_high", "rsi", "adx", "macd_hist", "bb_width", "atr_pct", "above_ema_200",
  "change_pct", "rel_volume", "rel_strength_nifty", "sector_strength",
  "breakout_score", "prebreakout_score", "bb_squeeze", "higher_lows", "near_resistance",
];
const RULE_FILTERS: FilterDef[] = RULE_FILTER_IDS.map((id) => FILTER_BY_ID[id]).filter(Boolean);

function opLabel(op: ScreenerCondition["op"]): string {
  switch (op) {
    case "gt": return ">"; case "gte": return "≥"; case "lt": return "<";
    case "lte": return "≤"; case "eq": return "="; case "is_true": return "is true"; case "is_false": return "is false";
  }
}

function summarizeConditions(groups: ScreenerGroup[]): string {
  const conds = groups[0]?.conditions ?? [];
  if (conds.length === 0) return "no conditions";
  return conds.map((c) => {
    const def = FILTER_BY_ID[c.column];
    const label = def?.label ?? c.column;
    if (c.op === "is_true" || c.op === "is_false") return `${label} ${opLabel(c.op)}`;
    return `${label} ${opLabel(c.op)} ${c.value}`;
  }).join(" AND ");
}

export default function AutoTrade() {
  const { data: settings } = useAutoTradeSettings();
  const settingsMut = useAutoTradeSettingsMutation();
  const { data: rules = [] } = useAutoTradeRules();
  const { save, setArmed, remove } = useAutoTradeRuleMutations();
  const { data: orders = [] } = useAutoTradeOrders();
  const { data: log = [] } = useAutoTradeLog();
  const { data: apiSettings = [] } = useMarketSettings();
  const action = useAutoTradeAction();

  const [editing, setEditing] = useState<AutoTradeRule | "new" | null>(null);
  const [caps, setCaps] = useState<{ max_capital_per_rule: string; max_open_positions: string; daily_loss_limit: string } | null>(null);

  const kotak = apiSettings.find((s) => s.active_provider === "kotak_neo");
  const kotakConnected = kotak?.connection_status === "connected";

  // Open AutoTrade positions, netted client-side from the order ledger —
  // same logic as the eval function's computeOpenPositions, for display only.
  const openPositions = useMemo(() => {
    const map = new Map<string, { symbol: string; exchange: string; qty: number; ruleId: string | null }>();
    for (const o of orders) {
      if (o.status !== "placed" && o.status !== "filled") continue;
      const key = `${o.rule_id}:${o.symbol}:${o.exchange}`;
      const cur = map.get(key) ?? { symbol: o.symbol, exchange: o.exchange, qty: 0, ruleId: o.rule_id };
      cur.qty += o.leg === "entry" ? o.quantity : -o.quantity;
      map.set(key, cur);
    }
    return [...map.values()].filter((p) => p.qty > 0);
  }, [orders]);

  const { data: watchlists = [] } = useQuery({
    queryKey: ["market", "autotrade", "watchlists-picker"],
    queryFn: async () => {
      const { data, error } = await supabase.from("market_watchlists").select("id,name").order("name");
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });
  const watchlistName = (id: string | null) => watchlists.find((w) => w.id === id)?.name ?? "—";

  const toggleEnabled = () => {
    if (!settings) return;
    settingsMut.mutate({ enabled: !settings.enabled, ...(settings.enabled ? {} : { disabled_reason: null, disabled_at: null }) });
  };

  const saveCaps = () => {
    if (!caps) return;
    settingsMut.mutate({
      max_capital_per_rule: Number(caps.max_capital_per_rule) || 0,
      max_open_positions: Math.max(1, Number(caps.max_open_positions) || 1),
      daily_loss_limit: Number(caps.daily_loss_limit) || 0,
    });
    setCaps(null);
  };

  const columns = useMemo(() => [
    { header: "Name", accessorKey: "name" as const },
    {
      header: "Scope", id: "scope",
      accessorFn: (r: AutoTradeRule) => r.symbol ? `${r.symbol} (${r.exchange})` : watchlistName(r.watchlist_id),
    },
    { header: "Entry", id: "entry", accessorFn: (r: AutoTradeRule) => summarizeConditions(r.entry_conditions) },
    {
      header: "Exit", id: "exit",
      accessorFn: (r: AutoTradeRule) => {
        const parts = [summarizeConditions(r.exit_conditions)];
        if (r.stop_loss_pct) parts.push(`SL -${r.stop_loss_pct}%`);
        if (r.target_pct) parts.push(`Target +${r.target_pct}%`);
        return parts.filter((p) => p !== "no conditions").join(" · ") || "—";
      },
    },
    {
      header: "Armed", id: "armed", meta: { align: "right" as const },
      cell: ({ row }: { row: { original: AutoTradeRule } }) => (
        <Btn size="sm" variant={row.original.is_armed ? "primary" : "ghost"}
          onClick={() => setArmed.mutate({ id: row.original.id, armed: !row.original.is_armed })}>
          {row.original.is_armed ? "armed" : "disarmed"}
        </Btn>
      ),
    },
    {
      header: "", id: "actions", meta: { align: "right" as const },
      cell: ({ row }: { row: { original: AutoTradeRule } }) => (
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <Btn size="sm" onClick={() => action.mutate({ action: "dry_run", rule_id: row.original.id })} title="Evaluate now without placing an order">test</Btn>
          <Btn size="sm" onClick={() => setEditing(row.original)}>edit</Btn>
          <button onClick={() => { if (confirm(`Delete rule "${row.original.name}"?`)) remove.mutate(row.original.id); }}
            className="hud-btn" data-variant="ghost" data-size="sm" title="Delete">
            <Trash2 size={11} />
          </button>
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [watchlists, setArmed, remove, action]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="AutoTrade Control" index="AT.01" live={settings?.enabled ? "ok" : "idle"}>
        {settings?.disabled_reason && (
          <div style={{ padding: 10, marginBottom: 10, border: "1px solid var(--danger)", background: "rgba(255,95,109,0.08)", fontSize: 12, color: "var(--danger)" }}>
            Circuit breaker tripped: {settings.disabled_reason}
          </div>
        )}
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={toggleEnabled}
            className="hud-btn focus-outline"
            data-variant={settings?.enabled ? "primary" : "danger"}
            data-size="md"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Power size={14} />
            {settings?.enabled ? "AUTOTRADE LIVE — click to kill" : "AUTOTRADE OFF — click to enable"}
          </button>
          <Chip tone={kotakConnected ? "ok" : "err"}>{kotakConnected ? "Kotak connected" : "Kotak not connected"}</Chip>
          <Chip tone="neutral">{openPositions.length} open position{openPositions.length === 1 ? "" : "s"}</Chip>
          <Chip tone="neutral">{rules.filter((r) => r.is_armed).length} armed rule{rules.filter((r) => r.is_armed).length === 1 ? "" : "s"}</Chip>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Max capital / rule (₹)</div>
            <input type="number" value={caps?.max_capital_per_rule ?? String(settings?.max_capital_per_rule ?? 10000)}
              onChange={(e) => setCaps({
                max_capital_per_rule: e.target.value,
                max_open_positions: caps?.max_open_positions ?? String(settings?.max_open_positions ?? 3),
                daily_loss_limit: caps?.daily_loss_limit ?? String(settings?.daily_loss_limit ?? 2000),
              })} style={{ ...inputStyle, width: 140 }} />
          </div>
          <div>
            <div style={labelStyle}>Max open positions</div>
            <input type="number" value={caps?.max_open_positions ?? String(settings?.max_open_positions ?? 3)}
              onChange={(e) => setCaps({
                max_capital_per_rule: caps?.max_capital_per_rule ?? String(settings?.max_capital_per_rule ?? 10000),
                max_open_positions: e.target.value,
                daily_loss_limit: caps?.daily_loss_limit ?? String(settings?.daily_loss_limit ?? 2000),
              })} style={{ ...inputStyle, width: 100 }} />
          </div>
          <div>
            <div style={labelStyle}>Daily loss limit (₹)</div>
            <input type="number" value={caps?.daily_loss_limit ?? String(settings?.daily_loss_limit ?? 2000)}
              onChange={(e) => setCaps({
                max_capital_per_rule: caps?.max_capital_per_rule ?? String(settings?.max_capital_per_rule ?? 10000),
                max_open_positions: caps?.max_open_positions ?? String(settings?.max_open_positions ?? 3),
                daily_loss_limit: e.target.value,
              })} style={{ ...inputStyle, width: 120 }} />
          </div>
          {caps && <Btn size="sm" variant="primary" onClick={saveCaps}>save caps</Btn>}
        </div>
      </HudPanel>

      <HudPanel flow title="Rules" index="AT.02" actions={<Btn size="sm" variant="primary" onClick={() => setEditing("new")}><Plus size={11} style={{ marginRight: 4 }} />new rule</Btn>}>
        {rules.length === 0 ? (
          <EmptyState hint="Create a rule to define entry/exit conditions for AutoTrade">no rules yet</EmptyState>
        ) : (
          <DataTable columns={columns as any} data={rules} emptyLabel="no rules" />
        )}
      </HudPanel>

      {openPositions.length > 0 && (
        <HudPanel flow title="Open AutoTrade Positions" index="AT.03">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {openPositions.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", border: "1px solid var(--edge)", fontSize: 12 }}>
                <span>{p.symbol} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{p.exchange} · qty {p.qty}</span></span>
                <Btn size="sm" variant="danger" onClick={() => action.mutate({ action: "flatten", symbol: p.symbol, exchange: p.exchange, rule_id: p.ruleId })}>
                  flatten now
                </Btn>
              </div>
            ))}
          </div>
        </HudPanel>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
        <HudPanel flow title="Recent Orders" index="AT.04">
          {orders.length === 0 ? <EmptyState>no orders yet</EmptyState> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflow: "auto" }}>
              {orders.map((o: AutoTradeOrder) => (
                <div key={o.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "4px 6px", borderBottom: "1px solid var(--edge)" }}>
                  <span>
                    <Chip tone={o.side === "BUY" ? "ok" : "warn"}>{o.side}</Chip>
                    <span style={{ marginLeft: 6 }}>{o.symbol} × {fmtNum(o.quantity, 0)}</span>
                    <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>{o.leg} · {o.status}</span>
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>{relTime(o.created_at)} ago</span>
                </div>
              ))}
            </div>
          )}
        </HudPanel>
        <HudPanel flow title="Activity Log" index="AT.05">
          {log.length === 0 ? <EmptyState>nothing logged yet</EmptyState> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflow: "auto" }}>
              {log.map((l) => (
                <div key={l.id} style={{ fontSize: 11, padding: "4px 6px", borderBottom: "1px solid var(--edge)" }}>
                  <Chip tone={l.level === "fired" ? "ok" : l.level === "error" ? "err" : l.level === "skip" ? "warn" : "neutral"}>{l.level}</Chip>
                  <span style={{ marginLeft: 6 }}>{l.message}</span>
                  <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{relTime(l.created_at)} ago</div>
                </div>
              ))}
            </div>
          )}
        </HudPanel>
      </div>

      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          watchlists={watchlists}
          onClose={() => setEditing(null)}
          onSave={(payload, arm) => {
            save.mutate({ ...payload, is_armed: arm }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}
    </div>
  );
}

/* ---------- Rule editor dialog ---------- */

function ConditionRow({ cond, onChange, onRemove }: {
  cond: ScreenerCondition;
  onChange: (c: ScreenerCondition) => void;
  onRemove: () => void;
}) {
  const def = FILTER_BY_ID[cond.column];
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select value={cond.column} onChange={(e) => {
        const nd = FILTER_BY_ID[e.target.value];
        onChange({ column: e.target.value, op: nd?.kind === "boolean" ? "is_true" : "gt", value: nd?.kind === "boolean" ? undefined : cond.value });
      }} style={{ ...inputStyle, width: 170, padding: "6px 8px", fontSize: 11 }}>
        {RULE_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      {def?.kind === "boolean" ? (
        <select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as ScreenerCondition["op"] })}
          style={{ ...inputStyle, width: 100, padding: "6px 8px", fontSize: 11 }}>
          <option value="is_true">is true</option>
          <option value="is_false">is false</option>
        </select>
      ) : (
        <>
          <select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as ScreenerCondition["op"] })}
            style={{ ...inputStyle, width: 70, padding: "6px 8px", fontSize: 11 }}>
            <option value="gt">&gt;</option>
            <option value="gte">&ge;</option>
            <option value="lt">&lt;</option>
            <option value="lte">&le;</option>
            <option value="eq">=</option>
          </select>
          <input type="number" value={cond.value ?? ""} onChange={(e) => onChange({ ...cond, value: e.target.value === "" ? undefined : Number(e.target.value) })}
            style={{ ...inputStyle, width: 90, padding: "6px 8px", fontSize: 11 }} placeholder={def?.unit ?? ""} />
        </>
      )}
      <button onClick={onRemove} className="hud-btn" data-variant="ghost" data-size="sm" title="Remove condition"><X size={11} /></button>
    </div>
  );
}

function ConditionBuilder({ label, conditions, onChange }: {
  label: string;
  conditions: ScreenerCondition[];
  onChange: (c: ScreenerCondition[]) => void;
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {conditions.map((c, i) => (
          <ConditionRow key={i} cond={c}
            onChange={(nc) => onChange(conditions.map((x, xi) => xi === i ? nc : x))}
            onRemove={() => onChange(conditions.filter((_, xi) => xi !== i))} />
        ))}
        <Btn size="sm" onClick={() => onChange([...conditions, { column: RULE_FILTERS[0].id, op: "gt", value: undefined }])}>
          <Plus size={11} style={{ marginRight: 4 }} />add condition
        </Btn>
      </div>
    </div>
  );
}

function RuleEditor({ rule, watchlists, onClose, onSave }: {
  rule: AutoTradeRule | null;
  watchlists: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (payload: Partial<AutoTradeRule> & { name: string }, arm: boolean) => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [scopeType, setScopeType] = useState<"symbol" | "watchlist">(rule?.watchlist_id ? "watchlist" : "symbol");
  const [symbol, setSymbol] = useState(rule?.symbol ?? "");
  const [exchange, setExchange] = useState<"NSE" | "BSE">((rule?.exchange as "NSE" | "BSE") ?? "NSE");
  const [watchlistId, setWatchlistId] = useState(rule?.watchlist_id ?? watchlists[0]?.id ?? "");
  const [entry, setEntry] = useState<ScreenerCondition[]>(rule?.entry_conditions?.[0]?.conditions ?? []);
  const [exit, setExit] = useState<ScreenerCondition[]>(rule?.exit_conditions?.[0]?.conditions ?? []);
  const [stopLoss, setStopLoss] = useState(rule?.stop_loss_pct != null ? String(rule.stop_loss_pct) : "3");
  const [target, setTarget] = useState(rule?.target_pct != null ? String(rule.target_pct) : "6");
  const [product, setProduct] = useState<"MIS" | "CNC">(rule?.product ?? "MIS");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">(rule?.order_type ?? "MARKET");
  const [limitOffset, setLimitOffset] = useState(rule?.limit_offset_pct != null ? String(rule.limit_offset_pct) : "0.1");
  const [sizingMode, setSizingMode] = useState<"fixed_qty" | "fixed_capital">(rule?.sizing_mode ?? "fixed_capital");
  const [sizingValue, setSizingValue] = useState(rule?.sizing_value != null ? String(rule.sizing_value) : "5000");

  const preview = useMemo(() => {
    const scope = scopeType === "symbol" ? (symbol || "?") + ` (${exchange})` : `watchlist "${watchlists.find((w) => w.id === watchlistId)?.name ?? "?"}"`;
    const entrySummary = entry.length ? summarizeConditions([{ conditions: entry }]) : "no conditions set";
    const exitParts = [exit.length ? summarizeConditions([{ conditions: exit }]) : null, stopLoss ? `stop-loss -${stopLoss}%` : null, target ? `target +${target}%` : null].filter(Boolean);
    const sizing = sizingMode === "fixed_qty" ? `${sizingValue} shares` : `up to ₹${sizingValue}`;
    return `BUY ${scope} when ${entrySummary}, using ${orderType} order (${product}), sizing ${sizing}. SELL when ${exitParts.join(" OR ") || "no exit set"}.`;
  }, [scopeType, symbol, exchange, watchlistId, watchlists, entry, exit, stopLoss, target, sizingMode, sizingValue, orderType, product]);

  const buildPayload = (): (Partial<AutoTradeRule> & { name: string }) | null => {
    if (!name.trim()) { alert("Name required"); return null; }
    if (scopeType === "symbol" && !symbol.trim()) { alert("Symbol required"); return null; }
    if (scopeType === "watchlist" && !watchlistId) { alert("Watchlist required"); return null; }
    if (entry.length === 0) { alert("At least one entry condition required"); return null; }
    return {
      id: rule?.id,
      name: name.trim(),
      symbol: scopeType === "symbol" ? symbol.trim().toUpperCase() : null,
      exchange,
      watchlist_id: scopeType === "watchlist" ? watchlistId : null,
      entry_conditions: [{ conditions: entry }],
      exit_conditions: exit.length ? [{ conditions: exit }] : [],
      stop_loss_pct: stopLoss ? Number(stopLoss) : null,
      target_pct: target ? Number(target) : null,
      product, order_type: orderType,
      limit_offset_pct: orderType === "LIMIT" ? Number(limitOffset) : null,
      sizing_mode: sizingMode, sizing_value: Number(sizingValue) || 0,
    };
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 96vw)", maxHeight: "90vh", overflowY: "auto",
        background: "var(--bg)", border: "1px solid var(--edge-strong)", padding: 16,
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>{rule ? "Edit rule" : "New rule"}</div>
          <button onClick={onClose} className="hud-btn focus-outline" data-variant="ghost" data-size="sm"><X size={14} /></button>
        </div>

        <div>
          <div style={labelStyle}>Name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="RSI dip on NIFTY IT" style={{ ...inputStyle, width: "100%" }} />
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Scope</div>
            <div style={{ display: "flex", gap: 4 }}>
              <Btn size="sm" variant={scopeType === "symbol" ? "primary" : "ghost"} onClick={() => setScopeType("symbol")}>symbol</Btn>
              <Btn size="sm" variant={scopeType === "watchlist" ? "primary" : "ghost"} onClick={() => setScopeType("watchlist")}>watchlist</Btn>
            </div>
          </div>
          {scopeType === "symbol" ? (
            <>
              <div>
                <div style={labelStyle}>Symbol</div>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="RELIANCE" style={{ ...inputStyle, width: 140 }} />
              </div>
              <div>
                <div style={labelStyle}>Exchange</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["NSE", "BSE"] as const).map((ex) => (
                    <Btn key={ex} size="sm" variant={exchange === ex ? "primary" : "ghost"} onClick={() => setExchange(ex)}>{ex}</Btn>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div>
              <div style={labelStyle}>Watchlist</div>
              <select value={watchlistId} onChange={(e) => setWatchlistId(e.target.value)} style={{ ...inputStyle, width: 200 }}>
                {watchlists.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
        </div>

        <ConditionBuilder label="Entry conditions (all must match)" conditions={entry} onChange={setEntry} />
        <ConditionBuilder label="Exit conditions (any match triggers exit)" conditions={exit} onChange={setExit} />

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Stop-loss %</div>
            <input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          </div>
          <div>
            <div style={labelStyle}>Target %</div>
            <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          </div>
          <div>
            <div style={labelStyle}>Product</div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["MIS", "CNC"] as const).map((p) => <Btn key={p} size="sm" variant={product === p ? "primary" : "ghost"} onClick={() => setProduct(p)}>{p}</Btn>)}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Order type</div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["MARKET", "LIMIT"] as const).map((o) => <Btn key={o} size="sm" variant={orderType === o ? "primary" : "ghost"} onClick={() => setOrderType(o)}>{o}</Btn>)}
            </div>
          </div>
          {orderType === "LIMIT" && (
            <div>
              <div style={labelStyle}>Limit offset %</div>
              <input type="number" value={limitOffset} onChange={(e) => setLimitOffset(e.target.value)} style={{ ...inputStyle, width: 90 }} />
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Sizing</div>
            <div style={{ display: "flex", gap: 4 }}>
              <Btn size="sm" variant={sizingMode === "fixed_capital" ? "primary" : "ghost"} onClick={() => setSizingMode("fixed_capital")}>₹ capital</Btn>
              <Btn size="sm" variant={sizingMode === "fixed_qty" ? "primary" : "ghost"} onClick={() => setSizingMode("fixed_qty")}>fixed qty</Btn>
            </div>
          </div>
          <div>
            <div style={labelStyle}>{sizingMode === "fixed_capital" ? "Capital (₹)" : "Quantity"}</div>
            <input type="number" value={sizingValue} onChange={(e) => setSizingValue(e.target.value)} style={{ ...inputStyle, width: 120 }} />
          </div>
        </div>

        <div style={{ padding: 10, border: "1px dashed var(--edge)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {preview}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn onClick={() => { const p = buildPayload(); if (p) onSave(p, rule?.is_armed ?? false); }}>save draft</Btn>
          <Btn variant="primary" onClick={() => { const p = buildPayload(); if (p) onSave(p, true); }}>arm this rule</Btn>
        </div>
      </div>
    </div>
  );
}
