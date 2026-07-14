import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/useSession";
import { useUi } from "@/store/uiStore";

interface Sugg {
  id: string;
  kind: string;
  payload: any;
  status: string;
  created_at: string;
}

/** Suggestions inbox — pending finance_suggestions rows (produced by
 * finance-detect). Accept/dismiss flip status to accepted/dismissed. */
export default function SuggestionsDrawer() {
  const push = useUi((s) => s.push);
  const { session } = useSession();
  const uid = session?.user.id;
  const [items, setItems] = useState<Sugg[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!uid) return;
    const client: any = supabase;
    const { data } = await client.from("finance_suggestions")
      .select("id, kind, payload, status, created_at")
      .eq("user_id", uid).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(20);
    setItems(data ?? []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [uid]);

  const decide = async (id: string, status: "accepted" | "dismissed") => {
    setBusy(id);
    try {
      const client: any = supabase;
      const { error } = await client.from("finance_suggestions").update({ status }).eq("id", id);
      if (error) throw error;
      setItems((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) { push(e?.message ?? "failed", "err"); }
    finally { setBusy(null); }
  };

  const summarize = (s: Sugg): string => {
    const p = s.payload ?? {};
    switch (s.kind) {
      case "salary": return `Detected salary: ${p.merchant} · ~${p.amount} on day ${p.avgDayOfMonth}`;
      case "investment": return `Detected investment: ${p.merchant} · ~${p.amount} × ${p.occurrences}`;
      case "duplicate": return `Duplicate: ${p.merchant} · ${p.amount}`;
      case "anomaly": return `Anomaly: ${p.merchant} · ${p.amount} (${p.detail ?? p.reason})`;
      case "subscription": return `Recurring: ${p.displayName ?? p.merchantKey} · ${p.amount} / ${p.cadence}`;
      case "category_rule": return `Rule: ${p.pattern} → ${p.category}`;
      default: return JSON.stringify(p).slice(0, 120);
    }
  };

  return (
    <HudPanel title="Suggestions" index="SGT" live={items.length ? "warn" : "ok"}
      actions={<Chip tone={items.length ? "warn" : "accent"}>{items.length} pending</Chip>}>
      {items.length === 0 ? (
        <EmptyState hint="run finance-detect nightly">nothing to review</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((s) => (
            <div key={s.id} style={{ padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <Chip tone="accent">{s.kind}</Chip>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{new Date(s.created_at).toLocaleDateString()}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6 }}>{summarize(s)}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="sm" variant="primary" disabled={busy === s.id} onClick={() => decide(s.id, "accepted")}>accept</Btn>
                <Btn size="sm" disabled={busy === s.id} onClick={() => decide(s.id, "dismissed")}>dismiss</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </HudPanel>
  );
}
