import { describe, it, expect } from "vitest";
import { computeTierChangeBilling } from "@/lib/membership-billing-math";

// Tiers used across cases (cents).
const ESSENTIAL = { monthlyPriceCents: 999, annualPriceCents: 9900, introPriceCents: 100 }; // $9.99 / $1 intro → remainder $8.99
const BLACK = { monthlyPriceCents: 8999, annualPriceCents: 89900, introPriceCents: 100 }; // $89.99 / $1 intro → remainder $88.99

describe("computeTierChangeBilling", () => {
  it("UPGRADE during $1 trial reprices the remainder up to the new tier (was the bug)", () => {
    // Signed up Essential on the $1 trial, upgraded to Black mid-trial.
    const r = computeTierChangeBilling({ isTrialing: true, billingCycle: "monthly", ...BLACK });
    // Next charge (the first-month remainder) must be Black's $88.99, not
    // Essential's $8.99 — the pre-fix bug undercharged here.
    expect(r.firstMonthRemainderCents).toBe(8899);
    expect(r.nextBillingAmountCents).toBe(8899);
  });

  it("DOWNGRADE during $1 trial reprices the remainder down to the new tier", () => {
    // Was Black on trial, downgraded to Essential — must not overcharge $88.99.
    const r = computeTierChangeBilling({ isTrialing: true, billingCycle: "monthly", ...ESSENTIAL });
    expect(r.firstMonthRemainderCents).toBe(899);
    expect(r.nextBillingAmountCents).toBe(899);
  });

  it("ACTIVE monthly upgrade reprices the NEXT RENEWAL to full monthly, leaves remainder untouched", () => {
    const r = computeTierChangeBilling({ isTrialing: false, billingCycle: "monthly", ...BLACK });
    expect(r.nextBillingAmountCents).toBe(8999); // full monthly, not remainder
    expect(r.firstMonthRemainderCents).toBeNull(); // don't touch a non-trial member's remainder
  });

  it("ACTIVE annual change reprices to the annual price", () => {
    const r = computeTierChangeBilling({ isTrialing: false, billingCycle: "annual", ...BLACK });
    expect(r.nextBillingAmountCents).toBe(89900);
    expect(r.firstMonthRemainderCents).toBeNull();
  });

  it("falls back to monthly price when annual price is missing", () => {
    const r = computeTierChangeBilling({ isTrialing: false, billingCycle: "annual", monthlyPriceCents: 8999, annualPriceCents: null, introPriceCents: 100 });
    expect(r.nextBillingAmountCents).toBe(8999);
  });

  it("never produces a negative remainder when intro price exceeds monthly", () => {
    const r = computeTierChangeBilling({ isTrialing: true, billingCycle: "monthly", monthlyPriceCents: 100, annualPriceCents: null, introPriceCents: 999 });
    expect(r.firstMonthRemainderCents).toBe(0);
    expect(r.nextBillingAmountCents).toBe(0);
  });
});
