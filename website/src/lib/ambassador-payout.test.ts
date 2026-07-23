import { describe, expect, it } from "vitest";
import {
  AMBASSADOR_PAYOUT_METHODS,
  AMBASSADOR_PAYOUT_METHOD_LABELS,
  isValidPayoutMethod,
} from "@/lib/partner-portal";

describe("ambassador payout method validation", () => {
  it("accepts the three supported methods", () => {
    expect(isValidPayoutMethod("paypal")).toBe(true);
    expect(isValidPayoutMethod("venmo")).toBe(true);
    expect(isValidPayoutMethod("cashapp")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidPayoutMethod("zelle")).toBe(false);
    expect(isValidPayoutMethod("bitcoin")).toBe(false);
    expect(isValidPayoutMethod("")).toBe(false);
    expect(isValidPayoutMethod("PayPal")).toBe(false); // case-sensitive; callers lowercase first
  });

  it("has a human label for every supported method", () => {
    for (const method of AMBASSADOR_PAYOUT_METHODS) {
      expect(AMBASSADOR_PAYOUT_METHOD_LABELS[method]).toBeTruthy();
    }
    expect(AMBASSADOR_PAYOUT_METHOD_LABELS.paypal).toBe("PayPal");
    expect(AMBASSADOR_PAYOUT_METHOD_LABELS.venmo).toBe("Venmo");
    expect(AMBASSADOR_PAYOUT_METHOD_LABELS.cashapp).toBe("Cash App");
  });
});
