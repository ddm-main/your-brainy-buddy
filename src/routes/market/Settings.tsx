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
type ServiceProvider = "fmp" | "alpha_vantage" | "nse" | "bse";

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
  // Ciphertext presence only — never rendered/decrypted client-side.
  totp_secret_enc: string | null;
  mobile_number_enc: string | null;
  mpin_enc: string | null;
};

const KOTAK_DEFAULT_BASE = "https://gw-napi.kotaksecurities.com";
const KOTAK_DEFAULT_WS = "wss://mlhsm.kotaksecurities.com";

const FETCHES: Record<Provider, string[]> = {
  yahoo: ["Quotes", "OHLC charts", "Fundamentals", "52-week range", "Indices"],
  kotak_neo: ["Holdings", "Positions", "Orders", "Live LTP", "Broker session"],
};

const SERVICE_PROVIDERS: ServiceProvider[] = ["fmp", "alpha_vantage", "nse", "bse"];
const SERVICE_META: Record<ServiceProvider, { name: string; role: string; fetches: string[]; needsKey: boolean }> = {
  fmp: { name: "Financial Modeling Prep", role: "Fundamentals", fetches: ["Market cap", "PE / PB / ROE / ROCE", "Balance sheet", "Cash flow", "Growth ratios"], needsKey: true },
  alpha_vantage: { name: "Alpha Vantage", role: "Technicals", fetches: ["SMA / EMA", "RSI", "MACD", "ADX / ATR", "Bollinger Bands"], needsKey: true },
  nse: { name: "NSE", role: "Exchange data", fetches: ["Market status", "Index constituents", "Bulk / block deals", "Corporate actions", "Holidays"], needsKey: false },
  bse: { name: "BSE", role: "Exchange data", fetches: ["Corporate actions", "Announcements", "Circulars"], needsKey: false },
};

export default function MarketSettings() {
  const push = useUi((s) => s.push);
  const [rows, setRows] = useState<Record<Provider, Settings | null>>({ kotak_neo: null, yahoo: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [consumerKey, setConsumerKey] = useState("");
  const [mobile, setMobile] = useState("");
  const [mpin, setMpin] = useState("");
  const [ucc, setUcc] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, unknown> | null>(null);
  const [serviceStatus, setServiceStatus] = useState<Record<ServiceProvider, { ok: boolean; detail: string | null; testedAt: string } | null>>(
    { fmp: null, alpha_vantage: null, nse: null, bse: null },
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
    if (k) {
      setConsumerKey(k.consumer_key ?? ""); setUcc(k.ucc ?? "");
      // Mobile number is low-sensitivity contact info — shown back in full.
      // MPIN/TOTP secret stay write-only, never decrypted to the browser.
      if (k.mobile_number_enc) {
        try {
          const r = await callFn("market-kotak-mobile", {});
          setMobile(r?.mobile_number ?? "");
        } catch { /* non-critical — form still works, just won't prefill */ }
      }
    }
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
        mobile_number: mobile || null,
        mpin: mpin || null,
        totp_secret: totpSecret || null,
        ucc: ucc || undefined,
        base_url: KOTAK_DEFAULT_BASE, ws_url: KOTAK_DEFAULT_WS,
      });
      setMpin(""); setMobile(""); setTotpSecret("");
      push("Configuration saved", "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Save failed").message, "err"); }
    finally { setBusy(null); }
  };

  const startLogin = async () => {
    setBusy("login");
    try {
      // Persist typed-but-unsaved fields first — login-start reads from the
      // DB, and blank fields never clear stored secrets (skipped via undefined).
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
      else if (r?.needs_totp) push(r?.message ?? "Enter the 6-digit TOTP below", r?.message ? "warn" : "ok");
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
  const kotakBroken = kotakConfigured && ["expired", "error"].includes(kotakStatus);
  // Only whether a TOTP secret is saved decides if reconnect is unattended —
  // Kotak itself hard-expires every session nightly regardless.
  const autoLoginEnabled = !!kotak?.totp_secret_enc;

  const pipelineSummary = useMemo(() => {
    if (!pipeline) return null;
    return Object.entries(pipeline)
      .filter(([k]) => !["ok", "step"].includes(k))
      .slice(0, 8)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ");
  }, [pipeline]);

  const kotakExpanded = (editing || kotak?.connection_status === "pending_otp") && (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
            <Btn onClick={startLogin} disabled={busy !== null || needsKotakBasics} title={needsKotakBasics ? "Save Consumer Key and UCC first" : undefined}>
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
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <HudPanel flow title="Data Providers" index="MK.S1" live={kotakConnected ? "ok" : "idle"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ProviderCard
            name="Yahoo Finance" role="Market data" fetches={FETCHES.yahoo}
            status="available" statusTone="ok" live={liveProvider === "yahoo"}
            actions={<Btn size="sm" onClick={() => testConnection("yahoo")} disabled={busy !== null}><TestTube2 size={11} style={{ marginRight: 4 }} />Test</Btn>}
          />
          <ProviderCard
            name="Kotak Neo" role="Broker" fetches={FETCHES.kotak_neo}
            status={kotakStatus} statusTone={kotakConnected ? "ok" : kotakStatus === "pending_otp" ? "warn" : kotak?.last_error ? "err" : "neutral"}
            live={liveProvider === "kotak_neo"}
            meta={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                {kotakConnected && kotak?.greeting_name && <span>Connected: <b style={{ color: "var(--accent)" }}>{kotak.greeting_name}</b></span>}
                {kotak?.token_expires_at && (
                  <span title="Kotak hard-expires every session nightly near midnight IST for every app — not app-controlled. Auto-login means it renews without you.">
                    {autoLoginEnabled ? "Fresh until" : "Valid until"} {new Date(kotak.token_expires_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                    {!autoLoginEnabled && ", then reconnect manually"}
                  </span>
                )}
                {kotakConfigured && <Chip tone={autoLoginEnabled ? "ok" : "warn"}>{autoLoginEnabled ? "auto-login on" : "auto-login off"}</Chip>}
              </div>
            }
            error={kotak?.last_error ?? undefined}
            expanded={kotakExpanded}
            actions={
              <>
                {kotakBroken && !editing && (
                  <Btn size="sm" variant="primary" onClick={startLogin} disabled={busy !== null}>
                    {busy === "login" ? "reconnecting…" : "Re-login"}
                  </Btn>
                )}
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
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
          Fallbacks when Kotak/Yahoo miss a field. FMP/Alpha Vantage need an API key (Supabase secret).
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
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

      <HudPanel flow title="Data Pipeline" index="MK.S4">
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          Run in order when the dashboard/screener are empty: Universe → EOD Batch → Aggregates.
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
        {pipelineSummary && <div style={{ marginTop: 6, fontSize: 11, color: "var(--accent-soft)", lineHeight: 1.5 }}>{pipelineSummary}</div>}
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
          Then verify in <Link to="/market/screener" style={{ color: "var(--accent)" }}>Screener</Link> or <Link to="/market" style={{ color: "var(--accent)" }}>Dashboard</Link>.
        </div>
      </HudPanel>
    </div>
  );
}

function ProviderCard({
  name, role, fetches, status, statusTone, live, actions, meta, error, expanded,
}: {
  name: string; role: string; fetches: string[];
  status: string; statusTone: "ok" | "warn" | "err" | "neutral"; live?: boolean;
  actions: React.ReactNode; meta?: React.ReactNode; error?: string; expanded?: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--edge)", borderRadius: 4, padding: "7px 10px", background: "rgba(255,255,255,0.015)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-hud)", fontSize: 14, color: "var(--text)", letterSpacing: "0.04em" }}>{name}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.16em" }}>{role}</span>
        <Chip tone={statusTone}>{status}</Chip>
        {live && <Chip tone="accent">live</Chip>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>{actions}</span>
      </div>
      <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)" }}>
        {fetches.join(" · ")}
      </div>
      {meta && <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>{meta}</div>}
      {error && <div style={{ marginTop: 3, fontSize: 11, color: "var(--danger)" }}>Last error: {error}</div>}
      {expanded && <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--edge)" }}>{expanded}</div>}
    </div>
  );
}

const MASK_DOTS = "••••••••••••";

function Field({ label, value, setValue, placeholder, type = "text", saved }: { label: string; value: string; setValue: (v: string) => void; placeholder?: string; type?: string; saved?: boolean }) {
  // A saved field with nothing typed shows a dot mask instead of a truly
  // empty box, so it's visually obvious something real is stored. Display-
  // only — never written into `value`, so it can't be submitted as data.
  // Focusing swaps to a real empty box ready for fresh input.
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
