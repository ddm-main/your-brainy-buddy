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

type BrokerId = "kotak_neo" | "shoonya" | "zerodha" | "upstox";
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

type ShoonyaSettings = {
  id?: string;
  connection_status: string;
  token_expires_at: string | null;
  last_error: string | null;
  greeting_name: string | null;
  ucc: string | null;
  vendor_code: string | null;
  api_secret_enc: string | null;
  password_enc: string | null;
  totp_secret_enc: string | null;
  imei: string | null;
};

const BROKERS: { id: BrokerId; name: string; enabled: boolean; blurb: string }[] = [
  { id: "kotak_neo", name: "Kotak Neo", enabled: true,  blurb: "Trade API — orders, holdings, positions, live LTP" },
  { id: "shoonya",   name: "Shoonya (Finvasia)", enabled: true, blurb: "Noren API — orders, holdings, native candles, live LTP" },
  { id: "zerodha",   name: "Zerodha",   enabled: false, blurb: "Kite Connect — coming soon" },
  { id: "upstox",    name: "Upstox",    enabled: false, blurb: "Upstox API v2 — coming soon" },
];
// Registered in Shoonya PRISM → API Key. Keep this URL stable; the current app
// origin rides in OAuth `state`, not in the PRISM-registered URL.
const shoonyaAppOrigin = typeof window !== "undefined" ? window.location.origin : "";
const shoonyaOriginToken = shoonyaAppOrigin ? encodeURIComponent(btoa(shoonyaAppOrigin)) : "";
const shoonyaRedirectUrl = `${SAFE_SUPABASE_URL}/functions/v1/shoonya-oauth-callback`;
const SHOONYA_AUTH_STARTED_KEY = "jarvis:shoonya-auth-started-at";

function mergedShoonyaParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const hashParams = new URLSearchParams(fragment.startsWith("?") ? fragment.slice(1) : fragment);
  hashParams.forEach((value, key) => { if (!params.has(key)) params.set(key, value); });
  return params;
}

function extractShoonyaCodeInput(value: string): { code?: string; error?: string } {
  const raw = value.trim();
  if (!raw) return {};
  try {
    const u = new URL(raw);
    const params = mergedShoonyaParams(u.search, u.hash);
    const code = params.get("shoonya_code") ?? params.get("code") ?? params.get("request_token");
    if (code?.trim()) return { code: code.trim() };
    const err = params.get("shoonya_error") ?? params.get("error_description") ?? params.get("error");
    if (err?.trim()) return { error: `Shoonya did not issue a code: ${err}. Recheck the clean Redirect URL and static IP in PRISM, then authorize again.` };
    if (/\/market\/settings/i.test(u.pathname) || /shoonya-oauth-callback/i.test(u.pathname)) {
      return { error: "That URL has no Shoonya authorization code. Use the clean Redirect URL shown here in PRISM, then authorize again." };
    }
  } catch { /* bare code */ }
  if (/^shoonya_error=/i.test(raw)) return { error: "Shoonya did not issue an authorization code. Recheck PRISM setup, then authorize again." };
  return { code: raw };
}


async function callFn(name: string, body: Record<string, unknown>) {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.detail ?? j?.error ?? r.statusText);
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

  // Shoonya OAuth: TOTP is entered only on Shoonya's page. This app receives
  // the separate authorization code from the resulting redirect.
  const [shoonya, setShoonya] = useState<ShoonyaSettings | null>(null);
  const [shEditing, setShEditing] = useState(false);
  const [shUid, setShUid] = useState("");
  const [shVendor, setShVendor] = useState("");
  const [shSecret, setShSecret] = useState("");
  const [shImei, setShImei] = useState("");
  const [shCode, setShCode] = useState("");
  const [shCodeError, setShCodeError] = useState<string | null>(null);
  const [shAuthUrl, setShAuthUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("market_api_settings").select("*").eq("active_provider", "kotak_neo").maybeSingle();
    if (error) { push(error.message, "err"); return; }
    const k = data as Settings | null;
    setKotak(k);
    if (k) {
      setConsumerKey(k.consumer_key ?? ""); setUcc(k.ucc ?? "");
      // Credentials are never sent back to the browser — the saved mobile is
      // shown as a masked hint only (matching MPIN/TOTP), not decrypted here.
      setMobile("");
    }
  }, [push]);

  const loadShoonya = useCallback(async () => {
    const { data, error } = await supabase.from("market_api_settings")
      .select("id,connection_status,token_expires_at,last_error,greeting_name,ucc,vendor_code,api_secret_enc,password_enc,totp_secret_enc,imei")
      .eq("active_provider", "shoonya").maybeSingle();
    if (error) { push(error.message, "err"); return; }
    const sh = data as unknown as ShoonyaSettings | null;
    setShoonya(sh);
    if (sh) { setShUid(sh.ucc ?? ""); setShVendor(sh.vendor_code ?? ""); setShImei(sh.imei ?? ""); }
  }, [push]);

  useEffect(() => { void load(); void loadShoonya(); }, [load, loadShoonya]);

  const saveShoonya = async () => {
    setBusy("sh-save");
    try {
      await callFn("market-config-save", {
        provider: "shoonya",
        ucc: shUid || undefined,
        vendor_code: shVendor || undefined,
        api_secret: shSecret || undefined,
        imei: shImei || undefined,
      });
      setShSecret("");
      push("Shoonya credentials saved", "ok");
      await loadShoonya();
    } catch (e) { push(toSafeError(e, "Save failed").message, "err"); }
    finally { setBusy(null); }
  };

  const exchangeShoonyaCode = useCallback(async (code: string) => {
    setBusy("sh-login");
    setShCodeError(null);
    try {
      const r = await callFn("market-shoonya-login", code ? { code } : { redirect_url: shoonyaRedirectUrl, state: shoonyaOriginToken });
      if (r?.authorize_url) {
        setShAuthUrl(r.authorize_url as string);
        try { window.localStorage.setItem(SHOONYA_AUTH_STARTED_KEY, String(Date.now())); } catch { /* non-critical */ }
        window.open(r.authorize_url as string, "_blank", "noopener");
        push("Log in on Shoonya — you'll be sent straight back here when it's done", "ok");
      } else {
        push(r?.detail ?? "Connected to Shoonya", r?.ok ? "ok" : "err");
        if (r?.ok) setShCode("");
        else setShCodeError(r?.detail ?? null);
      }
      await loadShoonya();
    } catch (e) {
      const msg = toSafeError(e, "Shoonya login failed").message;
      setShCodeError(msg);
      push(msg, "err");
    }
    finally { setBusy(null); }
  }, [loadShoonya, push]);

  const loginShoonya = async () => {
    const parsed = extractShoonyaCodeInput(shCode);
    if (parsed.error) {
      setShCodeError(parsed.error);
      push(parsed.error, "err");
      return;
    }
    const code = (parsed.code ?? "").trim();
    if (/^\d{6}$/.test(code)) {
      const message = "This looks like a TOTP. Enter it on Shoonya's page — the authorization code comes back automatically.";
      setShCodeError(message);
      push(message, "warn");
      return;
    }
    await exchangeShoonyaCode(code);
  };

  // Shoonya redirected the browser back through shoonya-oauth-callback, which
  // forwards the single-use code as ?shoonya_code. Exchange it immediately
  // (codes expire in minutes) and scrub it from the address bar so a refresh
  // can't replay a spent code.
  useEffect(() => {
    const params = mergedShoonyaParams(window.location.search, window.location.hash);
    const code = params.get("shoonya_code") ?? params.get("code") ?? params.get("request_token");
    const err = params.get("shoonya_error") ?? params.get("error_description") ?? params.get("error");
    if (!code && !err) {
      const startedRaw = (() => { try { return window.localStorage.getItem(SHOONYA_AUTH_STARTED_KEY); } catch { return null; } })();
      const startedAt = startedRaw ? Number(startedRaw) : NaN;
      if (Number.isFinite(startedAt) && Date.now() - startedAt < 10 * 60_000 && /\/market\/settings/i.test(window.location.pathname)) {
        try { window.localStorage.removeItem(SHOONYA_AUTH_STARTED_KEY); } catch { /* non-critical */ }
        const message = "Shoonya returned to JARVIS without an authorization code. In PRISM → API Key, set the Redirect URL exactly to the value shown here, save it, then authorize again.";
        setSelected("shoonya");
        setShEditing(true);
        setShCodeError(message);
        push(message, "err");
      }
      return;
    }
    try { window.localStorage.removeItem(SHOONYA_AUTH_STARTED_KEY); } catch { /* non-critical */ }
    params.delete("shoonya_code");
    params.delete("code");
    params.delete("request_token");
    params.delete("shoonya_error");
    params.delete("error_description");
    params.delete("error");
    params.delete("state");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    setSelected("shoonya");
    setShEditing(true);
    if (err) { setShCodeError(err); push(err, "err"); return; }
    if (code) { setShCode(code); void exchangeShoonyaCode(code); }
  }, [exchangeShoonyaCode, push]);


  const testShoonya = async () => {
    setBusy("sh-test");
    try {
      const r = await callFn("market-test-connection", { provider: "shoonya" });
      push(r?.ok ? `Shoonya OK (${r?.provider ?? "shoonya"})` : `Shoonya failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
      await loadShoonya();
    } catch (e) { push(toSafeError(e, "Test failed").message, "err"); }
    finally { setBusy(null); }
  };

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

  const shStatus = shoonya?.connection_status ?? "not configured";
  const shConnected = shStatus === "connected";
  const shConfigured = !!shoonya?.api_secret_enc;
  // OAuth needs only the user id, client id and secret code — the broker
  // retired password/TOTP login, so those fields no longer gate anything.
  const shNeedsBasics = !(shoonya?.ucc || shUid.trim())
    || !(shoonya?.vendor_code || shVendor.trim())
    || !(shoonya?.api_secret_enc || shSecret.trim());


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
                {b.id === "shoonya" && shoonya?.connection_status === "connected" && <Chip tone="ok">connected</Chip>}
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
                new Date(kotak.token_expires_at).getTime() <= Date.now()
                  ? <> · <span style={{ color: "var(--danger)" }}>session expired — reconnect</span></>
                  : <> · {autoLoginEnabled ? "fresh" : "valid"} until {new Date(kotak.token_expires_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</>
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
                    <Field label="Mobile Number" value={mobile} setValue={setMobile} placeholder={kotak?.mobile_number_enc ? "•••••• saved" : "+91XXXXXXXXXX"} saved={!!kotak?.mobile_number_enc} />
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

      {selected === "shoonya" && (
        <div style={{ border: "1px solid var(--edge)", borderRadius: 4, padding: "10px 12px", background: "rgba(255,255,255,0.015)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 14 }}>Shoonya (Finvasia)</span>
            <Chip tone={shConnected ? "ok" : shoonya?.last_error ? "err" : "neutral"}>{shStatus}</Chip>
            {shConfigured && <Chip tone="neutral">OAuth</Chip>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn size="sm" onClick={testShoonya} disabled={busy !== null}>
                <TestTube2 size={11} style={{ marginRight: 4 }} />Test
              </Btn>
              <Btn size="sm" variant={shEditing ? "primary" : "ghost"} onClick={() => setShEditing((v) => !v)}>
                <Pencil size={11} style={{ marginRight: 4 }} />{shEditing ? "Close" : shConfigured ? "Edit" : "Add credentials"}
              </Btn>
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
            Holdings · Positions · Orders · Live LTP · Native intraday &amp; daily candles
          </div>
          {shConnected && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
              Connected as <b style={{ color: "var(--accent)" }}>{shoonya?.greeting_name ?? shoonya?.ucc}</b>
              {shoonya?.token_expires_at && (
                <> · session valid today ({new Date(shoonya.token_expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</>
              )}
            </div>
          )}
          {shoonya?.last_error && <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger)" }}>Last error: {shoonya.last_error}</div>}

          {shEditing && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                <b style={{ color: "var(--accent)" }}>One-time setup in Shoonya PRISM → API Key:</b>
                <div>1. Paste the Redirect URL below into the app's <i>Redirect URL</i> field exactly and save.</div>
                <div>2. Whitelist the static Shoonya proxy server IP in the same screen; Supabase Edge IPs rotate and should not be copied one by one.</div>
                <div>3. Copy Client ID + Secret Code here, Save, then click Authorize.</div>
              </div>
              <div>
                  <div style={labelStyle}>Redirect URL (register exactly in Shoonya)</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input readOnly value={shoonyaRedirectUrl} onFocus={(e) => e.currentTarget.select()}
                    style={{ ...inputStyle, width: "100%", fontSize: 11 }} />
                  <Btn size="sm" onClick={() => { void navigator.clipboard?.writeText(shoonyaRedirectUrl); push("Redirect URL copied", "ok"); }}>Copy</Btn>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                Credentials are encrypted at rest and never sent back.
                <span style={{ color: "var(--ok)" }}> ✓ saved</span> = blank keeps the existing value.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label="User ID" value={shUid} setValue={setShUid} placeholder="e.g. FA207868" saved={!!shoonya?.ucc} />
                <Field label="Client ID" value={shVendor} setValue={setShVendor} placeholder="e.g. FA207868_U" saved={!!shoonya?.vendor_code} />
                <Field label="Secret Code" value={shSecret} setValue={setShSecret} placeholder="OAuth secret code from Shoonya" type="password" saved={!!shoonya?.api_secret_enc} />
                <Field label="IMEI / device id" value={shImei} setValue={setShImei} placeholder="any stable string" saved={!!shoonya?.imei} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Btn onClick={saveShoonya} disabled={busy !== null} variant="primary">
                  <LockKeyhole size={11} style={{ marginRight: 4 }} />{busy === "sh-save" ? "saving…" : "Save"}
                </Btn>
                <Btn onClick={loginShoonya} disabled={busy !== null || shNeedsBasics}
                  title={shNeedsBasics ? "Save User ID, Client ID and Secret Code first" : undefined}>
                  {busy === "sh-login" ? "working…" : shCode.trim() ? "Complete connection" : "Authorize with Shoonya"}
                </Btn>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={labelStyle}>Authorization code (only if the redirect didn't come back)</div>
                  <input value={shCode} onChange={(e) => { setShCode(e.target.value); setShCodeError(null); }}
                    placeholder="paste code=… or the full redirect URL" style={{ ...inputStyle, width: "100%" }} />
                  <div style={{ marginTop: 4, fontSize: 11, color: shCodeError ? "var(--danger)" : "var(--text-dim)", lineHeight: 1.4 }}>
                    {shCodeError ?? "Normally you never touch this — the 6-digit TOTP goes on Shoonya's page, and the code returns here automatically."}
                  </div>
                </div>
              </div>
              {shAuthUrl && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  If the tab did not open, use{" "}
                  <a href={shAuthUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>this Shoonya login link</a>.
                  {" "}It expects the Redirect URL shown above to be saved in PRISM.
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
