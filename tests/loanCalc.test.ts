import { describe, it, expect } from "vitest";
import { calcEmi, calcPrincipalFromEmi, roundCurrency } from "../src/lib/loanCalc";

describe("loanCalc", () => {
  it("returns null on invalid input", () => {
    expect(calcEmi(0, 10, 12)).toBeNull();
    expect(calcEmi(-1, 10, 12)).toBeNull();
    expect(calcEmi(100, -1, 12)).toBeNull();
    expect(calcEmi(100, 10, 0)).toBeNull();
    expect(calcEmi(100, 10, 1.5)).toBeNull();
    expect(calcEmi(100, 10, 100000)).toBeNull();
  });
  it("zero-interest EMI is straight division", () => {
    expect(calcEmi(12000, 0, 12)).toBe(1000);
  });
  it("computes standard reducing-balance EMI", () => {
    const emi = calcEmi(1_000_000, 10, 120)!;
    expect(Math.round(emi)).toBe(13215);
  });
  it("calcPrincipalFromEmi is the inverse", () => {
    const p = 500_000, r = 12, n = 60;
    const emi = calcEmi(p, r, n)!;
    const back = calcPrincipalFromEmi(emi, r, n)!;
    expect(Math.round(back)).toBe(p);
  });
  it("zero-rate inverse", () => {
    expect(calcPrincipalFromEmi(1000, 0, 12)).toBe(12000);
  });
  it("roundCurrency 2dp", () => {
    expect(roundCurrency(1.234)).toBe(1.23);
    expect(roundCurrency(1.235)).toBeGreaterThan(1.23);
  });
});
