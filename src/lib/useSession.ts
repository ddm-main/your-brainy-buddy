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

/**
 * EGRESS: `supabase.auth.getUser()` is a network round-trip to /auth/v1/user
 * on every call — with a dozen call sites firing on mount and on every mutation
 * it was a measurable slice of the project's Auth egress. The session in local
 * storage already carries a verified user id, and every write these call sites
 * guard is enforced server-side by RLS anyway, so read it locally.
 */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}
