import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  planStageOffer,
  RECOVERY_GIFT_COOLDOWN_MS,
  RECOVERY_GIFT_MIN_CART_CENTS,
  type RecoveryOfferContext,
} from "@/lib/cart-recovery-offers";

// ---------------------------------------------------------------------------
// WHO GETS PAID TO COME BACK, AND WHO DOES NOT.
//
// The old ladder gave every cart the same four emails and put its only
// incentive — 5% — on the last one. Two things were wrong with that, and they
// pull in opposite directions.
//
// TOO LITTLE, TOO LATE: 41 emails to real customers produced one click and no
// click-attributed recovery. Nothing in the first three messages gave anyone a
// reason to act, and the fourth arrived after they had already ignored three.
//
// TOO MUCH, TOO INDISCRIMINATELY: the incentive went to everyone who reached
// t72h, including people inside their own reorder cycle who were coming back
// anyway, and including an address on its second and third abandonment.
// Robin Lagrama abandoned the same $303.98 cart twice, took two full sequences,
// opened eight emails, clicked once and never bought — an escalating ladder
// aimed at her a third time is a discount for a habit.
//
// So the incentive is EARNED (nothing until they have ignored two messages that
// cost nothing) and BOUNDED (never to a recent buyer, never twice inside thirty
// days, never on a cart too small to carry it).
//
// A separate and equally important rule: the plan says what a stage MAY carry.
// What the email actually SAYS comes from what was really minted, never from
// this — see cart-recovery.ts. A plan is a request, not a promise.
// ---------------------------------------------------------------------------

const base: RecoveryOfferContext = {
  stage: "t72h",
  cartValueCents: 25_000,
  lastPaidAt: null,
  lastRecoveryCouponAt: null,
  lastRecoveryGiftAt: null,
  discountPercent: 10,
  now: Date.UTC(2026, 8, 7),
};

const at = (ctx: Partial<RecoveryOfferContext>) => planStageOffer({ ...base, ...ctx });

describe("the first two messages never carry an incentive", () => {
  it.each(["t30m", "t12h"] as const)("%s carries nothing at all", (stage) => {
    const plan = at({ stage });
    expect(plan.offerKey).toBeNull();
    expect(plan.coupon).toBe(false);
  });

  // Not an oversight — the reason it is worth stating. A discount on the first
  // reminder is a discount for being interrupted, and it teaches the fastest
  // lesson a store can teach: abandon the cart and wait.
  it("does not carry one even for a large cart from a brand-new customer", () => {
    const plan = at({ stage: "t30m", cartValueCents: 90_000, lastPaidAt: null });
    expect(plan.offerKey).toBeNull();
    expect(plan.coupon).toBe(false);
  });
});

describe("the third message carries the gift, and only the gift", () => {
  it("plans the free BAC Water and no percentage", () => {
    const plan = at({ stage: "t24h" });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
    expect(plan.coupon).toBe(false);
  });

  // THE REASON THE GIFT COMES FIRST AND THE PERCENTAGE SECOND. quoteOrder adds
  // a free-product line independently of the discount slot, while a percentage
  // COMPETES for that slot against the live promotion and loses: with Buy 2 Get
  // 1 running, 10% was measured worth exactly $0 to Heath's and Nikki's carts.
  // A gift lands whatever else is running; a percentage may land nothing.
  it("is the incentive that survives a live promotion", () => {
    expect(at({ stage: "t24h" }).reason).toContain("gift");
  });
});

describe("the last message carries the gift and the discount", () => {
  it("plans both", () => {
    const plan = at({ stage: "t72h" });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
    expect(plan.coupon).toBe(true);
  });

  it("carries no coupon when the operator has set the discount to zero", () => {
    const plan = at({ stage: "t72h", discountPercent: 0 });
    expect(plan.coupon).toBe(false);
    // The gift is a separate decision and survives.
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
  });
});

describe("a customer inside their own reorder cycle is not paid to come back", () => {
  const day = 24 * 3_600_000;

  it.each([
    ["bought yesterday", 1],
    ["bought 29 days ago", 29],
  ])("%s: no gift and no coupon", (_label, daysAgo) => {
    const plan = at({ stage: "t72h", lastPaidAt: base.now - daysAgo * day });
    expect(plan.offerKey).toBeNull();
    expect(plan.coupon).toBe(false);
  });

  it("bought 31 days ago: the ladder applies normally again", () => {
    const plan = at({ stage: "t72h", lastPaidAt: base.now - 31 * day });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
    expect(plan.coupon).toBe(true);
  });

  // The message still goes. It is the last note about this cart either way, and
  // a reminder costs nothing; only the incentive is withheld.
  it("still plans a message, just an empty-handed one", () => {
    expect(at({ stage: "t72h", lastPaidAt: base.now - day }).suppressed).toBe(false);
  });
});

describe("the same address is not gifted twice inside thirty days", () => {
  it("withholds a second gift while the cooldown runs", () => {
    const plan = at({ stage: "t24h", lastRecoveryGiftAt: base.now - RECOVERY_GIFT_COOLDOWN_MS + 1 });
    expect(plan.offerKey).toBeNull();
  });

  it("allows one again once the cooldown has passed", () => {
    const plan = at({ stage: "t24h", lastRecoveryGiftAt: base.now - RECOVERY_GIFT_COOLDOWN_MS - 1 });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
  });

  // THE TWO COOLDOWNS ARE SEPARATE ON PURPOSE. A cart that reaches t24h and
  // then t72h is ONE sequence and gets ONE gift — the t72h gift is the same
  // entitlement, re-offered, not a second one. But a shopper who was given a
  // coupon last month and no gift may still receive a gift, and vice versa,
  // because they are different costs answering different objections.
  it("a recent coupon does not block the gift", () => {
    const plan = at({ stage: "t24h", lastRecoveryCouponAt: base.now - 1000 });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
  });

  it("a recent gift does not block the coupon", () => {
    const plan = at({ stage: "t72h", lastRecoveryGiftAt: base.now - 1000, lastRecoveryCouponAt: null });
    expect(plan.coupon).toBe(true);
    expect(plan.offerKey).toBeNull();
  });

  it("a recent coupon blocks a new coupon", () => {
    const plan = at({ stage: "t72h", lastRecoveryCouponAt: base.now - 1000 });
    expect(plan.coupon).toBe(false);
  });
});

describe("a cart too small to carry the gift does not get one", () => {
  it("withholds it below the floor", () => {
    const plan = at({ stage: "t24h", cartValueCents: RECOVERY_GIFT_MIN_CART_CENTS - 1 });
    expect(plan.offerKey).toBeNull();
    expect(plan.reason).toContain("cart");
  });

  it("grants it exactly at the floor", () => {
    expect(at({ stage: "t24h", cartValueCents: RECOVERY_GIFT_MIN_CART_CENTS }).offerKey)
      .toBe("cart_recovery_bac_water");
  });

  // The vial is $14.99 retail. Shipping one free against a $20 basket is a loss
  // dressed as a recovery, and the shopper most likely to accept it is the one
  // who was going to buy the $20 anyway.
  it("still sends the message, without the gift", () => {
    expect(at({ stage: "t24h", cartValueCents: 1_000 }).suppressed).toBe(false);
  });
});

describe("the plan explains itself", () => {
  it("always states a reason, whatever it decided", () => {
    for (const stage of ["t30m", "t12h", "t24h", "t72h"] as const) {
      expect(at({ stage }).reason.length).toBeGreaterThan(0);
    }
  });

  it("names the blocking rule when it withholds", () => {
    expect(at({ stage: "t72h", lastPaidAt: base.now - 1000 }).reason).toContain("recent");
  });
});

// ---------------------------------------------------------------------------
// CHANGING THE RECOVERY DISCOUNT MUST MOVE NOTHING ELSE.
//
// `cart_recovery.discount_percent` is about to go from 5 to 10, and the word
// "discountPercent" appears on several unrelated config objects — subscribe &
// save (its own default is 10), the referral programme, and the membership
// tiers. They are separate admin_control keys with separate defaults, and a
// change to one must not read as a change to another.
//
// Pinned on the SOURCE, because the risk is not that today's code is wrong —
// it is that a later refactor quietly widens the read.
// ---------------------------------------------------------------------------

describe("the recovery discount's blast radius", () => {
  const sweep = readFileSync(path.resolve(__dirname, "./cart-recovery.ts"), "utf8");

  it("is read in exactly two places, both of them the last stage", () => {
    const uses = [...sweep.matchAll(/config\.discountPercent/g)];
    expect(uses).toHaveLength(2);
  });

  it("reaches only the stage-4 plan and the stage-4 coupon mint", () => {
    expect(sweep).toContain("discountPercent: config.discountPercent");
    expect(sweep).toContain("resolveLastChanceCoupon(cartId, email, config.discountPercent");
  });

  // Stage 3's gift is a product with no percentage at all, so the number cannot
  // reach it even by accident.
  it("stage 3 carries a gift and never a percentage, whatever the setting says", () => {
    for (const discountPercent of [0, 5, 10, 40, 100]) {
      const plan = at({ stage: "t24h", discountPercent });
      expect(plan.coupon).toBe(false);
      expect(plan.offerKey).toBe("cart_recovery_bac_water");
    }
  });

  it("stage 4 carries the gift AND the code once the discount is set", () => {
    const plan = at({ stage: "t72h", discountPercent: 10 });
    expect(plan.offerKey).toBe("cart_recovery_bac_water");
    expect(plan.coupon).toBe(true);
  });

  // The email describes the percentage READ BACK FROM THE COUPON ROW, never the
  // current setting (K-05), so a code minted at 5 still reads as 5 after the
  // setting moves to 10.
  it("the last-chance email describes the coupon row, not the live setting", () => {
    expect(sweep).toContain("discountPercent: coupon ? coupon.percent : 0");
  });
});
