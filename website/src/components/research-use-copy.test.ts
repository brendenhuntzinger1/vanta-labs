import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// RESEARCH-USE COPY GUARD
//
// These products are sold research-use-only. Two families of phrasing quietly
// undo that positioning wherever they appear in customer-facing copy:
//
//   1. Preparation-for-use language ("reconstitution", "dilute", "mix with").
//      Reconstitution is the step that only matters if a person intends to use
//      the material. Publishing it is preparation guidance, whatever the
//      surrounding disclaimer says.
//
//   2. Second-person use framing ("your dose", "your protocol"). It addresses
//      the reader as the person taking the compound rather than as a lab
//      buying a material.
//
// Both had reached the storefront by accretion, one sentence at a time, with
// every individual addition looking harmless. This test is the ratchet: the
// strings are asserted against component SOURCE so a reviewer sees the
// violation in the diff rather than in a browser six weeks later.
//
// Internal identifiers are deliberately NOT covered: ProductDose,
// selectedDoseId, requiresReconstitution and the reconstitution_note column are
// the data model, never shown to a customer (the visible variant label is "Vial
// Size"). The patterns below are word-anchored so a camelCase identifier cannot
// trip them — a guard that fires on `requiresReconstitution` would be edited
// away within a week, and then it would be protecting nothing.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip JSX comments and line comments so the guard reads rendered copy, not
 *  the notes explaining why a rule exists — this very file's rationale would
 *  otherwise trip its own assertions. */
function renderedCopy(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const SURFACES = [
  "src/components/product-detail-client.tsx",
  "src/components/product-card.tsx",
  "src/components/bac-water-upsell.tsx",
  "src/app/page.tsx",
];

describe("customer-facing copy keeps the research-use boundary", () => {
  it("never publishes preparation-for-use guidance", () => {
    for (const file of SURFACES) {
      const copy = renderedCopy(read(file));
      expect.soft(copy, `${file} renders reconstitution guidance`).not.toMatch(
        /\breconstitut(?:e|ion|ing)/i,
      );
      expect.soft(copy, `${file} renders dilution guidance`).not.toMatch(
        /\bmix with\b|\bdraw up\b/i,
      );
    }
  });

  it("never addresses the reader as the person using the compound", () => {
    for (const file of SURFACES) {
      const copy = renderedCopy(read(file));
      expect
        .soft(copy, `${file} uses second-person use framing`)
        // Up to two intervening words. Anchoring "your" directly to the noun
        // looked correct and caught nothing: the phrasing actually shipped was
        // "your selected dose", and an adjective was enough to walk straight
        // through the guard.
        .not.toMatch(
          /\byour\s+(?:\w+\s+){0,2}(?:dose|doses|protocol|cycle|regimen)\b/i,
        );
    }
  });

  it("says BAC Water, never the full compound name", () => {
    // Owner decision: the storefront says "BAC Water" everywhere a customer can
    // read it. Comments, slugs and the isBacWater() detector are exempt on
    // purpose — the detector matches the stored product name and slug, so
    // "correcting" its vocabulary would silently switch the whole cross-sell
    // off rather than rename anything.
    for (const file of SURFACES) {
      expect
        .soft(renderedCopy(read(file)), `${file} shows the full compound name`)
        .not.toMatch(/bacteriostatic/i);
    }
  });

  it("keeps the Reconstitution row off the public specification table", () => {
    // The row rendered product.reconstitutionNote straight into the public
    // spec list, so anything an operator typed in Admin shipped unreviewed.
    const pdp = read("src/components/product-detail-client.tsx");
    expect(pdp).not.toMatch(/\["Reconstitution",/);
  });
});
