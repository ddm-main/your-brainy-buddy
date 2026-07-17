// Market Alerts — real CRUD over public.market_alerts.
// Create/toggle/delete alerts on any NSE symbol; supports price/percent/RSI/EMA/breakout
// triggers across browser + email + telegram + whatsapp channels.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Bell, Plus, Trash2 } from "lucide-react";

type Alert = {
  id: string;
  symbol: string;
  exchange: string;
  alert_type: string;
  threshold: number | null;
  config: any;
  channel: "browser" | "email" | "telegram" | "whatsapp";
  is_active: boolean;
  triggered_at: string | null;
  last_error: string | null;
  created_at: string;
};

const TYPES = [
  { v: "price_above", l: "Price above" },
  { v: "price_below", l: "Price below" },
  { v: "pct_move", l: "% move (intraday)" },
  { v: "rsi_above", l: "RSI above" },
  { v: "rsi_below", l: "RSI below" },
  { v: "ema_cross", l: "EMA cross (20/50)" },
  { v: "breakout", l: "Breakout confirmed" },
];
const CHANNELS: Alert["channel"][] = ["browser", "email", "telegram", "whatsapp"];

export default function Alerts() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [filterSym, setFilterSym] = useState("");
  const [filterType, setFilterType] = useState("");

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ["market", "alerts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("market_alerts")
        .select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Alert[];
    },
  });

  const filtered = useMemo(() => alerts.filter((a) =>
    (!filterSym || a.symbol.toUpperCase().includes(filterSym.toUpperCase())) &&
    (!filterType || a.alert_type === filterType)
  ), [alerts, filterSym, filterType]);

  const toggle = async (a: Alert) => {
    try {
      const { error } = await supabase.from("market_alerts")
        .update({ is_active: !a.is_active }).eq("id", a.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["market", "alerts"] });
    } catch (e) { push(toSafeError(e, "toggle failed").message, "err"); }
  };
  const remove = async (a: Alert) => {
    if (!confirm(`Delete alert on ${a.symbol}?`)) return;
    try {
      const { error } = await supabase.from("market_alerts").delete().eq("id", a.id);
      if (error) throw error;
      push("Alert deleted", "ok");
      qc.invalidateQueries({ queryKey: ["market", "alerts"] });
    } catch (e) { push(toSafeError(e, "delete failed").message, "err"); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Alerts" index="MK.ALR"
        actions={<Btn size="sm" variant="primary" onClick={() => setCreating(true)}><Plus size={11} style={{ marginRight: 4 }}/> new alert</Btn>}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
          <div>
            <div style={labelStyle}>Symbol filter</div>
            <input value={filterSym} onChange={(e) => setFilterSym(e.target.value)} placeholder="RELIANCE" style={{ ...inputStyle, width: 160 }}/>
          </div>
          <div>
            <div style={labelStyle}>Type filter</div>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ ...inputStyle, width: 200 }}>
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
            {filtered.length} of {alerts.length}
          </div>
        </div>

        {isLoading ? (
          <div className="hud-label" style={{ padding: 16 }}>loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState hint="Create price/RSI/breakout alerts on any NSE symbol. Alerts fire via browser + optional email/telegram/whatsapp.">
            <Bell size={12} style={{ marginRight: 4 }}/> no alerts yet
          </EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filtered.map((a) => (
              <div key={a.id} style={{
                display: "grid", gridTemplateColumns: "120px 1fr 120px 100px 130px auto",
                gap: 8, alignItems: "center", padding: "8px 6px",
                borderBottom: "1px solid var(--edge)", fontSize: 12,
              }}>
                <span style={{ color: "var(--accent)", fontWeight: 500 }}>{a.symbol}</span>
                <span>
                  {TYPES.find((t) => t.v === a.alert_type)?.l ?? a.alert_type}
                  {a.threshold != null && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>@ {a.threshold}</span>}
                </span>
                <Chip tone="neutral">{a.channel}</Chip>
                <Chip tone={a.is_active ? "ok" : "neutral"}>{a.is_active ? "active" : "paused"}</Chip>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {a.triggered_at ? `fired ${new Date(a.triggered_at).toLocaleDateString()}` : "not yet fired"}
                </span>
                <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <Btn size="sm" onClick={() => toggle(a)}>{a.is_active ? "pause" : "resume"}</Btn>
                  <Btn size="sm" onClick={() => remove(a)}><Trash2 size={11}/></Btn>
                </span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      {creating && <NewAlertModal onClose={() => setCreating(false)} onCreated={() => {
        qc.invalidateQueries({ queryKey: ["market", "alerts"] });
        setCreating(false);
      }}/>}
    </div>
  );
}

function NewAlertModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const push = useUi((s) => s.push);
  const [symbol, setSymbol] = useState("");
  const [alertType, setAlertType] = useState("price_above");
  const [threshold, setThreshold] = useState("");
  const [channel, setChannel] = useState<Alert["channel"]>("browser");
  const [busy, setBusy] = useState(false);

  const needsThreshold = !["ema_cross", "breakout"].includes(alertType);

  const save = async () => {
    if (!symbol.trim()) { push("Symbol required", "err"); return; }
    if (needsThreshold && !threshold.trim()) { push("Threshold required", "err"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) throw new Error("not signed in");
      const { error } = await supabase.from("market_alerts").insert({
        user_id: u.user.id,
        symbol: symbol.trim().toUpperCase(),
        exchange: "NSE",
        alert_type: alertType,
        threshold: needsThreshold ? Number(threshold) : null,
        channel,
        is_active: true,
        config: {},
      });
      if (error) throw error;
      push("Alert created", "ok");
      onCreated();
    } catch (e) { push(toSafeError(e, "create failed").message, "err"); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 420, background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 16, display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>New alert</div>
        <div>
          <div style={labelStyle}>Symbol</div>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="RELIANCE" style={inputStyle} autoFocus/>
        </div>
        <div>
          <div style={labelStyle}>Type</div>
          <select value={alertType} onChange={(e) => setAlertType(e.target.value)} style={inputStyle}>
            {TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </div>
        {needsThreshold && (
          <div>
            <div style={labelStyle}>Threshold</div>
            <input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="2500" style={inputStyle} type="number"/>
          </div>
        )}
        <div>
          <div style={labelStyle}>Channel</div>
          <select value={channel} onChange={(e) => setChannel(e.target.value as Alert["channel"])} style={inputStyle}>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
          <Btn onClick={onClose}>cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={busy}>{busy ? "saving…" : "create"}</Btn>
        </div>
      </div>
    </div>
  );
}
