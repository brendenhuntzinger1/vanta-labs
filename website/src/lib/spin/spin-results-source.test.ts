import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SPIN_PRIZES } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// TWO THINGS THE ADMIN WHEEL PANEL MUST NOT GET WRONG.
//
// 1. STOCK LIVES ON THE DOSE, NOT THE PRODUCT. Every prize product's parent row
//    reads inventory_quantity 0 in production — KLOW, Semax, MT-2, GLP-2, GLP-3
//    and CJC all do — while the real count sits on the dose beneath it. A panel
//    that counted the parent would show "0" against every prize, the operator
//    would learn to ignore the column within a day, and the one genuinely thin
//    prize (Tesamorelin, five units) would be invisible among the false zeros.
//
// 2. RESULTS MATCH ON REWARD IDENTITY, NOT WEDGE INDEX. The stored offer records
//    the reward — deliberately, so editing the wheel cannot change what an
//    already-awarded prize means. Matching results by index would re-label
//    history the first time a wedge moved.
//
// Source assertions because both live in server components that need a database
// to run; the browser pass on the panel is what confirms the rendering.
// ---------------------------------------------------------------------------

const PANEL_PAGE = readFileSync("src/app/admin/email/page.tsx", "utf8");
const RESULTS = readFileSync("src/lib/spin/spin-results.ts", "utf8");

describe("admin wheel panel data", () => {
  it("reads prize stock from product_doses, not from the product row", () => {
    expect(PANEL_PAGE).toContain('.from("product_doses")');
    // The parent read exists only to map slug -> id. If it ever selects an
    // inventory figure, someone has started counting the wrong row.
    const parentSelect = /\.from\("products"\)\s*\.select\(([^)]*)\)/.exec(PANEL_PAGE)?.[1] ?? "";
    expect(parentSelect).not.toMatch(/inventory_quantity/);
  });

  it("picks the same dose the till would grant: default first, then position", () => {
    expect(PANEL_PAGE).toMatch(/is_default\s*\?\s*-1\s*:\s*Number\(row\.position/);
  });

  it("treats an untracked dose as unlimited rather than as zero", () => {
    // track_inventory false means the storefront ignores the count entirely.
    // Reporting it as a number would show "0 left" on a product that sells.
    expect(PANEL_PAGE).toMatch(/track_inventory === true \? Math\.max\(0[\s\S]{0,80}: null/);
  });

  it("matches results on reward identity rather than wedge index", () => {
    expect(RESULTS).toContain("function rewardIdentity");
    expect(RESULTS).toContain("function prizeIdentity");
    expect(RESULTS).not.toMatch(/sliceIndex|wedgeIndex/);
  });

  it("groups a reward that sits on two wedges into one row", () => {
    // 15% off is on two wedges and must report as one prize at 2-in-16, the
    // same grouping the customer-facing disclosure uses.
    const fifteens = SPIN_PRIZES.filter((p) => p.reward.kind === "percent" && p.reward.percent === 15);
    expect(fifteens.length).toBe(2);
    expect(RESULTS).toContain("if (seen.has(identity)) continue;");
    expect(RESULTS).toMatch(/wedges = SPIN_PRIZES\.filter/);
  });

  it("reports a failed read as degraded instead of as zeroes", () => {
    // A results card that prints 0 spins because the query failed is worse
    // than one that prints nothing: it reads as fact beside a Send button.
    expect(RESULTS).toContain("degraded: true");
    expect(readFileSync("src/components/admin-wheel-panel.tsx", "utf8"))
      .toMatch(/r\.degraded \?[\s\S]{0,160}not real/);
  });
});
