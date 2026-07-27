// market-kotak-probe — TEMPORARY diagnostic. Admin-only.
// Every kotak_neo getQuotes call is failing with "401 unauthorised" while the
// stored session looks valid. This probes the header/route matrix against the
// live system session and reports raw status + body for each combination so
// the fix is based on evidence, not a guess.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";

const NEO_FIN_KEY = "neotradeapi";

async function dec(encJson: string | null): Promise<string | null> {
  if (!encJson) return null;
  try { return await decryptStatementPassword(JSON.parse(encJson) as StatementPasswordRule); }
  catch { return null; }
}

async function probe(url: string, headers: Record<string, string>) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { accept: "application/json", ...headers } });
    const text = await r.text();
    return { url, headers: Object.keys(headers), status: r.status, ms: Date.now() - t0, body: text.replace(/\s+/g, " ").slice(0, 300) };
  } catch (e) {
    return { url, headers: Object.keys(headers), status: 0, ms: Date.now() - t0, body: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    // Auth: admin JWT, the market cron secret, or the temporary probe key
    // (diagnostics run without a browser session).
    const cronSecret = req.headers.get("x-cron-secret");
    const probeKey = req.headers.get("x-probe-key");
    const expectedProbe = Deno.env.get("KOTAK_PROBE_KEY") ?? "";
    let allowed = !!probeKey && !!expectedProbe && probeKey === expectedProbe;
    if (!allowed && cronSecret) {
      const { data: ok } = await svc.rpc("verify_market_cron_secret", { _secret: cronSecret });
      allowed = ok === true;
    }

    if (!allowed) {
      const auth = await requireUserId(req);
      if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
      const { data: role } = await svc.from("user_roles").select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle();
      if (!role) return errorResponse(req, "admin only", 403);
    }



    const { data: s } = await svc
      .from("market_api_settings")
      .select("id,consumer_key,base_url,sid,hs_server_id,session_token_enc,view_token_enc,ucc,connection_status,token_expires_at")
      .eq("is_system", true).maybeSingle();
    if (!s) return errorResponse(req, "no system feed row", 404);

    const editToken = await dec(s.session_token_enc as string | null);
    const viewToken = await dec(s.view_token_enc as string | null);
    const base = String(s.base_url ?? "").replace(/\/+$/, "");
    const sid = String(s.sid ?? "");
    const serverId = String(s.hs_server_id ?? "");
    if (!editToken || !base || !sid) return errorResponse(req, "system session incomplete", 400);

    // Known-good NSE cash token for the probe (defaults to RELIANCE).
    const body = await req.json().catch(() => ({}));
    const symbol = String(body?.symbol ?? "RELIANCE");
    const { data: stock } = await svc.from("market_stocks")
      .select("symbol,token,kotak_segment").eq("symbol", symbol).eq("exchange", "NSE").maybeSingle();
    if (!stock?.token) return errorResponse(req, `no instrument token for ${symbol}`, 404);
    const neo = `${stock.kotak_segment || "nse_cm"}|${stock.token}`;
    const enc = encodeURIComponent(neo);

    const headerVariants: Array<{ name: string; h: Record<string, string> }> = [
      { name: "current(Auth+Sid)", h: { Auth: editToken, Sid: sid } },
      { name: "+neo-fin-key", h: { Auth: editToken, Sid: sid, "neo-fin-key": NEO_FIN_KEY } },
      { name: "+Authorization(ck)", h: { Auth: editToken, Sid: sid, Authorization: String(s.consumer_key ?? "") } },
      { name: "+Bearer(edit)", h: { Auth: editToken, Sid: sid, Authorization: `Bearer ${editToken}` } },
      { name: "all(ck+finkey)", h: { Auth: editToken, Sid: sid, Authorization: String(s.consumer_key ?? ""), "neo-fin-key": NEO_FIN_KEY } },
      { name: "all(Bearer+finkey)", h: { Auth: editToken, Sid: sid, Authorization: `Bearer ${editToken}`, "neo-fin-key": NEO_FIN_KEY } },
      ...(viewToken ? [{ name: "viewToken+finkey", h: { Auth: viewToken, Sid: sid, "neo-fin-key": NEO_FIN_KEY } }] : []),
    ];

    const sIdQs = serverId ? `?sId=${encodeURIComponent(serverId)}` : "";
    const mode = String(body?.mode ?? "quotes");
    const routes = mode === "history" ? [] : [
      `${base}/script-details/1.0/quotes/neosymbol/${enc}/all`,
      `${base}/script-details/1.0/quotes/neosymbol/${enc}/ltp`,
      `${base}/script-details/1.0/quotes/neosymbol/${enc}/all${sIdQs}`,
      `${base}/quotes/v1/neosymbol/${enc}/all`,
      `${base}/Orders/2.0/quick/user/positions${sIdQs}`,
      `${base}/portfolio/v1/holdings`,
    ];


    const results: unknown[] = [];
    for (const route of routes) {
      for (const v of headerVariants) {
        const r = await probe(route, v.h);
        results.push({ variant: v.name, ...r });
        // Short-circuit the header sweep for a route once one variant works.
        if (r.status === 200) break;
      }
    }

    if (mode === "history") {
      const full: Record<string, string> = {
        Auth: editToken, Sid: sid,
        Authorization: String(s.consumer_key ?? ""),
        "neo-fin-key": NEO_FIN_KEY,
      };
      const to = Math.floor(Date.now() / 1000);
      const from = to - 7 * 86400;
      const tok = String(stock.token);
      const seg = stock.kotak_segment || "nse_cm";
      const attempts: Array<{ name: string; url: string; init: RequestInit }> = [
        { name: "POST /charts/v2/history", url: `${base}/charts/v2/history`, init: { method: "POST", headers: { ...full, "Content-Type": "application/json" }, body: JSON.stringify({ exch: "NSE", token: tok, fromDate: String(from), toDate: String(to), interval: "5" }) } },
        { name: "GET /charts/v2/{seg}/{tok}", url: `${base}/charts/v2/${seg}/${tok}?fromDate=${from}&toDate=${to}&interval=5`, init: { headers: full } },
        { name: "GET /charts/v2/nse_cm/{tok}?sId", url: `${base}/charts/v2/${seg}/${tok}?fromDate=${from}&toDate=${to}&interval=5&sId=${serverId}`, init: { headers: full } },
        { name: "POST /charts/v2/{seg}", url: `${base}/charts/v2/${seg}`, init: { method: "POST", headers: { ...full, "Content-Type": "application/json" }, body: JSON.stringify({ instrument_token: tok, from_date: from, to_date: to, interval: "5" }) } },
        { name: "GET /chart/v2/{seg}/{tok}", url: `${base}/chart/v2/${seg}/${tok}?fromDate=${from}&toDate=${to}&interval=5`, init: { headers: full } },
        { name: "GET /charts/v1/{seg}/{tok}", url: `${base}/charts/v1/${seg}/${tok}?fromDate=${from}&toDate=${to}&interval=5`, init: { headers: full } },
        { name: "GET chart-api", url: `https://gw-napi.kotaksecurities.com/charts/v2/${seg}/${tok}?fromDate=${from}&toDate=${to}&interval=5`, init: { headers: full } },
      ];
      for (const a of attempts) {
        const t0 = Date.now();
        try {
          const r = await fetch(a.url, a.init);
          const text = await r.text();
          results.push({ variant: a.name, url: a.url, status: r.status, ms: Date.now() - t0, body: text.replace(/\s+/g, " ").slice(0, 300) });
        } catch (e) {
          results.push({ variant: a.name, url: a.url, status: 0, ms: Date.now() - t0, body: e instanceof Error ? e.message : String(e) });
        }
      }
    }


    return jsonResponse(req, {
      session: {
        base, serverId, sid_len: sid.length, token_len: editToken.length,
        connection_status: s.connection_status, token_expires_at: s.token_expires_at, ucc: s.ucc,
      },
      probe_symbol: { symbol, neo },
      results,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
