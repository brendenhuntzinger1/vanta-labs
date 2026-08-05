import { describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks @/lib/fulfillment/service wholesale; pull the real one.
const { normalizeOrder, looksLikeUuid } = await vi.importActual<typeof import("@/lib/fulfillment/service")>(
  "@/lib/fulfillment/service",
);

/**
 * docs/3PL-INTEGRATION-REQUIREMENTS.md §5, sent to the partner as the agreed
 * contract:
 *
 *   "Our `sku` is the product slug (e.g. `glp-1`) and `variant` is the dose
 *    (e.g. `5mg`). Inventory callbacks must match on the same pair."
 *
 * The code was sending this store's internal product_doses UUID as `variant`.
 * Reported consequence, from the warehouse on reship 127902: "print vial label"
 * was offered for the MOTS-C line and not for GLP-1 5mg — a vial label is
 * per-strength, and the partner had a UUID where "5mg" was promised. MOTS-C has
 * no dose at all, so its plain slug identified the vial and its label printed.
 */

const DOMAIN = "vantalabsresearch.com";
const DOSE_ID = "6d1f0a8e-4b2c-4f11-9a3d-77c2b0e5a911";

const BASE_ORDER = {
  order_id: "order-b2ea193e",
  order_number: "VL-E8F4D52F",
  customer_name: "Brenden H",
  shipping_address: "123 Research Way",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
  subtotal: 0,
  shipping_amount: 0,
  tax_amount: 0,
  amount_paid: 0,
};

const doses = new Map([
  [DOSE_ID, { sku: "GLP1-SEMA-5MG", label: "5mg", batchNumber: "B-2026-0417" }],
]);

const dosedOrder = {
  ...BASE_ORDER,
  order_items: [
    { product_id: `glp-1::${DOSE_ID}`, product_name: "GLP-1 (S) – sema (5mg)", quantity: 1, unit_price: 0 },
  ],
};

describe("variant is the dose, exactly as the contract promises", () => {
  it('sends variant "5mg", not a UUID', () => {
    const [item] = normalizeOrder(dosedOrder, DOMAIN, doses).items;
    expect(item.sku).toBe("glp-1");
    expect(item.variant).toBe("5mg");
    expect(looksLikeUuid(String(item.variant))).toBe(false);
  });

  it("still carries the internal id, so a callback can round-trip it", () => {
    const [item] = normalizeOrder(dosedOrder, DOMAIN, doses).items;
    expect(item.variantId).toBe(DOSE_ID);
  });

  it("gives the vial label a SKU and a batch to print", () => {
    const [item] = normalizeOrder(dosedOrder, DOMAIN, doses).items;
    expect(item.variantSku).toBe("GLP1-SEMA-5MG");
    expect(item.batchNumber).toBe("B-2026-0417");
  });
});

describe("a single-dose line is unaffected", () => {
  it("needs no dose — its slug already names the vial", () => {
    const order = {
      ...BASE_ORDER,
      order_items: [{ product_id: "mots-c", product_name: "MOTS-C 10mg", quantity: 1, unit_price: 0 }],
    };
    const [item] = normalizeOrder(order, DOMAIN, doses).items;
    expect(item.sku).toBe("mots-c");
    expect(item.variant).toBeNull();
    expect(item.variantId).toBeNull();
    expect(item.variantSku).toBeNull();
  });
});

describe("unresolvable dose data never makes things worse", () => {
  it("falls back to the raw suffix rather than claiming there is no dose", () => {
    // Sending null would tell the partner this product has no strengths at all,
    // which is how the wrong vial gets picked. A useless identifier beats a
    // confidently wrong one.
    const [item] = normalizeOrder(dosedOrder, DOMAIN, new Map()).items;
    expect(item.variant).toBe(DOSE_ID);
    expect(item.variantId).toBe(DOSE_ID);
    expect(item.variantSku).toBeNull();
  });

  it("passes through a suffix that is already a dose label", () => {
    const order = {
      ...BASE_ORDER,
      order_items: [{ product_id: "glp-1::5mg", product_name: "GLP-1 (5mg)", quantity: 1, unit_price: 0 }],
    };
    const [item] = normalizeOrder(order, DOMAIN, new Map()).items;
    expect(item.variant).toBe("5mg");
  });

  it("tolerates a dose row with no SKU recorded", () => {
    const partial = new Map([[DOSE_ID, { sku: null, label: "5mg", batchNumber: null }]]);
    const [item] = normalizeOrder(dosedOrder, DOMAIN, partial).items;
    expect(item.variant).toBe("5mg");
    expect(item.variantSku).toBeNull();
  });
});

describe("looksLikeUuid", () => {
  it("tells an internal id from a dose label", () => {
    expect(looksLikeUuid(DOSE_ID)).toBe(true);
    expect(looksLikeUuid("5mg")).toBe(false);
    expect(looksLikeUuid("10 mg")).toBe(false);
    expect(looksLikeUuid("")).toBe(false);
  });
});
