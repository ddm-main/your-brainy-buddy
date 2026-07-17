// Shared helpers for market-* edge functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../cors.ts";
import { requireUserId } from "../auth.ts";

export { corsFor, preflight, requireUserId };

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

// Yahoo Finance quote fetch — no auth required. Used as fallback for indices.
export async function yahooQuote(symbols: string[]): Promise<Array<{ symbol: string; name: string; price: number; change_pct: number | null; change_abs: number | null }>> {
  if (symbols.length === 0) return [];
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return [];
    const j = await r.json();
    const rows = j?.quoteResponse?.result ?? [];
    return rows.map((q: any) => ({
      symbol: q.symbol,
      name: q.shortName ?? q.symbol,
      price: q.regularMarketPrice ?? 0,
      change_abs: q.regularMarketChange ?? null,
      change_pct: q.regularMarketChangePercent ?? null,
    }));
  } catch {
    return [];
  }
}
