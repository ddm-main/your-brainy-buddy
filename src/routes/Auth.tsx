import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function Auth() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setInfo("Account created. Check your email to confirm, then sign in.");
        }
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <form onSubmit={submit} style={{
        width: 380, padding: 28,
        border: "1px solid var(--edge-strong)",
        background: "var(--panel-tint-strong)",
        backdropFilter: "blur(20px)",
        borderRadius: 4,
        display: "flex", flexDirection: "column", gap: 16,
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{
            fontFamily: "var(--font-display)", fontWeight: 700,
            letterSpacing: "0.28em", fontSize: 16, color: "var(--text)",
          }}>J.A.R.V.I.S</span>
          <span className="hud-label" style={{ fontSize: 9, letterSpacing: "0.24em" }}>
            {mode === "signin" ? "identity verification required" : "register new operator"}
          </span>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="hud-label" style={{ fontSize: 9 }}>email</span>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="hud-label" style={{ fontSize: 9 }}>password</span>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            style={inputStyle}
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="focus-outline"
          style={{
            padding: "10px 14px",
            background: "rgba(53, 214, 237, 0.08)",
            border: "1px solid var(--edge-strong)",
            color: "var(--accent)",
            fontFamily: "var(--font-hud)",
            fontSize: 11,
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            cursor: busy ? "wait" : "pointer",
            borderRadius: 2,
          }}
        >
          {busy ? "authenticating…" : mode === "signin" ? "sign in" : "create account"}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setErr(null); setInfo(null); }}
          style={{
            background: "transparent", border: "none",
            color: "var(--text-dim)", fontSize: 11,
            cursor: "pointer", textAlign: "center",
            fontFamily: "var(--font-hud)", letterSpacing: "0.18em", textTransform: "uppercase",
          }}
        >
          {mode === "signin" ? "need an account? register" : "have an account? sign in"}
        </button>

        {mode === "signin" && (
          <button
            type="button"
            onClick={async () => {
              if (!email.trim()) { setErr("Enter your email first."); return; }
              setBusy(true); setErr(null);
              try {
                const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
                  redirectTo: `${window.location.origin}/reset-password`,
                });
                if (error) throw error;
                setInfo("Password reset link sent. Check your inbox.");
              } catch (e: any) { setErr(e?.message ?? String(e)); }
              finally { setBusy(false); }
            }}
            style={{
              background: "transparent", border: "none",
              color: "var(--text-dim)", fontSize: 10,
              cursor: "pointer", textAlign: "center",
              fontFamily: "var(--font-hud)", letterSpacing: "0.18em", textTransform: "uppercase",
            }}
          >
            forgot password?
          </button>
        )}

        {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
        {info && <div style={{ fontSize: 12, color: "var(--accent)" }}>{info}</div>}
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--edge)",
  color: "var(--text)",
  padding: "10px 12px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 13,
  borderRadius: 2,
  outline: "none",
};
