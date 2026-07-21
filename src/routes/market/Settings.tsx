// Market Config — data providers, broker credentials, and the data pipeline.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Database, LockKeyhole, Pencil, Play, RefreshCw, TestTube2 } from "lucide-react";

type Provider = "kotak_neo" | "yahoo";
type ServiceProvider = "fmp" | "alpha_vantage" | "nse" | "bse" | "stooq";

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

// What each provider actually feeds into the app.
const FETCHES: Record<Provider, string[]> = {
  yahoo: ["Quotes", "OHLC charts", "Fundamentals", "52-week range", "Indices"],
  kotak_neo: ["Holdings", "Positions", "Orders", "Live LTP", "Broker session"],
};

// Secondary data providers — priority-chain fallbacks used by the sync
// pipelines (market-fmp-sync, market-fundamentals-global-sync, screener
// technicals). None of these hold a per-user broker session; "Test" pings
// the provider directly and reports API-key / reachability status.
const SERVICE_PROVIDERS: ServiceProvider[] = ["fmp", "alpha_vantage", "nse", "bse", "stooq"];
const SERVICE_META: Record<ServiceProvider, { name: string; role: string; fetches: string[]; needsKey: boolean }> = {
  fmp: { name: "Financial Modeling Prep", role: "Fundamentals", fetches: ["Market cap", "PE / PB / ROE / ROCE", "Balance sheet", "Cash flow", "Growth ratios"], needsKey: true },
  alpha_vantage: { name: "Alpha Vantage", role: "Technicals", fetches: ["SMA / EMA", "RSI", "MACD", "ADX / ATR", "Bollinger Bands"], needsKey: true },
  nse: { name: "NSE", role: "Exchange data", fetches: ["Market status", "Index constituents", "Bulk / block deals", "Corporate actions", "Holidays"], needsKey: false },
  bse: { name: "BSE", role: "Exchange data", fetches: ["Corporate actions", "Announcements", "Circulars"], needsKey: false },
  stooq: { name: "Stooq", role: "Backup prices", fetches: ["Daily OHLCV (backup)"], needsKey: false },
};

export default function MarketSettings() {
  const push = useUi((s) => s.push);
  const [rows, setRows] = useState<Record<Provider, Settings | null>>({ kotak_neo: null, yahoo: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Kotak form state (secrets never repopulate on load).
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [mobile, setMobile] = useState("");
  const [mpin, setMpin] = useState("");
  const [ucc, setUcc] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, unknown> | null>(null);
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceProvider, { ok: boolean; detail: string | null; testedAt: string } | null>>(
    { fmp: null, alpha_vantage: null, nse: null, bse: null, stooq: null },
  );

  const load = async () => {
    const { data, error } = await supabase.from("market_api_settings").select("*");
    if (error) { push(error.message, "err"); return; }
    const map: Record<Provider, Settings | null> = { kotak_neo: null, yahoo: null };
    for (const r of (data ?? []) as any[]) {
      if (r.active_provider === "kotak_neo" || r.active_provider === "yahoo") map[r.active_provider as Provider] = r as Settings;
    }
    setRows(map);
    const k = map.kotak_neo;
    if (k) { setConsumerKey(k.consumer_key ?? ""); setUcc(k.ucc ?? ""); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

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
        provider: "kotak_neo",
        consumer_key: consumerKey || null,
        consumer_secret: consumerSecret || null,
        mobile_number: mobile || null,
        mpin: mpin || null,
        totp_secret: totpSecret || null,
        ucc: ucc || undefined,
        base_url: KOTAK_DEFAULT_BASE, ws_url: KOTAK_DEFAULT_WS,
      });
      setConsumerSecret(""); setMpin(""); setMobile(""); setTotpSecret("");
      push("Configuration saved", "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Save failed").message, "err"); }
    finally { setBusy(null); }
  };

  const setActive = async (prov: Provider) => {
    setBusy("activate");
    try {
      if (prov === "yahoo") {
        push("Yahoo Finance is always available for quotes and charts", "ok");
      } else {
        await callFn("market-config-save", { provider: "kotak_neo", consumer_key: consumerKey || undefined, ucc: ucc || undefined });
        push("Kotak Neo selected — save credentials and login to activate broker sync", "ok");
      }
      await load();
    } catch (e) { push(toSafeError(e, "Activate failed").message, "err"); }
    finally { setBusy(null); }
  };

  const startLogin = async () => {
    setBusy("login");
    try {
      // Persist typed-but-unsaved fields first — login-start reads from the DB, and
      // secrets (mobile/MPIN/TOTP) never repopulate on reload. `undefined` fields are
      // skipped server-side, so blank fields never clear stored secrets.
      await callFn("market-config-save", {
        provider: "kotak_neo",
        consumer_key: consumerKey || undefined,
        mobile_number: mobile || undefined,
        mpin: mpin || undefined,
        totp_secret: totpSecret || undefined,
        consumer_secret: consumerSecret || undefined,
        ucc: ucc || undefined,
      });
      setConsumerSecret(""); setMpin(""); setMobile(""); setTotpSecret("");
      const r = await callFn("market-kotak-login-start", {});
      if (r?.auto) push(`Connected as ${r?.greeting_name ?? "Kotak user"} (auto TOTP)`, "ok");
      else if (r?.needs_totp) push("Enter the 6-digit TOTP below", "ok");
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
        // Kotak APIM occasionally 502s transiently — retry once.
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

  const testConnection = async (prov: Provider) => {
    setBusy("test");
    try {
      const r = await callFn("market-test-connection", { provider: prov });
      push(r?.ok ? `Connection OK (${r?.provider})` : `Connection failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
      await load();
    } catch (e) { push(toSafeError(e, "Test failed").message, "err"); }
    finally { setBusy(null); }
  };

  const testService = async (prov: ServiceProvider) => {
    setBusy(`test-${prov}`);
    try {
      const r = await callFn("market-test-connection", { provider: prov });
      setServiceStatus((s) => ({ ...s, [prov]: { ok: !!r?.ok, detail: r?.detail ?? null, testedAt: new Date().toISOString() } }));
      push(r?.ok ? `${SERVICE_META[prov].name} OK` : `${SERVICE_META[prov].name} failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
    } catch (e) {
      const msg = toSafeError(e, "Test failed").message;
      setServiceStatus((s) => ({ ...s, [prov]: { ok: false, detail: msg, testedAt: new Date().toISOString() } }));
      push(msg, "err");
    } finally { setBusy(null); }
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

  const kotak = rows.kotak_neo;
  const kotakConnected = kotak?.connection_status === "connected";
  const liveProvider: Provider = kotakConnected ? "kotak_neo" : "yahoo";
  const needsKotakBasics = !consumerKey.trim() || !ucc.trim();
  const kotakStatus = kotak?.connection_status ?? "not configured";
  const kotakConfigured = !!kotak?.consumer_key;

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
      <HudPanel flow title="Data Providers" index="MK.S1" live={kotakConnected ? "ok" : "idle"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Yahoo — always-on market data */}
          <ProviderCard
            name="Yahoo Finance" role="Market data" fetches={FETCHES.yahoo}
            status="available" statusTone="ok" live={liveProvider === "yahoo"}
            actions={<Btn size="sm" onClick={() => testConnection("yahoo")} disabled={busy !== null}><TestTube2 size={11} style={{ marginRight: 4 }} />Test</Btn>}
          />
          {/* Kotak Neo — broker */}
          <ProviderCard
            name="Kotak Neo" role="Broker" fetches={FETCHES.kotak_neo}
            status={kotakStatus} statusTone={kotakConnected ? "ok" : kotakStatus === "pending_otp" ? "warn" : kotak?.last_error ? "err" : "neutral"}
            live={liveProvider === "kotak_neo"}
            meta={
              <>
                {kotakConnected && kotak?.greeting_name && <span>Connected: <b style={{ color: "var(--accent)" }}>{kotak.greeting_name}</b></span>}
                {kotak?.token_expires_at && <span style={{ marginLeft: kotakConnected ? 12 : 0 }}>Token expires {new Date(kotak.token_expires_at).toLocaleString()}</span>}
                {kotak?.last_sync_at && <span style={{ marginLeft: 12 }}>Last sync {new Date(kotak.last_sync_at).toLocaleString()}</span>}
              </>
            }
            error={kotak?.last_error ?? undefined}
            actions={
              <>
                {!kotakConnected && <Btn size="sm" onClick={() => setActive("kotak_neo")} disabled={busy !== null}>Make active</Btn>}
                <Btn size="sm" onClick={() => testConnection("kotak_neo")} disabled={busy !== null}><TestTube2 size={11} style={{ marginRight: 4 }} />Test</Btn>
                <Btn size="sm" variant={editing ? "primary" : "ghost"} onClick={() => setEditing((v) => !v)}>
                  <Pencil size={11} style={{ marginRight: 4 }} />{editing ? "Close" : kotakConfigured ? "Edit" : "Add credentials"}
                </Btn>
              </>
            }
          />
        </div>
      </HudPanel>

      <HudPanel flow title="Secondary Providers" index="MK.S1B" live="idle">
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
          Priority-chain fallbacks used by the sync pipelines when Kotak/Yahoo don't cover a field (fundamentals, technicals, exchange metadata). FMP and Alpha Vantage need a free-tier API key set as a Supabase secret — Test reports whether one is configured and reachable.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {SERVICE_PROVIDERS.map((prov) => {
            const meta = SERVICE_META[prov];
            const status = serviceStatus[prov];
            const statusLabel = status ? (status.ok ? "reachable" : "failed") : meta.needsKey ? "untested" : "available";
            const statusTone: "ok" | "warn" | "err" | "neutral" = status ? (status.ok ? "ok" : "err") : meta.needsKey ? "warn" : "neutral";
            return (
              <ProviderCard
                key={prov}
                name={meta.name} role={meta.role} fetches={meta.fetches}
                status={statusLabel} statusTone={statusTone}
                meta={status ? <span>Last test: {new Date(status.testedAt).toLocaleTimeString()}</span> : undefined}
                error={status && !status.ok ? (status.detail ?? undefined) : undefined}
                actions={
                  <Btn size="sm" onClick={() => testService(prov)} disabled={busy !== null}>
                    <TestTube2 size={11} style={{ marginRight: 4 }} />{busy === `test-${prov}` ? "testing…" : "Test"}
                  </Btn>
                }
              />
            );
          })}
        </div>
      </HudPanel>

      {!editing && kotakConfigured && ["expired", "error"].includes(kotakStatus) && (
        <HudPanel flow title="Kotak Session Expired" index="MK.S2">
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            Kotak sessions reset daily near midnight IST. Reconnect using your saved credentials — nothing to re-enter.
          </div>
          <Btn onClick={startLogin} disabled={busy !== null} variant="primary">
            {busy === "login" ? "reconnecting…" : "Re-login"}
          </Btn>
        </HudPanel>
      )}

      {editing && (
        <HudPanel flow title="Kotak Neo — Credentials" index="MK.S2">
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
            Stored encrypted at rest. Sessions expire daily near midnight IST — save the TOTP secret
            (Kotak Neo app → API TOTP) and JARVIS re-logs in automatically each morning.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Consumer Key" value={consumerKey} setValue={setConsumerKey} placeholder="From Kotak Neo → Trade API" />
            <Field label="UCC (Client Code)" value={ucc} setValue={setUcc} placeholder="e.g. ABC123" />
            <Field label="Mobile Number" value={mobile} setValue={setMobile} placeholder="+91XXXXXXXXXX (blank to keep)" />
            <Field label="MPIN" value={mpin} setValue={setMpin} placeholder="6-digit (blank to keep)" type="password" />
            <Field label="TOTP Secret" value={totpSecret} setValue={setTotpSecret} placeholder="Base32 — enables auto-login" type="password" />
            <Field label="Consumer Secret" value={consumerSecret} setValue={setConsumerSecret} placeholder="Optional" type="password" />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Btn onClick={saveConfig} disabled={busy !== null} variant="primary">
              <LockKeyhole size={11} style={{ marginRight: 4 }} />{busy === "save" ? "saving…" : "Save"}
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

      {kotak?.connection_status === "pending_otp" && (
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
          {otpError && <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>{otpError}</div>}
        </HudPanel>
      )}

      <HudPanel flow title="Data Pipeline" index="MK.S4">
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
          Run in order when the dashboard/screener are empty: Universe → EOD Batch → Aggregates.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => runPipeline("market-scrips-sync", "Universe sync")} disabled={busy !== null}>
            <Database size={11} style={{ marginRight: 4 }} />{busy === "market-scrips-sync" ? "syncing…" : "Sync universe"}
          </Btn>
          <Btn onClick={() => runPipeline("market-pipeline-eod", "EOD batch")} disabled={busy !== null}>
            <Play size={11} style={{ marginRight: 4 }} />{busy === "market-pipeline-eod" ? "running…" : "Run EOD batch"}
          </Btn>
          <Btn onClick={() => runPipeline("market-pipeline-aggregates", "Aggregates")} disabled={busy !== null}>
            <RefreshCw size={11} style={{ marginRight: 4 }} />{busy === "market-pipeline-aggregates" ? "finalizing…" : "Finalize aggregates"}
          </Btn>
          <Btn onClick={() => runPipeline("market-indices", "Index refresh")} disabled={busy !== null}>Refresh indices</Btn>
          <Btn onClick={() => runPipeline("market-fundamentals-global-sync", "Fundamentals sync")} disabled={busy !== null} title="Populates fundamentals (PE, PB, ROE, market cap, sector) from Yahoo. ~2 min for the full universe.">
            <Database size={11} style={{ marginRight: 4 }} />{busy === "market-fundamentals-global-sync" ? "syncing… (~2 min)" : "Sync fundamentals"}
          </Btn>
        </div>
        {pipelineSummary && <div style={{ marginTop: 10, fontSize: 11, color: "var(--accent-soft)", lineHeight: 1.5 }}>{pipelineSummary}</div>}
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
          Then verify in <Link to="/market/screener" style={{ color: "var(--accent)" }}>Screener</Link> or <Link to="/market" style={{ color: "var(--accent)" }}>Dashboard</Link>.
        </div>
      </HudPanel>
    </div>
  );
}

function ProviderCard({
  name, role, fetches, status, statusTone, live, actions, meta, error,
}: {
  name: string; role: string; fetches: string[];
  status: string; statusTone: "ok" | "warn" | "err" | "neutral"; live?: boolean;
  actions: React.ReactNode; meta?: React.ReactNode; error?: string;
}) {
  return (
    <div style={{ border: "1px solid var(--edge)", borderRadius: 4, padding: "10px 12px", background: "rgba(255,255,255,0.015)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-hud)", fontSize: 14, color: "var(--text)", letterSpacing: "0.04em" }}>{name}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.16em" }}>{role}</span>
        <Chip tone={statusTone}>{status}</Chip>
        {live && <Chip tone="accent">live</Chip>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>{actions}</span>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.18em" }}>Fetches</span>
        {fetches.map((f) => <Chip key={f} tone="neutral">{f}</Chip>)}
      </div>
      {meta && <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>{meta}</div>}
      {error && <div style={{ marginTop: 6, fontSize: 11, color: "var(--danger)" }}>Last error: {error}</div>}
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
