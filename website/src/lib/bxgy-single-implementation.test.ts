import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import { REDEEMED_STATUSES } from "@/lib/bxgy-promotions";

// ---------------------------------------------------------------------------
// ONE ENGINE, NOT SIX IMPLEMENTATIONS.
//
// The brief for these promotions was explicit: make the Buy X Get Y engine
// reusable and configurable rather than hard-coding five separate ones. That is
// a property of the SHAPE of the code, not of any total, so no arithmetic test
// can protect it. These do.
//
// The specific regression they exist to stop is the one this feature replaced:
// quote-order.ts and cart-context.tsx each carried their own
// `Math.floor(units / 4)` loop, and the two had to be kept byte-identical by
// hand because a divergence shows a shopper a total the card is not charged.
// Both now call the shared engine, and nothing may quietly grow a second copy.
// ---------------------------------------------------------------------------

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const PRICING_SITES = [
  "src/lib/quote-order.ts",
  "src/components/cart-context.tsx",
];

describe("the Buy X Get Y arithmetic lives in exactly one module", () => {
  it.each(PRICING_SITES)("%s prices promotions through the shared engine", (file) => {
    const source = read(file);
    expect(source).toContain("selectPromotionForCart");
    expect(source).toContain("@/lib/bxgy-engine");
  });

  it.each(PRICING_SITES)("%s no longer counts reward groups itself", (file) => {
    const source = read(file);
    // The old hand-written promotion loop, in either file's spelling.
    expect(source).not.toMatch(/Math\.floor\(\s*expandedPrices\.length/);
    expect(source).not.toMatch(/freeItemCount/);
    // And no second copy of the group-size division under any name.
    expect(source).not.toMatch(/\.length\s*\/\s*4\s*\)/);
  });

  it("no pricing path reads the legacy Buy 3 Get 1 flag as its own rule", () => {
    // The flag still exists and still switches that promotion on — it is
    // reconciled onto the promotion in bxgy-config.ts. What must not come back
    // is a pricing branch keyed on it, because five of the six promotions would
    // be invisible to that branch.
    for (const file of PRICING_SITES) {
      expect(read(file)).not.toContain("promoBuy3Get1Enabled");
    }
  });
});

describe("the promotions from the brief are configurations, not code", () => {
  it("ships all five requested promotions plus the store's original one", () => {
    const byName = new Map(defaultBxgyPromotions().map((promotion) => [promotion.name, promotion]));

    // Buy 2 Get 1 Free — buy any 2 eligible items, cheapest is free.
    expect(byName.get("Buy 2 Get 1 Free")).toMatchObject({ buyQuantity: 2, getQuantity: 1, rewardPercent: 100 });
    // Buy 3 Get 2 Free.
    expect(byName.get("Buy 3 Get 2 Free")).toMatchObject({ buyQuantity: 3, getQuantity: 2, rewardPercent: 100 });
    // Buy 1 Get 1 Free — BOGO.
    expect(byName.get("Buy 1 Get 1 Free")).toMatchObject({ buyQuantity: 1, getQuantity: 1, rewardPercent: 100 });
    // Buy 1 Get 1 50% Off — second eligible item half price.
    expect(byName.get("Buy 1 Get 1 50% Off")).toMatchObject({ buyQuantity: 1, getQuantity: 1, rewardPercent: 50 });
    // Buy 2 Get 1 50% Off.
    expect(byName.get("Buy 2 Get 1 50% Off")).toMatchObject({ buyQuantity: 2, getQuantity: 1, rewardPercent: 50 });
    // And the promotion the store already ran, preserved unchanged.
    expect(byName.get("Buy 3 Get 1 Free")).toMatchObject({ buyQuantity: 3, getQuantity: 1, rewardPercent: 100 });
  });

  it("ships every one of them switched OFF, so installing this changes no price", () => {
    expect(defaultBxgyPromotions().every((promotion) => !promotion.enabled)).toBe(true);
  });

  it("ships Buy 1 Get 1 Free excluding the two SKUs it cannot afford", () => {
    // A guard rail, not a lock: an admin can remove the exclusion. What it
    // stops is switching BOGO on and discovering the loss at the pay button.
    const bogo = defaultBxgyPromotions().find((p) => p.id === "buy-1-get-1-free");
    expect(bogo?.eligibility.excludeSlugs.sort()).toEqual(["cerebrolysin", "pinealon"]);
    // And only that one — Buy 3 Get 2 pays its way on both, so excluding them
    // there would cost sales for no reason.
    const buy3get2 = defaultBxgyPromotions().find((p) => p.id === "buy-3-get-2-free");
    expect(buy3get2?.eligibility.excludeSlugs).toEqual([]);
  });

  it("gives every promotion the same full set of controls", () => {
    for (const promotion of defaultBxgyPromotions()) {
      expect(promotion).toHaveProperty("eligibility.includeSlugs");
      expect(promotion).toHaveProperty("eligibility.excludeSlugs");
      expect(promotion).toHaveProperty("startsAt");
      expect(promotion).toHaveProperty("endsAt");
      expect(promotion).toHaveProperty("maxRedemptions");
      expect(promotion).toHaveProperty("perCustomerLimit");
      expect(promotion).toHaveProperty("maxRewardUnitsPerOrder");
      expect(promotion).toHaveProperty("stackWithCoupon");
      expect(promotion).toHaveProperty("stackWithBundlePricing");
    }
  });
});

describe("redemptions are counted, never incremented", () => {
  it("derives a redemption from order status, never from a stored counter", () => {
    // Liveness is computed in SQL from the order's payment_status. A counter
    // column would need a decrement on every refund and cancellation path, and
    // the first one missed is silent.
    const sql = read("src/lib/sql/bxgy-redemption-claims.sql");
    expect(sql).toMatch(/payment_status in \('paid', 'partially_refunded'\)/);
    expect(sql).toMatch(/payment_status in \('canceled', 'cancelled', 'payment_failed', 'refunded'\)/);
    expect(read("src/lib/bxgy-promotions.ts")).not.toMatch(/redemptions_count/);
  });

  it("keeps the JS redeemed-status list in step with the SQL that enforces it", () => {
    // Two lists, one rule. The SQL is authoritative; this catches the day one
    // of them gains a status the other does not.
    const sql = read("src/lib/sql/bxgy-redemption-claims.sql");
    for (const status of REDEEMED_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it("enforces the limit under a lock, in one function, before the order exists", () => {
    const sql = read("src/lib/sql/bxgy-redemption-claims.sql");
    // The lock is what makes the count-and-insert atomic. Its absence is
    // proved to break the concurrency suite (bxgy-redemption-claims.test.ts).
    expect(sql).toContain("pg_advisory_xact_lock");
    // Exactly one lock acquisition: a transaction taking one lock cannot
    // deadlock, and a second would reintroduce the possibility.
    expect(sql.match(/pg_advisory_xact_lock/g)).toHaveLength(1);
  });

  it("claims before writing the order, on BOTH checkout lanes", () => {
    for (const file of ["src/lib/payment-service.ts", "src/app/api/checkout/express/authorize/route.ts"]) {
      const source = read(file);
      const claimAt = source.indexOf("claimPromotionRedemption");
      const insertAt = source.indexOf("insertOrderRow(orderRow)");
      expect(claimAt, `${file} must claim a redemption`).toBeGreaterThan(-1);
      expect(insertAt, `${file} must insert the order`).toBeGreaterThan(-1);
      // A claim taken AFTER the insert leaves an order that has to be undone.
      expect(claimAt, `${file} must claim before inserting the order`).toBeLessThan(insertAt);
    }
  });

  it("never counts with head:true, which would hide the missing-column error", () => {
    // A HEAD response has no body, so PostgREST's 42703 never arrives and the
    // missing-migration guard cannot fire. Found on the wire against a real
    // PostgREST after the unit tests passed, because the mock returned a
    // structured error the HEAD request would never have delivered.
    expect(read("src/lib/bxgy-promotions.ts")).not.toMatch(/\.select\([^)]*head:\s*true/);
  });

  it("records the promotion on the order row so the count has something to read", () => {
    expect(read("src/lib/quote-order.ts")).toContain("promotion_id");
    expect(read("src/lib/sql/bxgy-promotions.sql")).toContain("add column if not exists promotion_id");
  });
});
