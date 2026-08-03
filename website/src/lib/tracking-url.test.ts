import { describe, expect, it } from "vitest";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";

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
});
