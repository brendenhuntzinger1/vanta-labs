import { describe, expect, it } from "vitest";
import { isConfiguredGoogleAdsId } from "./google-conversion-id";

describe("isConfiguredGoogleAdsId", () => {
  it("accepts a real Google Ads conversion id", () => {
    expect(isConfiguredGoogleAdsId("AW-123456789")).toBe(true);
  });

  it("rejects an empty value, which is how the pixel stays inert before the account exists", () => {
    expect(isConfiguredGoogleAdsId("")).toBe(false);
  });

  it("rejects a placeholder left in by mistake", () => {
    expect(isConfiguredGoogleAdsId("AW-XXXXXXXXX")).toBe(false);
  });

  it("rejects a GA4 measurement id, which is a different product and would report nothing", () => {
    expect(isConfiguredGoogleAdsId("G-ABC123")).toBe(false);
  });

  it("rejects a bare number with no AW- prefix", () => {
    expect(isConfiguredGoogleAdsId("123456789")).toBe(false);
  });
});
