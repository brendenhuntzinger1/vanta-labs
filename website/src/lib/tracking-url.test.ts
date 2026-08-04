import { describe, expect, it } from "vitest";
import { buildCarrierTrackingUrl, carrierDisplayName, resolveCarrier } from "@/lib/tracking-url";

// The 3PL's webhook carries its own `tracking_url` pointing at the 3PL's
// storefront. Emailing it sent Vanta Labs customers to another brand's site to
// track a Vanta Labs order. Nothing customer-facing may use that URL — the link
// is derived from carrier + tracking number instead.

const REAL_UPS = "1Z0037BB0313242143";

describe("buildCarrierTrackingUrl", () => {
  it("links to the carrier, never to a fulfilment provider", () => {
    const url = buildCarrierTrackingUrl("UPS", REAL_UPS);
    expect(url).toBe(`https://www.ups.com/track?tracknum=${REAL_UPS}`);
    expect(url).not.toMatch(/evolabs/i);
  });

  it("handles every supported carrier", () => {
    expect(buildCarrierTrackingUrl("USPS", "94001")).toContain("tools.usps.com");
    expect(buildCarrierTrackingUrl("FedEx", "7712")).toContain("fedex.com");
    expect(buildCarrierTrackingUrl("DHL Express", "JD01")).toContain("dhl.com");
    expect(buildCarrierTrackingUrl("OnTrac", "D100")).toContain("ontrac.com");
  });

  it("matches carrier names case-insensitively and inside longer strings", () => {
    expect(buildCarrierTrackingUrl("ups ground", REAL_UPS)).toContain("ups.com");
    expect(buildCarrierTrackingUrl("UNITED STATES POSTAL SERVICE", "94001")).toContain("usps.com");
    expect(buildCarrierTrackingUrl("Fed Ex Home Delivery", "7712")).toContain("fedex.com");
  });

  it("infers UPS from the 1Z tracking format when the 3PL omits the carrier", () => {
    expect(buildCarrierTrackingUrl(null, REAL_UPS)).toBe(`https://www.ups.com/track?tracknum=${REAL_UPS}`);
    expect(buildCarrierTrackingUrl("", REAL_UPS)).toContain("ups.com");
  });

  it("does NOT guess a carrier from an ambiguous numeric tracking number", () => {
    // FedEx and USPS both use plain digit strings; a wrong guess lands the
    // customer on a carrier page reporting "not found".
    expect(buildCarrierTrackingUrl(null, "9400111899223817428490")).toBeNull();
    expect(buildCarrierTrackingUrl(null, "771234567890")).toBeNull();
  });

  it("returns null for an unknown carrier so the caller can keep the customer on Vanta Labs", () => {
    expect(buildCarrierTrackingUrl("Evo Labs Courier", "ABC123")).toBeNull();
    expect(buildCarrierTrackingUrl("some-regional-carrier", "ABC123")).toBeNull();
  });

  it("returns null without a tracking number, whatever the carrier", () => {
    expect(buildCarrierTrackingUrl("UPS", null)).toBeNull();
    expect(buildCarrierTrackingUrl("UPS", "")).toBeNull();
    expect(buildCarrierTrackingUrl("UPS", "   ")).toBeNull();
  });

  it("url-encodes the tracking number so it cannot break out of the query string", () => {
    const url = buildCarrierTrackingUrl("UPS", "1Z ABC&foo=bar");
    expect(url).toContain("1Z%20ABC%26foo%3Dbar");
    expect(url).not.toContain("&foo=bar");
  });

  it("trims surrounding whitespace from the tracking number", () => {
    expect(buildCarrierTrackingUrl("UPS", `  ${REAL_UPS}  `)).toContain(REAL_UPS);
  });

  it("does not match a carrier name that merely contains the letters of one", () => {
    // "Groupon" contains "ups". Substring matching sent those parcels to a UPS
    // page reporting "not found".
    expect(buildCarrierTrackingUrl("Groupon Logistics", "ABC123")).toBeNull();
    expect(buildCarrierTrackingUrl("Backups Courier", "ABC123")).toBeNull();
    // ...while real UPS service names still resolve.
    expect(buildCarrierTrackingUrl("UPS SurePost", REAL_UPS)).toContain("ups.com");
    expect(buildCarrierTrackingUrl("ups-ground", REAL_UPS)).toContain("ups.com");
  });
});

describe("carrierDisplayName", () => {
  // The carrier field is free text the 3PL controls. It was printed verbatim on
  // the orders list, the order detail page and the shipping email, so a payload
  // naming the supplier put that name in front of the customer.
  it("never echoes the 3PL's text back", () => {
    expect(carrierDisplayName("Evo Labs Research", REAL_UPS)).toBe("UPS");
    expect(carrierDisplayName("EVO Labs Courier", "ABC123")).toBeNull();
    expect(carrierDisplayName("some-regional-partner", "ABC123")).toBeNull();
  });

  it("returns the carrier's canonical name, not the input spelling", () => {
    expect(carrierDisplayName("ups ground", REAL_UPS)).toBe("UPS");
    expect(carrierDisplayName("fed ex home delivery", "7712")).toBe("FedEx");
    expect(carrierDisplayName("UNITED STATES POSTAL SERVICE", "94001")).toBe("USPS");
    expect(carrierDisplayName("dhl express", "JD01")).toBe("DHL");
    expect(carrierDisplayName("ontrac", "D100")).toBe("OnTrac");
  });

  it("names UPS from the tracking format alone when the carrier is withheld", () => {
    expect(carrierDisplayName(null, REAL_UPS)).toBe("UPS");
  });

  it("says nothing without a tracking number", () => {
    expect(carrierDisplayName("UPS", null)).toBeNull();
    expect(carrierDisplayName("UPS", "  ")).toBeNull();
  });

  it("only ever returns a name from the allow-list", () => {
    const allowed = new Set(["USPS", "UPS", "FedEx", "DHL", "OnTrac"]);
    const payloads = [
      "Evo Labs Research",
      "evolabsresearch.co",
      "Partner Fulfilment Network",
      "UPS",
      "ups ground",
      "",
      "  ",
      "<script>alert(1)</script>",
    ];
    for (const carrier of payloads) {
      const name = carrierDisplayName(carrier, REAL_UPS);
      if (name !== null) expect(allowed.has(name)).toBe(true);
    }
  });
});

describe("resolveCarrier", () => {
  it("returns name and url together so callers cannot mix a stale pair", () => {
    expect(resolveCarrier("UPS", REAL_UPS)).toEqual({
      id: "ups",
      name: "UPS",
      trackingUrl: `https://www.ups.com/track?tracknum=${REAL_UPS}`,
    });
  });

  it("resolves to null rather than a partial result", () => {
    expect(resolveCarrier("Evo Labs Courier", "ABC123")).toBeNull();
    expect(resolveCarrier("UPS", "")).toBeNull();
  });

  it("only ever points at a real carrier's own domain", () => {
    const domains = ["ups.com", "usps.com", "fedex.com", "dhl.com", "ontrac.com"];
    for (const carrier of ["UPS", "USPS", "FedEx", "DHL", "OnTrac"]) {
      const url = resolveCarrier(carrier, REAL_UPS)?.trackingUrl ?? "";
      expect(url.startsWith("https://")).toBe(true);
      expect(domains.some((domain) => new URL(url).hostname.endsWith(domain))).toBe(true);
    }
  });
});
