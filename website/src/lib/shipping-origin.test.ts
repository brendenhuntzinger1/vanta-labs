import { describe, expect, it } from "vitest";
import { REQUIRED_ORIGIN_FIELDS, validateShippingOrigin, type ShippingOrigin } from "@/lib/shipping-origin";

function origin(overrides: Partial<ShippingOrigin> = {}): ShippingOrigin {
  return {
    name: "Vanta Labs",
    company: "",
    street1: "1 Example St",
    street2: "",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    phone: "5125550123",
    email: "",
    ...overrides,
  };
}

describe("validateShippingOrigin", () => {
  it("accepts an origin with every carrier-required field", () => {
    expect(validateShippingOrigin(origin())).toEqual({ isComplete: true, missing: [] });
  });

  it("treats company, street2 and email as genuinely optional", () => {
    const result = validateShippingOrigin(origin({ company: "", street2: "", email: "" }));
    expect(result.isComplete).toBe(true);
  });

  // Each of these produces a different carrier failure, and a generic
  // "address invalid" message would send the owner hunting. Report the field.
  it.each(REQUIRED_ORIGIN_FIELDS)("reports %s when it is blank", (field) => {
    const result = validateShippingOrigin(origin({ [field]: "" } as Partial<ShippingOrigin>));
    expect(result.isComplete).toBe(false);
    expect(result.missing).toContain(field);
  });

  it("reports every missing field at once rather than one at a time", () => {
    const result = validateShippingOrigin(origin({ city: "", state: "", zip: "" }));
    expect(result.missing).toEqual(expect.arrayContaining(["city", "state", "zip"]));
    expect(result.missing).toHaveLength(3);
  });

  // Phone is the subtle one: USPS quotes without it, UPS and FedEx do not. An
  // origin missing a phone therefore looks half-working — USPS rates appear and
  // the other carriers silently return nothing — which reads as "those carriers
  // aren't enabled" rather than "the address is incomplete".
  it("requires phone, so UPS and FedEx cannot silently drop out", () => {
    expect(REQUIRED_ORIGIN_FIELDS).toContain("phone");
    expect(validateShippingOrigin(origin({ phone: "" })).isComplete).toBe(false);
  });

  it("does not accept whitespace as a filled field", () => {
    expect(validateShippingOrigin(origin({ street1: "" })).isComplete).toBe(false);
  });
});
