import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import HudPanel from "@/components/hud/HudPanel";
import { supabase } from "@/integrations/supabase/client";
import { ALL_SECTIONS, type AppSection } from "@/store/accessStore";
import { Trash2, Plus, Shield, User as UserIcon } from "lucide-react";

type Row = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  role: "admin" | "user";
  sections: AppSection[];
};

// Configurable via VITE_OWNER_USER_ID (see .env.example). Falls back to the
// original hardcoded owner id so existing deployments keep working.
const OWNER_ID = (import.meta.env.VITE_OWNER_USER_ID as string | undefined)?.trim()
  || "2ff4497a-dedc-4885-98e5-435b26894275";

async function call(action: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action, ...extra },
  });
  if (error) throw new Error(error.message);
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data;
}

export default function AdminConfig() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ email: string; password: string; role: "admin" | "user"; sections: Set<AppSection> } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setLoading(true); setErr(null);
    try {
      const d = await call("list") as { users: Row[] };
      setRows(d.users ?? []);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const toggleSection = (userId: string, sec: AppSection, current: AppSection[]) => async () => {
    const next = current.includes(sec) ? current.filter((s) => s !== sec) : [...current, sec];
    setBusy(true);
    try { await call("update_access", { user_id: userId, sections: next }); await refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const setRole = (userId: string, role: "admin" | "user") => async () => {
    setBusy(true);
    try { await call("update_role", { user_id: userId, role }); await refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const del = (userId: string, email: string | null) => async () => {
    if (!confirm(`Delete user ${email ?? userId}?`)) return;
    setBusy(true);
    try { await call("delete", { user_id: userId }); await refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const submitInvite = async () => {
    if (!invite) return;
    setBusy(true);
    try {
      await call("create", { email: invite.email, password: invite.password, role: invite.role, sections: Array.from(invite.sections) });
      setInvite(null); await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <HudPanel title="Admin · Users" index="ADM" live={err ? "err" : "ok"} bodyClass="overflow-auto">
      {err && <div style={{ color: "var(--danger)", marginBottom: 10, fontSize: 12 }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="hud-label">{loading ? "loading…" : `${rows.length} users`}</div>
        <button
          onClick={() => setInvite({ email: "", password: "", role: "user", sections: new Set(["market"]) })}
          className="focus-outline"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
            border: "1px solid var(--edge-strong)", background: "rgba(53,214,237,0.08)",
            color: "var(--accent)", fontFamily: "var(--font-hud)", fontSize: 11,
            letterSpacing: "0.16em", textTransform: "uppercase", cursor: "pointer", borderRadius: 2,
          }}
        >
          <Plus size={13} /> Create user
        </button>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((r) => {
          const owner = r.id === OWNER_ID;
          return (
            <div key={r.id} style={{
              border: "1px solid var(--edge)", padding: 12, borderRadius: 2,
              display: "grid", gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {r.role === "admin" ? <Shield size={14} color="var(--accent)" /> : <UserIcon size={14} color="var(--text-dim)" />}
                  <div style={{ fontSize: 13, color: "var(--text)" }}>{r.email ?? "(no email)"}</div>
                  {owner && <span className="hud-label" style={{ color: "var(--accent)" }}>owner</span>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    value={r.role}
                    disabled={owner || busy}
                    onChange={(e) => { void setRole(r.id, e.target.value as "admin" | "user")(); }}
                    style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--edge)", padding: "4px 8px", fontSize: 12 }}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    onClick={() => { void del(r.id, r.email)(); }}
                    disabled={owner || busy}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px",
                      background: "transparent", color: owner ? "var(--text-muted)" : "var(--danger)",
                      border: "1px solid var(--edge)", cursor: owner ? "not-allowed" : "pointer", fontSize: 11,
                    }}
                    title={owner ? "Cannot delete owner" : "Delete user"}
                  ><Trash2 size={12} /></button>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ALL_SECTIONS.map((s) => {
                  const on = r.sections.includes(s);
                  return (
                    <button
                      key={s}
                      disabled={busy}
                      onClick={() => { void toggleSection(r.id, s, r.sections)(); }}
                      style={{
                        padding: "4px 10px", border: `1px solid ${on ? "var(--edge-strong)" : "var(--edge)"}`,
                        background: on ? "rgba(53,214,237,0.08)" : "transparent",
                        color: on ? "var(--accent)" : "var(--text-dim)",
                        fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.14em",
                        textTransform: "uppercase", cursor: busy ? "wait" : "pointer", borderRadius: 2,
                      }}
                    >{s}</button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {invite && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 100,
        }}
          onClick={() => setInvite(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--panel)", border: "1px solid var(--edge-strong)",
              padding: 20, minWidth: 380, maxWidth: 480, display: "grid", gap: 12,
            }}
          >
            <div className="hud-label" style={{ color: "var(--accent)" }}>Create user</div>
            <input
              type="email" placeholder="email@example.com" autoFocus
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              style={{ background: "transparent", border: "1px solid var(--edge)", color: "var(--text)", padding: "8px 10px", fontSize: 13 }}
            />
            <input
              type="text" placeholder="password (min 8 chars)"
              value={invite.password}
              onChange={(e) => setInvite({ ...invite, password: e.target.value })}
              style={{ background: "transparent", border: "1px solid var(--edge)", color: "var(--text)", padding: "8px 10px", fontSize: 13, fontFamily: "var(--font-hud)" }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="hud-label">Role</span>
              <select
                value={invite.role}
                onChange={(e) => setInvite({ ...invite, role: e.target.value as "admin" | "user" })}
                style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--edge)", padding: "4px 8px", fontSize: 12 }}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div>
              <div className="hud-label" style={{ marginBottom: 6 }}>Sections</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ALL_SECTIONS.map((s) => {
                  const on = invite.sections.has(s);
                  return (
                    <button
                      key={s}
                      onClick={() => {
                        const next = new Set(invite.sections);
                        if (next.has(s)) next.delete(s); else next.add(s);
                        setInvite({ ...invite, sections: next });
                      }}
                      style={{
                        padding: "4px 10px", border: `1px solid ${on ? "var(--edge-strong)" : "var(--edge)"}`,
                        background: on ? "rgba(53,214,237,0.08)" : "transparent",
                        color: on ? "var(--accent)" : "var(--text-dim)",
                        fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.14em",
                        textTransform: "uppercase", cursor: "pointer", borderRadius: 2,
                      }}
                    >{s}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setInvite(null)} style={{
                padding: "6px 12px", background: "transparent", border: "1px solid var(--edge)",
                color: "var(--text-dim)", cursor: "pointer", fontSize: 12,
              }}>Cancel</button>
              <button onClick={submitInvite} disabled={busy || !invite.email || invite.password.length < 8}
                style={{
                  padding: "6px 12px", background: "rgba(53,214,237,0.08)",
                  border: "1px solid var(--edge-strong)", color: "var(--accent)",
                  cursor: busy ? "wait" : "pointer", fontSize: 12,
                }}>Create user</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </HudPanel>
  );
}
