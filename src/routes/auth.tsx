import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import jarvisOrb from "@/assets/jarvis-orb.png";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/" });
    });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background hud-grid p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <img
            src={jarvisOrb}
            alt="JARVIS"
            width={96}
            height={96}
            className="jarvis-glow"
          />
          <h1 className="mt-6 text-3xl font-bold tracking-[0.3em] text-primary font-orbitron">
            J.A.R.V.I.S.
          </h1>
          <p className="mt-2 text-xs uppercase tracking-widest text-muted-foreground font-orbitron">
            Just A Rather Very Intelligent System
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-primary/30 bg-card/60 backdrop-blur p-6 space-y-4"
        >
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-widest text-muted-foreground font-orbitron">
              Email
            </label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tony@stark.industries"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-widest text-muted-foreground font-orbitron">
              Password
            </label>
            <Input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "..." : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="w-full text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            {mode === "signin"
              ? "No account yet? Sign up, sir."
              : "Already have an account? Sign in."}
          </button>
        </form>
      </div>
    </div>
  );
}
