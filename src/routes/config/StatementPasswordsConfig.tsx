import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { db } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { Eye, EyeOff, Copy } from "lucide-react";

type Row = { type: "card" | "account"; id: string; label: string; bank: string | null; mask: string | null; password: string | null };

export default function StatementPasswordsConfig() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const push = useUi((s) => s.push);

  useEffect(() => {
    (async () => {
      try { setRows(await db.statements.listPasswords()); }
      catch (e: any) { push(e?.message ?? "failed to load", "err"); setRows([]); }
      finally { setLoading(false); }
    })();
  }, [push]);

  const copy = async (pwd: string | null) => {
    if (!pwd) return;
    try { await navigator.clipboard.writeText(pwd); push("Password copied", "ok"); }
    catch { push("Copy failed", "err"); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel
        title="Statement PDF Passwords"
        index="PWD"
        live={loading ? "warn" : "ok"}
        style={{ flex: 1, minHeight: 0 }}
        bodyClass="overflow-auto"
        actions={
          <Btn size="sm" onClick={() => setShowAll((v) => !v)} disabled={!rows?.length}>
            {showAll ? "hide all" : "show all"}
          </Btn>
        }
      >
        {loading ? (
          <div className="hud-label">loading…</div>
        ) : !rows || rows.length === 0 ? (
          <EmptyState>no saved passwords yet — set one from a card or account</EmptyState>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {rows.map((r) => {
              const key = `${r.type}:${r.id}`;
              const show = showAll || revealed[key];
              return (
                <div key={key} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", padding: "10px 12px", border: "1px solid var(--edge)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 14 }}>{r.label}</div>
                      <Chip>{r.type}</Chip>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                      {r.bank ?? "no bank"} {r.mask ? `· ${r.mask}` : ""}
                    </div>
                    <div style={{ marginTop: 6, fontFamily: "var(--font-mono, monospace)", fontSize: 13, letterSpacing: show ? 0 : "0.2em", color: r.password ? "var(--text)" : "var(--warn)" }}>
                      {r.password == null ? "decrypt failed" : show ? r.password : "•".repeat(Math.min(r.password.length, 12))}
                    </div>
                  </div>
                  <button
                    title={show ? "hide" : "show"}
                    onClick={() => setRevealed((s) => ({ ...s, [key]: !s[key] }))}
                    style={{ background: "none", border: "1px solid var(--edge)", padding: "6px 8px", color: "var(--text-muted)", cursor: "pointer" }}
                  >
                    {show ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    title="copy"
                    disabled={!r.password}
                    onClick={() => copy(r.password)}
                    style={{ background: "none", border: "1px solid var(--edge)", padding: "6px 8px", color: "var(--text-muted)", cursor: r.password ? "pointer" : "not-allowed", opacity: r.password ? 1 : 0.4 }}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </HudPanel>
    </div>
  );
}
