import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  COA_SHORT,
  FULFILMENT_DETAIL,
  FULFILMENT_SHORT,
  TESTING_SHORT,
  catalogTrustRail,
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

const readRaw = (path: string) => readFileSync(path, "utf8");

/**
 * Source with its COMMENTS REMOVED.
 *
 * These assertions scan file text, which cannot by itself tell a rendered claim
 * from a comment about one — and this repository documents a removed claim by
 * naming it, right where it used to be. Scanning raw text therefore makes the
 * fix for a banned claim indistinguishable from the claim, so the honest way to
 * record why "256-bit SSL" is gone would re-fail the test that removed it.
 *
 * Only the two comment forms this codebase writes are stripped: block comments
 * (`/* … *\/`, JSX `{/* … *\/}` included, since the braces fall outside) and
 * whole lines that are a line comment. A mid-line `//` is deliberately NOT
 * treated as a comment, because that is what a URL looks like.
 */
const read = (path: string) =>
  readRaw(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

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

// ---------------------------------------------------------------------------
// TWO WAYS THIS SUITE PASSED WHILE THE CLAIMS IT BANS WERE ON THE SITE.
//
// 1. CASE. `toContain("Full batch traceability")` is case-sensitive, and
//    checkout/page.tsx rendered "…encrypted payment, and full batch
//    traceability." mid-sentence. The banned claim sat on the LAST SCREEN
//    BEFORE PAYMENT and this file reported green. Every comparison below now
//    folds case, which is how a human reads a claim.
//
// 2. COVERAGE. The surfaces list named five files. "256-bit SSL" — banned by
//    name, three lines down — was in cart-drawer.tsx, which is reachable from
//    every page, and "COA verified" was on product-card.tsx, rendered for every
//    product in the grid. Neither file was looked at, so neither claim existed
//    as far as this suite was concerned.
//
// The lesson is the general one: a guard that names its subjects will only ever
// be as complete as that list. So the list now covers the customer-facing
// surfaces that actually render trust copy, and adding a new one is the same
// one-line change as adding a page.
// ---------------------------------------------------------------------------
describe("the claims that were never substantiated are gone", () => {
  const surfaces = [
    "src/app/page.tsx",
    "src/app/checkout/page.tsx",
    "src/app/products/products-client.tsx",
    "src/components/site-footer.tsx",
    "src/components/age-gate.tsx",
    "src/components/product-detail-client.tsx",
    "src/components/product-card.tsx",
    "src/components/cart-drawer.tsx",
    "src/components/catalog-trust-rail.tsx",
    "src/app/cart/cart-client.tsx",
  ];

  /** Case-folded containment — the reason two banned claims shipped. */
  const contains = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase());

  it("no COA-EXISTENCE claim is made outside the evidence gate", () => {
    // This is the claim that is currently FALSE: "COA Documented", "COA Verified"
    // and "COA on every lot" all assert that documents exist, and ledger finding
    // F-006 established that none do. Any surface asserting one must get it from
    // trustPoints(), which omits it unless the caller can show one.
    for (const path of surfaces) {
      const source = read(path);
      for (const claim of ["COA Verified", "COA on every lot", "Batch-level Certificates"]) {
        expect(contains(source, claim), `${path} hard-codes "${claim}"`).toBe(false);
      }
      // COA_SHORT asserts a document EXISTS, so it must be gated on evidence.
      // trustPoints() is one such gate. hasCoa() is the other, and it is the
      // stronger of the two: it is per-product and it rejects the placeholders
      // ("pending", "TBD", " ") that operators actually type. product-card.tsx
      // used plain `product.coaUrl ?` truthiness for the badge while gating the
      // COA LINK forty lines below on hasCoa() — so a card asserted a document
      // and offered nothing to open.
      if (source.includes("COA_SHORT")) {
        expect(source, `${path} must gate COA_SHORT on trustPoints() or hasCoa()`)
          .toMatch(/trustPoints\(|hasCoa\(/);
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
      expect(contains(read(path), claim), `${path} carries "${claim}"`).toBe(false);
    }
  });

  it("the catalogue RAIL carries no purity figure either", () => {
    // The strip assertion above covers trustPoints(). It did not cover
    // catalogTrustRail(), which is the busiest buying surface in the store and
    // which carried "≥99% / Purity" — a hard-coded figure inside the very
    // module whose TESTING block says none appears anywhere in the UI.
    for (const item of catalogTrustRail(true)) {
      expect(`${item.top} ${item.bottom}`, `rail item "${item.top} ${item.bottom}"`)
        .not.toMatch(/\d+\s*%/);
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

  it("the canonical promise names its cutoff and its weekday qualifier", () => {
    // An unqualified "same-day fulfilment" promises same-day shipping to someone
    // ordering at 11pm on a Sunday, which is a dispute waiting to happen.
    expect(FULFILMENT_DETAIL).toContain("2PM ET");
    expect(FULFILMENT_DETAIL).toContain("Mon");
  });

  it("and so does the one on the catalogue rail", () => {
    // This assertion existed only for FULFILMENT_DETAIL, a constant the rail
    // did not use — so the rail shipped a bare "Same-Day / Fulfillment", which
    // is precisely the unqualified promise the line above exists to forbid.
    const fulfilment = catalogTrustRail(true).find((item) => item.icon === "fulfillment");
    expect(fulfilment, "the rail must carry a fulfilment item").toBeDefined();
    const claim = `${fulfilment!.top} ${fulfilment!.bottom}`;
    expect(claim, "the rail's same-day claim must name its cutoff").toContain("2PM ET");
    expect(claim, "the rail's same-day claim must name its weekday qualifier").toContain("Mon");
  });
});
