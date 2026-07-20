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
export function evaluateGroups(row: Record<string, unknown>, groups: ScreenerGroup[]): boolean {
  if (!groups || groups.length === 0) return false;
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
