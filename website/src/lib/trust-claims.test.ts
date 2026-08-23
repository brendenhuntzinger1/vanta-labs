import { describe, expect, it } from "vitest";
import { COA_RAIL_COMPLETE, COA_RAIL_PARTIAL, catalogTrustRail } from "@/lib/trust-claims";

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

  it("keeps the purity claim at its recorded programme-level wording", () => {
    // NOT a coverage claim, and deliberately left alone by this change.
    //
    // "≥99% Purity" is the owner's attestation recorded in trust-claims.ts
    // (2026-08) that every product is third-party tested to that standard. It
    // is a statement about the programme. A purity figure about a PARTICULAR
    // vial is a different claim and is rendered only from that product's own
    // record, behind hasVerifiedTesting, which requires both a purity value and
    // a COA on file.
    //
    // Pinned exactly so the two cannot be quietly merged: if someone changes
    // this wording they have to come here and say why.
    for (const everyProductHasCoa of [true, false]) {
      const purity = catalogTrustRail(everyProductHasCoa).find((item) => item.bottom === "Purity");
      expect(purity).toEqual({ top: "≥99%", bottom: "Purity", icon: "purity" });
      // It links nowhere — it is a statement, not a route to evidence.
      expect(purity?.href).toBeUndefined();
    }
  });
});
