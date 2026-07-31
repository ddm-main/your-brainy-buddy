import { describe, expect, it } from "vitest";
import { isKotakSessionFailure } from "../supabase/functions/_shared/market/kotakErrorClassifier";
import { parseKotakLimits } from "../supabase/functions/_shared/market/kotakClient";

describe("Kotak session classifier", () => {
  it("treats HTTP 401 as a session failure", () => {
    expect(isKotakSessionFailure(401, "anything")).toBe(true);
  });

  it("does not treat generic unauthorised 403 as a session failure", () => {
    expect(isKotakSessionFailure(403, '{"error":true,"message":"unauthorised"}')).toBe(false);
    expect(isKotakSessionFailure(403, "Kotak API 403: unauthorised {\"error\":true,\"message\":\"unauthorised\"}")).toBe(false);
    expect(isKotakSessionFailure(403, "Client not authorised to place sell order in this product")).toBe(false);
  });

  it("does not treat RMS/business sell rejections as session failures", () => {
    expect(isKotakSessionFailure(403, "RMS: Margin exceeds, insufficient holdings for SELL")).toBe(false);
    expect(isKotakSessionFailure(403, "Delivery sell quantity is not available in demat holdings")).toBe(false);
  });

  it("treats explicit token/session 403 responses as session failures", () => {
    expect(isKotakSessionFailure(403, "token expired")).toBe(true);
    expect(isKotakSessionFailure(403, "session invalid, login required")).toBe(true);
    expect(isKotakSessionFailure(403, "authentication required")).toBe(true);
    expect(isKotakSessionFailure(403, "access token invalid")).toBe(true);
  });
});

describe("Kotak limits parser", () => {
  it("treats a valid all-zero limits payload as ₹0 available, not missing", () => {
    const funds = parseKotakLimits({
      Net: 0,
      MarginUsed: 0,
      Collateral: 0,
      AmountUtilizedPrsnt: 0,
      AmtUntilizedPrsnt: 0,
      stat: "Ok",
      stCode: 200,
    });
    expect(funds.available_margin).toBe(0);
    expect(funds.used_margin).toBe(0);
    expect(funds.net_cash).toBe(0);
  });
});