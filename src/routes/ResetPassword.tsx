import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";

export default function ResetPassword() {
  const nav = useNavigate();
  const [recovery, setRecovery] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    // Supabase sends `#type=recovery&access_token=...` on password reset links.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (hash.get("type") === "recovery") setRecovery(true);

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setOk(true);
      setTimeout(() => nav("/", { replace: true }), 1500);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!recovery) {
    return (
      <div style={wrap}>
        <div style={card}>
          <span className="hud-label">invalid or expired reset link</span>
          <button onClick={() => nav("/", { replace: true })} style={btn}>return</button>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <form onSubmit={submit} style={card}>
        <span className="hud-label" style={{ fontSize: 9, letterSpacing: "0.24em" }}>set new password</span>
        <input
          type="password"
          required
          minLength={8}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="new password (min 8)"
          style={input}
        />
        <button type="submit" disabled={busy || ok} style={btn}>
          {ok ? "updated ✓" : busy ? "saving…" : "update password"}
        </button>
        {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
      </form>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
};
const card: React.CSSProperties = {
  width: 380, padding: 28, border: "1px solid var(--edge-strong)",
  background: "var(--panel-tint-strong)", backdropFilter: "blur(20px)",
  borderRadius: 4, display: "flex", flexDirection: "column", gap: 16,
};
const input: React.CSSProperties = {
  background: "transparent", border: "1px solid var(--edge)", color: "var(--text)",
  padding: "10px 12px", fontFamily: "var(--font-mono, monospace)", fontSize: 13,
  borderRadius: 2, outline: "none",
};
const btn: React.CSSProperties = {
  padding: "10px 14px", background: "rgba(53, 214, 237, 0.08)",
  border: "1px solid var(--edge-strong)", color: "var(--accent)",
  fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.24em",
  textTransform: "uppercase", cursor: "pointer", borderRadius: 2,
};
