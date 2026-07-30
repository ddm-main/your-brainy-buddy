// shoonya-oauth-callback — the Redirect URL registered in Shoonya PRISM.
//
// Shoonya sends the browser here with `?code=...` after the user finishes
// password + TOTP on Shoonya's own page. PRISM is sensitive about exact
// Redirect URLs, so the app origin is carried in the path, not a query string:
//   /functions/v1/shoonya-oauth-callback/<base64(app origin)>
// The callback then bounces the browser back to that app origin with the code.
const FALLBACK_ORIGIN = "https://id-preview--20eefbcb-c787-44d9-a5bf-bdcdd84e9b0d.lovable.app";
const ALLOWED_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(lovable\.app|lovableproject\.com)$/i;

function decodeOriginToken(encoded: string): string | null {
  if (!encoded) return null;
  try {
    const cleaned = decodeURIComponent(encoded).replace(/-/g, "+").replace(/_/g, "/");
    const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
}

function appOrigin(url: URL): string {
  const marker = "/shoonya-oauth-callback/";
  const encoded = url.pathname.includes(marker)
    ? url.pathname.split(marker)[1]?.split("/")[0]
    : (url.searchParams.get("state") ?? "");
  if (encoded) {
    try {
      const decoded = decodeOriginToken(encoded);
      if (!decoded) throw new Error("empty origin token");
      const origin = new URL(decoded).origin;
      if (origin === "http://localhost:8080" || ALLOWED_ORIGIN.test(origin)) return origin;
    } catch { /* fall through */ }
  }
  return Deno.env.get("APP_ORIGIN")?.trim() || FALLBACK_ORIGIN;
}

Deno.serve((req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? url.searchParams.get("request_token") ?? url.searchParams.get("shoonya_code");
  const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const to = new URL("/market/settings", appOrigin(url));
  if (code) to.searchParams.set("shoonya_code", code);
  else to.searchParams.set("shoonya_error", err || "Shoonya did not return an authorization code.");

  return new Response(null, {
    status: 302,
    headers: { Location: to.toString(), "Referrer-Policy": "no-referrer" },
  });
});
