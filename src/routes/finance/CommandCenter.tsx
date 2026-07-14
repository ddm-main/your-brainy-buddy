// Command Center — F3 real build. Adds a market strip and a quick-action
// rail (Detect / Reconcile / Rescan / Refresh market) over the existing
// rich Overview panel. Overview already renders health-score, KPIs,
// alerts, insights, budgets, upcoming bills, AI Take — we compose rather
// than duplicate so a single query graph feeds the whole surface.

import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { db } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { useFinanceSnapshot } from "@/lib/useFinanceSnapshot";
import { toSafeError } from "@/lib/errors";
import Overview from "@/routes/finance/Overview";
import { Activity, RefreshCw, Search, ShieldCheck } from "lucide-react";

type Quote = {
  symbol: string; name: string; kind: string; price: number;
  change_pct: number | null; currency: string;
};

function tone(pct: number | null): "ok" | "err" | "neutral" {
  if (pct == null) return "neutral";
  return pct > 0 ? "ok" : pct < 0 ? "err" : "neutral";
}
function pctStr(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export default function CommandCenter() {
  const push = useUi((s) => s.push);
  const { refresh } = useFinanceSnapshot();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [busy, setBusy] = useState<null | "market" | "detect" | "reconcile" | "rescan">(null);

  const loadQuotes = () =>
    db.finance.quotes().then((r) => setQuotes(r as unknown as Quote[])).catch(() => {});
  useEffect(() => { loadQuotes(); }, []);

  const run = async (kind: "market" | "detect" | "reconcile" | "rescan") => {
    setBusy(kind);
    try {
      if (kind === "market") {
        await db.finance.syncMarket(); await loadQuotes(); push("Market refreshed", "ok");
      } else if (kind === "detect") {
        const r = await db.finance.detect();
        push(`Detector: ${r.scanned} scanned, ${r.flagged} flagged`, r.flagged ? "warn" : "ok");
        await refresh();
      } else if (kind === "reconcile") {
        const r = await db.finance.reconcile();
        push(`Reconcile: ${r.new_alerts ?? 0} new alerts`, r.new_alerts ? "warn" : "ok");
        await refresh();
      } else if (kind === "rescan") {
        const j = await db.finance.extract({ since_days: 90, limit: 500 });
        push(`Extracted ${j.transactions ?? 0} txn, ${j.statements ?? 0} stmt`, "ok");
        await refresh();
      }
    } catch (e) {
      push(toSafeError(e, `${kind} failed`).message, "err");
    } finally { setBusy(null); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Market" index="F3.1" actions={
        <Btn onClick={() => run("market")} disabled={busy === "market"}>
          <RefreshCw size={12} style={{ marginRight: 4 }} /> Refresh
        </Btn>
      }>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 2px" }}>
          {quotes.length === 0 && (
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.16em", color: "var(--text-dim)" }}>
              NO CACHE — CLICK REFRESH
            </span>
          )}
          {quotes.map((q) => (
            <Chip key={q.symbol} tone={tone(q.change_pct)}>
              <span style={{ opacity: 0.75, marginRight: 6 }}>{q.name}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span style={{ marginLeft: 6, opacity: 0.9 }}>{pctStr(q.change_pct)}</span>
            </Chip>
          ))}
        </div>
      </HudPanel>

      <HudPanel title="Quick actions" index="F3.2">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => run("rescan")}    disabled={busy === "rescan"}>
            <RefreshCw size={12} style={{ marginRight: 6 }}/> Rescan email
          </Btn>
          <Btn onClick={() => run("detect")}    disabled={busy === "detect"}>
            <Search size={12} style={{ marginRight: 6 }}/> Detect &amp; classify
          </Btn>
          <Btn onClick={() => run("reconcile")} disabled={busy === "reconcile"}>
            <ShieldCheck size={12} style={{ marginRight: 6 }}/> Reconcile
          </Btn>
          <Btn onClick={() => run("market")}    disabled={busy === "market"}>
            <Activity size={12} style={{ marginRight: 6 }}/> Refresh market
          </Btn>
        </div>
      </HudPanel>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <Overview />
      </div>
    </div>
  );
}