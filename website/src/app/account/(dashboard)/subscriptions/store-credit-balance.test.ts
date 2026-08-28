import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The membership panel used to print ONLY the tier's monthly entitlement
// ("$15.00/mo"). That is not money the member holds: checkout spends the
// BALANCE, which is $0.00 the day they join and moves as they spend and accrue.
// A member had no surface anywhere in the account area showing what they
// actually had, so the entitlement read as a balance. This pins the balance to
// the page and to the same source checkout reads (getMembershipPerks), so a
// refactor cannot quietly drop it or swap it back for the tier constant.
const source = readFileSync(
  path.join(process.cwd(), "src/app/account/(dashboard)/subscriptions/page.tsx"),
  "utf8",
);

describe("membership panel store credit", () => {
  it("shows the member's real balance, not just the tier entitlement", () => {
    expect(source).toContain("perks.storeCreditBalanceCents");
    expect(source).toMatch(/available now/);
  });

  it("still shows the tier's monthly entitlement alongside it", () => {
    expect(source).toContain("membership.tier.monthlyStoreCreditCents");
  });

  it("states the minimum order the balance can be spent on", () => {
    expect(source).toContain("perks.storeCreditMinOrderCents");
  });

  it("reads the balance from the same helper checkout uses", () => {
    // getMembershipPerks is what the cart/checkout path resolves credit from.
    // Reading the balance from anywhere else is how the two surfaces drift.
    expect(source).toContain("getMembershipPerks");
  });
});
