import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";

// ---------------------------------------------------------------------------
// THE RATE THAT APPLIED, NOT THE RATE THAT APPLIES.
//
// commission_percent has always been frozen onto the commission row. The
// customer discount now needs the same treatment, and for a sharper reason:
// the discount is visible in the order total. Raise an ambassador's rate next
// month and, without a snapshot, every past order would claim a discount that
// does not reconcile against the money actually charged.
//
// Both figures are resolved with the SAME rule checkout uses, so the stored
// number is what the shopper got -- not what the ambassador happens to be set
// to when someone opens the report.
// ---------------------------------------------------------------------------

const webhook = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

describe("the commission row snapshots the discount", () => {
  it("loads the ambassador's own rate alongside their status", () => {
    expect(webhook).toContain('.select("status, customer_discount_percent")');
  });

  it("resolves it with the same rule checkout uses", () => {
    expect(webhook).toContain("resolveAmbassadorCustomerDiscount(");
    expect(webhook).toContain("referralProgram.discountPercent");
  });

  // Three rows record a commission: one in referral_orders and two in
  // commissions. A snapshot on two of the three is worse than none, because the
  // gap only shows up on the orders that took the other branch.
  it("writes the snapshot everywhere commission_percent is written", () => {
    const rateWrites = webhook.match(/commission_percent: commissionPercent,/g) ?? [];
    const snapshots = webhook.match(/customer_discount_percent: customerDiscountPercent,/g) ?? [];

    expect(rateWrites.length).toBe(3);
    expect(snapshots.length).toBe(rateWrites.length);
  });

  // Reading the live ambassador row at report time is exactly the bug the
  // snapshot exists to prevent.
  it("takes the value from the order's own resolution, not a later lookup", () => {
    const block = webhook.slice(webhook.indexOf("const customerDiscountPercent"));
    expect(block.slice(0, 400)).not.toContain("await supabaseAdmin");
  });
});

// The resolver decides what gets frozen, so the freezing is only as correct as
// it is. These restate the rule from the perspective of the stored record.
describe("what a stored snapshot means", () => {
  it("records an override as the ambassador's own number", () => {
    expect(resolveAmbassadorCustomerDiscount(15, 10)).toBe(15);
  });

  it("records the program rate for an ambassador who was inheriting", () => {
    // The order got 10%. If the program default later moves to 20%, this row
    // must still read 10 -- which is exactly why it is stored rather than
    // recomputed.
    expect(resolveAmbassadorCustomerDiscount(null, 10)).toBe(10);
  });

  it("records a deliberate 0% rather than falling back", () => {
    expect(resolveAmbassadorCustomerDiscount(0, 10)).toBe(0);
  });
});
