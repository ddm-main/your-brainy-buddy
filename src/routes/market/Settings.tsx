// Market Settings — API Configuration for provider (Kotak Neo primary)
import { useEffect, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase, SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";

type Provider = "kotak_neo" | "yahoo" | "zerodha" | "dhan";

type Settings = {
  id?: string;
  active_provider: Provider;
  consumer_key: string | null;
  base_url: string | null;
  ws_url: string | null;
  exchange: string | null;
  connection_status: string;
  token_expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  ucc: string | null;
  greeting_name: string | null;
};

const KOTAK_DEFAULT_BASE = "https://gw-napi.kotaksecurities.com";
const KOTAK_DEFAULT_WS = "wss://mlhsm.kotaksecurities.com";

export default function MarketSettings() {
  const push = useUi((s) => s.push);
  const [provider, setProvider] = useState<Provider>("kotak_neo");
  const [rows, setRows] = useState<Record<Provider, Settings | null>>({
    kotak_neo: null, yahoo: null, zerodha: null, dhan: null,
  });
  const [busy, setBusy] = useState<string | null>(null);

  // form state (never populated with existing secrets)
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [mpin, setMpin] = useState("");
  const [ucc, setUcc] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(KOTAK_DEFAULT_BASE);
  const [wsUrl, setWsUrl] = useState(KOTAK_DEFAULT_WS);
  const [otp, setOtp] = useState("");

  const load = async () => {
    const { data, error } = await supabase.from("market_api_settings").select("*");
    if (error) { push(error.message, "err"); return; }
    const map: Record<Provider, Settings | null> = { kotak_neo: null, yahoo: null, zerodha: null, dhan: null };
    for (const r of (data ?? []) as any[]) map[r.active_provider as Provider] = r as Settings;
    setRows(map);
    const cur = map[provider];
    if (cur) {
      setConsumerKey(cur.consumer_key ?? "");
      setUcc(cur.ucc ?? "");
      setBaseUrl(cur.base_url ?? KOTAK_DEFAULT_BASE);
      setWsUrl(cur.ws_url ?? KOTAK_DEFAULT_WS);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const cur = rows[provider];
    if (cur) {
      setConsumerKey(cur.consumer_key ?? "");
      setUcc(cur.ucc ?? "");
      setBaseUrl(cur.base_url ?? KOTAK_DEFAULT_BASE);
      setWsUrl(cur.ws_url ?? KOTAK_DEFAULT_WS);
    }
    // eslint-disable-next-line
  }, [provider]);

  const callFn = async (name: string, body: Record<string, unknown>) => {
    const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
    const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? r.statusText);
    return j;
  };

  const saveConfig = async () => {
    setBusy("save");
    try {
      await callFn("market-config-save", {
        provider, consumer_key: consumerKey || null,
        consumer_secret: consumerSecret || null,
        mobile_number: mobile || null,
        password: password || null,
        mpin: mpin || null,
        totp_secret: totpSecret || null,
        ucc: ucc || undefined,
        base_url: baseUrl || null, ws_url: wsUrl || null,
      });
      setConsumerSecret(""); setPassword(""); setMpin(""); setMobile(""); setTotpSecret("");
      push("Configuration saved", "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Save failed").message, "err"); }
    finally { setBusy(null); }
  };

  const setActive = async () => {
    setBusy("activate");
    try {
      await callFn("market-config-save", { provider, activate: true });
      push(`Active provider: ${provider}`, "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Activate failed").message, "err"); }
    finally { setBusy(null); }
  };

  const startLogin = async () => {
    setBusy("login");
    try {
      const r = await callFn("market-kotak-login-start", {});
      if (r?.auto) {
        push(`Connected as ${r?.greeting_name ?? "Kotak user"} (auto TOTP)`, "ok");
      } else if (r?.needs_totp) {
        push("Enter the 6-digit TOTP from your authenticator app below", "ok");
      } else {
        push(r?.message ?? "Login started", "ok");
      }
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
    try {
      const r = await callFn("market-kotak-login-otp", { otp: otp.trim() });
      setOtp("");
      push(`Connected as ${r?.greeting_name ?? "Kotak user"}`, "ok");
      await load();
    } catch (e) { push(toSafeError(e, "OTP validation failed").message, "err"); }
    finally { setBusy(null); }
  };

  const testConnection = async () => {
    setBusy("test");
    try {
      const r = await callFn("market-test-connection", {});
      push(r?.ok ? `Connection OK (${r?.provider})` : "Connection failed", r?.ok ? "ok" : "err");
      await load();
    } catch (e) { push(toSafeError(e, "Test failed").message, "err"); }
    finally { setBusy(null); }
  };

  const cur = rows[provider];
  const active = Object.values(rows).find((r) => r?.connection_status === "connected");
  const isKotak = provider === "kotak_neo";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Active Provider" index="MK.S1">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}
              style={{ ...inputStyle, padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>
              <option value="kotak_neo">Kotak Neo</option>
              <option value="yahoo">Yahoo Finance</option>
              <option value="zerodha">Zerodha Kite (coming soon)</option>
              <option value="dhan">Dhan (coming soon)</option>
            </select>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Status: <b style={{ color: cur?.connection_status === "connected" ? "var(--ok)" : "var(--text-dim)" }}>
              {cur?.connection_status ?? "not configured"}
            </b>
            {cur?.token_expires_at && (
              <span style={{ marginLeft: 12 }}>· token expires {new Date(cur.token_expires_at).toLocaleString()}</span>
            )}
            {cur?.last_sync_at && (
              <span style={{ marginLeft: 12 }}>· last sync {new Date(cur.last_sync_at).toLocaleString()}</span>
            )}
          </div>
          <Btn onClick={setActive} disabled={busy !== null}>Make active</Btn>
          <Btn onClick={testConnection} disabled={busy !== null}>Test connection</Btn>
        </div>
        {active && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent-soft)" }}>
            Live provider currently in use: <b style={{ color: "var(--accent)" }}>{active.active_provider}</b>
          </div>
        )}
        {cur?.last_error && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
            Last error: {cur.last_error}
          </div>
        )}
      </HudPanel>

      {isKotak && (
        <HudPanel title="Kotak Neo Credentials" index="MK.S2">
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
            Store credentials once (encrypted at rest). Sessions expire daily around midnight IST — save the
            TOTP secret (from Kotak Neo app → API TOTP setup) and JARVIS re-logs-in automatically every morning.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Consumer Key" value={consumerKey} setValue={setConsumerKey} placeholder="From Kotak Neo app → Trade API" />
            <Field label="UCC (Client Code)" value={ucc} setValue={setUcc} placeholder="e.g. ABC123" />
            <Field label="Mobile Number" value={mobile} setValue={setMobile} placeholder="+91XXXXXXXXXX (leave blank to keep)" />
            <Field label="MPIN" value={mpin} setValue={setMpin} placeholder="6-digit (leave blank to keep existing)" type="password" />
            <Field label="TOTP Secret" value={totpSecret} setValue={setTotpSecret} placeholder="Base32 secret for auto-login (optional)" type="password" />
            <Field label="Consumer Secret" value={consumerSecret} setValue={setConsumerSecret} placeholder="(optional, v2 API doesn't need it)" type="password" />
            <Field label="Base URL" value={baseUrl} setValue={setBaseUrl} />
            <Field label="WebSocket URL" value={wsUrl} setValue={setWsUrl} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Btn onClick={saveConfig} disabled={busy !== null} variant="primary">
              {busy === "save" ? "saving…" : "Save configuration"}
            </Btn>
            <Btn onClick={startLogin} disabled={busy !== null}>
              {busy === "login" ? "logging in…" : "Login to Kotak"}
            </Btn>
            <Btn onClick={refreshSession} disabled={busy !== null}>
              {busy === "refresh" ? "refreshing…" : "Refresh session"}
            </Btn>
          </div>
        </HudPanel>
      )}

      {isKotak && cur?.connection_status === "pending_otp" && (
        <HudPanel title="Complete Login — TOTP" index="MK.S3">
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
            Enter the current 6-digit TOTP from your authenticator app (Kotak Neo → API TOTP).
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1, maxWidth: 200 }}>
              <div style={labelStyle}>TOTP code</div>
              <input value={otp} onChange={(e) => setOtp(e.target.value)} style={inputStyle} inputMode="numeric" autoFocus />
            </div>
            <Btn onClick={completeOtp} disabled={busy !== null} variant="primary">
              {busy === "otp" ? "validating…" : "Complete login"}
            </Btn>
          </div>
        </HudPanel>
      )}
    </div>
  );
}

function Field({ label, value, setValue, placeholder, type = "text" }: { label: string; value: string; setValue: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input type={type} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} style={inputStyle} autoComplete="off" />
    </div>
  );
}
