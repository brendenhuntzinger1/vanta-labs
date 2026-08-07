import { describe, expect, it, vi } from "vitest";

// The module reaches Supabase at import time; the address builder is pure and
// touches none of it.
vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: {} }));

import { orderDestinationAddress, type OrderShippingRow } from "@/lib/shippo/service";

function order(overrides: Partial<OrderShippingRow> = {}): OrderShippingRow {
  return {
    customer_name: "Dana Reyes",
    shipping_address: "1400 Cypress Row",
    shipping_address_2: null,
    city: "Austin",
    state: "TX",
    postal_code: "78701",
    country: "United States",
    phone: "5125550147",
    ...overrides,
  } as OrderShippingRow;
}

describe("the address sent to Shippo", () => {
  it("carries the apartment as street2, not glued onto the street line", () => {
    const address = orderDestinationAddress(order({ shipping_address_2: "Apt 4B" }));

    expect(address.street1).toBe("1400 Cypress Row");
    expect(address.street2).toBe("Apt 4B");
  });

  // Shippo treats an empty string as a validation failure rather than as "no
  // second line", so a blank must be absent, not present-and-empty.
  it("omits street2 entirely when there is no unit", () => {
    expect(orderDestinationAddress(order()).street2).toBeUndefined();
    expect(orderDestinationAddress(order({ shipping_address_2: "" })).street2).toBeUndefined();
    expect(orderDestinationAddress(order({ shipping_address_2: "   " })).street2).toBeUndefined();
  });

  it("trims a unit the shopper padded", () => {
    expect(orderDestinationAddress(order({ shipping_address_2: "  Suite 210  " })).street2).toBe("Suite 210");
  });

  it("still normalises the state alongside the new field", () => {
    const address = orderDestinationAddress(order({ state: "Texas", shipping_address_2: "Unit 9" }));

    expect(address.state).toBe("TX");
    expect(address.street2).toBe("Unit 9");
  });
});
