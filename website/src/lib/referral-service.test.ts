import { describe, expect, it } from "vitest";
import { calculateCommissionAmount, calculateDiscountAmount, normalizeReferralCode } from "@/lib/referral-service";

describe("referral service", () => {
  it("normalizes referral codes for Supabase lookups", () => {
    expect(normalizeReferralCode("  alpha-10  ")).toBe("ALPHA-10");
  });

  it("applies the fixed customer discount", () => {
    expect(calculateDiscountAmount(200, 10)).toBe(20);
  });

  it("calculates commissions from paid order totals", () => {
    expect(calculateCommissionAmount(200, 10)).toBe(20);
  });
});
