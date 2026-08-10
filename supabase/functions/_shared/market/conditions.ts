// Shared condition model for screener filters AND AutoTrade entry/exit rules.
// Mirrors src/lib/market/hooks.ts's conditionToPgrst()/useStockScores({groups})
// exactly (same shape, same escaping) so a condition list authored once in
// the frontend behaves identically whether it's driving a saved screener or
// an armed AutoTrade rule evaluated here on the server.

export interface ScreenerCondition {
  column: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "is_true" | "is_false";
  value?: number | string;
}
export interface ScreenerGroup {
  conditions: ScreenerCondition[];
}

function escapePgrst(v: string): string {
  return v.replace(/[,()\\]/g, "\\$&");
}

const NUMERIC_OPS: Record<string, string> = { gt: "gt", gte: "gte", lt: "lt", lte: "lte", eq: "eq" };

function conditionToPgrst(c: ScreenerCondition): string | null {
  const col = c.column.replace(/[^a-z0-9_]/g, "");
  if (c.op === "is_true") return `${col}.is.true`;
  if (c.op === "is_false") return `${col}.is.false`;
  const op = NUMERIC_OPS[c.op];
  if (!op || c.value === undefined || c.value === "") return null;
  return `${col}.${op}.${escapePgrst(String(c.value))}`;
}

// deno-lint-ignore no-explicit-any
export function applyGroupsToQuery<T extends { or: (s: string) => any; filter: (c: string, o: string, v: unknown) => any }>(
  q: T,
  groups: ScreenerGroup[],
): T {
  if (!groups || groups.length === 0) return q;
  const orParts = groups
    .map((g) => {
      const parts = g.conditions.map(conditionToPgrst).filter((p): p is string => p != null);
      if (parts.length === 0) return null;
      return parts.length === 1 ? parts[0] : `and(${parts.join(",")})`;
    })
    .filter((p): p is string => p != null);
  if (orParts.length === 0) return q;
  if (orParts.length === 1 && !orParts[0].startsWith("and(")) {
    const [col, op, ...rest] = orParts[0].split(".");
    return q.filter(col, op, rest.join("."));
  }
  return q.or(orParts.join(","));
}

// Pure in-memory evaluation — used for exit conditions, which are checked
// against a single already-fetched score row per open position rather than
// issued as a fresh query.
//
// `requireTradeDate`: market-pipeline-eod advances a symbol's sync cursor
// even when its fetch fails, so a symbol whose data keeps failing to sync
// keeps an old trade_date indefinitely while still looking "synced" — an
// AutoTrade rule could otherwise fire an entry/exit off a technical/momentum
// value that's days old. When supplied (callers should pass today's IST
// trade date), a row whose trade_date doesn't match is never considered a
// match, full stop — same defense the screener's filterMatches has via its
// scope-aware applicability check, simplified here since this function has
// no per-column scope metadata to work with.
export function evaluateGroups(row: Record<string, unknown>, groups: ScreenerGroup[], requireTradeDate?: string | null): boolean {
  if (!groups || groups.length === 0) return false;
  if (requireTradeDate != null && row.trade_date !== requireTradeDate) return false;
  return groups.some((g) =>
    g.conditions.every((c) => {
      const v = row[c.column];
      if (c.op === "is_true") return v === true;
      if (c.op === "is_false") return v === false;
      if (c.value === undefined || c.value === "") return true;
      const n = typeof v === "number" ? v : Number(v);
      const target = Number(c.value);
      if (!Number.isFinite(n) || !Number.isFinite(target)) return false;
      switch (c.op) {
        case "gt": return n > target;
        case "gte": return n >= target;
        case "lt": return n < target;
        case "lte": return n <= target;
        case "eq": return n === target;
        default: return false;
      }
    })
  );
}

// EGRESS: AutoTrade used to read the score row with `select("*")` — 123
// columns, ~4.5 KB a row, 8 000 reads a day (8.6 MB) to evaluate a handful of
// user-chosen fields. The conditions themselves say exactly which columns are
// needed, so build the projection from them. `trade_date` is always included:
// evaluateGroups refuses a row whose session is stale, and the caller logs it.
const CONDITION_BASE_COLUMNS = ["symbol", "exchange", "trade_date"];

export function columnsForGroups(...groupSets: Array<ScreenerGroup[] | null | undefined>): string {
  const cols = new Set(CONDITION_BASE_COLUMNS);
  for (const groups of groupSets) {
    for (const g of groups ?? []) {
      for (const c of g.conditions ?? []) {
        const col = String(c.column ?? "").replace(/[^a-z0-9_]/g, "");
        if (col) cols.add(col);
      }
    }
  }
  return Array.from(cols).join(",");
}
