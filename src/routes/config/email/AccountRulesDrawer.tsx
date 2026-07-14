import { useEffect, useState } from "react";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type EmailAccount } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { X } from "lucide-react";

const FINANCE_DOMAINS = [
  "hdfcbank.net","hdfcbank.com","icicibank.com","axisbank.com","sbi.co.in","kotak.com",
  "chase.com","bankofamerica.com","paypal.com","stripe.com","razorpay.com",
];

function buildQueryPreview(a: Partial<EmailAccount> & Record<string, any>): string {
  const days = Math.max(1, Math.min(365, Number(a.sync_period_days ?? 30)));
  const parts = [`newer_than:${days}d`, `in:inbox`];
  const financeMode = !!a.finance_only || a.use_case === "finance";
  if (financeMode) {
    const extra = String(a.finance_sender_filter ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const all = Array.from(new Set([...FINANCE_DOMAINS, ...extra]));
    if (all.length) parts.push(`from:(${all.join(" OR ")})`);
  }
  return parts.join(" ");
}

export default function AccountRulesDrawer({
  account, onClose, onSaved,
}: {
  account: EmailAccount;
  onClose: () => void;
  onSaved: (a: EmailAccount) => void;
}) {
  const push = useUi((s) => s.push);
  const [draft, setDraft] = useState<any>(account);
  const [saving, setSaving] = useState<string | null>(null);
  const [permDirty, setPermDirty] = useState(false);

  useEffect(() => { setDraft(account); setPermDirty(false); }, [account.id]);

  const patch = async (key: string, value: any) => {
    const prev = (draft as any)[key];
    setDraft((d: any) => ({ ...d, [key]: value }));
    setSaving(key);
    try {
      const updated = await db.emailAccounts.update(account.id, { [key]: value });
      onSaved(updated as EmailAccount);
      if (key === "permission_level") {
        // Show the "reconnect required" hint only while the saved level
        // differs from the mailbox's original permission_level. Reverting
        // back or reconnecting elsewhere clears the hint on next open.
        setPermDirty(value !== account.permission_level);
      }
    } catch (e: any) {
      setDraft((d: any) => ({ ...d, [key]: prev }));
      push(e?.message ?? "save failed", "err");
    } finally { setSaving(null); }
  };

  const isPaused = !!draft.paused_at;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100,
      display: "flex", justifyContent: "flex-end",
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, 100%)", height: "100%",
          background: "var(--bg, #0b1117)",
          borderLeft: "1px solid var(--edge-strong)",
          padding: 16, overflow: "auto",
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11 }}>rules</div>
          <div style={{ fontSize: 13, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.email_address}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}><X size={16} /></button>
        </div>

        <Section title="Sync">
          <Row label="frequency">
            <select value={draft.sync_frequency ?? "manual"} onChange={(e) => patch("sync_frequency", e.target.value)} style={inputStyle}>
              <option value="manual">manual</option>
              <option value="15m">every 15 min</option>
              <option value="hourly">hourly</option>
              <option value="6h">every 6 h</option>
              <option value="daily">daily</option>
            </select>
          </Row>
          <Row label="period (days back)">
            <select value={draft.sync_period_days ?? 30} onChange={(e) => patch("sync_period_days", Number(e.target.value))} style={inputStyle}>
              {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Row>
          <Row label="max per sync">
            <select value={draft.max_per_sync ?? 100} onChange={(e) => patch("max_per_sync", Number(e.target.value))} style={inputStyle}>
              {[25, 50, 100, 250, 500].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Row>
          <Row label={isPaused ? "paused" : "active"}>
            <Btn size="sm" variant={isPaused ? "primary" : "ghost"}
              onClick={() => patch("paused_at", isPaused ? null : new Date().toISOString())}>
              {saving === "paused_at" ? "…" : isPaused ? "resume" : "pause"}
            </Btn>
          </Row>
        </Section>

        <Section title="Purpose">
          <Row label="use case">
            <select value={draft.use_case ?? "general"} onChange={(e) => patch("use_case", e.target.value)} style={inputStyle}>
              <option value="general">general</option>
              <option value="finance">finance</option>
              <option value="work">work</option>
              <option value="personal">personal</option>
            </select>
          </Row>
          <Row label="finance only">
            <input type="checkbox" checked={!!draft.finance_only} onChange={(e) => patch("finance_only", e.target.checked)} />
          </Row>
          <div>
            <label style={labelStyle}>extra sender domains (comma-separated)</label>
            <textarea
              value={draft.finance_sender_filter ?? ""}
              onChange={(e) => setDraft((d: any) => ({ ...d, finance_sender_filter: e.target.value }))}
              onBlur={(e) => e.target.value !== (account.finance_sender_filter ?? "") && patch("finance_sender_filter", e.target.value || null)}
              rows={2}
              style={{ ...inputStyle, width: "100%", borderBottom: "1px solid var(--edge)", padding: 6, fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}
              placeholder="acme.com, mybank.co"
            />
          </div>
        </Section>

        <Section title="Permissions">
          <Row label="access level">
            <select value={draft.permission_level ?? "read"} onChange={(e) => patch("permission_level", e.target.value)} style={inputStyle}>
              <option value="read">read</option>
              <option value="read_write">read + modify</option>
            </select>
          </Row>
          {permDirty && (
            <div style={{ fontSize: 11, color: "var(--warn, #e0a458)", marginTop: -6, display: "flex", gap: 8, alignItems: "center" }}>
              <span>→ reconnect required for scope change to take effect</span>
              <button
                type="button"
                onClick={() => setPermDirty(false)}
                style={{ background: "none", border: "1px solid var(--edge)", color: "var(--text-muted)", padding: "1px 6px", cursor: "pointer", fontSize: 10 }}
              >dismiss</button>
            </div>
          )}
        </Section>

        <Section title="Automation">
          <Row label="auto-categorize">
            <input type="checkbox" checked={draft.auto_categorize ?? true} onChange={(e) => patch("auto_categorize", e.target.checked)} />
          </Row>
          <Row label="notify on new">
            <input type="checkbox" checked={!!draft.notify_on_new} onChange={(e) => patch("notify_on_new", e.target.checked)} />
          </Row>
        </Section>

        <Section title="Effective query">
          <pre style={{
            fontSize: 11, padding: 8, border: "1px solid var(--edge)",
            background: "rgba(0,0,0,0.2)", whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: "var(--font-mono, monospace)", color: "var(--text-dim, var(--text))",
            maxHeight: 120, overflow: "auto",
          }}>{buildQueryPreview(draft)}</pre>
        </Section>

        {saving && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>saving {saving}…</div>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 10, borderBottom: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ color: "var(--accent-soft)", fontSize: 10 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 8 }}>
      <label style={labelStyle}>{label}</label>
      <div>{children}</div>
    </div>
  );
}