// Shared helpers for market-* edge functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../cors.ts";
import { requireUserId } from "../auth.ts";

export { corsFor, preflight, requireUserId };

// Sentinel user_id for rows in per-user tables that are actually shared caches
// (e.g. Yahoo fundamentals, nightly AI recommendations). Not a real user;
// the RLS policies scope these tables to auth.uid() so authenticated users
// never see this sentinel row directly — edge functions read/write it via
// the service role.
export const SHARED_CACHE_USER_ID = "00000000-0000-0000-0000-000000000000";

export function svcClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}

export function errorResponse(req: Request, message: string, status = 400): Response {
  return jsonResponse(req, { error: message }, status);
}

// Yahoo helpers live in yahooClient.ts; re-exported for existing consumers.
export { yahooQuote } from "./yahooClient.ts";
