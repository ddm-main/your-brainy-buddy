// market-shoonya-probe — admin-only live check of the Shoonya (Noren) API.
//
// Logs in with the SHOONYA_* environment secrets and exercises each route the
// provider will depend on, reporting per-route ok/error. Read-only: it never
// places or modifies an order.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import {
  SHOONYA_BASE,
  SHOONYA_SETTINGS_COLS,
  persistShoonyaSession,
  shoonyaLoginWithCode,
  type ShoonyaSettings,
  shoonyaQuote,
  shoonyaIntradayCandles,
  shoonyaDailyCandles,
  shoonyaHoldings,
  shoonyaPositions,
  shoonyaLimits,
  shoonyaOrderBook,
  shoonyaSearchScrip,
  type ShoonyaCtx,
} from "../_shared/market/shoonyaClient.ts";
import { decryptStatementPassword, encryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";

const encrypt = async (v: string) => JSON.stringify(await encryptStatementPassword(v));

async function step(name: string, fn: () => Promise<unknown>, out: Record<string, unknown>) {
  try {
    const value = await fn();
    out[name] = { ok: true, sample: JSON.parse(JSON.stringify(value)) };
  } catch (e) {
    out[name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const svc = svcClient();
  const { data: admin } = await svc.from("user_roles")
    .select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle();
  if (!admin) return new Response("forbidden", { status: 403, headers: corsFor(req) });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const report: Record<string, unknown> = {};
  let ctx: ShoonyaCtx | null = null;

  // The probe rides the stored OAuth session, or exchanges a fresh
  // authorization code when one is supplied.
  const { data: rows } = await svc.from("market_api_settings")
    .select(SHOONYA_SETTINGS_COLS)
    .eq("user_id", auth.userId).eq("active_provider", "shoonya");
  const shRows = (rows ?? []) as unknown as ShoonyaSettings[];
  const settings = shRows.find((r) => !!r.api_secret_enc) ?? shRows[0];
  if (!settings) return errorResponse(req, "Shoonya is not configured for this user", 400);

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  try {
    if (code) {
      const sess = await shoonyaLoginWithCode(settings, code);
      await persistShoonyaSession(svc, settings, sess, encrypt);
      ctx = { base: SHOONYA_BASE, jKey: sess.token, uid: sess.uid, actid: sess.actid };
      report.login = { ok: true, via: "oauth_code", uid: sess.uid, actid: sess.actid };
    } else {
      const jKey = settings.session_token_enc
        ? await decryptStatementPassword(JSON.parse(settings.session_token_enc) as StatementPasswordRule)
        : null;
      if (!jKey) throw new Error("no stored Shoonya session — authorize first or pass { code }");
      const uid = (settings.ucc ?? "").trim();
      ctx = { base: SHOONYA_BASE, jKey, uid, actid: uid };
      report.login = { ok: true, via: "stored_session", uid };
    }
  } catch (e) {
    report.login = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!ctx?.jKey) return jsonResponse(req, { ok: false, report }, 200);

  const c = ctx;
  let token = String((body as any)?.token ?? "");
  await step("search_scrip", async () => {
    const rows = await shoonyaSearchScrip(c, "RELIANCE", "NSE");
    if (!token) token = String(rows.find((r: any) => /^RELIANCE-EQ$/i.test(r?.tsym))?.token ?? rows[0]?.token ?? "");
    return rows.slice(0, 3);
  }, report);

  if (token) {
    const now = Math.floor(Date.now() / 1000);
    await step("quote", () => shoonyaQuote(c, token, "NSE"), report);
    await step("intraday_5m", async () => {
      const bars = await shoonyaIntradayCandles(c, token, "NSE", "5", now - 5 * 86400, now);
      return { count: bars.length, first: bars[0], last: bars.at(-1) };
    }, report);
    await step("daily", async () => {
      const bars = await shoonyaDailyCandles(c, "RELIANCE", "NSE", now - 60 * 86400, now);
      return { count: bars.length, first: bars[0], last: bars.at(-1) };
    }, report);
  }

  await step("holdings", async () => {
    const h = await shoonyaHoldings(c);
    return { count: h.rows.length, first: h.rows[0] ?? null };
  }, report);
  await step("positions", async () => {
    const p = await shoonyaPositions(c);
    return { count: p.rows.length, realized: p.realized.length, first: p.rows[0] ?? null };
  }, report);
  await step("limits", () => shoonyaLimits(c), report);
  await step("orderbook", async () => ({ count: (await shoonyaOrderBook(c)).length }), report);

  return jsonResponse(req, { ok: true, token, report });
});