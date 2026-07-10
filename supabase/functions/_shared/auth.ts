// Validates the caller's Supabase JWT and returns the user id.
// Rejects anon tokens (publishable key) — sub must be present.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export async function requireUserId(req: Request): Promise<
  { userId: string } | { error: Response }
> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { error: json({ error: "unauthorized" }, 401) };
  }
  const token = authHeader.slice(7).trim();
  if (!token) return { error: json({ error: "unauthorized" }, 401) };

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  const sub = (data?.claims as any)?.sub as string | undefined;
  if (error || !sub) {
    return { error: json({ error: "unauthorized" }, 401) };
  }
  return { userId: sub };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
