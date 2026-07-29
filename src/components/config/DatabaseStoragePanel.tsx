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
import { Trash2, Archive } from "lucide-react";

const SAFE_PCT = 80;

type QuotaReport = {
  db_bytes: number;
  db_limit_bytes: number;
  storage_bytes: number;
  storage_limit_bytes: number;
  tables: { name: string; bytes: number }[];
  quota: {
    egress_bytes?: number;
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

function toneFor(pct: number): "ok" | "warn" | "err" {
  if (pct >= SAFE_PCT) return "err";
  if (pct >= SAFE_PCT - 15) return "warn";
  return "ok";
}

function QuotaBar({ label, used, limit, suffix }: {
  label: string; used: number; limit: number; suffix?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = toneFor(pct);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
        <span className="hud-label" style={{ color: "var(--text-muted)" }}>{label}</span>
        {suffix ? <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{suffix}</span> : null}
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", color: "var(--text)" }}>
          {human(used)} / {human(limit)}
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
  const [busy, setBusy] = useState<null | "clean" | "archive">(null);
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

  const dbBytes = report?.db_bytes != null ? Number(report.db_bytes) : 0;
  const dbLimit = report?.db_limit_bytes != null ? Number(report.db_limit_bytes) : 500 * 1024 * 1024;
  const storeBytes = report?.storage_bytes != null ? Number(report.storage_bytes) : 0;
  const storeLimit = report?.storage_limit_bytes != null ? Number(report.storage_limit_bytes) : 1024 ** 3;
  const dbPct = dbLimit > 0 ? Math.round((dbBytes / dbLimit) * 100) : 0;
  const storePct = storeLimit > 0 ? Math.round((storeBytes / storeLimit) * 100) : 0;
  const worst = Math.max(dbPct, storePct);
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
          <Btn size="sm" onClick={archiveNow} disabled={busy !== null}>
            <Archive size={11} style={{ marginRight: 4 }} />{busy === "archive" ? "archiving…" : "Archive"}
          </Btn>
          <Btn size="sm" onClick={runNow} disabled={busy !== null}>
            <Trash2 size={11} style={{ marginRight: 4 }} />{busy === "clean" ? "cleaning…" : "Clean"}
          </Btn>
        </span>
      }
    >
      <QuotaBar label="Database" used={dbBytes} limit={dbLimit} />
      <QuotaBar
        label="File storage"
        used={storeBytes}
        limit={storeLimit}
        suffix={coverage ? `${coverage.archived_bars.toLocaleString()} bars archived` : undefined}
      />

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
