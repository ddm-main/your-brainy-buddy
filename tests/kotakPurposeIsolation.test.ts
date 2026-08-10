import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

describe("Kotak account/data purpose isolation", () => {
  it("connection tests filter Kotak by the requested purpose", () => {
    const src = read("../supabase/functions/market-test-connection/index.ts");
    expect(src.match(/\.eq\("purpose", probePurpose\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect(src).not.toContain("fall back to the other");
    expect(src).toContain("surfaceReport(svc, auth.userId, which, probePurpose, scope)");
  });

  it("manual refresh defaults to account and filters the selected purpose", () => {
    const src = read("../supabase/functions/market-kotak-refresh/index.ts");
    expect(src).toContain('?? "account"');
    expect(src).toContain('q = q.eq("purpose", purposeFilter)');
    expect(src).toContain('if (purposeFilter === "data")');
    expect(src).toContain('errorResponse(req, "admin_only", 403)');
  });

  it("the broker UI sends its purpose to refresh and test calls", () => {
    const src = read("../src/components/market/BrokerConnectPanel.tsx");
    expect(src).toContain('callFn("market-kotak-refresh", { purpose })');
    expect(src).toContain('callFn("market-test-connection", { provider: "kotak_neo", purpose })');
  });

  it("Kotak eligibility requires a complete session or complete auto-login credentials", () => {
    const src = read("../supabase/functions/_shared/market/provider.ts");
    expect(src).toContain("const completeSession");
    expect(src).toContain("const completeAutoLogin");
    expect(src).toContain("!!r.mobile_number_enc");
    expect(src).toContain("!!r.mpin_enc");
    expect(src).toContain("!!r.totp_secret_enc");
  });
});