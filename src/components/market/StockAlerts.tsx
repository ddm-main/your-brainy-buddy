// Per-symbol alert creation + management — replaces the standalone Alerts
// page. Alerts are now created and viewed right where you'd act on them: the
// stock's own Analysis view. Symbol/exchange come from the caller (locked,
// not retyped) — the old page took a ?symbol= query param but never actually
// read it, so "prefill" silently did nothing; this fixes that too.
import { useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Bell, Plus, Trash2 } from "lucide-react";

export type AlertChannel = "browser" | "email" | "telegram" | "whatsapp";
type Alert = {
  id: string;
  symbol: string;
  exchange: string;
  alert_type: string;
  threshold: number | null;
  channel: AlertChannel;
  is_active: boolean;
  triggered_at: string | null;
};

// Values must match market-alerts-eval's switch exactly — a mismatch here
// means an alert can be created and never fire, silently, forever.
export const ALERT_TYPES = [
  { v: "price_above", l: "Price above" },
  { v: "price_below", l: "Price below" },
  { v: "percent_change", l: "% move (intraday)" },
  { v: "rsi_above", l: "RSI above" },
  { v: "rsi_below", l: "RSI below" },
  { v: "ema_cross_up", l: "EMA cross (20/50)" },
  { v: "breakout", l: "Breakout confirmed" },
];
const CHANNELS: AlertChannel[] = ["browser", "email", "telegram", "whatsapp"];

function alertsKey(symbol: string, exchange: string) {
  return ["market", "alerts", symbol, exchange];
}

export function StockAlertsPanel({ symbol, exchange }: { symbol: string; exchange: string }) {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const key = alertsKey(symbol, exchange);

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.from("market_alerts")
        .select("id,symbol,exchange,alert_type,threshold,channel,is_active,triggered_at")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Alert[];
    },
  });

  const toggle = async (a: Alert) => {
    try {
      // market-alerts-eval only scans triggered_at IS NULL — an alert that
      // already fired once stays permanently dead unless resuming re-arms it.
      const resuming = !a.is_active;
      const { error } = await supabase.from("market_alerts")
        .update({ is_active: !a.is_active, ...(resuming ? { triggered_at: null } : {}) }).eq("id", a.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { push(toSafeError(e, "toggle failed").message, "err"); }
  };
  const remove = async (a: Alert) => {
    if (!confirm("Delete this alert?")) return;
    try {
      const { error } = await supabase.from("market_alerts").delete().eq("id", a.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { push(toSafeError(e, "delete failed").message, "err"); }
  };

  return (
    <HudPanel flow title="Alerts" index="A9"
      actions={<Btn size="sm" variant="primary" onClick={() => setCreating(true)}><Plus size={11} style={{ marginRight: 4 }} /> new</Btn>}>
      {isLoading ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : alerts.length === 0 ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <Bell size={12} /> no alerts on {symbol} yet
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {alerts.map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
              <span>
                {ALERT_TYPES.find((t) => t.v === a.alert_type)?.l ?? a.alert_type}
                {a.threshold != null && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>@ {a.threshold}</span>}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <Chip tone={a.is_active ? "ok" : "neutral"}>{a.is_active ? "active" : "paused"}</Chip>
                <Btn size="sm" onClick={() => toggle(a)}>{a.is_active ? "pause" : "resume"}</Btn>
                <Btn size="sm" onClick={() => remove(a)}><Trash2 size={11} /></Btn>
              </span>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <NewAlertModal symbol={symbol} exchange={exchange} onClose={() => setCreating(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: key }); setCreating(false); }} />
      )}
    </HudPanel>
  );
}

export function NewAlertModal({ symbol, exchange, onClose, onCreated }: {
  symbol: string; exchange: string; onClose: () => void; onCreated: () => void;
}) {
  const push = useUi((s) => s.push);
  const [alertType, setAlertType] = useState("price_above");
  const [threshold, setThreshold] = useState("");
  const [channel, setChannel] = useState<AlertChannel>("browser");
  const [busy, setBusy] = useState(false);

  const needsThreshold = !["ema_cross_up", "breakout"].includes(alertType);

  const save = async () => {
    if (needsThreshold && !threshold.trim()) { push("Threshold required", "err"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) throw new Error("not signed in");
      const { error } = await supabase.from("market_alerts").insert({
        user_id: u.user.id,
        symbol, exchange,
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
        width: 380, background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 16, display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>New alert · {symbol} ({exchange})</div>
        <div>
          <div style={labelStyle}>Type</div>
          <select value={alertType} onChange={(e) => setAlertType(e.target.value)} style={inputStyle}>
            {ALERT_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </div>
        {needsThreshold && (
          <div>
            <div style={labelStyle}>Threshold</div>
            <input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="2500" style={inputStyle} type="number" autoFocus />
          </div>
        )}
        <div>
          <div style={labelStyle}>Channel</div>
          <select value={channel} onChange={(e) => setChannel(e.target.value as AlertChannel)} style={inputStyle}>
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
