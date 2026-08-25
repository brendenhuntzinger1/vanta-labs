import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { computeProfit } from "@/lib/profit-engine";

// ---------------------------------------------------------------------------
// THE WALLET LANE MUST NOT REFUSE AN ORDER THE CARD LANE ACCEPTS.
//
// Found in production telemetry: three "Promotion unavailable on this order."
// refusals on /api/checkout/express/session in three minutes. The cause was not
// pricing policy, it was an asymmetric comparison inside the profit guard.
//
// quoteOrder in "address_optional" mode (the wallet session, before any
// address exists) resolves shipping to 0 by construction — the destination is
// unknown, so the fee the shopper will pay is not knowable. The guard still
// charged the full shippingCostPerOrder against that revenue. Revenue without
// the shipping fee, costs including the shipping spend: two different orders.
//
// The result was a silently missing Apple Pay button on orders the store was
// happy to take. GHRP-2 is the case that proves it is not a Bac Water quirk:
// a normally-priced $39.99 product with a $33 cost.
//
// Nothing is let through by relaxing this. express/authorize re-quotes in
// "full" mode with the real address and THAT is the authoritative guard.
// ---------------------------------------------------------------------------

/** Production defaults at the time of the incident: no admin overrides set. */
const FEE_PERCENT = 8;
const SHIPPING_COST_PER_ORDER = 6;
const DOMESTIC_SHIPPING_FEE = 15;

/** The guard's inputs, with only the two things that vary between lanes. */
function guard(opts: { price: number; cost: number; shippingCollected: number; shippingCost: number }) {
  return computeProfit(
    {
      subtotal: opts.price,
      productCost: opts.cost,
      bundleDiscount: 0,
      referralAccepted: false,
      referralPercent: 0,
      isMember: false,
      membershipPercent: 0,
      couponDiscount: 0,
      allowCouponStacking: false,
      commissionPercent: 0,
      processingFeePercent: FEE_PERCENT,
      processingFeeIncludesTax: true,
      shippingCollected: opts.shippingCollected,
      shippingCost: opts.shippingCost,
      handlingCollected: 0,
      taxPercent: 0,
    },
    { amount: 0, components: [], label: "resolved" },
  );
}

/** The floor quoteOrder applies: default minimum profit is $0. */
const clearsFloor = (grossProfit: number) => grossProfit >= 0;

const GHRP2 = { price: 39.99, cost: 33 };
const BAC_WATER = { price: 2, cost: 8 };

describe("GHRP-2 — profitable, and the wallet lane used to refuse it", () => {
  it("clears the card lane comfortably", () => {
    const p = guard({ ...GHRP2, shippingCollected: DOMESTIC_SHIPPING_FEE, shippingCost: SHIPPING_COST_PER_ORDER });
    expect(p.grossProfit).toBeCloseTo(11.59, 2);
    expect(clearsFloor(p.grossProfit)).toBe(true);
  });

  it("was refused by the old asymmetric wallet comparison — no shipping fee, full shipping cost", () => {
    const p = guard({ ...GHRP2, shippingCollected: 0, shippingCost: SHIPPING_COST_PER_ORDER });
    expect(p.grossProfit).toBeCloseTo(-2.21, 2);
    expect(clearsFloor(p.grossProfit)).toBe(false); // the bug: a silently missing Apple Pay button
  });

  it("clears the wallet pre-check once the comparison is symmetric", () => {
    const p = guard({ ...GHRP2, shippingCollected: 0, shippingCost: 0 });
    expect(p.grossProfit).toBeCloseTo(3.79, 2);
    expect(clearsFloor(p.grossProfit)).toBe(true);
  });
});

describe("an order that genuinely loses money on goods alone is still refused", () => {
  it("Bac Water at $2.00 against an $8.00 cost fails the wallet pre-check even symmetric", () => {
    // This is the guard doing its job, not the bug. Relaxing the shipping term
    // must not become a way to sell below cost.
    const p = guard({ ...BAC_WATER, shippingCollected: 0, shippingCost: 0 });
    expect(p.grossProfit).toBeCloseTo(-6.16, 2);
    expect(clearsFloor(p.grossProfit)).toBe(false);
  });

  it("and the card lane is unchanged by this fix", () => {
    const p = guard({ ...BAC_WATER, shippingCollected: DOMESTIC_SHIPPING_FEE, shippingCost: SHIPPING_COST_PER_ORDER });
    expect(p.grossProfit).toBeCloseTo(1.64, 2);
  });
});

describe("the symmetry is actually wired into quoteOrder", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");

  it("charges the shipping cost only when the destination is known", () => {
    // A conditional that nothing reads would leave the defect in place while
    // looking fixed.
    expect(source).toMatch(/shippingCost:\s*destinationKnown\s*\?\s*profitSettings\.shippingCostPerOrder\s*:\s*0/);
  });

  it("still resolves the shipping FEE to 0 in the same mode, which is what makes it symmetric", () => {
    expect(source).toMatch(/const destinationKnown = input\.mode !== "address_optional"/);
    expect(source).toMatch(/const shipping = !destinationKnown\s*\?\s*0/);
  });
});
