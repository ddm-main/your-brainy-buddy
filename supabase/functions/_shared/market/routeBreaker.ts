// Route-level circuit breaker for upstream broker/vendor endpoints.
//
// WHY THIS EXISTS: Kotak's `/charts/v2/history` route is not available on this
// account's base URL — it answers "404 page not found". The provider already
// falls back to Yahoo on 404, so charts kept working, but every single symbol
// in every pipeline run still paid a full round-trip to a route that can never
// succeed, and wrote a market_provider_health row about it: 9,658 identical
// failure rows in a single day, on a 500 MB database budget.
//
// A dead route is a property of the route, not of the symbol. Once it has
// failed with a terminal status (404/501 — "this endpoint does not exist
// here"), stop asking until the cooldown expires, and log the transition once
// instead of once per call.
//
// State is per-isolate (in-memory). That is deliberate: it costs nothing, and
// a chunked pipeline run processes hundreds of symbols inside one isolate, so
// the very first 404 spares all the rest. A fresh isolate re-probes once,
// which is exactly the retry behaviour we want after a broker-side fix.

type RouteState = {
  failures: number;
  openUntil: number;    // epoch ms; while in the future the breaker is open
  openedAt: number;     // epoch ms; when the current open period began
  lastError: string;
  loggedOpen: boolean;  // health row already written for this open period
};

const states = new Map<string, RouteState>();

// A route that reports "not found" / "not implemented" is structurally absent
// on this session's gateway — retrying it sooner than an hour is pure waste.
const TERMINAL_STATUSES = new Set([404, 501]);
const TERMINAL_COOLDOWN_MS = 60 * 60 * 1000;   // 1 hour
// Overload/outage: back off briefly, the route itself is fine.
const TRANSIENT_COOLDOWN_MS = 2 * 60 * 1000;   // 2 minutes
// Dropped from 5 → 3 so a genuine outage trips the breaker within a handful
// of calls instead of after every symbol in a screener sweep has already
// paid the timeout.
const TRANSIENT_THRESHOLD = 3;

/** Milliseconds the breaker has been continuously open (0 when closed). */
export function routeOpenForMs(route: string): number {
  const s = states.get(route);
  if (!s || s.openUntil <= Date.now() || s.openedAt === 0) return 0;
  return Math.max(0, Date.now() - s.openedAt);
}

function get(route: string): RouteState {
  let s = states.get(route);
  if (!s) {
    s = { failures: 0, openUntil: 0, openedAt: 0, lastError: "", loggedOpen: false };
    states.set(route, s);
  }
  return s;
}

/** True when the breaker is open and the caller should skip straight to its fallback. */
export function isRouteOpen(route: string): boolean {
  return get(route).openUntil > Date.now();
}

/** Human-readable reason the breaker is open, for logs and fallback messages. */
export function routeOpenReason(route: string): string {
  const s = get(route);
  const secs = Math.max(0, Math.round((s.openUntil - Date.now()) / 1000));
  return `${route} circuit open for ${secs}s after ${s.failures} failure(s): ${s.lastError}`;
}

/**
 * Records a failed call.
 * @returns true if this call *opened* the breaker (the one worth logging).
 */
export function noteRouteFailure(route: string, status: number | undefined, message: string): boolean {
  const s = get(route);
  s.failures++;
  s.lastError = message.slice(0, 300);

  const terminal = status != null && TERMINAL_STATUSES.has(status);
  if (!terminal && s.failures < TRANSIENT_THRESHOLD) return false;

  const wasOpen = s.openUntil > Date.now();
  s.openUntil = Date.now() + (terminal ? TERMINAL_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
  if (!wasOpen) s.openedAt = Date.now();
  persistRoute(route);
  if (wasOpen && s.loggedOpen) return false;
  s.loggedOpen = true;
  return true;
}

/** Records a success — closes the breaker and clears the failure streak. */
export function noteRouteSuccess(route: string): void {
  const s = states.get(route);
  if (!s) return;
  const wasOpen = s.openUntil > Date.now();
  s.failures = 0;
  s.openUntil = 0;
  s.openedAt = 0;
  s.loggedOpen = false;
  if (wasOpen) persistRoute(route);
}

/** Snapshot for diagnostics/tests. */
export function routeBreakerSnapshot(): Array<{ route: string; failures: number; openForMs: number; lastError: string }> {
  const now = Date.now();
  return [...states.entries()].map(([route, s]) => ({
    route,
    failures: s.failures,
    openForMs: Math.max(0, s.openUntil - now),
    lastError: s.lastError,
  }));
}

/** Test-only reset. */
export function resetRouteBreakers(): void {
  states.clear();
  hydratedAt = 0;
}

// --- Shared persistence (survives isolate cold-starts) --------------------
// The in-memory state above is per-isolate. Supabase edge functions spin fresh
// isolates constantly, so a broker outage that already tripped the breaker in
// one isolate gets re-probed by the next. To avoid punishing users twice we
// mirror open breakers into `public.market_route_health`: hydrate once per
// isolate on request start, and fire-and-forget persist on state transitions.

// deno-lint-ignore no-explicit-any
type Svc = any;
let persistSvc: Svc | null = null;
let hydratedAt = 0;
const HYDRATE_TTL_MS = 60_000;

export function setRouteBreakerPersistence(svc: Svc): void {
  persistSvc = svc;
}

export async function hydrateRouteBreakers(svc: Svc): Promise<void> {
  if (Date.now() - hydratedAt < HYDRATE_TTL_MS) return;
  hydratedAt = Date.now();
  try {
    const { data } = await svc
      .from("market_route_health")
      .select("route,failures,open_until,opened_at,last_error")
      .gt("open_until", new Date().toISOString());
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const route = String(row.route);
      const openUntil = row.open_until ? new Date(String(row.open_until)).getTime() : 0;
      const openedAt = row.opened_at ? new Date(String(row.opened_at)).getTime() : 0;
      if (openUntil <= Date.now()) continue;
      const s = get(route);
      // DB wins over cold in-memory state.
      s.openUntil = openUntil;
      s.openedAt = openedAt || Date.now();
      s.failures = Number(row.failures ?? s.failures) || s.failures;
      s.lastError = String(row.last_error ?? s.lastError);
      s.loggedOpen = true;
    }
  } catch { /* best-effort; fall back to in-memory only */ }
}

function persistRoute(route: string): void {
  if (!persistSvc) return;
  const s = states.get(route);
  if (!s) return;
  const row = {
    route,
    failures: s.failures,
    open_until: s.openUntil ? new Date(s.openUntil).toISOString() : null,
    opened_at: s.openedAt ? new Date(s.openedAt).toISOString() : null,
    last_error: s.lastError || null,
    updated_at: new Date().toISOString(),
  };
  persistSvc.from("market_route_health")
    .upsert(row, { onConflict: "route" })
    .then(() => {}, () => {});
}
