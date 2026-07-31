// Regressions for the Kotak audit fixes: ask-side depth parsing, the
// invalid-OTP no-retry rule, and mobile-number normalisation.
import { describe, it, expect } from "vitest";
import {
  parseFlatSide,
  isInvalidOtpAnswer,
  normalizeKotakMobile,
} from "../supabase/functions/_shared/market/kotakClient.ts";

describe("parseFlatSide", () => {
  // Flat Neo payload: buy uses bp/bq, sell uses sp/sq. The old parser read the
  // sell quantity from the BUY key, silently zeroing every ask size.
  const flat = {
    bp: 100, bq: 10, bno1: 1,
    bp1: 99, bq1: 20, bno2: 2,
    sp: 101, sq: 30, sno1: 3,
    sp1: 102, sq1: 40, sno2: 4,
  };

  it("reads ask quantities from the sell-side key", () => {
    const asks = parseFlatSide(flat, "sp", ["sq", "ss"], "sno");
    expect(asks).toEqual([
      { price: 101, qty: 30, orders: 3 },
      { price: 102, qty: 40, orders: 4 },
    ]);
  });

  it("still reads bid quantities correctly", () => {
    const bids = parseFlatSide(flat, "bp", ["bq", "bs"], "bno");
    expect(bids.map((r) => r.qty)).toEqual([10, 20]);
  });

  it("falls back to the alternate quantity key", () => {
    const asks = parseFlatSide({ sp: 50, ss: 7, sno1: 1 }, "sp", ["sq", "ss"], "sno");
    expect(asks[0].qty).toBe(7);
  });
});

describe("isInvalidOtpAnswer", () => {
  it("detects an explicit invalid-OTP rejection", () => {
    expect(isInvalidOtpAnswer(new Error("Invalid OTP"))).toBe(true);
    expect(isInvalidOtpAnswer(new Error("otp is incorrect"))).toBe(true);
  });
  it("does not treat transient failures as invalid OTP", () => {
    expect(isInvalidOtpAnswer(new Error("503 service unavailable"))).toBe(false);
    expect(isInvalidOtpAnswer(new Error("network timeout"))).toBe(false);
  });
});

describe("normalizeKotakMobile", () => {
  it("does not double-prefix a number already carrying 91", () => {
    expect(normalizeKotakMobile("919876543210")).toBe("+919876543210");
    expect(normalizeKotakMobile("+919876543210")).toBe("+919876543210");
  });
  it("normalises bare and zero-padded local numbers", () => {
    expect(normalizeKotakMobile("9876543210")).toBe("+919876543210");
    expect(normalizeKotakMobile("09876543210")).toBe("+919876543210");
  });
});
