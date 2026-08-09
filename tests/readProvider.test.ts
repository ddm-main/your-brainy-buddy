// Guardrail: market data must never be served through a user's personal broker
// session. provider.ts is a Deno module (npm: specifiers, .ts imports) so it
// cannot be imported into vitest; we assert the invariants on its source, which
// is exactly where a regression would be reintroduced.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../supabase/functions/_shared/market/provider.ts", import.meta.url)),
  "utf8",
);

function body(fnName: string): string {
  const start = src.indexOf(`export async function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${fnName}`);
}

describe("market-data provider isolation", () => {
  it("getReadProvider never falls back to the caller's account connection", () => {
    const fn = body("getReadProvider");
    expect(fn).toContain("getSystemFeedRow");
    expect(fn).not.toContain("getActiveProvider");
    expect(fn).toContain("yahooProvider");
  });

  it("getServiceProvider also uses only the designated feed or vendors", () => {
    const fn = body("getServiceProvider");
    expect(fn).not.toContain("getActiveProvider");
    expect(fn).toContain("yahooProvider");
  });

  it("the system feed row is restricted to designated data-purpose rows", () => {
    const start = src.indexOf("async function getSystemFeedRow(");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\n}", start));
    expect(fn).toContain('.eq("is_system", true)');
    expect(fn).toContain('.eq("purpose", "data")');
    // No "newest connected broker row of any user" legacy fallback.
    expect(fn).not.toContain("order(");
  });

  it("getActiveProvider stays scoped to account-purpose rows", () => {
    const fn = body("getActiveProvider");
    const scoped = fn.includes('.eq("purpose", "account")') || src.includes('.eq("purpose", "account")');
    expect(scoped).toBe(true);
  });
});
