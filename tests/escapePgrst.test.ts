import { describe, it, expect } from "vitest";

// mirror of escapePgrst in supabase/functions/jarvis-chat/index.ts
function escapePgrst(v: string): string {
  return v.replace(/[,()\\]/g, "\\$&");
}

describe("escapePgrst", () => {
  it("escapes commas and parens", () => {
    expect(escapePgrst("a,b(c)")).toBe("a\\,b\\(c\\)");
  });
  it("escapes backslash", () => {
    expect(escapePgrst("a\\b")).toBe("a\\\\b");
  });
  it("passes through safe input", () => {
    expect(escapePgrst("hello world")).toBe("hello world");
  });
});
