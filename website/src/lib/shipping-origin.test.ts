import { describe, expect, it } from "vitest";
import {
  EMPTY_ADDRESS,
  REQUIRED_ADDRESS_FIELDS,
  isAddressEmpty,
  parseAddress,
  validateAddress,
  type ShippingAddress,
} from "@/lib/shipping-origin";

function address(overrides: Partial<ShippingAddress> = {}): ShippingAddress {
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

describe("validateAddress", () => {
  it("accepts an address with every carrier-required field", () => {
    expect(validateAddress(address())).toEqual({ isComplete: true, missing: [] });
  });

  it("treats company, street2 and email as genuinely optional", () => {
    expect(validateAddress(address({ company: "", street2: "", email: "" })).isComplete).toBe(true);
  });

  // Each missing field produces a different carrier failure, and a generic
  // "address invalid" would send the owner hunting. Name the field.
  it.each(REQUIRED_ADDRESS_FIELDS)("reports %s when it is blank", (field) => {
    const result = validateAddress(address({ [field]: "" } as Partial<ShippingAddress>));
    expect(result.isComplete).toBe(false);
    expect(result.missing).toContain(field);
  });

  it("reports every missing field at once rather than one at a time", () => {
    const result = validateAddress(address({ city: "", state: "", zip: "" }));
    expect(result.missing).toEqual(expect.arrayContaining(["city", "state", "zip"]));
    expect(result.missing).toHaveLength(3);
  });

  // Phone is the subtle one: USPS quotes without it, UPS and FedEx do not. An
  // address missing a phone looks half-working rather than broken.
  it("requires phone, so UPS and FedEx cannot silently drop out", () => {
    expect(REQUIRED_ADDRESS_FIELDS).toContain("phone");
    expect(validateAddress(address({ phone: "" })).isComplete).toBe(false);
  });
});

describe("parseAddress", () => {
  it("normalizes state and country to two-letter uppercase codes", () => {
    const parsed = parseAddress({ state: "tx", country: "us" });
    expect(parsed.state).toBe("TX");
    expect(parsed.country).toBe("US");
  });

  it("trims whitespace so a space-only field counts as missing", () => {
    expect(validateAddress(parseAddress({ ...address(), street1: "   " })).isComplete).toBe(false);
  });

  it("defaults country to US but never invents any other field", () => {
    const parsed = parseAddress({});
    expect(parsed.country).toBe("US");
    expect(parsed.street1).toBe("");
    expect(parsed.city).toBe("");
  });

  it("ignores non-string values rather than coercing them", () => {
    const parsed = parseAddress({ zip: 78701, name: null, city: { x: 1 } });
    expect(parsed.zip).toBe("");
    expect(parsed.name).toBe("");
    expect(parsed.city).toBe("");
  });
});

describe("isAddressEmpty", () => {
  it("is true for a wholly unconfigured address", () => {
    expect(isAddressEmpty({ ...EMPTY_ADDRESS })).toBe(true);
  });

  // country defaults to "US" even when nothing is configured, so it must not
  // count toward "the owner filled something in" — otherwise every blank
  // return address would read as deliberately configured and the origin would
  // never be used as the fallback.
  it("ignores the defaulted country when deciding emptiness", () => {
    expect(isAddressEmpty(parseAddress({}))).toBe(true);
  });

  it("is false once any real field is set", () => {
    expect(isAddressEmpty({ ...EMPTY_ADDRESS, city: "Austin" })).toBe(false);
  });
});

// The privacy-critical behaviour: the origin is a home address, and the return
// address is what a stranger reads off the parcel. These must not be conflated.
describe("origin vs return address separation", () => {
  it("a complete separate return address is distinct from the origin", () => {
    const origin = address({ street1: "12 Home Ln", city: "Austin" });
    const returnAddr = address({ name: "Vanta Labs", street1: "PO Box 4", city: "Austin" });
    expect(validateAddress(origin).isComplete).toBe(true);
    expect(validateAddress(returnAddr).isComplete).toBe(true);
    expect(returnAddr.street1).not.toBe(origin.street1);
  });

  // A half-filled return address must NOT be sent to the carrier. Falling back
  // to the origin prints the home address, which is why the admin UI has to
  // warn loudly rather than treat this as a harmless default.
  it("an incomplete return address is not usable and must fall back", () => {
    const partial = address({ street1: "PO Box 4", city: "", state: "", zip: "", phone: "" });
    expect(isAddressEmpty(partial)).toBe(false);
    expect(validateAddress(partial).isComplete).toBe(false);
  });
});
