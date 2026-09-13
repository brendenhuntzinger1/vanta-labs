import { describe, expect, it } from "vitest";
import {
  planStageOffer,
  recoveryGiftConfig,
  RECOVERY_GIFT_MIN_CART_CENTS,
} from "@/lib/cart-recovery-offers";
import { DEFAULT_RECOVERY_TIERS } from "@/lib/cart-recovery-tiers";
import { describeGiftTerms } from "@/lib/offers/gift-terms";

// ---------------------------------------------------------------------------
// P0-3. AN EXPENSIVE GIFT MUST NOT BE SPENDABLE ON A TINY CART.
//
// recoveryGiftConfig stamped every assembled gift with the PROGRAMME floor —
// $35 — whatever band produced it. The bands exist precisely because a $520
// cart and a $61 cart deserve different offers, and the redemption rule threw
// that distinction away at the last step.
//
// The concrete hole: the $500+ band gifts a KLOW ($25.07 cost, $119.99 retail)
// plus a GHK-Cu and a Recon Water. A shopper could take the email, remove
// items until the basket read $40, and check out. The store ships ~$175 of
// retail product against a $40 order — a negative-contribution order the
// system accepts without complaint.
//
// Nothing had walked it, because nothing has ever been redeemed. That is luck,
// not a guard.
// ---------------------------------------------------------------------------

const names = new Map([
  ["ghk-cu", "GHK-Cu 50mg"],
  ["bac-water", "Recon Water"],
  ["klow", "KLOW"],
]);

const base = {
  lastPaidAt: null,
  lastRecoveryCouponAt: null,
  lastRecoveryGiftAt: null,
  discountPercent: 10,
  tiers: DEFAULT_RECOVERY_TIERS,
  now: Date.UTC(2026, 8, 12),
};

describe("a gift's redemption minimum", () => {
  it("is the floor of the band that earned it, not the programme floor", () => {
    // The shipped ladder: $35 / $100 / $250 / $500.
    const cases: Array<[number, number]> = [
      [6_100, 3_500],    // $61 cart  -> lowest band
      [15_000, 10_000],  // $150 cart -> $100 band
      [38_000, 25_000],  // $380 cart -> $250 band
      [52_000, 50_000],  // $520 cart -> $500 band
    ];
    for (const [cartValueCents, expected] of cases) {
      const plan = planStageOffer({ ...base, stage: "t72h", cartValueCents });
      expect(plan.minCartCents).toBe(expected);
    }
  });

  it("closes the hole: the $500-band gift cannot be redeemed against $40", () => {
    const plan = planStageOffer({ ...base, stage: "t72h", cartValueCents: 52_000 });
    const config = recoveryGiftConfig(plan.gifts, names, 0, plan.minCartCents);
    expect(config).not.toBeNull();

    // $50,000 in cents. A $40 basket is nowhere near it, which is the point.
    expect(config!.minSubtotalCents).toBe(50_000);
    expect(config!.minSubtotalCents).toBeGreaterThan(4_000);
  });

  it("tells the customer the number the till will enforce", () => {
    const plan = planStageOffer({ ...base, stage: "t72h", cartValueCents: 52_000 });
    const config = recoveryGiftConfig(plan.gifts, names, 0, plan.minCartCents)!;
    const terms = describeGiftTerms(config, new Date(base.now + 10 * 86_400_000).toISOString());

    // A raised minimum that is not disclosed is a worse defect than the one it
    // fixes: the shopper would reach the till and silently lose the gift.
    // describeGiftTerms renders the SAME config the mint wrote onto the row.
    expect(terms).toContain("$500");
  });

  it("never drops below the programme floor, whatever a band is configured to", () => {
    // A band whose floor was edited below the code floor must not widen the
    // gift's reach — the code floor is a safety rail, not a marketing setting.
    const plan = planStageOffer({
      ...base,
      stage: "t72h",
      cartValueCents: 4_000,
      tiers: [{ minCents: 1_000, stage3: [], stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }], percent: 0 } }],
    });
    expect(plan.minCartCents).toBeGreaterThanOrEqual(RECOVERY_GIFT_MIN_CART_CENTS);
  });

  it("leaves the honest shopper untouched", () => {
    // Somebody who keeps the cart they abandoned clears their own band by
    // construction — the band was chosen from that cart's value.
    for (const cartValueCents of [6_100, 15_000, 38_000, 52_000]) {
      const plan = planStageOffer({ ...base, stage: "t72h", cartValueCents });
      expect(cartValueCents).toBeGreaterThanOrEqual(plan.minCartCents);
    }
  });

  it("keeps the old default for callers that do not pass a floor", () => {
    // Campaign and win-back gifts share this helper and are not band-scoped.
    const config = recoveryGiftConfig([{ slug: "ghk-cu", quantity: 1 }], names);
    expect(config!.minSubtotalCents).toBe(RECOVERY_GIFT_MIN_CART_CENTS);
  });
});
