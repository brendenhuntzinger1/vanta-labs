import { describe, expect, it } from "vitest";
import { fulfillmentContactEmail, domainFromEmailAddress } from "@/lib/fulfillment/contact-email";

// The 3PL emails its OWN branded order confirmation to whatever address it is
// given. A Vanta Labs purchase reached the buyer as "EVO Labs Research", showing
// the item as a $0.00 FREE GIFT — two conflicting confirmations for one order,
// from a company the buyer has never heard of, disclosing our supplier.
// The buyer's real address must never leave the building.

const BUYER = "btunchi88@gmail.com";

describe("fulfillmentContactEmail", () => {
  it("returns a Vanta-controlled alias, never the buyer's address", () => {
    const email = fulfillmentContactEmail("VL-E8F4D52F", "vantalabsresearch.com");
    expect(email).toBe("orders+VL-E8F4D52F@vantalabsresearch.com");
    expect(email).not.toBe(BUYER);
    expect(email).not.toContain("gmail");
  });

  it("tags the order so a 3PL reply is traceable", () => {
    expect(fulfillmentContactEmail("VL-100190", "example.com")).toContain("+VL-100190@");
  });

  it("strips characters that would break the address", () => {
    const email = fulfillmentContactEmail("VL 123/../<script>", "example.com");
    expect(email).toBe("orders+VL123script@example.com");
  });

  it("never emits a bare or malformed address when the order number is empty", () => {
    expect(fulfillmentContactEmail("", "example.com")).toBe("orders+unknown@example.com");
  });

  it("returns EMPTY rather than anything buyer-shaped when no domain is configured", () => {
    // No contact channel is the correct fallback. The buyer's inbox is not.
    expect(fulfillmentContactEmail("VL-1", "")).toBe("");
    expect(fulfillmentContactEmail("VL-1", "   ")).toBe("");
  });

  it("tolerates a domain written with a leading @ or in mixed case", () => {
    expect(fulfillmentContactEmail("VL-1", "@Example.COM")).toBe("orders+VL-1@example.com");
  });
});

describe("domainFromEmailAddress", () => {
  it("reads a plain address", () => {
    expect(domainFromEmailAddress("orders@vantalabsresearch.com")).toBe("vantalabsresearch.com");
  });

  it("reads a display-name address", () => {
    expect(domainFromEmailAddress("Vanta Labs <orders@vantalabsresearch.com>")).toBe("vantalabsresearch.com");
  });

  it("drops a www. prefix and lowercases", () => {
    expect(domainFromEmailAddress("orders@WWW.Example.com")).toBe("example.com");
  });

  it("returns empty for anything that is not an address", () => {
    expect(domainFromEmailAddress("")).toBe("");
    expect(domainFromEmailAddress(null)).toBe("");
    expect(domainFromEmailAddress("not-an-email")).toBe("");
  });
});
