import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bootTimeout = window.setTimeout(() => {
      if (cancelled) return;
      console.warn("[JARVIS] Supabase session boot timed out; showing auth shell.");
      setReady(true);
    }, 3500);

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (cancelled) return;
      setSession(s);
      setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setReady(true);
    }).catch((error) => {
      if (cancelled) return;
      console.warn("[JARVIS] Supabase session boot failed; showing auth shell.", error);
      setSession(null);
      setReady(true);
    }).finally(() => {
      window.clearTimeout(bootTimeout);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(bootTimeout);
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}
