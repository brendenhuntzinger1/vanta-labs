import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: { from: () => ({}) } }));

import { withoutCostFields } from "@/lib/admin-products";
import { canViewProfit } from "@/lib/admin-roles";

// ---------------------------------------------------------------------------
// THE LOWEST-PRIVILEGE ADMIN ROLE MAY NOT READ THE STORE'S MARGINS.
//
// admin-roles.ts:53-58 states the rule and the reason in its own words: profit
// and COGS-derived figures are manager+ "so the lowest-privilege staff role
// can't read the store's margins".
//
// Every WRITE path under /api/admin/products honoured it — POST and PATCH both
// call canManageProducts — while both READ paths checked only that a session
// existed. So a `staff` session could GET the entire catalogue with per-SKU unit
// cost, supplier margin, suggested retail and the per-product profit floor in
// the response body: exactly the data the control exists to withhold, available
// to the role it was written to withhold it from.
//
// Refusing the read outright would be the wrong trade — staff need the
// catalogue for fulfilment and support, and none of that needs a cost — so the
// row is served with the money fields removed.
//
// REMOVED, NOT ZEROED. A 0 reads as "this costs nothing" and would feed a margin
// calculation downstream as though it were a measurement. Absent is what it is.
// ---------------------------------------------------------------------------

describe("who is allowed to see cost", () => {
  it("keeps profit visibility at manager and above", () => {
    expect(canViewProfit("staff")).toBe(false);
    expect(canViewProfit("manager")).toBe(true);
    expect(canViewProfit("super_admin")).toBe(true);
  });
});

describe("stripping cost from a product row", () => {
  const row = () => ({
    id: "p1",
    name: "BPC-157",
    priceCents: 5900,
    productCostCents: 2614,
    suggestedRetailCents: 7900,
    minSellingPriceCents: 3900,
    minProfitCents: 800,
    minProfitPercent: 20,
    doses: [
      { id: "d1", label: "5mg", priceCents: 5900, productCostCents: 2614 },
      { id: "d2", label: "10mg", priceCents: 8900, productCostCents: 3900 },
    ],
  });

  it("removes every cost and margin field from the product", () => {
    const [out] = withoutCostFields([row()]);
    for (const key of [
      "productCostCents",
      "suggestedRetailCents",
      "minSellingPriceCents",
      "minProfitCents",
      "minProfitPercent",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("removes cost from every dose, which is where per-SKU COGS actually lives", () => {
    const [out] = withoutCostFields([row()]);
    const doses = (out as { doses: Array<Record<string, unknown>> }).doses;
    expect(doses).toHaveLength(2);
    for (const dose of doses) expect(dose).not.toHaveProperty("productCostCents");
  });

  it("leaves everything a staff member legitimately needs", () => {
    const [out] = withoutCostFields([row()]);
    expect(out).toMatchObject({ id: "p1", name: "BPC-157", priceCents: 5900 });
    const doses = (out as { doses: Array<Record<string, unknown>> }).doses;
    expect(doses[0]).toMatchObject({ id: "d1", label: "5mg", priceCents: 5900 });
  });

  it("does not invent a zero where a cost was removed", () => {
    const [out] = withoutCostFields([row()]);
    expect((out as Record<string, unknown>).productCostCents).toBeUndefined();
    expect("productCostCents" in (out as object)).toBe(false);
  });

  it("copes with a product that carries no doses", () => {
    const [out] = withoutCostFields([{ id: "p2", name: "Recon Water", productCostCents: 100 }]);
    expect(out).not.toHaveProperty("productCostCents");
    expect(out).toMatchObject({ id: "p2" });
  });
});

describe("both read routes apply it", () => {
  const list = readFileSync(resolve(process.cwd(), "src/app/api/admin/products/route.ts"), "utf8");
  const detail = readFileSync(resolve(process.cwd(), "src/app/api/admin/products/[productId]/route.ts"), "utf8");

  it("gates the catalogue list on canViewProfit", () => {
    expect(list).toContain("canViewProfit(session.role) ? rows : withoutCostFields(");
  });

  it("gates the single-product read on canViewProfit", () => {
    expect(detail).toContain("canViewProfit(session.role)");
    expect(detail).toContain("withoutCostFields(");
  });
});
