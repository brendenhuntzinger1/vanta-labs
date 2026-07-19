import { describe, expect, it } from "vitest";
import { generateReferralCode } from "@/lib/referral-code-utils";

describe("generateReferralCode", () => {
  it("creates uppercase code with prefix and suffix", () => {
    const code = generateReferralCode("Alex Morgan");
    expect(code).toMatch(/^ALEXMO-[A-F0-9]{6}$/);
  });

  it("falls back to default prefix when seed has no alphanumerics", () => {
    const code = generateReferralCode("---");
    expect(code).toMatch(/^PARTNR-[A-F0-9]{6}$/);
  });
});
