// Market Settings — API Configuration for provider (Kotak Neo primary)
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Database, LockKeyhole, Play, RefreshCw, TestTube2 } from "lucide-react";

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
  const [otpError, setOtpError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, unknown> | null>(null);

  const load = async () => {
    const { data, error } = await supabase.from("market_api_settings").select("*");
    if (error) { push(error.message, "err"); return; }
    const map: Record<Provider, Settings | null> = { kotak_neo: null, yahoo: null, zerodha: null, dhan: null };
    for (const r of (data ?? []) as any[]) map[r.active_provider as Provider] = r as Settings;
    setRows(map);
    const activeProvider: Provider = map.kotak_neo?.connection_status === "connected" ? "kotak_neo" : "yahoo";
    setProvider((prev) => (prev === "kotak_neo" && activeProvider === "yahoo" ? prev : activeProvider));
    const cur = map[activeProvider] ?? map[provider];
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
      if (provider === "yahoo") {
        push("Yahoo Finance is always available for quotes and charts", "ok");
      } else if (provider === "kotak_neo") {
        await callFn("market-config-save", { provider, consumer_key: consumerKey || undefined, ucc: ucc || undefined, base_url: baseUrl || undefined, ws_url: wsUrl || undefined });
        push("Kotak Neo selected — save credentials and login to activate broker sync", "ok");
      } else {
        push("This broker connector is not implemented yet", "warn");
      }
      await load();
    } catch (e) { push(toSafeError(e, "Activate failed").message, "err"); }
    finally { setBusy(null); }
  };

  const startLogin = async () => {
    setBusy("login");
    try {
      // Persist whatever is currently in the form before logging in. login-start
      // reads credentials from the DB, so typed-but-unsaved fields (mobile, MPIN,
      // TOTP — which never repopulate on reload for security) would otherwise be
      // missing and the login rejects with "Save Kotak credentials first".
      // `undefined` fields are skipped server-side, so this never clears stored
      // secrets the user left blank this session.
      await callFn("market-config-save", {
        provider,
        consumer_key: consumerKey || undefined,
        mobile_number: mobile || undefined,
        mpin: mpin || undefined,
        totp_secret: totpSecret || undefined,
        consumer_secret: consumerSecret || undefined,
        ucc: ucc || undefined,
        base_url: baseUrl || undefined,
        ws_url: wsUrl || undefined,
      });
      setConsumerSecret(""); setPassword(""); setMpin(""); setMobile(""); setTotpSecret("");
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
    setOtpError(null);
    const trimmed = otp.trim();
    const attempt = () => callFn("market-kotak-login-otp", { otp: trimmed });
    try {
      let r: any;
      try {
        r = await attempt();
      } catch (err) {
        // Kotak APIM occasionally 502s transiently — retry once.
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b502\b/.test(msg)) {
          await new Promise((res) => setTimeout(res, 1500));
          r = await attempt();
        } else {
          throw err;
        }
      }
      setOtp("");
      push(`Connected as ${r?.greeting_name ?? "Kotak user"}`, "ok");
      await load();
    } catch (e) {
      const msg = toSafeError(e, "OTP validation failed").message;
      setOtpError(msg);
      push(msg, "err");
    } finally { setBusy(null); }
  };


  const testConnection = async () => {
    setBusy("test");
    try {
      const r = await callFn("market-test-connection", { provider });
      push(r?.ok ? `Connection OK (${r?.provider})` : `Connection failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
      await load();
    } catch (e) { push(toSafeError(e, "Test failed").message, "err"); }
    finally { setBusy(null); }
  };

  const runPipeline = async (fn: string, label: string) => {
    setBusy(fn);
    try {
      const r = await callFn(fn, {});
      setPipeline({ step: label, ...r });
      push(`${label} complete`, "ok");
    } catch (e) { push(toSafeError(e, `${label} failed`).message, "err"); }
    finally { setBusy(null); }
  };

  const cur = rows[provider];
  const kotak = rows.kotak_neo;
  const liveProvider = kotak?.connection_status === "connected" ? "kotak_neo" : "yahoo";
  const isKotak = provider === "kotak_neo";
  const needsKotakBasics = !consumerKey.trim() || !ucc.trim();
  const pipelineSummary = useMemo(() => {
    if (!pipeline) return null;
    return Object.entries(pipeline)
      .filter(([k]) => !["ok", "step"].includes(k))
      .slice(0, 8)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ");
  }, [pipeline]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="Market Data Provider" index="MK.S1" live={liveProvider === "kotak_neo" ? "ok" : "idle"}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}
              style={{ ...inputStyle, minWidth: 200 }}>
              <option value="kotak_neo">Kotak Neo</option>
              <option value="yahoo">Yahoo Finance</option>
              <option value="zerodha" disabled>Zerodha Kite (not enabled)</option>
              <option value="dhan" disabled>Dhan (not enabled)</option>
            </select>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Status: <b style={{ color: cur?.connection_status === "connected" ? "var(--ok)" : "var(--text-dim)" }}>
              {provider === "yahoo" ? "available" : (cur?.connection_status ?? "not configured")}
            </b>
            {cur?.token_expires_at && (
              <span style={{ marginLeft: 12 }}>· token expires {new Date(cur.token_expires_at).toLocaleString()}</span>
            )}
            {cur?.last_sync_at && (
              <span style={{ marginLeft: 12 }}>· last sync {new Date(cur.last_sync_at).toLocaleString()}</span>
            )}
          </div>
          <Btn onClick={setActive} disabled={busy !== null || provider === "zerodha" || provider === "dhan"}>Make active</Btn>
          <Btn onClick={testConnection} disabled={busy !== null}>
            <TestTube2 size={11} style={{ marginRight: 4 }} /> Test connection
          </Btn>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Chip tone={liveProvider === "kotak_neo" ? "ok" : "neutral"}>live: {liveProvider === "kotak_neo" ? "Kotak Neo" : "Yahoo Finance"}</Chip>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Yahoo handles public quotes/charts; Kotak unlocks holdings, positions and broker sessions.
          </span>
        </div>
        {kotak?.connection_status === "connected" && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent-soft)" }}>
            Connected broker: <b style={{ color: "var(--accent)" }}>{kotak.greeting_name || kotak.ucc || "Kotak Neo"}</b>
          </div>
        )}
        {cur?.last_error && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
            Last error: {cur.last_error}
          </div>
        )}
      </HudPanel>

      {isKotak && (
        <HudPanel flow title="Kotak Neo Credentials" index="MK.S2">
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
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            The Kotak API base URL is auto-discovered per session on login — no manual entry needed.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Btn onClick={saveConfig} disabled={busy !== null} variant="primary">
              <LockKeyhole size={11} style={{ marginRight: 4 }} />
              {busy === "save" ? "saving…" : "Save configuration"}
            </Btn>
            <Btn onClick={startLogin} disabled={busy !== null || needsKotakBasics} title={needsKotakBasics ? "Save Consumer Key and UCC first" : undefined}>
              {busy === "login" ? "logging in…" : "Login to Kotak"}
            </Btn>
            <Btn onClick={refreshSession} disabled={busy !== null}>
              {busy === "refresh" ? "refreshing…" : "Refresh session"}
            </Btn>
          </div>
        </HudPanel>
      )}

      <HudPanel flow title="Data Pipeline" index="MK.S4">
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
          Run these when the dashboard/screener show empty data. Start with Universe, then EOD Batch, then Aggregates.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => runPipeline("market-scrips-sync", "Universe sync")} disabled={busy !== null}>
            <Database size={11} style={{ marginRight: 4 }} /> {busy === "market-scrips-sync" ? "syncing…" : "Sync universe"}
          </Btn>
          <Btn onClick={() => runPipeline("market-pipeline-eod", "EOD batch")} disabled={busy !== null}>
            <Play size={11} style={{ marginRight: 4 }} /> {busy === "market-pipeline-eod" ? "running…" : "Run EOD batch"}
          </Btn>
          <Btn onClick={() => runPipeline("market-pipeline-aggregates", "Aggregates")} disabled={busy !== null}>
            <RefreshCw size={11} style={{ marginRight: 4 }} /> {busy === "market-pipeline-aggregates" ? "finalizing…" : "Finalize aggregates"}
          </Btn>
          <Btn onClick={() => runPipeline("market-indices", "Index refresh")} disabled={busy !== null}>Refresh indices</Btn>
          <Btn onClick={() => runPipeline("market-fundamentals-global-sync", "Fundamentals sync")} disabled={busy !== null} title="Populates the Screener's fundamentals (PE, PB, ROE, market cap, sector, industry) from Yahoo. Takes ~2 minutes for the full universe.">
            <Database size={11} style={{ marginRight: 4 }} /> {busy === "market-fundamentals-global-sync" ? "syncing fundamentals… (~2 min)" : "Sync fundamentals (Yahoo)"}
          </Btn>
        </div>
        {pipelineSummary && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--accent-soft)", lineHeight: 1.5 }}>{pipelineSummary}</div>
        )}
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
          After the first EOD batch, open <Link to="/market/screener" style={{ color: "var(--accent)" }}>Screener</Link> or <Link to="/market" style={{ color: "var(--accent)" }}>Dashboard</Link> to verify results.
        </div>
      </HudPanel>

      {isKotak && cur?.connection_status === "pending_otp" && (
        <HudPanel flow title="Complete Login — TOTP" index="MK.S3">
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
            Enter the current 6-digit TOTP from your authenticator app (Kotak Neo → API TOTP).
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1, maxWidth: 200 }}>
              <div style={labelStyle}>TOTP code</div>
              <input value={otp} onChange={(e) => setOtp(e.target.value)} style={{ ...inputStyle, width: "100%" }} inputMode="numeric" autoFocus />
            </div>
            <Btn onClick={completeOtp} disabled={busy !== null} variant="primary">
              {busy === "otp" ? "validating…" : "Complete login"}
            </Btn>
          </div>
          {otpError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>
              {otpError}
            </div>
          )}
        </HudPanel>
      )}
    </div>
  );
}

function Field({ label, value, setValue, placeholder, type = "text" }: { label: string; value: string; setValue: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input type={type} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} style={{ ...inputStyle, width: "100%" }} autoComplete="off" />
    </div>
  );
}
