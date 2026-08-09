// AccountHealthPanel — health of the *user's own* broker connection: funds,
// holdings, positions and order placement. These surfaces are account-bound, so
// they are probed on the "account" plane and shown here rather than in Admin
// Config, where a personal session problem would wrongly look like a platform
// outage.
import { useMemo } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Chip } from "@/components/hud/HudControls";
import { PROVIDERS, type Feed, type ProviderId } from "@/components/config/providers/feedCatalog";
import { canonicalProviderId, isProbeStale, useSurfaceProbes, type SurfaceProbe } from "@/lib/market/selftest";
import { agoLabel, nseClockOpen, useMarketHoliday } from "@/lib/market/feedStatus";
import { clean } from "@/components/config/providers/providerUtils";

const BROKERS: ProviderId[] = ["kotak_neo", "shoonya"];

const cell: React.CSSProperties = { padding: "5px 8px", verticalAlign: "top", borderBottom: "1px solid var(--edge)" };
const head: React.CSSProperties = {
  ...cell, fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.14em",
  textTransform: "uppercase", color: "var(--text-muted)", textAlign: "left",
};

export default function AccountHealthPanel({ provider }: { provider?: ProviderId }) {
  const { data: probeRows = [] } = useSurfaceProbes("account");
  const { data: holiday = false } = useMarketHoliday();
  const sessionOpen = nseClockOpen() && !holiday;

  const brokers = provider ? [provider] : BROKERS;

  const bySurface = useMemo(() => {
    const out: Record<string, SurfaceProbe> = {};
    for (const r of probeRows) {
      const key = `${canonicalProviderId(r.provider)}|${r.surface}`;
      const cur = out[key];
      if (!cur || r.checked_at > cur.checked_at) out[key] = r;
    }
    return out;
  }, [probeRows]);

  const rows = brokers.flatMap((id) =>
    PROVIDERS[id].feeds
      .filter((f) => f.scope === "account")
      .map((f: Feed) => {
        const probe = f.surface ? bySurface[`${canonicalProviderId(id)}|${f.surface}`] : undefined;
        let tone: "ok" | "warn" | "err" | "neutral" = "neutral";
        let label = f.surface ? "not checked" : "write path";
        let note = f.note ?? null;
        if (probe) {
          note = clean(probe.detail ?? undefined) ?? note;
          const state = probe.state ?? (probe.ok ? "ok" : "failed");
          if (state === "not_configured") { tone = "neutral"; label = "not connected"; }
          else if (isProbeStale(probe.checked_at, sessionOpen)) { tone = "neutral"; label = "not checked"; }
          else if (state === "ok") { tone = "ok"; label = "ok"; }
          else if (state === "degraded") { tone = "warn"; label = "degraded"; }
          else { tone = "err"; label = "failed"; }
        }
        return { id, f, tone, label, note, checkedAt: probe?.checked_at ?? null };
      }),
  );

  const bad = rows.some((r) => r.tone === "err");
  const warn = rows.some((r) => r.tone === "warn");

  return (
    <HudPanel title="Account Health" index="ACH" live={bad ? "err" : warn ? "warn" : "ok"}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={head}>Surface</th>
              <th style={head}>Broker</th>
              <th style={head}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, f, tone, label, note, checkedAt }) => (
              <tr key={`${id}-${f.id}`}>
                <td style={cell}>
                  <div style={{ color: "var(--text)", fontFamily: "var(--font-hud)" }}>{f.label}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{f.desc}</div>
                </td>
                <td style={{ ...cell, color: "var(--text-dim)", fontSize: 10 }}>{PROVIDERS[id].name}</td>
                <td style={cell}>
                  <Chip tone={tone}>{label}</Chip>
                  {checkedAt && <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>checked {agoLabel(checkedAt)}</div>}
                  {note && <div style={{ fontSize: 10, color: tone === "err" ? "var(--danger)" : "var(--text-muted)", marginTop: 2 }}>{note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HudPanel>
  );
}
