// Kotak reconnect popup — checked once whenever the Market section is
// opened (mounted from Market.tsx, the shared shell for every /market/*
// route). If the broker session is expired/errored, this surfaces
// immediately instead of only showing as a buried banner on the Settings
// page. Reconnect is one click when a TOTP secret is saved (no typing at
// all — MPIN is already stored and reused the same way it always has been);
// only falls back to asking for a fresh 6-digit code when auto-login itself
// fails. There's deliberately no raw "type your MPIN" field here — MPIN is
// never re-entered on its own, it's reused from what's already saved,
// exactly like every other reconnect path in this app.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { callMarketFn } from "@/lib/market/api";
import { useMarketSettings } from "@/lib/market/hooks";
import { toSafeError } from "@/lib/errors";
import { useUi } from "@/store/uiStore";

export function KotakReconnectModal() {
  const { data: settings = [] } = useMarketSettings();
  const kotak = settings.find((s) => s.active_provider === "kotak_neo");
  const qc = useQueryClient();
  const push = useUi((s) => s.push);

  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsOtp, setNeedsOtp] = useState(false);
  const [otp, setOtp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // Only for someone who's actually configured Kotak (has a consumer key) —
  // a user who's never touched it and is just running on Yahoo shouldn't
  // see a "disconnected" popup for a broker they never connected.
  const broken = !!kotak?.consumer_key && ["expired", "error"].includes(kotak.connection_status);

  // Fresh check every time the Market shell mounts, i.e. every time the
  // section is actually opened — not just once per page load.
  useEffect(() => { setDismissed(false); setNeedsOtp(false); setMsg(null); }, []);

  const reconnect = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await callMarketFn("market-kotak-login-start", {});
      if (r?.auto) {
        push(`Reconnected as ${r?.greeting_name ?? "Kotak user"}`, "ok");
        qc.invalidateQueries({ queryKey: ["market", "settings"] });
        setDismissed(true);
      } else if (r?.needs_totp) {
        setNeedsOtp(true);
        setMsg(r?.message ?? "Enter the current 6-digit TOTP code from your authenticator app.");
      } else {
        setMsg(r?.message ?? "Reconnect failed.");
      }
    } catch (e) {
      setMsg(toSafeError(e, "Reconnect failed").message);
    } finally { setBusy(false); }
  };

  const submitOtp = async () => {
    if (!otp.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await callMarketFn("market-kotak-login-otp", { otp: otp.trim() });
      push(`Connected as ${r?.greeting_name ?? "Kotak user"}`, "ok");
      qc.invalidateQueries({ queryKey: ["market", "settings"] });
      setOtp(""); setNeedsOtp(false); setDismissed(true);
    } catch (e) {
      setMsg(toSafeError(e, "OTP validation failed").message);
    } finally { setBusy(false); }
  };

  if (!broken || dismissed) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        width: 420, maxWidth: "100%", background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 20, display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="hud-label" style={{ color: "var(--danger)", letterSpacing: "0.2em" }}>Kotak Disconnected</div>
          <button onClick={() => setDismissed(true)} className="hud-btn focus-outline" data-variant="ghost" data-size="sm" title="Dismiss"><X size={14} /></button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Your Kotak Neo session isn't connected — live prices, holdings sync, and AutoTrade all depend on it.
        </div>

        {!needsOtp ? (
          <Btn variant="primary" onClick={reconnect} disabled={busy}>{busy ? "reconnecting…" : "Reconnect now"}</Btn>
        ) : (
          <>
            {msg && <div style={{ fontSize: 12, color: "var(--warn)", lineHeight: 1.5 }}>{msg}</div>}
            <div>
              <div style={labelStyle}>TOTP code</div>
              <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code"
                inputMode="numeric" autoFocus style={{ ...inputStyle, width: "100%" }}
                onKeyDown={(e) => e.key === "Enter" && submitOtp()} />
            </div>
            <Btn variant="primary" onClick={submitOtp} disabled={busy || !otp.trim()}>{busy ? "connecting…" : "Complete login"}</Btn>
          </>
        )}
        {msg && !needsOtp && <div style={{ fontSize: 11, color: "var(--danger)" }}>{msg}</div>}

        <Link to="/market/settings" onClick={() => setDismissed(true)} style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>
          Open full Kotak settings →
        </Link>
      </div>
    </div>
  );
}
