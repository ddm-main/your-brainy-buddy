import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function Auth() {
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
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="auth-stage">
      <div className="auth-scan" aria-hidden />
      <form onSubmit={submit} className="auth-card hud-panel">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />

        <div className="auth-reactor" aria-hidden>
          <span className="auth-reactor-ring r1" />
          <span className="auth-reactor-ring r2" />
          <span className="auth-reactor-core" />
        </div>

        <div className="auth-title-block">
          <h1 className="auth-title">J.A.R.V.I.S</h1>
          <span className="auth-subtitle">Identity Verification Required</span>
        </div>

        <label className="auth-field">
          <span className="auth-label">Email</span>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="auth-input"
          />
        </label>

        <label className="auth-field">
          <span className="auth-label">Password</span>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="auth-input"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="auth-submit focus-outline"
        >
          <span>{busy ? "Authenticating…" : "Sign In"}</span>
        </button>


        {err && <div className="auth-msg auth-msg-err">{err}</div>}
        {info && <div className="auth-msg auth-msg-info">{info}</div>}
      </form>
    </div>
  );
}
