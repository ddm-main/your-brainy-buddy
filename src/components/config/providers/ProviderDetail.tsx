// Provider detail — what a single provider actually supplies, whether each
// feed is live right now, who really served it (Kotak vs Yahoo fallback),
// how fresh the stored data is, and which screens consume it.
import { useMemo } from "react";
import { Link } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { ArrowLeft, KeyRound, Settings2, TestTube2 } from "lucide-react";
import { PROVIDERS, type ProviderId, type Feed } from "./feedCatalog";
import { ago, clean, type CredRow, type HealthRow } from "./providerUtils";
import {
  useFeedFreshness, useSurfaceProbes, canonicalProviderId, freshKey, isProbeStale,
  type SurfaceProbe,
} from "@/lib/market/selftest";
import { nseClockOpen, useMarketHoliday } from "@/lib/market/feedStatus";
import HealthSparkline from "./HealthSparkline";


type Tone = "ok" | "warn" | "err" | "neutral" | "accent";

function freshnessTone(iso: string | null): { tone: Tone; label: string } {
  if (!iso) return { tone: "warn", label: "no data" };
  const age = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(age)) return { tone: "warn", label: "unknown" };
  const hours = age / 3_600_000;
  if (hours <= 26) return { tone: "ok", label: "flowing" };
  if (hours <= 24 * 7) return { tone: "warn", label: "stale" };
  return { tone: "err", label: "cold" };
}

/** Older probe payloads embedded the source in the text ("… via kotak"). */
function sourceFrom(detail: string | undefined, fallback: string): string {
  if (!detail) return fallback;
  const m = detail.match(/(?:via|source=)\s*([a-z_]+)/i);
  return m ? m[1] : fallback;
}

/** Does this probe source belong to the provider whose page is open? */
function isOwnSource(id: ProviderId, source: string): boolean {
  const s = source.toLowerCase();
  if (id === "kotak_neo") return s === "kotak" || s === "kotak_neo";
  if (id === "shoonya") return s === "shoonya" || s === "noren" || s === "finvasia";
  return s === id;
}


// RLS-scoped to the signed-in account: an empty read means "you have no rows",
// not "the pipeline is dead".
const USER_SCOPED_TABLES = new Set(["market_holdings", "market_positions", "market_funds"]);

const cell: React.CSSProperties = { padding: "5px 8px", verticalAlign: "top", borderBottom: "1px solid var(--edge)" };
const head: React.CSSProperties = {
  ...cell, fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.14em",
  textTransform: "uppercase", color: "var(--text-muted)", textAlign: "left",
};

export default function ProviderDetail({
  id, cred, health, busy, onBack, onEdit, onTest, liveDetail,
}: {
  id: ProviderId;
  cred: CredRow | null;
  health: HealthRow[];
  busy: string | null;
  onBack: () => void;
  onEdit: (p: ProviderId) => void;
  onTest: (p: ProviderId) => void;
  liveDetail: { ok: boolean; detail: string | null; at: string } | null;
}) {
  const meta = PROVIDERS[id];
  const probeable = id === "kotak_neo" || id === "shoonya" || id === "yahoo";

  // Freshness of every table this catalog references — one RPC, and the same
  // shared query key/shape Feed Routing uses so neither can poison the other.
  const { data: freshness } = useFeedFreshness();

  // Stored probe results for THIS provider. Probing on mount used to fire a
  // live broker call per page view and reset on reload; the self-test (button
  // + cron) is the single writer now, so the page is instant and consistent.
  const { data: probeRows = [], isFetching: probing } = useSurfaceProbes("data");
  const { data: holiday = false } = useMarketHoliday();
  const sessionOpen = nseClockOpen() && !holiday;
  const surfaces = useMemo(() => {
    const mine: Record<string, SurfaceProbe> = {};
    for (const r of probeRows) {
      if (canonicalProviderId(r.provider) !== id) continue;
      const cur = mine[r.surface];
      if (!cur || r.checked_at > cur.checked_at) mine[r.surface] = r;
    }
    return mine;
  }, [probeRows, id]);

  const keySource = cred?.key_set ? `saved in app (${cred.key_hint ?? "••••"})` : meta.envName ? `edge secret ${meta.envName}` : null;


  const rowFor = (f: Feed) => {
    const fresh = f.table ? (freshness?.[freshKey(f.table)] ?? null) : null;
    // Rows are already scoped to this provider, so the source is never a
    // fallback artefact of the probe path the way it was when every page
    // probed the *active* provider.
    const probe = f.surface ? surfaces[f.surface] : undefined;

    let tone: Tone; let label: string; let source: string; let note: string | null = null;
    let checkedAt: string | null = null;

    if (probe) {
      checkedAt = probe.checked_at ?? null;
      note = clean(probe.detail ?? undefined);
      source = meta.name;
      const state = probe.state ?? (probe.ok ? "ok" : "failed");
      // A verdict that nobody refreshed is history, not status. Rendering a
      // day-old red "failed" chip as current health was pure misinformation.
      if (state !== "not_configured" && isProbeStale(probe.checked_at, sessionOpen)) {
        tone = "neutral"; label = "not checked";
        note = `last verdict ${probe.ok ? "ok" : state}${note ? ` · ${note}` : ""}`;
        return { f, tone, label, source, note, fresh, checkedAt };
      }
      if (state === "ok") { tone = "ok"; label = "live"; }
      else if (state === "degraded") { tone = "warn"; label = probe.ok ? "degraded" : "busy — retry"; }
      // A provider nobody connected has no health to report — showing it as a
      // red "failed" feed was the single biggest source of false alarms here.
      else if (state === "not_configured") { tone = "neutral"; label = "not configured"; }
      else { tone = "err"; label = "failed"; }
    } else if (f.table) {
      const ft = freshnessTone(fresh);
      tone = ft.tone; label = ft.label; source = f.table.name;
    } else {
      tone = "neutral"; label = probeable && f.surface ? "not probed" : "no cache";
      source = "—"; note = f.note ?? null;
    }


    return { f, tone, label, source, note, fresh, checkedAt };
  };


  // Admin Config shows only the shared data feed. Account surfaces live on the
  // user's own broker screen, where a session problem is actionable.
  const rows = meta.feeds.filter((f) => (f.scope ?? "data") === "data").map(rowFor);
  const bad = rows.some((r) => r.tone === "err");
  const warn = rows.some((r) => r.tone === "warn");

  return (
    <HudPanel
      title={meta.name}
      index="PRV"
      live={bad ? "err" : warn ? "warn" : "ok"}
      bodyClass="overflow-visible"
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Btn size="sm" onClick={onBack}><ArrowLeft size={11} style={{ marginRight: 4 }} />Back</Btn>
          <Btn size="sm" onClick={() => onEdit(id)} disabled={busy !== null}>
            {meta.edit === "kotak" || meta.edit === "broker" ? <KeyRound size={11} style={{ marginRight: 4 }} /> : <Settings2 size={11} style={{ marginRight: 4 }} />}
            Edit
          </Btn>
          <Btn size="sm" onClick={() => onTest(id)} disabled={busy !== null}>
            <TestTube2 size={11} style={{ marginRight: 4 }} />
            {busy === `test-${id}` || probing ? "testing…" : "Test all feeds"}
          </Btn>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.14em" }}>{meta.role}</span>
          {meta.primary && <Chip tone="accent">primary</Chip>}
          {meta.edit === "key" && <Chip tone={cred?.key_set ? "ok" : "warn"}>{cred?.key_set ? "key saved" : "using edge secret / unset"}</Chip>}
          {liveDetail && <Chip tone={liveDetail.ok ? "ok" : "err"}>{liveDetail.ok ? "probe ok" : "probe failed"} · {ago(liveDetail.at)}</Chip>}
        </div>

        <div style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>{meta.summary}</div>
        {keySource && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Key in effect: {keySource}</div>}
        {liveDetail?.detail && (
          <div style={{ fontSize: 10, color: liveDetail.ok ? "var(--text-muted)" : "var(--danger)" }}>{liveDetail.detail}</div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={head}>Feed</th>
                <th style={head}>Status</th>
                <th style={head}>Source</th>
                <th style={head}>Freshness</th>
                <th style={head}>Used by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ f, tone, label, source, note, fresh, checkedAt }) => (
                <tr key={f.id}>
                  <td style={cell}>
                    <div style={{ color: "var(--text)", fontFamily: "var(--font-hud)" }}>{f.label}</div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{f.desc}</div>
                    {note && <div style={{ fontSize: 10, color: tone === "err" ? "var(--danger)" : "var(--text-muted)", marginTop: 2 }}>{note}</div>}
                  </td>
                  <td style={cell}>
                    <Chip tone={tone}>{label}</Chip>
                    {checkedAt && <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>checked {ago(checkedAt)}</div>}
                  </td>
                  <td style={{ ...cell, color: "var(--text-dim)", fontSize: 10 }}>{source}</td>
                  <td style={{ ...cell, color: "var(--text-dim)", fontSize: 10 }}>
                    {f.table
                      ? (fresh ? ago(fresh) : (USER_SCOPED_TABLES.has(f.table.name) ? "no rows for this account" : "never"))
                      : "—"}
                    {f.table && <div style={{ color: "var(--text-muted)" }}>{f.table.name}</div>}
                  </td>

                  <td style={cell}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {f.usedBy.map((u) => (
                        <Link key={u.to + u.label} to={u.to} style={{ color: "var(--accent)", fontSize: 10, textDecoration: "none" }}>{u.label}</Link>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The sparkline already plots the same history with latency, so the
            old duplicate square-strip below it is gone. */}
        <HealthSparkline provider={id} />


      </div>
    </HudPanel>
  );
}
