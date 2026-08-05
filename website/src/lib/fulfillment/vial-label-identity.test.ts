import { describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks @/lib/fulfillment/service wholesale; pull the real one.
const { normalizeOrder } = await vi.importActual<typeof import("@/lib/fulfillment/service")>(
  "@/lib/fulfillment/service",
);

/**
 * Reported from the warehouse: a Vanta Labs reship offered "print vial label"
 * for the MOTS-C line but not for the GLP-1 5mg line.
 *
 * A vial label is per-STRENGTH — a 5mg label is not a 10mg label — so a 3PL
 * keying its label template on a SKU needs something that identifies the exact
 * dose. A single-dose product (MOTS-C) has no variant, so its plain slug does
 * that on its own and the label prints. A dosed product used to send only the
 * base slug plus this store's internal product_doses UUID, which matches
 * nothing in anyone else's catalogue — hence no label option.
 *
 * These tests pin the dose's real catalogue identity onto the line.
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

describe("a dosed line carries enough to print its vial label", () => {
  const order = {
    ...BASE_ORDER,
    order_items: [
      { product_id: `glp-1::${DOSE_ID}`, product_name: "GLP-1 (S) – sema (5mg)", quantity: 1, unit_price: 0 },
    ],
  };

  it("sends the dose's real SKU, not only our internal UUID", () => {
    const [item] = normalizeOrder(order, DOMAIN, doses).items;
    expect(item.variantSku).toBe("GLP1-SEMA-5MG");
    expect(item.variantLabel).toBe("5mg");
    expect(item.batchNumber).toBe("B-2026-0417");
  });

  it("still sends the base slug and dose id, so inventory sync is unchanged", () => {
    // Inbound inventory webhooks match on exactly these two. Enriching the line
    // must not move them.
    const [item] = normalizeOrder(order, DOMAIN, doses).items;
    expect(item.sku).toBe("glp-1");
    expect(item.variant).toBe(DOSE_ID);
  });

  it("identifies the strength somewhere other than a free-text name", () => {
    const [item] = normalizeOrder(order, DOMAIN, doses).items;
    // Before this change the ONLY place "5mg" appeared was inside the display
    // name — not something a label template can be keyed on.
    expect(item.variantLabel ?? item.variantSku).toBeTruthy();
  });
});

describe("a single-dose line is unaffected", () => {
  it("needs no variant identity — its slug already names the vial", () => {
    const order = {
      ...BASE_ORDER,
      order_items: [{ product_id: "mots-c", product_name: "MOTS-C 10mg", quantity: 1, unit_price: 0 }],
    };
    const [item] = normalizeOrder(order, DOMAIN, doses).items;
    expect(item.sku).toBe("mots-c");
    expect(item.variant).toBeNull();
    expect(item.variantSku).toBeNull();
    expect(item.variantLabel).toBeNull();
  });
});

describe("missing dose data never blocks a shipment", () => {
  it("transmits with the identifiers it always had when the lookup is empty", () => {
    const order = {
      ...BASE_ORDER,
      order_items: [
        { product_id: `glp-1::${DOSE_ID}`, product_name: "GLP-1 (S) – sema (5mg)", quantity: 1, unit_price: 0 },
      ],
    };
    const [item] = normalizeOrder(order, DOMAIN, new Map()).items;
    expect(item.sku).toBe("glp-1");
    expect(item.variant).toBe(DOSE_ID);
    expect(item.variantSku).toBeNull();
    expect(item.quantity).toBe(1);
  });

  it("tolerates a dose row with no SKU recorded", () => {
    const order = {
      ...BASE_ORDER,
      order_items: [
        { product_id: `glp-1::${DOSE_ID}`, product_name: "GLP-1 (S) – sema (5mg)", quantity: 1, unit_price: 0 },
      ],
    };
    const partial = new Map([[DOSE_ID, { sku: null, label: "5mg", batchNumber: null }]]);
    const [item] = normalizeOrder(order, DOMAIN, partial).items;
    expect(item.variantSku).toBeNull();
    expect(item.variantLabel).toBe("5mg");
  });
});
