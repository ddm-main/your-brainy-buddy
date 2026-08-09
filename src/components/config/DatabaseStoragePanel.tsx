// Free-plan quota panel — keeps every Supabase free-tier meter under 80%.
// Compact readout: bars for the metered sections that actually report data,
// the archive drain progress, and the largest tables.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Trash2, Archive, RefreshCw } from "lucide-react";

const SAFE_PCT = 80;

type QuotaReport = {
  db_bytes: number;
  db_own_bytes?: number;
  db_reported_bytes?: number | null;
  db_limit_bytes: number;
  storage_bytes: number;
  storage_limit_bytes: number;
  mau?: number;
  mau_limit?: number;
  cycle_start?: string;
  egress_bytes?: number | string;
  egress_reported_bytes?: number | string | null;
  egress_budget_bytes?: number | string;
  egress_limit_bytes?: number | string;
  egress_sources?: { source: string; route: string; bytes: number | string; requests: number | string }[];
  tables: { name: string; bytes: number }[];
  quota: {
    egress_bytes?: number;
    egress_breakdown?: Record<string, number | string> | null;
    egress_window_start?: string | null;
    egress_window_end?: string | null;
    egress_synced_at?: string | null;
    low_bandwidth?: boolean;
    last_level?: string;
    checked_at?: string;
  } | null;
};


type Coverage = {
  archived: number;
  universe: number;
  archived_bars: number;
  archived_bytes: number;
  pending: number;
  last_maintenance: {
    ran_at: string; mode: string; total_deleted: number;
    size_bytes: number | null; duration_ms: number | null;
  } | null;
};

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function count(n: number): string {
  return n.toLocaleString();
}

function toneFor(pct: number): "ok" | "warn" | "err" {
  if (pct >= SAFE_PCT) return "err";
  if (pct >= SAFE_PCT - 15) return "warn";
  return "ok";
}

function QuotaBar({ label, used, limit, suffix, format = human }: {
  label: string; used: number; limit: number; suffix?: string; format?: (n: number) => string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = toneFor(pct);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
        <span className="hud-label" style={{ color: "var(--text-muted)" }}>{label}</span>
        {suffix ? <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{suffix}</span> : null}
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
          {format(used)} / {format(limit)}
        </span>
        <Chip tone={tone}>{pct}%</Chip>
      </div>
      <div style={{ marginTop: 3, height: 5, background: "rgba(255,255,255,0.06)", border: "1px solid var(--edge)", position: "relative" }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: tone === "err" ? "var(--danger)" : tone === "warn" ? "var(--warn, var(--accent))" : "var(--accent)",
        }} />
        <span style={{ position: "absolute", left: `${SAFE_PCT}%`, top: -2, bottom: -2, width: 1, background: "var(--danger)", opacity: 0.6 }} />
      </div>
    </div>
  );
}

export default function DatabaseStoragePanel() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "clean" | "archive" | "egress">(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { data: report, isLoading } = useQuery({
    queryKey: ["system", "quota-report"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("quota_report");
      if (error) throw error;
      return data as QuotaReport;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const { data: coverage } = useQuery({
    queryKey: ["system", "archive-coverage"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("archive_coverage");
      if (error) throw error;
      return data as Coverage;
    },
    staleTime: 60_000,
  });

  const runNow = async () => {
    if (busy) return;
    setBusy("clean");
    try {
      const { error } = await (supabase as any).rpc("run_daily_maintenance");
      if (error) throw error;
      push("Cleanup complete", "ok");
      await qc.invalidateQueries({ queryKey: ["system"] });
    } catch (e) {
      push(toSafeError(e, "Cleanup failed").message, "err");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const archiveNow = async () => {
    if (busy) return;
    setBusy("archive");
    try {
      const { error } = await supabase.functions.invoke("market-archive-prices", { body: { limit: 120 } });
      if (error) throw error;
      push("Cold history archived to file storage", "ok");
      await qc.invalidateQueries({ queryKey: ["system"] });
    } catch (e) {
      push(toSafeError(e, "Archive failed").message, "err");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  // Egress is measured by the app itself (src/lib/egressMeter.ts) and rolled
  // up here on demand, in addition to the scheduled roll-up. `invoke` hides
  // the response body behind a generic "Failed to send a request" error, so
  // read the real message out of the error context when there is one.
  const syncEgress = async () => {
    if (busy) return;
    setBusy("egress");
    try {
      // The egress sync rides on `market-selftest` — this project has no free
      // edge-function slots left for a dedicated function.
      const { data, error } = await supabase.functions.invoke("market-selftest", {
        body: { action: "usage-egress" },
      });
      if (error) {
        const ctx = (error as any)?.context;
        let detail = "";
        if (ctx instanceof Response) {
          const text = await ctx.text().catch(() => "");
          try { detail = JSON.parse(text)?.error ?? text; } catch { detail = text; }
          if (ctx.status === 404) detail = "the market-selftest function is not deployed";
        }

        throw new Error(detail ? `Egress sync failed: ${detail}` : (error as Error).message);
      }
      if ((data as any)?.ok === false) throw new Error((data as any).error ?? "usage sync failed");
      push("Egress figure refreshed", "ok");
      await qc.invalidateQueries({ queryKey: ["system"] });
    } catch (e) {
      push(toSafeError(e, "Egress sync failed").message, "err");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };


  const dbBytes = report?.db_bytes != null ? Number(report.db_bytes) : 0;
  const dbReported = report?.db_reported_bytes != null ? Number(report.db_reported_bytes) : null;
  const dbLimit = report?.db_limit_bytes != null ? Number(report.db_limit_bytes) : 500 * 1024 * 1024;
  const storeBytes = report?.storage_bytes != null ? Number(report.storage_bytes) : 0;
  const storeLimit = report?.storage_limit_bytes != null ? Number(report.storage_limit_bytes) : 1024 ** 3;
  const mau = Number(report?.mau ?? 0);
  const mauLimit = Number(report?.mau_limit ?? 50_000);
  const dbPct = dbLimit > 0 ? Math.round((dbBytes / dbLimit) * 100) : 0;
  const storePct = storeLimit > 0 ? Math.round((storeBytes / storeLimit) * 100) : 0;

  // Egress: measured client-side, rolled up per billing cycle. Percentages are
  // against our self-imposed 4 GB budget, not the 5 GB hard cap.
  const egressBytes = Number(report?.egress_bytes ?? 0);
  const egressReported = report?.egress_reported_bytes != null ? Number(report.egress_reported_bytes) : null;
  const egressBudget = Number(report?.egress_budget_bytes ?? 4 * 1024 ** 3);
  const egressCap = Number(report?.egress_limit_bytes ?? 5 * 1024 ** 3);
  const egressSyncedAt = report?.quota?.egress_synced_at ?? null;
  const egressPct = egressBudget > 0 ? Math.round((egressBytes / egressBudget) * 100) : 0;
  const egressSplit = Object.entries(report?.quota?.egress_breakdown ?? {})
    .map(([k, v]) => [k, Number(v)] as const)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const egressSources = (report?.egress_sources ?? [])
    .map((s) => ({ ...s, bytes: Number(s.bytes), requests: Number(s.requests) }))
    .slice(0, 6);
  const cycle = report?.quota?.egress_window_start && report?.quota?.egress_window_end
    ? `${report.quota.egress_window_start} → ${report.quota.egress_window_end}`
    : null;

  const worst = Math.max(dbPct, storePct, egressSyncedAt ? egressPct : 0);
  const tables = (report?.tables ?? []).slice(0, 6);
  const biggest = tables[0]?.bytes ?? 1;


  const archivePct = coverage?.universe ? Math.min(100, Math.round((coverage.archived / coverage.universe) * 100)) : 0;
  const fullyArchived = !!coverage && coverage.universe > 0 && coverage.archived >= coverage.universe;
  const lastRun = coverage?.last_maintenance ?? null;

  // Warn once per session when any metered section crosses the 80% line.
  const warnedRef = useRef(false);
  useEffect(() => {
    if (!report) return;
    if (worst >= SAFE_PCT && !warnedRef.current) {
      warnedRef.current = true;
      push(`Quota alert: a free-plan section is at ${worst}% — run cleanup`, "err");
    }
    if (worst < SAFE_PCT) warnedRef.current = false;
  }, [report, worst, push]);

  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 8,
    alignItems: "center",
    fontSize: 11,
    color: "var(--text-dim)",
    padding: "1px 0",
  };

  return (
    <HudPanel
      title="Storage & Quota"
      index="QTA"
      live={isLoading ? "warn" : worst >= SAFE_PCT ? "err" : "ok"}
      bodyClass="overflow-visible"
      actions={
        <span style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" onClick={syncEgress} disabled={busy !== null}>
            <RefreshCw size={11} style={{ marginRight: 4 }} />{busy === "egress" ? "syncing…" : "Egress"}
          </Btn>
          <Btn size="sm" onClick={archiveNow} disabled={busy !== null}>

            <Archive size={11} style={{ marginRight: 4 }} />{busy === "archive" ? "archiving…" : "Archive"}
          </Btn>
          <Btn size="sm" onClick={runNow} disabled={busy !== null}>
            <Trash2 size={11} style={{ marginRight: 4 }} />{busy === "clean" ? "cleaning…" : "Clean"}
          </Btn>
        </span>
      }
    >
      <QuotaBar
        label="Disk size"
        used={dbBytes}
        limit={dbLimit}
        suffix={dbReported != null ? `Supabase reports ${human(dbReported)}` : "all databases on the instance"}
      />
      <QuotaBar
        label="File storage"
        used={storeBytes}
        limit={storeLimit}
        suffix={coverage ? `${coverage.archived_bars.toLocaleString()} bars archived` : undefined}
      />
      <QuotaBar label="Monthly active users" used={mau} limit={mauLimit} format={count} suffix="signed in this cycle" />

      {egressSyncedAt ? (
        <>
          <QuotaBar
            label="Egress"
            used={egressBytes}
            limit={egressBudget}
            suffix={`measured · budget of ${human(egressBudget)} · cap ${human(egressCap)}${cycle ? ` · ${cycle}` : ""}`}
          />
          <div style={{ marginTop: -2, marginBottom: 6, display: "flex", gap: 8, flexWrap: "wrap", fontSize: 10, color: "var(--text-muted)" }}>
            {egressSplit.length
              ? egressSplit.map(([k, v]) => <span key={k}>{k} {human(v)}</span>)
              : <span>no per-type split reported</span>}
            {egressReported != null ? <span>Supabase reports {human(egressReported)}</span> : null}
            <span style={{ marginLeft: "auto", color: Date.now() - new Date(egressSyncedAt).getTime() > 12 * 3_600_000 ? "var(--warn, #d19a30)" : undefined }}>
              synced {new Date(egressSyncedAt).toLocaleString()}
              {Date.now() - new Date(egressSyncedAt).getTime() > 12 * 3_600_000 ? " · stale" : ""}
            </span>
          </div>
          {egressSources.length ? (
            <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 1 }}>
              {egressSources.map((s) => {
                // Two budget rules, surfaced where the bytes are: no route may
                // average over 128 KB per request (missing server-side filter)
                // and no route may exceed 2 000 requests/day (missing batching).
                const per = s.requests > 0 ? s.bytes / s.requests : s.bytes;
                const fat = per > 128 * 1024;
                const chatty = s.requests > 2000;
                return (
                  <div key={`${s.source}/${s.route}`} style={rowStyle}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.source} · {s.route || "—"} · {s.requests.toLocaleString()} req
                      {fat ? <span style={{ color: "var(--danger, #e0524a)" }} title={`${Math.round(per / 1024)} KB per request — needs server-side filtering`}> · oversized</span> : null}
                      {chatty ? <span style={{ color: "var(--warn, #d19a30)" }} title="Over 2,000 requests/day — batch these reads"> · chatty</span> : null}
                    </span>
                    <span style={{ fontFamily: "var(--font-hud)", color: "var(--text)" }}>{human(s.bytes)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ marginBottom: 6, fontSize: 10, color: "var(--text-muted)" }}>
          <span className="hud-label" style={{ color: "var(--text-muted)" }}>Egress</span>{" "}
          not rolled up yet — the app measures its own egress as you browse; press Egress to total it up.
        </div>
      )}


      {coverage ? (
        <div style={{ marginTop: 2, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
            <span className="hud-label" style={{ color: "var(--text-muted)" }}>Archive drain</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
              {fullyArchived
                ? "complete"
                : `${coverage.archived.toLocaleString()} / ${coverage.universe.toLocaleString()} symbols`}
            </span>
            <Chip tone={fullyArchived ? "ok" : "warn"}>{archivePct}%</Chip>
          </div>
          <div style={{ marginTop: 3, height: 4, background: "rgba(255,255,255,0.06)", border: "1px solid var(--edge)" }}>
            <div style={{ height: "100%", width: `${archivePct}%`, background: "var(--accent)" }} />
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 1 }}>
        {tables.map((t) => (
          <div key={t.name} style={rowStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
              <span style={{ flex: 1, height: 3, background: "rgba(53,214,237,0.12)", minWidth: 40 }}>
                <span style={{ display: "block", height: "100%", width: `${biggest > 0 ? Math.round((t.bytes / biggest) * 100) : 0}%`, background: "var(--accent)" }} />
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-hud)", color: "var(--text)" }}>{human(t.bytes)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--edge)", fontSize: 10, color: "var(--text-muted)" }}>
        {lastRun
          ? `Last cleanup ${new Date(lastRun.ran_at).toLocaleString()} · ${lastRun.mode} · ${lastRun.total_deleted.toLocaleString()} rows${
              lastRun.duration_ms != null ? ` in ${(lastRun.duration_ms / 1000).toFixed(1)}s` : ""
            }`
          : "Cleanup has never completed — check the maintenance cron."}
      </div>
    </HudPanel>
  );
}
