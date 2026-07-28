// Free-plan quota panel — keeps every Supabase free-tier meter under 80%.
//
// Four sections are metered by Supabase: database (500 MB), file storage
// (1 GB), egress (5 GB / cycle) and monthly active users (50k). The governor
// (public.run_daily_maintenance, twice daily) prunes, archives cold price
// history into file storage, and escalates in three bands: normal below
// 380 MB, aggressive above it, emergency above 430 MB.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { HardDrive, Trash2, Archive } from "lucide-react";

const SAFE_PCT = 80;

type QuotaReport = {
  db_bytes: number;
  db_limit_bytes: number;
  storage_bytes: number;
  storage_limit_bytes: number;
  egress_limit_bytes: number;
  buckets: { name: string; objects: number; bytes: number }[];
  tables: { name: string; bytes: number }[];
  quota: {
    egress_bytes?: number;
    low_bandwidth?: boolean;
    last_level?: string;
    checked_at?: string;
  } | null;
};

type MaintenanceRow = {
  ran_at: string;
  mode: string;
  total_deleted: number;
  size_bytes: number | null;
  duration_ms: number | null;
};

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toneFor(pct: number): "ok" | "warn" | "err" {
  if (pct >= SAFE_PCT) return "err";
  if (pct >= SAFE_PCT - 15) return "warn";
  return "ok";
}

function QuotaBar({ label, used, limit, note }: { label: string; used: number | null; limit: number; note?: string }) {
  const known = used != null;
  const pct = known ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = toneFor(pct);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
        <span className="hud-label" style={{ color: "var(--text-muted)" }}>{label}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
          {known ? `${human(used!)} / ${human(limit)}` : `— / ${human(limit)}`}
        </span>
        <Chip tone={known ? tone : "warn"}>{known ? `${pct}%` : "n/a"}</Chip>
      </div>
      <div style={{ marginTop: 4, height: 6, background: "rgba(255,255,255,0.06)", border: "1px solid var(--edge)", position: "relative" }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: tone === "err" ? "var(--danger)" : tone === "warn" ? "var(--warn, var(--accent))" : "var(--accent)",
        }} />
        {/* 80% safety line */}
        <span style={{ position: "absolute", left: `${SAFE_PCT}%`, top: -2, bottom: -2, width: 1, background: "var(--danger)", opacity: 0.6 }} />
      </div>
      {note ? <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>{note}</div> : null}
    </div>
  );
}

export default function DatabaseStoragePanel() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "clean" | "archive">(null);

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

  const { data: last } = useQuery({
    queryKey: ["system", "maintenance-log"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("system_maintenance_log")
        .select("ran_at,mode,total_deleted,size_bytes,duration_ms")
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as MaintenanceRow | null;
    },
    staleTime: 60_000,
  });

  const { data: coverage } = useQuery({
    queryKey: ["system", "archive-coverage"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("archive_coverage");
      if (error) throw error;
      return data as {
        archived: number;
        universe: number;
        archived_bars: number;
        archived_bytes: number;
        pending: number;
        last_maintenance: {
          ran_at: string; mode: string; total_deleted: number;
          size_bytes: number; duration_ms: number;
        } | null;
      };

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
      setBusy(null);
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
      setBusy(null);
    }
  };


  const dbBytes = report?.db_bytes ?? 0;
  const dbLimit = report?.db_limit_bytes ?? 500 * 1024 * 1024;
  const storeBytes = report?.storage_bytes ?? 0;
  const storeLimit = report?.storage_limit_bytes ?? 1024 ** 3;
  const egressLimit = report?.egress_limit_bytes ?? 5 * 1024 ** 3;
  const egressBytes = report?.quota?.egress_bytes ? Number(report.quota.egress_bytes) : null;
  const dbPct = Math.round((dbBytes / dbLimit) * 100);
  const worst = Math.max(dbPct, Math.round((storeBytes / storeLimit) * 100));
  const biggest = report?.tables?.[0]?.bytes ?? 1;

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
    padding: "3px 0",
  };

  return (
    <HudPanel
      title="Free-Plan Quota"
      index="QTA"
      live={isLoading ? "warn" : worst >= SAFE_PCT ? "err" : "ok"}
      bodyClass="overflow-visible"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Target: every section under {SAFE_PCT}%
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Btn size="sm" onClick={archiveNow} disabled={busy !== null}>
            <Archive size={11} style={{ marginRight: 4 }} />{busy === "archive" ? "archiving…" : "Archive cold history"}
          </Btn>
          <Btn size="sm" onClick={runNow} disabled={busy !== null}>
            <Trash2 size={11} style={{ marginRight: 4 }} />{busy === "clean" ? "cleaning…" : "Run cleanup now"}
          </Btn>
        </span>
      </div>

      <QuotaBar label="Database" used={dbBytes} limit={dbLimit} note="Hot data only — bars past the hot window live in file storage." />
      <QuotaBar
        label="File storage"
        used={storeBytes}
        limit={storeLimit}
        note={`${coverage?.archived ?? 0} / ${coverage?.universe ?? 0} symbols archived · statements + cold price history`}
      />
      <QuotaBar label="Egress (cycle)" used={egressBytes} limit={egressLimit} note="Recorded by the governor; check Supabase for the live figure." />
      <QuotaBar label="Monthly active users" used={null} limit={50_000} note="Single-operator app — never near the cap." />

      {coverage ? (
        <div style={{ marginTop: 2, marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
            <span className="hud-label" style={{ color: "var(--text-muted)" }}>Archive drain</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
              {coverage.pending > 0 ? `${coverage.pending}+ symbols pending` : "drained"}
            </span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
              {coverage.pending > 0 ? `${coverage.pending} symbols pending` : "drained"}
            </span>
            <Chip tone={coverage.pending > 0 ? "warn" : "ok"}>
              {coverage.universe ? Math.round((coverage.archived / coverage.universe) * 100) : 0}%
            </Chip>
          </div>
          <div style={{ marginTop: 4, height: 4, background: "rgba(255,255,255,0.06)", border: "1px solid var(--edge)" }}>
            <div style={{
              height: "100%",
              width: `${coverage.universe ? Math.min(100, Math.round((coverage.archived / coverage.universe) * 100)) : 0}%`,
              background: "var(--accent)",
            }} />
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-dim)" }}>
            {coverage.last_maintenance
              ? `Last cleanup ${new Date(coverage.last_maintenance.ran_at).toLocaleString()} · ${coverage.last_maintenance.mode} · ${coverage.last_maintenance.total_deleted.toLocaleString()} rows in ${Math.round(coverage.last_maintenance.duration_ms / 1000)}s`
              : "Cleanup has never completed — check the maintenance cron."}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11, marginBottom: 4 }}>
          <HardDrive size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />Largest tables

        </div>
        {(report?.tables ?? []).map((t) => (
          <div key={t.name} style={rowStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
              <span style={{ flex: 1, height: 3, background: "rgba(53,214,237,0.12)", minWidth: 40 }}>
                <span style={{ display: "block", height: "100%", width: `${Math.round((t.bytes / biggest) * 100)}%`, background: "var(--accent)" }} />
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-hud)", color: "var(--text)" }}>{human(t.bytes)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--edge)", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {last ? (
          <>
            Last run {new Date(last.ran_at).toLocaleString()} ({last.mode}) — removed{" "}
            <span style={{ color: "var(--text)" }}>{last.total_deleted.toLocaleString()}</span> rows
            {last.duration_ms != null ? ` in ${(last.duration_ms / 1000).toFixed(1)}s` : ""}.
          </>
        ) : (
          <>No cleanup run recorded yet. The governor runs at 01:30 and 13:30 IST.</>
        )}
        <div>
          Hot window: ~500 days for tracked symbols, ~260 for the rest — older bars are gzipped into the
          <code style={{ margin: "0 4px" }}>market-archive</code> bucket and served back on demand.
          Logs and caches keep 1–14 days.
          {coverage ? ` Archived: ${coverage.archived_bars.toLocaleString()} bars, ${human(coverage.archived_bytes)}.` : ""}
        </div>

      </div>
    </HudPanel>
  );
}
