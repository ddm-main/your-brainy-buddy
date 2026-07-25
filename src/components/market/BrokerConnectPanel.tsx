// Broker connect panel — per-user broker connection (Kotak Neo enabled;
// Zerodha / Upstox listed as coming soon). Shared UI extracted from the
// former /config/broker route so it can live under Market → Config.
import { useCallback, useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { LockKeyhole, Pencil, TestTube2 } from "lucide-react";

type BrokerId = "kotak_neo" | "zerodha" | "upstox";
type Settings = {
  id?: string;
  active_provider: string;
  consumer_key: string | null;
  connection_status: string;
  token_expires_at: string | null;
  last_error: string | null;
  ucc: string | null;
  greeting_name: string | null;
  totp_secret_enc: string | null;
  mobile_number_enc: string | null;
  mpin_enc: string | null;
};

const KOTAK_DEFAULT_BASE = "https://gw-napi.kotaksecurities.com";
const KOTAK_DEFAULT_WS = "wss://mlhsm.kotaksecurities.com";

const BROKERS: { id: BrokerId; name: string; enabled: boolean; blurb: string }[] = [
  { id: "kotak_neo", name: "Kotak Neo", enabled: true,  blurb: "Trade API — orders, holdings, positions, live LTP" },
  { id: "zerodha",   name: "Zerodha",   enabled: false, blurb: "Kite Connect — coming soon" },
  { id: "upstox",    name: "Upstox",    enabled: false, blurb: "Upstox API v2 — coming soon" },
];

async function callFn(name: string, body: Record<string, unknown>) {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

export default function BrokerConnectPanel() {
  const push = useUi((s) => s.push);
  const [selected, setSelected] = useState<BrokerId>("kotak_neo");
  const [kotak, setKotak] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [consumerKey, setConsumerKey] = useState("");
  const [mobile, setMobile] = useState("");
  const [mpin, setMpin] = useState("");
  const [ucc, setUcc] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("market_api_settings").select("*").eq("active_provider", "kotak_neo").maybeSingle();
    if (error) { push(error.message, "err"); return; }
    const k = data as Settings | null;
    setKotak(k);
    if (k) {
      setConsumerKey(k.consumer_key ?? ""); setUcc(k.ucc ?? "");
      if (k.mobile_number_enc) {
        try { const r = await callFn("market-kotak-mobile", {}); setMobile(r?.mobile_number ?? ""); }
        catch { /* non-critical */ }
      }
    }
  }, [push]);
  useEffect(() => { void load(); }, [load]);

  const saveConfig = async () => {
    setBusy("save");
    try {
      await callFn("market-config-save", {
        provider: "kotak_neo",
        consumer_key: consumerKey || null,
        mobile_number: mobile || null,
        mpin: mpin || null,
        totp_secret: totpSecret || null,
        ucc: ucc || undefined,
        base_url: KOTAK_DEFAULT_BASE, ws_url: KOTAK_DEFAULT_WS,
      });
      setMpin(""); setMobile(""); setTotpSecret("");
      push("Broker credentials saved", "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Save failed").message, "err"); }
    finally { setBusy(null); }
  };

  const startLogin = async () => {
    setBusy("login");
    try {
      await callFn("market-config-save", {
        provider: "kotak_neo",
        consumer_key: consumerKey || undefined,
        mobile_number: mobile || undefined,
        mpin: mpin || undefined,
        totp_secret: totpSecret || undefined,
        ucc: ucc || undefined,
      });
      setMpin(""); setMobile(""); setTotpSecret("");
      const r = await callFn("market-kotak-login-start", {});
      if (r?.auto) push(`Connected as ${r?.greeting_name ?? "Kotak user"} (auto TOTP)`, "ok");
      else if (r?.needs_totp) push(r?.message ?? "Enter the 6-digit TOTP below", "warn");
      else push(r?.message ?? "Login started", "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Login failed").message, "err"); }
    finally { setBusy(null); }
  };

  const refreshSession = async () => {
    setBusy("refresh");
    try {
      const r = await callFn("market-kotak-refresh", {});
      const me = r?.refreshed?.[0];
      if (me?.ok) push(`Session refreshed — ${me.greeting_name ?? "connected"}`, "ok");
      else push(me?.error ?? "Refresh failed (is the TOTP secret saved?)", "err");
      await load();
    } catch (e) { push(toSafeError(e, "Refresh failed").message, "err"); }
    finally { setBusy(null); }
  };

  const completeOtp = async () => {
    if (!otp.trim()) { push("Enter OTP", "warn"); return; }
    setBusy("otp");
    setOtpError(null);
    const trimmed = otp.trim();
    const attempt = () => callFn("market-kotak-login-otp", { otp: trimmed });
    try {
      let r: any;
      try { r = await attempt(); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b502\b/.test(msg)) { await new Promise((res) => setTimeout(res, 1500)); r = await attempt(); }
        else throw err;
      }
      setOtp("");
      push(`Connected as ${r?.greeting_name ?? "Kotak user"}`, "ok");
      await load();
    } catch (e) {
      const msg = toSafeError(e, "OTP validation failed").message;
      setOtpError(msg); push(msg, "err");
    } finally { setBusy(null); }
  };

  const testConnection = async () => {
    setBusy("test");
    try {
      const r = await callFn("market-test-connection", { provider: "kotak_neo" });
      push(r?.ok ? `Broker OK (${r?.provider})` : `Broker failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
      await load();
    } catch (e) { push(toSafeError(e, "Test failed").message, "err"); }
    finally { setBusy(null); }
  };

  const kotakConnected = kotak?.connection_status === "connected";
  const kotakStatus = kotak?.connection_status ?? "not configured";
  const kotakConfigured = !!kotak?.consumer_key;
  const kotakBroken = kotakConfigured && ["expired", "error"].includes(kotakStatus);
  const autoLoginEnabled = !!kotak?.totp_secret_enc;
  const needsBasics = !consumerKey.trim() || !ucc.trim();
  const showForm = editing || kotak?.connection_status === "pending_otp";

  return (
    <HudPanel title="My Broker" index="BRK" live={kotakConnected ? "ok" : "idle"} bodyClass="overflow-visible">
      <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 10 }}>
        Connect your broker account so orders, holdings, positions and funds are yours — not shared.
        Credentials are encrypted at rest and never sent back to the browser.
      </div>

      <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11, marginBottom: 6 }}>Choose broker</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 8, marginBottom: 14 }}>
        {BROKERS.map((b) => {
          const active = selected === b.id;
          const disabled = !b.enabled;
          return (
            <button key={b.id}
              disabled={disabled}
              aria-label={`Select ${b.name}${disabled ? " (coming soon)" : ""}`}
              onClick={() => b.enabled && setSelected(b.id)}
              style={{
                textAlign: "left", cursor: disabled ? "not-allowed" : "pointer",
                padding: "10px 12px",
                border: `1px solid ${active ? "var(--accent)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "rgba(53,214,237,0.02)",
                opacity: disabled ? 0.5 : 1,
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontFamily: "var(--font-hud)", fontSize: 13, color: "var(--text)" }}>{b.name}</span>
                {!b.enabled && <Chip tone="warn">coming soon</Chip>}
                {b.id === "kotak_neo" && kotakConnected && <Chip tone="ok">connected</Chip>}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{b.blurb}</div>
            </button>
          );
        })}
      </div>

      {selected === "kotak_neo" && (
        <div style={{ border: "1px solid var(--edge)", borderRadius: 4, padding: "10px 12px", background: "rgba(255,255,255,0.015)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 14 }}>Kotak Neo</span>
            <Chip tone={kotakConnected ? "ok" : kotakStatus === "pending_otp" ? "warn" : kotak?.last_error ? "err" : "neutral"}>{kotakStatus}</Chip>
            {kotakConfigured && <Chip tone={autoLoginEnabled ? "ok" : "warn"}>{autoLoginEnabled ? "auto-login on" : "auto-login off"}</Chip>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {kotakBroken && !editing && (
                <Btn size="sm" variant="primary" onClick={startLogin} disabled={busy !== null}>
                  {busy === "login" ? "reconnecting…" : "Re-login"}
                </Btn>
              )}
              <Btn size="sm" onClick={testConnection} disabled={busy !== null}>
                <TestTube2 size={11} style={{ marginRight: 4 }} />Test
              </Btn>
              <Btn size="sm" variant={editing ? "primary" : "ghost"} onClick={() => setEditing((v) => !v)}>
                <Pencil size={11} style={{ marginRight: 4 }} />{editing ? "Close" : kotakConfigured ? "Edit" : "Add credentials"}
              </Btn>
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
            Holdings · Positions · Orders · Live LTP · Broker session
          </div>
          {kotakConnected && kotak?.greeting_name && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
              Connected as <b style={{ color: "var(--accent)" }}>{kotak.greeting_name}</b>
              {kotak?.token_expires_at && (
                <> · {autoLoginEnabled ? "fresh" : "valid"} until {new Date(kotak.token_expires_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</>
              )}
            </div>
          )}
          {kotak?.last_error && <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger)" }}>Last error: {kotak.last_error}</div>}

          {showForm && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
              {editing && (
                <>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    Encrypted at rest, never sent back. <span style={{ color: "var(--ok)" }}>✓ saved</span> = blank keeps the existing value.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label="Consumer Key" value={consumerKey} setValue={setConsumerKey} placeholder="From Kotak Neo → Trade API" saved={!!kotak?.consumer_key} />
                    <Field label="UCC (Client Code)" value={ucc} setValue={setUcc} placeholder="e.g. ABC123" saved={!!kotak?.ucc} />
                    <Field label="Mobile Number" value={mobile} setValue={setMobile} placeholder="+91XXXXXXXXXX" saved={!!kotak?.mobile_number_enc} />
                    <Field label="MPIN" value={mpin} setValue={setMpin} placeholder="6-digit" type="password" saved={!!kotak?.mpin_enc} />
                    <Field label="TOTP Secret" value={totpSecret} setValue={setTotpSecret} placeholder="Base32 — enables auto-login" type="password" saved={!!kotak?.totp_secret_enc} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Btn onClick={saveConfig} disabled={busy !== null} variant="primary">
                      <LockKeyhole size={11} style={{ marginRight: 4 }} />{busy === "save" ? "saving…" : "Save"}
                    </Btn>
                    <Btn onClick={startLogin} disabled={busy !== null || needsBasics}
                      title={needsBasics ? "Save Consumer Key and UCC first" : undefined}>
                      {busy === "login" ? "logging in…" : "Login to Kotak"}
                    </Btn>
                    <Btn onClick={refreshSession} disabled={busy !== null}>
                      {busy === "refresh" ? "refreshing…" : "Refresh session"}
                    </Btn>
                  </div>
                </>
              )}
              {kotak?.connection_status === "pending_otp" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: editing ? 8 : 0, borderTop: editing ? "1px solid var(--edge)" : undefined }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Enter the current 6-digit TOTP (Kotak Neo → API TOTP).</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1, maxWidth: 200 }}>
                      <input value={otp} onChange={(e) => setOtp(e.target.value)} style={{ ...inputStyle, width: "100%" }} inputMode="numeric" autoFocus placeholder="6-digit code" />
                    </div>
                    <Btn onClick={completeOtp} disabled={busy !== null} variant="primary">
                      {busy === "otp" ? "validating…" : "Complete login"}
                    </Btn>
                  </div>
                  {otpError && <div style={{ fontSize: 11, color: "var(--danger)", wordBreak: "break-word" }}>{otpError}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </HudPanel>
  );
}

const MASK_DOTS = "••••••••••••";

function Field({ label, value, setValue, placeholder, type = "text", saved }: { label: string; value: string; setValue: (v: string) => void; placeholder?: string; type?: string; saved?: boolean }) {
  const [touched, setTouched] = useState(false);
  const showMask = saved && !touched && !value;
  return (
    <div>
      <div style={labelStyle}>
        {label}
        {saved && <span style={{ marginLeft: 6, color: "var(--ok)", textTransform: "none", letterSpacing: 0 }}>✓ saved</span>}
      </div>
      <input type={type} value={showMask ? MASK_DOTS : value}
        onFocus={() => { if (showMask) setTouched(true); }}
        onChange={(e) => { setTouched(true); setValue(e.target.value); }}
        placeholder={saved ? `${placeholder} — blank keeps saved value` : placeholder}
        style={{ ...inputStyle, width: "100%" }} autoComplete="off" />
    </div>
  );
}
