// Reflect-if-allowed CORS. Replaces the SDK's blanket `*`.
const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:8080",
  "http://localhost:5173",
  "https://jarvis.lovable.app",
  "https://your-brainy-buddy.lovable.app",
  "https://jarvis.ferfier.app",
]);

// Also allow any *.lovable.app / *.lovableproject.com preview by suffix
// (covers this project's id-preview host and any published subdomain).
const ALLOWED_SUFFIXES = [".lovable.app", ".lovableproject.com"];

function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

export function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allow = isAllowed(origin) ? origin! : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { headers: corsFor(req) });
}
