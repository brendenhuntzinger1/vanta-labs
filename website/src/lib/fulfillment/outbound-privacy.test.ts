import { describe, expect, it, vi } from "vitest";

// The 3PL must never have a way to contact a Vanta Labs customer. It gets a
// pick list and a shipping label, nothing more. This suite walks the ACTUAL
// payload that goes over the wire and fails if anything buyer-reachable
// appears in it.
//
// vitest.setup.ts mocks @/lib/fulfillment/service wholesale, so pull the real
// module for these assertions.
const { normalizeOrder } = await vi.importActual<typeof import("@/lib/fulfillment/service")>(
  "@/lib/fulfillment/service",
);

const BUYER_EMAIL = "btunchi88@gmail.com";
const BUYER_PHONE = "+15551234567";
const DOMAIN = "vantalabsresearch.com";

// Shaped like the real transmit query result.
const ORDER = {
  order_id: "order-b2ea193e",
  order_number: "VL-E8F4D52F",
  customer_name: "Brenden H",
  shipping_address: "123 Research Way",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
  subtotal: 54.99,
  shipping_amount: 15,
  tax_amount: 3.85,
  amount_paid: 76.04,
  order_items: [
    { product_id: "glp-1::5mg", product_name: "GLP-1 (5mg)", quantity: 1, unit_price: 54.99 },
  ],
};

function serialized() {
  return JSON.stringify(normalizeOrder(ORDER, DOMAIN));
}

describe("outbound 3PL payload carries no channel to the customer", () => {
  it("does not contain the buyer's email anywhere in the payload", () => {
    expect(serialized()).not.toContain(BUYER_EMAIL);
    expect(serialized()).not.toContain("gmail");
  });

  it("does not contain a phone number", () => {
    expect(serialized()).not.toContain(BUYER_PHONE);
    expect(serialized()).not.toContain("5551234567");
  });

  it("sends a Vanta-controlled alias as the only contact address", () => {
    const payload = normalizeOrder(ORDER, DOMAIN);
    expect(payload.customer.email).toBe("orders+VL-E8F4D52F@vantalabsresearch.com");
    expect(payload.customer.email.endsWith(`@${DOMAIN}`)).toBe(true);
  });

  it("sends NO contact address rather than the buyer's when no domain resolves", () => {
    expect(normalizeOrder(ORDER, "").customer.email).toBe("");
  });

  it("even an order row that somehow carries an email cannot leak it", () => {
    // Belt and braces: the field is off the type, but a stray cast must not
    // change what goes over the wire.
    const contaminated = { ...ORDER, customer_email: BUYER_EMAIL } as unknown as typeof ORDER;
    expect(JSON.stringify(normalizeOrder(contaminated, DOMAIN))).not.toContain(BUYER_EMAIL);
  });
});

describe("the 3PL still receives everything needed to pick, pack and ship", () => {
  const payload = normalizeOrder(ORDER, DOMAIN);

  it("identifies the order both ways", () => {
    expect(payload.orderNumber).toBe("VL-E8F4D52F");
    expect(payload.orderId).toBe("order-b2ea193e");
  });

  it("carries the full shipping destination", () => {
    expect(payload.shipping).toEqual({
      address: "123 Research Way", city: "Austin", state: "TX", postalCode: "78701", country: "US",
    });
  });

  it("carries the recipient name for the label", () => {
    expect(payload.customer.name).toBe("Brenden H");
  });

  it("splits product_id into SKU and variant so the right dose is picked", () => {
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ sku: "glp-1", variant: "5mg", quantity: 1 });
  });

  it("handles a product with no variant", () => {
    const noVariant = { ...ORDER, order_items: [{ product_id: "bac-water", product_name: "BAC Water", quantity: 2, unit_price: 9.99 }] };
    const items = normalizeOrder(noVariant, DOMAIN).items;
    expect(items[0]).toMatchObject({ sku: "bac-water", variant: null, quantity: 2 });
  });

  it("carries order totals", () => {
    expect(payload.totals).toEqual({ subtotal: 54.99, shipping: 15, tax: 3.85, total: 76.04 });
  });
});

// A membership is a subscription, not a parcel. Both paid paths used to send
// them to the 3PL anyway — finalizeManualPayment computed isMembershipOrder to
// skip points and mark the order fulfilled, then transmitted without consulting
// it, and the card webhook never checked. Arcline received a $1.00 "Monthly
// Membership — Vanta Essential" with an empty name, address and email, rejected
// it 422, and raised a critical "customer is paid but the order did not reach
// fulfilment" alert for an order that must never reach fulfilment.
describe("membership orders are structurally unfit for fulfilment", () => {
  const MEMBERSHIP_ORDER = {
    ...ORDER,
    order_type: "membership",
    order_number: "VL-49CA32C1",
    customer_name: null,
    shipping_address: null,
    city: null,
    state: null,
    postal_code: null,
    country: null,
    order_items: [
      { product_id: "membership:essential", product_name: "Monthly Membership — Vanta Essential", quantity: 1, unit_price: 1 },
    ],
  } as unknown as typeof ORDER;

  it("has no shippable destination — proving there is nothing to fulfil", () => {
    const payload = normalizeOrder(MEMBERSHIP_ORDER, DOMAIN);
    expect(payload.shipping).toEqual({ address: "", city: "", state: "", postalCode: "", country: "" });
    expect(payload.customer.name).toBe("");
  });

  it("its line item is a plan, not a SKU the 3PL could pick", () => {
    const payload = normalizeOrder(MEMBERSHIP_ORDER, DOMAIN);
    expect(payload.items[0].sku).toBe("membership:essential");
    expect(payload.items[0].sku?.startsWith("membership:")).toBe(true);
  });
});

describe("outbound 3PL payload carries a shippable address", () => {
  // Checkout REQUIRES a state ("Please select the state for your shipping
  // address") and stores it on the order, but normalizeOrder never forwarded
  // it — so every US order reached the 3PL with no state, which no domestic
  // carrier will accept and which no packing slip can be printed from.
  it("includes the state", () => {
    const payload = normalizeOrder(ORDER, DOMAIN);
    expect(payload.shipping.state).toBe("TX");
    expect(serialized()).toContain('"state":"TX"');
  });

  it("carries every field a label needs", () => {
    const { address, city, state, postalCode, country } = normalizeOrder(ORDER, DOMAIN).shipping;
    for (const field of [address, city, state, postalCode, country]) {
      expect(field.trim().length).toBeGreaterThan(0);
    }
  });

  it("degrades to an empty string rather than 'undefined' when a field is absent", () => {
    const payload = normalizeOrder({ ...ORDER, state: null }, DOMAIN);
    expect(payload.shipping.state).toBe("");
    expect(JSON.stringify(payload)).not.toContain("undefined");
  });
});
