// Syncs investment_nav_cache from AMFI's public daily NAV feed
// (https://www.amfiindia.com/spages/NAVAll.txt — free, keyless, no stated
// prohibition on programmatic personal use) and re-prices any
// investment_holdings rows whose symbol_or_scheme_code matches a scheme in
// the feed. Deliberately on-demand only (no pg_cron dependency — matches
// this repo's existing policy of client/edge-invoked periodic sync, see
// 20260710082821_...sql) — the caller is a "sync now" button plus an
// opportunistic re-sync when the Investments page loads and the cache looks
// stale.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";
const syncLimiter = createSlidingWindowLimiter(1, 60 * 60_000); // 1/hour/user

interface AmfiRow {
  scheme_code: string;
  scheme_name: string;
  nav: number;
  nav_date: string; // YYYY-MM-DD
}

function toIsoDate(raw: string): string | null {
  // AMFI dates look like "10-Jul-2026"
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const mon = months[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

// AMFI's flat file interleaves AMC-name header lines (no semicolons) between
// blocks of "Scheme Code;ISIN Growth;ISIN Reinvest;Scheme Name;NAV;Date" rows
// with a column-header line per block. Rather than track AMC section state,
// just keep any line with exactly 6 semicolon fields where the NAV field is
// numeric — cheap and robust to AMFI's formatting quirks.
function parseAmfiFeed(text: string): AmfiRow[] {
  const rows: AmfiRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(";");
    if (fields.length !== 6) continue;
    const [schemeCode, , , schemeName, navRaw, dateRaw] = fields;
    if (!schemeCode?.trim() || schemeCode.trim().toLowerCase() === "scheme code") continue;
    const nav = Number(navRaw.trim());
    if (!Number.isFinite(nav) || nav <= 0) continue;
    const navDate = toIsoDate(dateRaw);
    if (!navDate) continue;
    rows.push({ scheme_code: schemeCode.trim(), scheme_name: schemeName.trim(), nav, nav_date: navDate });
  }
  return rows;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  const rl = syncLimiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const res = await fetch(AMFI_URL);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "amfi_unreachable", status: res.status }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const text = await res.text();
    const rows = parseAmfiFeed(text);
    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "amfi_feed_unparseable" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Batch upsert in chunks — the feed has ~25k+ scheme rows.
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
      const { error } = await supabase.from("investment_nav_cache").upsert(chunk, { onConflict: "scheme_code" });
      if (error) throw error;
    }

    // Re-price this user's mutual fund holdings against the freshly-synced cache.
    const navByCode = new Map(rows.map((r) => [r.scheme_code, r]));
    const { data: holdings } = await supabase.from("investment_holdings")
      .select("id, symbol_or_scheme_code, units")
      .eq("user_id", uid).eq("asset_type", "mutual_fund")
      .not("symbol_or_scheme_code", "is", null);
    let repriced = 0;
    for (const h of holdings ?? []) {
      const nav = navByCode.get(h.symbol_or_scheme_code);
      if (!nav) continue;
      const units = Number(h.units) || 0;
      await supabase.from("investment_holdings").update({
        current_price: nav.nav,
        current_price_updated_at: new Date().toISOString(),
        current_price_source: "amfi",
        current_value: units * nav.nav,
      }).eq("id", h.id);
      repriced++;
    }

    return new Response(JSON.stringify({ ok: true, schemesSynced: rows.length, holdingsRepriced: repriced }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "NAV sync failed", "finance-sync-nav", cors);
  }
});
