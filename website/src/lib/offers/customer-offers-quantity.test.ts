import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN OFFER THAT GRANTS MORE THAN ONE UNIT.
//
// The catalogue could name the product but not the count, and quoteOrder wrote
// `quantity: 1` as a literal — so "two free BAC Water" could be promised in an
// email and never shipped. The count now lives on the reward, is written onto
// the row at mint time, and is what the till reads.
//
// IT IS WRITTEN ONTO THE ROW, NOT LOOKED UP FROM THE CATALOGUE AT REDEMPTION.
// Same reason reward_kind, product_slug and percent_off already are: a token
// has a thirty-day life, and the entry it was minted from can be edited or
// retired inside it. What was promised is what redeems.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  /** Simulate a database that has not run the migration adding the column. */
  missingColumn: false,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = () => ({
    async insert(values: Record<string, unknown>) {
      if (db.missingColumn && "quantity" in values) {
        return { error: { code: "42703", message: `column "quantity" of relation "customer_offers" does not exist` } };
      }
      db.inserted.push(values);
      return { error: null };
    },
    select: () => ({
      eq: () => ({ eq: () => ({ is: () => ({ is: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }),
  });
  return { supabaseAdmin: { from }, createServerClient: () => ({ from }) };
});

beforeEach(() => {
  db.inserted = [];
  db.missingColumn = false;
});

describe("the Labor Day two-vial gift", () => {
  it("is a known offer key granting two BAC Water", async () => {
    const { OFFER_CATALOG, isOfferKey } = await import("@/lib/offers/customer-offers");
    const { BAC_WATER_SLUG } = await import("@/lib/bac-water");

    expect(isOfferKey("labor_day_bac_water_2")).toBe(true);
    expect(OFFER_CATALOG.labor_day_bac_water_2.reward).toEqual({
      kind: "free_product", productSlug: BAC_WATER_SLUG, quantity: 2,
    });
  });

  it("states the count in the terms the customer reads", async () => {
    const { describeOfferTerms } = await import("@/lib/offers/customer-offers");

    const terms = describeOfferTerms("labor_day_bac_water_2", "2026-09-15T05:30:00Z");

    // Plural, because two vials described as "a free BAC Water" is the same
    // copy-versus-till mismatch describeOfferTerms exists to prevent.
    expect(terms).toContain("2 free BAC Water are added to your order");
    expect(terms).toContain("September 15");
    expect(terms).toContain("$35");
  });

  it("still says 'a free ...' for the single-unit gifts", async () => {
    const { describeOfferTerms } = await import("@/lib/offers/customer-offers");

    expect(describeOfferTerms("winback_60_free_ghkcu", "2026-12-01T00:00:00Z"))
      .toContain("a free GHK-Cu is added to your order");
  });
});

describe("minting a multi-unit gift", () => {
  it("writes the count onto the row", async () => {
    const { issueCustomerOffer } = await import("@/lib/offers/customer-offers");

    const issued = await issueCustomerOffer({ offerKey: "labor_day_bac_water_2", email: "Buyer@Example.test" });

    expect(issued).not.toBeNull();
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0].quantity).toBe(2);
    expect(db.inserted[0].reward_kind).toBe("free_product");
    expect(db.inserted[0].email).toBe("buyer@example.test");
  });

  it("writes 1 for the single-unit gifts rather than leaving it unsaid", async () => {
    // Explicit beats implicit here: a row that states its count reads the same
    // whether or not the column has a default, and the till has one rule.
    const { issueCustomerOffer } = await import("@/lib/offers/customer-offers");

    await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: "buyer@example.test" });

    expect(db.inserted[0].quantity).toBe(1);
  });

  it("does not write a count for a gift that grants no product", async () => {
    const { issueCustomerOffer } = await import("@/lib/offers/customer-offers");

    await issueCustomerOffer({ offerKey: "winback_60_free_shipping", email: "buyer@example.test" });

    expect(db.inserted[0].quantity ?? null).toBeNull();
  });

  it("REFUSES to mint a multi-unit gift a database cannot record", async () => {
    // The opposite of how the automation_key column degrades, and deliberately
    // so. Losing a provenance breadcrumb costs a report; losing the count means
    // a customer is emailed "two free vials" and shipped one, because the
    // column's default silently answers 1. Better to send nothing.
    db.missingColumn = true;
    const { issueCustomerOffer } = await import("@/lib/offers/customer-offers");

    const issued = await issueCustomerOffer({ offerKey: "labor_day_bac_water_2", email: "buyer@example.test" });

    expect(issued).toBeNull();
    expect(db.inserted).toHaveLength(0);
  });
});

describe("the 72-hour follow-up gift", () => {
  it("grants two vials AND forty percent, in one reward", async () => {
    const { OFFER_CATALOG, isOfferKey } = await import("@/lib/offers/customer-offers");
    const { BAC_WATER_SLUG } = await import("@/lib/bac-water");

    expect(isOfferKey("labor_day_bac_water_2_40")).toBe(true);
    expect(OFFER_CATALOG.labor_day_bac_water_2_40.reward).toEqual({
      kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 40, quantity: 2,
    });
  });

  it("is forty and not thirty, because thirty is worth nothing here", async () => {
    // Buy 2 Get 1 is worth 30% on a ten-unit cart, and the store grants one
    // discount per order — so a 30% gift loses the slot and changes no price.
    // This pins the number against a well-meaning trim.
    const { OFFER_CATALOG } = await import("@/lib/offers/customer-offers");
    const reward = OFFER_CATALOG.labor_day_bac_water_2_40.reward as { percent: number };
    expect(reward.percent).toBeGreaterThan(33.4);
  });

  it("describes both halves in the terms the checkout enforces", async () => {
    const { describeOfferTerms } = await import("@/lib/offers/customer-offers");
    const terms = describeOfferTerms("labor_day_bac_water_2_40", "2026-09-15T16:30:00Z");
    expect(terms).toContain("40% off");
    expect(terms).toContain("2 free BAC Water are added to your order");
    expect(terms).toContain("$35 or more");
  });

  it("outlives the sale it sits beside", async () => {
    const { OFFER_CATALOG } = await import("@/lib/offers/customer-offers");
    // Minted at the 72-hour mark (10 Sept) it must still be live on the 14th,
    // which is when Buy 2 Get 1 ends.
    expect(OFFER_CATALOG.labor_day_bac_water_2_40.ttlDays).toBeGreaterThanOrEqual(5);
  });
});
