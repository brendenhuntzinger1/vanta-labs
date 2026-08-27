import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Google pixel.
 *
 * These are assertions about the source itself because the failures they catch
 * do not show up in a unit test of any individual module: a consent gate
 * deleted during a refactor, an environment guard removed as "redundant", or
 * Google's placeholder identity string left in the config object.
 */
const PIXEL = join(process.cwd(), "src/components/google-pixel.tsx");
const source = () => readFileSync(PIXEL, "utf8");

describe("google-pixel.tsx invariants", () => {
  it("consults the consent state", () => {
    expect(source()).toContain("vl_cookie_consent");
  });

  it("consults the environment guard", () => {
    expect(source()).toContain("browserAdsReportingAllowed");
  });

  it("checks the conversion id is really a Google Ads id", () => {
    expect(source()).toContain("isConfiguredGoogleAdsId");
  });

  it("carries no raw identity field in the gtag config", () => {
    const text = source();
    expect(text).not.toContain("INSERT_USER_EMAIL");
    expect(text).not.toMatch(/['"]email['"]\s*:/);
    expect(text).not.toMatch(/user_data\s*:/);
  });

  it("declares no conversion id of its own", () => {
    expect(source()).not.toMatch(/["'`]AW-\d+["'`]/);
  });
});
