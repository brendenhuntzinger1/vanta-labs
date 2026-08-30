import { describe, expect, it } from "vitest";
import {
  CHECKOUT_SHORT,
  COA_RAIL_COMPLETE,
  COA_RAIL_PARTIAL,
  FULFILMENT_CUTOFF,
  TESTING_SHORT,
  catalogTrustRail,
} from "@/lib/trust-claims";

// ---------------------------------------------------------------------------
// THE COA CLAIM MUST FOLLOW THE DATA.
//
// "Batch-Tested COAs" was hard-coded into the catalogue rail. It asserts
// coverage across the entire catalogue, and it rested on a launch precondition
// rather than on anything the application checks — so publishing one product
// without a COA made a testing claim false on every catalogue page, silently,
// with nothing to catch it.
//
// These tests pin the rule that replaced it: the coverage wording appears only
// when coverage is established, and the default direction is to under-claim.
// ---------------------------------------------------------------------------
describe("catalogTrustRail", () => {
  const coaItem = (everyProductHasCoa?: boolean) =>
    catalogTrustRail(everyProductHasCoa).find((item) => item.bottom === "COAs");

  it("claims catalogue-wide coverage ONLY when every product has a COA", () => {
    expect(coaItem(true)).toEqual(COA_RAIL_COMPLETE);
    expect(coaItem(true)?.top).toBe("Batch-Tested");
  });

  it("drops to the weaker, always-true claim when coverage is incomplete", () => {
    expect(coaItem(false)).toEqual(COA_RAIL_PARTIAL);
    expect(coaItem(false)?.top).not.toBe("Batch-Tested");
  });

  it("under-claims by default, so a caller that forgets the flag cannot over-claim", () => {
    expect(coaItem()).toEqual(COA_RAIL_PARTIAL);
  });

  it("keeps both claims pointing at the COA library, so the link never disappears", () => {
    expect(COA_RAIL_COMPLETE.href).toBe("/coa-library");
    expect(COA_RAIL_PARTIAL.href).toBe("/coa-library");
  });

  it("changes nothing else about the rail", () => {
    const complete = catalogTrustRail(true);
    const partial = catalogTrustRail(false);
    expect(complete).toHaveLength(5);
    expect(partial).toHaveLength(5);
    // Every position except the COA slot is identical in both.
    complete.forEach((item, index) => {
      if (item.bottom === "COAs") return;
      expect(partial[index]).toEqual(item);
    });
  });

  it("states the testing PROGRAMME in the assay slot, and never a figure", () => {
    // THIS TEST USED TO PIN THE BUG. It asserted the slot was exactly
    // `{ top: "≥99%", bottom: "Purity" }` and called it "the owner's
    // attestation… a statement about the programme" — but a number IS the
    // per-vial claim, which is why trust-claims.ts says no hard-coded figure
    // appears anywhere in the UI and why K-21 stripped one from the home page.
    // Pinning the exact string meant the rule and its own guard disagreed, and
    // the guard was the one being run.
    //
    // The programme-level claim is TESTING_SHORT. The figure stays where it is
    // earned: rendered from a product's own record behind hasVerifiedTesting,
    // which requires both a purity value and a COA on file.
    for (const everyProductHasCoa of [true, false]) {
      const assay = catalogTrustRail(everyProductHasCoa).find((item) => item.icon === "purity");
      expect(assay).toBeDefined();
      expect(`${assay!.top} ${assay!.bottom}`).toBe(TESTING_SHORT);
      expect(`${assay!.top} ${assay!.bottom}`).not.toMatch(/\d/);
      // It links nowhere — it is a statement, not a route to evidence.
      expect(assay?.href).toBeUndefined();
    }
  });

  it("qualifies the same-day promise with its cutoff and its weekdays", () => {
    // A bare "Same-Day / Fulfillment" promises same-day shipping to someone
    // ordering at 11pm on a Sunday. trust-claims.ts calls that "a dispute
    // waiting to happen" and the rail shipped it anyway, because the only
    // assertion of the qualifier was on FULFILMENT_DETAIL — a constant the rail
    // did not use.
    const fulfilment = catalogTrustRail(true).find((item) => item.icon === "fulfillment");
    expect(fulfilment).toBeDefined();
    const claim = `${fulfilment!.top} ${fulfilment!.bottom}`;
    expect(claim).toContain(FULFILMENT_CUTOFF);
    expect(claim).toContain("Mon");
    // …and it leads to the policy that states the transit caveat in full.
    expect(fulfilment!.href).toBe("/legal/shipping");
  });

  it("names each claim exactly once, in the canonical wording", () => {
    // The rail carried "Secure Checkout" while trust-claims.ts already named
    // that claim "Encrypted Checkout" — two wordings of one claim, which is the
    // single thing this module exists to prevent.
    const labels = catalogTrustRail(true).map((item) => `${item.top} ${item.bottom}`);
    expect(labels).toContain(CHECKOUT_SHORT);
    expect(labels).toContain(TESTING_SHORT);
  });
});
