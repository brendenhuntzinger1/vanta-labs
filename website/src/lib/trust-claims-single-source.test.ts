import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  COA_SHORT,
  FULFILMENT_DETAIL,
  FULFILMENT_SHORT,
  TESTING_SHORT,
  trustPoints,
  trustPointsDetailed,
} from "@/lib/trust-claims";

// ---------------------------------------------------------------------------
// K-21. EVERY CUSTOMER-FACING CLAIM COMES FROM THE ONE MODULE, AND ONLY WHEN
// SOMETHING SUBSTANTIATES IT.
//
// src/lib/trust-claims.ts exists because these strings were copied into eight
// files and drifted into four versions of one fulfilment promise. Its rule:
// "a claim earns its place by being checkable against configuration, published
// policy, or an explicit decision by the owner that is recorded in the comment
// next to it. Nothing goes in because it would convert well."
//
// Two pages had re-created local copies and drifted anyway:
//
//   src/app/page.tsx        hard-coded "99%+ Purity" — which the module's own
//                           text says "no hard-coded 99% appears anywhere in the
//                           UI" — plus "Third-Party Batch Verified" (stronger
//                           than the canonical "Third-Party Tested") and "Based
//                           in the USA" (no provenance anywhere).
//
//   src/app/checkout/page.tsx  "Ships within 1 business day" — word for word one
//                           of the four drifted variants the module's header
//                           lists as the reason it was created — plus
//                           "256-bit SSL encrypted", a certification claim the
//                           module deliberately declines to make, and "Full batch
//                           traceability", made site-wide with zero COAs on file.
//
// The drifted fulfilment line sat on the LAST SCREEN BEFORE PAYMENT, which is the
// version a customer would quote in a dispute.
//
// The COA claim is the one that has to be conditional rather than merely correct:
// "COA Documented" asserts that documents exist, and ledger finding F-006
// established that none do. A surface that cannot substantiate it must not make
// it — so the strip is now a function of the evidence a caller actually holds.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

describe("the trust strip is a function of evidence, not a constant", () => {
  it("omits the COA claim when the caller cannot show a published COA", () => {
    expect(trustPoints({ coaPublished: false })).not.toContain(COA_SHORT);
    // A caller that does not know must not assert it either.
    expect(trustPoints({})).not.toContain(COA_SHORT);
  });

  it("includes the COA claim only when a COA is actually published", () => {
    expect(trustPoints({ coaPublished: true })).toContain(COA_SHORT);
  });

  it("always carries the claims that do not depend on a document", () => {
    const points = trustPoints({ coaPublished: false });
    expect(points).toContain(TESTING_SHORT);
    expect(points).toContain(FULFILMENT_SHORT);
  });

  it("keeps the detailed variant in step with the short one", () => {
    for (const coaPublished of [true, false]) {
      expect(trustPointsDetailed({ coaPublished }).map((p) => p.label))
        .toEqual(trustPoints({ coaPublished }));
    }
  });
});

describe("no page re-declares its own trust claims", () => {
  it.each([
    "src/app/page.tsx",
    "src/app/checkout/page.tsx",
  ])("%s does not declare a local TRUST_POINTS", (path) => {
    expect(read(path)).not.toMatch(/const TRUST_POINTS\s*=/);
  });

  it.each([
    "src/app/page.tsx",
    "src/app/checkout/page.tsx",
    "src/components/site-footer.tsx",
    "src/components/age-gate.tsx",
  ])("%s sources its claims from @/lib/trust-claims", (path) => {
    expect(read(path)).toContain("@/lib/trust-claims");
  });
});

describe("the claims that were never substantiated are gone", () => {
  const surfaces = [
    "src/app/page.tsx",
    "src/app/checkout/page.tsx",
    "src/components/site-footer.tsx",
    "src/components/age-gate.tsx",
    "src/components/product-detail-client.tsx",
  ];

  it("no COA-EXISTENCE claim is made outside the evidence gate", () => {
    // This is the claim that is currently FALSE: "COA Documented", "COA Verified"
    // and "COA on every lot" all assert that documents exist, and ledger finding
    // F-006 established that none do. Any surface asserting one must get it from
    // trustPoints(), which omits it unless the caller can show one.
    for (const path of surfaces) {
      const source = read(path);
      for (const claim of ["COA Verified", "COA on every lot", "Batch-level Certificates"]) {
        expect(source, `${path} hard-codes "${claim}"`).not.toContain(claim);
      }
      if (source.includes("COA_SHORT")) {
        expect(source, `${path} must source COA_SHORT through the gate`).toMatch(/trustPoints\(/);
      }
    }
  });

  it("the trust STRIP carries no purity figure — that is a per-vial claim", () => {
    // trust-claims.ts is explicit that a number attached to purity is a statement
    // about a specific vial, rendered only from that product's own purityResult
    // and COA. The strip is catalogue-wide, so it may not carry one.
    for (const label of trustPoints({ coaPublished: true })) {
      expect(label).not.toMatch(/\d+\s*%/);
    }
  });

  it.each([
    ["Full batch traceability", "a compliance claim with no document behind it"],
    ["256-bit SSL", "a certification claim trust-claims.ts deliberately declines to make"],
    ["Third-Party Batch Verified", "stronger than the canonical TESTING_SHORT"],
    ["Based in the USA", "no recorded provenance anywhere in the codebase"],
  ])("%s is gone — %s", (claim) => {
    for (const path of surfaces) {
      expect(read(path), path).not.toContain(claim);
    }
  });
});

describe("one fulfilment promise, everywhere", () => {
  it("the drifted variant the module was created to kill is gone", () => {
    for (const path of ["src/app/page.tsx", "src/app/checkout/page.tsx", "src/components/site-footer.tsx"]) {
      expect(read(path), path).not.toContain("Ships within 1 business day");
      expect(read(path), path).not.toContain("Ships within one business day");
      expect(read(path), path).not.toContain("Ships in 1 business day");
    }
  });

  it("the homepage FAQ makes the canonical promise, not the retired 'one business day' one", () => {
    const page = read("src/app/page.tsx");
    expect(page).not.toContain("within one business day");
    // The answer is built from the module's constants, so it cannot drift again.
    expect(page).toMatch(/FULFILMENT_(CUTOFF|SENTENCE)/);
  });

  it("the canonical promise names its cutoff and its weekday qualifier", () => {
    // An unqualified "same-day fulfilment" promises same-day shipping to someone
    // ordering at 11pm on a Sunday, which is a dispute waiting to happen.
    expect(FULFILMENT_DETAIL).toContain("2PM ET");
    expect(FULFILMENT_DETAIL).toContain("Mon");
  });
});
